// `bounce prune` and /prune: the workers' copies under ~/.bounce/w, listed with the session and task each belongs to,
// when it was last used and whether its work reached the checkout, then removed as the user chooses. Nothing removes
// a copy on its own (found live: a daemon starting after a reboot removed another session's copies, and a finished
// panel no task had integrated yet went with them). A copy whose task is still running in a live session is never
// removed.
import fs from 'node:fs';
import path from 'node:path';
import {pidAlive, readJournal} from './core.js';
import {tasks as taskView, TERMINAL} from './reducers.js';

const COPY = /^[0-9a-f]{8}$/;
const pidIn = file => { try { const text = fs.readFileSync(file, 'utf8').trim(); const pid = Number(text.startsWith('{') ? JSON.parse(text).pid : text); return Number.isSafeInteger(pid) ? pid : null; } catch { return null; } };
const running = dir => [path.join(dir, 'daemon.json'), path.join(dir, 'lock')].some(file => pidAlive(pidIn(file)));

// Every copy folder, newest use first: {name, dir, session, task, state, integrated, live, lastUsed}. A copy no
// journal names has no session or task (its session was deleted, or it was never journaled).
export function listCopies({root}) {
  const copyRoot = path.join(root, 'w'), sessions = path.join(root, 'sessions');
  let names = [];
  try { names = fs.readdirSync(copyRoot).filter(name => COPY.test(name)); } catch { return []; }
  const owners = new Map();
  let ids = [];
  try { ids = fs.readdirSync(sessions); } catch {}
  for (const id of ids) {
    let events;
    try { events = readJournal(path.join(sessions, id, 'journal.jsonl')).events; } catch { continue; }
    const view = taskView(events), live = running(path.join(sessions, id));
    const lastByTask = new Map();
    for (const e of events) if (e.task && e.time) lastByTask.set(e.task, e.time);
    for (const e of events) {
      if (e.kind !== 'task.workspace' || typeof e.cwd !== 'string' || path.dirname(e.cwd) !== copyRoot) continue;
      const state = view[e.task]?.state ?? 'unknown';
      owners.set(path.basename(e.cwd), {session: id, task: e.task, state, live: live && !TERMINAL.has(state),
        integrated: events.some(row => row.task === e.task && row.kind === 'task.integrated'), lastUsed: lastByTask.get(e.task) ?? e.time});
    }
  }
  return names.map(name => {
    const dir = path.join(copyRoot, name);
    let mtime = null;
    try { mtime = fs.statSync(dir).mtime.toISOString(); } catch {}
    const owner = owners.get(name);
    const lastUsed = [owner?.lastUsed, mtime].filter(Boolean).sort().at(-1) ?? null;
    return {name, dir, session: owner?.session ?? null, task: owner?.task ?? null, state: owner?.state ?? 'unknown',
      integrated: owner?.integrated ?? false, live: owner?.live ?? false, lastUsed};
  }).sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));
}

const short = id => (id ? id.slice(0, 8) : '—');
const work = copy => copy.live ? 'still running' : copy.integrated ? 'integrated' : copy.task ? `${copy.state}, not integrated` : 'no task found';
export function copyTable(copies) {
  if (!copies.length) return 'No worker copies.';
  const rows = copies.map((copy, i) => [`${i + 1}.`, copy.name, copy.lastUsed ? copy.lastUsed.slice(0, 16).replace('T', ' ') : '—', `session ${short(copy.session)}`, `task ${short(copy.task)}`, work(copy)]);
  const widths = rows[0].map((_, column) => Math.max(...rows.map(row => row[column].length)));
  return rows.map(row => row.map((cell, column) => column === row.length - 1 ? cell : cell.padEnd(widths[column])).join('  ')).join('\n');
}

// The user's answer to "remove which?": y / all, n / none, or numbers and ranges from the list ("1,3-5").
// Null when the answer is not one of those.
export function chooseCopies(answer, copies) {
  const text = String(answer ?? '').trim().toLowerCase();
  if (['y', 'yes', 'all', 's', 'si', 'sí'].includes(text)) return copies.filter(copy => !copy.live);
  if (['', 'n', 'no', 'none'].includes(text)) return [];
  const picked = new Set();
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return null;
    const from = Number(range[1]), to = Number(range[2] ?? range[1]);
    if (from < 1 || to > copies.length || from > to) return null;
    for (let i = from; i <= to; i++) picked.add(i - 1);
  }
  return [...picked].sort((a, b) => a - b).map(i => copies[i]).filter(copy => !copy.live);
}

// Removes the chosen copies; a copy whose task is still running is skipped, whatever was chosen.
export async function removeCopies(chosen) {
  const removed = [], failed = [];
  for (const copy of chosen) {
    if (copy.live) continue;
    try { await fs.promises.rm(copy.dir, {recursive: true, force: true}); removed.push(copy); }
    catch (error) { failed.push({copy, error: error.message}); }
  }
  return {removed, failed};
}
