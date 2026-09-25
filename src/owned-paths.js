// The paths a task's worker may change. Found live: a local write worker filed a blocked report
// about a file its orders forbade, then edited it anyway and reported success; the edit stayed in
// the tree while the rework ran. Enforcement is by the filesystem, not git — a project with nothing
// tracked yet (the case observed) still gets it: snapshot the tree before the turn, revert every
// change outside `owns` after it, and say what was reverted.
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules', '.bounce']);
const MAX_FILE = 4 * 1024 * 1024; // a bigger file is compared by size and mtime, never read

// A glob to a RegExp: `**` any depth, `*` within one segment, `?` one char. Relative paths only.
const toRegExp = glob => new RegExp(`^${glob.split('**').map(part => part.split('*').map(seg => seg.split('?').map(s => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]')).join('[^/]*')).join('.*')}$`);

export function ownedBy(file, owns = []) {
  if (!owns.length) return true;
  return owns.some(own => own === file || toRegExp(own).test(file));
}

export function validOwns(owns) {
  return Array.isArray(owns) && owns.every(own => typeof own === 'string' && own && !own.startsWith('/') && !own.includes('\0') && !own.split('/').some(part => part === '..'));
}

// {relative path: {content|size+mtime}} for every file under cwd, skipping git internals and deps.
export function treeSnapshot(cwd) {
  const out = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(cwd, full).split(path.sep).join('/');
        const stat = fs.statSync(full);
        out[rel] = stat.size <= MAX_FILE ? {content: fs.readFileSync(full)} : {size: stat.size, mtimeMs: stat.mtimeMs};
      }
    }
  };
  walk(cwd);
  return out;
}

const same = (a, b) => a.content && b.content ? a.content.equals(b.content) : a.size === b.size && a.mtimeMs === b.mtimeMs;

// Put back every file outside `owns` that changed since `before`; returns the paths, sorted.
export function revertOutside(cwd, before, owns = []) {
  if (!owns.length) return [];
  const after = treeSnapshot(cwd);
  const reverted = [];
  for (const rel of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (ownedBy(rel, owns)) continue;
    const was = before[rel], is = after[rel];
    if (was && is && same(was, is)) continue;
    const full = path.join(cwd, rel);
    if (!was) fs.rmSync(full, {force: true});
    else if (was.content) { fs.mkdirSync(path.dirname(full), {recursive: true}); fs.writeFileSync(full, was.content); }
    else continue; // a big file we never read: cannot restore, so leave it and let the reviewer see it
    reverted.push(rel);
  }
  return reverted.sort();
}
