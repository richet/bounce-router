// A worker's copy lives as long as its session is open. /quit removes the copies the closing session made; a
// daemon starting removes the copies of every session that is not running, except the one it resumes. A copy
// belongs to each session whose journal names its folder, so one no running session names is nobody's.
import fs from 'node:fs';
import path from 'node:path';
import {pidAlive} from './core.js';

const COPY = /^[0-9a-f]{8}$/;
const FRESH_MS = 10 * 60_000; // a copy made a moment ago may not be journaled yet

const pidIn = file => { try { const text = fs.readFileSync(file, 'utf8').trim(); const pid = Number(text.startsWith('{') ? JSON.parse(text).pid : text); return Number.isSafeInteger(pid) ? pid : null; } catch { return null; } };
const running = dir => [path.join(dir, 'daemon.json'), path.join(dir, 'lock')].some(file => pidAlive(pidIn(file)));

function named(journal, copyRoot) {
  let text = '';
  try { text = fs.readFileSync(journal, 'utf8'); } catch { return []; }
  const prefix = copyRoot.endsWith(path.sep) ? copyRoot : copyRoot + path.sep;
  const found = new Set();
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
    const name = text.slice(at + prefix.length, at + prefix.length + 8);
    if (COPY.test(name)) found.add(name);
  }
  return [...found];
}

// `keep`: the session being resumed (kept even before its daemon runs). `closing`: the session that is quitting
// (its own daemon is still running, and its copies go). Resolves to the folders removed; removal never blocks the
// daemon's event loop (a first sweep can be tens of gigabytes).
export async function sweepCopies({root, keep = null, closing = null, now = Date.now()}) {
  const copyRoot = path.join(root, 'w'), sessions = path.join(root, 'sessions');
  let copies = [];
  try { copies = fs.readdirSync(copyRoot).filter(name => COPY.test(name)); } catch { return []; }
  const kept = new Set();
  let ids = [];
  try { ids = fs.readdirSync(sessions); } catch {}
  const closingNames = new Set(closing ? named(path.join(sessions, closing, 'journal.jsonl'), copyRoot) : []);
  for (const id of ids) {
    const dir = path.join(sessions, id);
    if (id === closing || (id !== keep && !running(dir))) continue;
    for (const name of named(path.join(dir, 'journal.jsonl'), copyRoot)) kept.add(name);
  }
  const removed = [];
  for (const name of copies) {
    if (kept.has(name)) continue;
    const dir = path.join(copyRoot, name);
    try {
      if (!closingNames.has(name) && now - fs.statSync(dir).mtimeMs < FRESH_MS) continue;
      await fs.promises.rm(dir, {recursive: true, force: true});
      removed.push(dir);
    } catch {}
  }
  return removed;
}
