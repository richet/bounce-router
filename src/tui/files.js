import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fuzzyScore} from '../terminal.js';

// The files an `@mention` completes from (docs/ARCHITECTURE.md § TUI). In a git repository: what git
// tracks plus untracked files it does not ignore. Elsewhere: a bounded walk that skips dependency and VCS folders.
// Read at most every ten seconds per workspace, so typing stays instant.
const LIMIT = 20_000;
const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', 'target', '.next', '.cache']);
const cache = new Map();

function walk(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (found.length >= LIMIT || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (found.length >= LIMIT) return;
      if (entry.isDirectory()) { if (!SKIP.has(entry.name)) visit(path.join(dir, entry.name), depth + 1); }
      else if (entry.isFile()) found.push(path.relative(root, path.join(dir, entry.name)));
    }
  };
  visit(root, 0);
  return found;
}

export function workspaceFiles(cwd, {fresh = false, now = Date.now()} = {}) {
  const cached = cache.get(cwd);
  if (!fresh && cached && now - cached.at < 10_000) return cached.files;
  let files;
  try {
    files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000})
      .split('\n').filter(Boolean).slice(0, LIMIT);
  } catch { files = walk(cwd); }
  cache.set(cwd, {at: now, files});
  return files;
}

// Best first: the query at the start of the file's name, then anywhere in its path, then its letters in order;
// a shorter path first at a tie.
export function matchFiles(files, query, limit = 50) {
  const needle = String(query ?? '');
  const scored = [];
  for (const file of files) {
    const base = path.basename(file);
    const score = needle && base.toLowerCase().startsWith(needle.toLowerCase()) ? 4 : fuzzyScore(file, needle);
    if (score > 0) scored.push({file, score});
  }
  return scored.sort((a, b) => b.score - a.score || a.file.length - b.file.length || a.file.localeCompare(b.file)).slice(0, limit).map(entry => entry.file);
}
