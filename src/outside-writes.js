// What appeared or changed outside a worker's copy while its attempt ran, in the directories a stray install or link
// lands in: the ones on PATH. Found live, 2026-11-04: a builder linked a file into /opt/homebrew/bin. Workers
// run with the vendor's sandbox off, so this cannot block the write; it makes it seen. Directories under the temp dir,
// the copies, the session or the checkout are left out: writing there is allowed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_DIRS = 32;
const MAX_ENTRIES = 5000; // a directory past this is not a bin directory worth watching
const MAX_SHOWN = 10;

const realOrNull = dir => { try { return fs.realpathSync(dir); } catch { return null; } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`);

export function watchedDirs({PATH = process.env.PATH ?? '', exclude = []} = {}) {
  const left = [os.tmpdir(), ...exclude].map(realOrNull).filter(Boolean);
  const dirs = [];
  for (const entry of PATH.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const dir = realOrNull(entry);
    if (!dir || dirs.includes(dir) || left.some(root => inside(dir, root))) continue;
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    dirs.push(dir);
    if (dirs.length === MAX_DIRS) break;
  }
  return dirs;
}

// One string per entry that changes when the entry is replaced, rewritten or relinked.
export function snapshot(dirs) {
  const seen = new Map();
  for (const dir of dirs) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    if (names.length > MAX_ENTRIES) continue;
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const stat = fs.lstatSync(file);
        seen.set(file, `${stat.ino}:${stat.size}:${stat.mtimeMs}${stat.isSymbolicLink() ? `:${fs.readlinkSync(file)}` : ''}`);
      } catch {}
    }
  }
  return seen;
}

// Each entry added or changed since `before`, with where a link points (resolved against its directory).
export function outsideChanges(before, after) {
  const changes = [];
  for (const [file, mark] of after) {
    if (before.get(file) === mark) continue;
    let link = null;
    try { if (fs.lstatSync(file).isSymbolicLink()) link = path.resolve(path.dirname(file), fs.readlinkSync(file)); } catch {}
    changes.push({path: file, how: before.has(file) ? 'changed' : 'added', ...(link ? {link} : {})});
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// The finding's one line. A link into this task's own copy is the worker's for certain; anything else only happened
// while it ran, and another process (a package upgrade, another worker) may have made it.
export function outsideFinding(changes, copy) {
  const own = copy ? realOrNull(copy) ?? copy : null;
  const said = changes.slice(0, MAX_SHOWN).map(change => `${change.path} ${change.how}${change.link ? ` (a link to ${change.link}${own && inside(change.link, own) ? ', inside this task\'s working copy' : ''})` : ''}`);
  const more = changes.length > MAX_SHOWN ? `, and ${changes.length - MAX_SHOWN} more` : '';
  return `Written outside the working copy while this attempt ran: ${said.join('; ')}${more}. Check whether the worker did it, and undo it if it should not stay.`;
}
