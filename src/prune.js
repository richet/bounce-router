// `bounce prune` and /prune: the workers' copies under ~/.bounce/w, listed with the session and task each belongs to,
// when it was last used and whether its work reached the checkout, then removed as the user chooses. Nothing removes
// a copy on its own (found live: a daemon starting after a reboot removed another session's copies, and a finished
// panel no task had integrated yet went with them). A copy whose task is still running in a live session is never
// removed.
import fs from 'node:fs';
import {execFile, execFileSync} from 'node:child_process';
import path from 'node:path';
import {pidAlive, readJournal} from './core.js';
import {reachedCheckout} from './branch-delivery.js';
import {tasks as taskView, TERMINAL} from './reducers.js';

const COPY = /^[0-9a-f]{8}$/;
const pidIn = file => { try { const text = fs.readFileSync(file, 'utf8').trim(); const pid = Number(text.startsWith('{') ? JSON.parse(text).pid : text); return Number.isSafeInteger(pid) ? pid : null; } catch { return null; } };
const running = dir => [path.join(dir, 'daemon.json'), path.join(dir, 'lock')].some(file => pidAlive(pidIn(file)));

// Every copy folder, newest use first: {name, dir, session, task, state, integrated, live, lastUsed}. A copy no
// journal names has no session or task (its session was deleted, or it was never journaled).
// A copy holding a delivered branch the checkout has not fetched yet (src/branch-delivery.js) is the only place that
// work exists, so it is never removed as ended. Returns the branch name, or null.
function unfetchedBranch(events, task, checkout) {
  const delivered = events.findLast(row => row.kind === 'task.integrated' && row.task === task && row.delivery === 'branch');
  if (!delivered) return null;
  return checkout && reachedCheckout({checkout, head: delivered.head}) ? null : delivered.branch;
}

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
    const checkout = events.find(e => e.kind === 'session')?.cwd ?? null;
    const lastByTask = new Map();
    for (const e of events) if (e.task && e.time) lastByTask.set(e.task, e.time);
    for (const e of events) {
      if (e.kind !== 'task.workspace' || typeof e.cwd !== 'string' || path.dirname(e.cwd) !== copyRoot) continue;
      const state = view[e.task]?.state ?? 'unknown';
      owners.set(path.basename(e.cwd), {session: id, task: e.task, state, live: live && !TERMINAL.has(state), sessionLive: live,
        integrated: events.some(row => row.task === e.task && row.kind === 'task.integrated'), unfetched: unfetchedBranch(events, e.task, checkout), checkout, lastUsed: lastByTask.get(e.task) ?? e.time});
    }
  }
  const copies = names.map(name => {
    const dir = path.join(copyRoot, name);
    let mtime = null;
    try { mtime = fs.statSync(dir).mtime.toISOString(); } catch {}
    const owner = owners.get(name);
    const lastUsed = [owner?.lastUsed, mtime].filter(Boolean).sort().at(-1) ?? null;
    return {name, dir, session: owner?.session ?? null, task: owner?.task ?? null, state: owner?.state ?? 'unknown',
      integrated: owner?.integrated ?? false, unfetched: owner?.unfetched ?? null, live: owner?.live ?? false, sessionLive: owner?.sessionLive ?? false,
      checkout: owner?.checkout ?? null, lastUsed};
  });
  markSuperseded(copies);
  return copies.map(({checkout, ...copy}) => copy).sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));
}

// kb control, 2026-11-05 (6363e2cd: 20 copies of one branch). A copy holds nothing of its own when it is clean and its
// commit is already in another copy of the same session (an ancestor of that copy's HEAD) or in the checkout:
// `superseded` names where ('the checkout', or the copy's name). Null otherwise, and for a copy whose task runs.
const gitQuiet = (cwd, ...args) => {
  try { return execFileSync('git', args, {cwd, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(); }
  catch { return null; }
};
function markSuperseded(copies) {
  // Only where it changes the answer: a copy a stopped session's ended task owns goes anyway, so git is asked only
  // about the copies of running sessions and of held (non-terminal) tasks, and their session's other copies.
  const matters = copy => copy.task && !copy.live && (copy.sessionLive || !TERMINAL.has(copy.state));
  const heads = new Map();
  const headOf = copy => { if (!heads.has(copy.name)) heads.set(copy.name, gitQuiet(copy.dir, 'rev-parse', '--verify', '-q', 'HEAD')); return heads.get(copy.name); };
  for (const copy of copies) {
    copy.superseded = null;
    if (!matters(copy)) continue;
    const own = {head: headOf(copy)};
    if (!own.head || gitQuiet(copy.dir, 'status', '--porcelain', '--untracked-files=all') !== '') continue;
    if (copy.checkout && reachedCheckout({checkout: copy.checkout, head: own.head})) { copy.superseded = 'the checkout'; continue; }
    const holder = copies.find(other => other !== copy && other.task && other.session === copy.session && headOf(other) && headOf(other) !== own.head
      && gitQuiet(other.dir, 'merge-base', '--is-ancestor', own.head, headOf(other)) !== null);
    if (holder) copy.superseded = holder.name;
  }
}

// `bounce prune --ended --older-than D`, without asking (Nirby control session, 2026-11-04: 241 copies, 215 GB, because
// prune only ran in a terminal): copies of sessions not running whose task ended, or that no journal names, unused for
// D. A running session's copies stay even when their task ended: a cancelled task can still be accepted from its copy.
export function endedCopies(copies, {now = Date.now(), olderThanMs}) {
  // A superseded copy (markSuperseded) goes from a running session too once its task ended, and from a stopped one even
  // when its task was held: what it holds is elsewhere.
  return copies.filter(copy => !copy.live && !copy.unfetched
    && ((!copy.sessionLive && (!copy.task || TERMINAL.has(copy.state))) || (copy.superseded && (TERMINAL.has(copy.state) || !copy.sessionLive)))
    && copy.lastUsed && now - Date.parse(copy.lastUsed) >= olderThanMs);
}
const AGE = {d: 86400000, h: 3600000, m: 60000};
export function parseAge(text) {
  const match = /^(\d+)([dhm])$/.exec(String(text ?? '').trim());
  return match ? Number(match[1]) * AGE[match[2]] : null;
}

const short = id => (id ? id.slice(0, 8) : '—');
const work = copy => copy.live ? 'still running' : copy.unfetched ? `branch ${copy.unfetched} not fetched yet` : copy.superseded ? `already in ${copy.superseded === 'the checkout' ? 'the checkout' : `copy ${copy.superseded}`}` : copy.integrated ? 'integrated' : copy.task ? `${copy.state}, not integrated` : 'no task found';
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
  if (['y', 'yes', 'all', 's', 'si', 'sí'].includes(text)) return copies.filter(copy => !copy.live && !copy.unfetched);
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

// `ace down --volumes --json` in a copy (ace item 11, 2026-11-05): its stack and the volumes it declared go with it.
// {ok, volumes} or {ok: false, error}.
export function aceDown(dir, {env = process.env, timeoutMs = 120000} = {}) {
  return new Promise(resolve => {
    execFile('ace', ['down', '--volumes', '--json'], {cwd: dir, env, timeout: timeoutMs, encoding: 'utf8'}, (error, stdout, stderr) => {
      if (error) return resolve({ok: false, error: String(stderr || error.message).trim().split('\n').at(-1).slice(0, 300)});
      let result = null;
      try { result = JSON.parse(String(stdout).trim().split('\n').at(-1)); } catch {}
      if (result?.ok === false) return resolve({ok: false, error: String(result.error?.message ?? result.error ?? 'ace down failed').slice(0, 300)});
      resolve({ok: true, volumes: result?.data?.deletedVolumes ?? []});
    });
  });
}

// Removes the chosen copies; a copy whose task is still running is skipped, whatever was chosen. A copy with an
// ace.yaml has its stack taken down with its volumes first; when that fails the copy is kept, since its folder is
// how its stack is found.
export async function removeCopies(chosen, {stackDown = aceDown} = {}) {
  const removed = [], failed = [];
  for (const copy of chosen) {
    if (copy.live) continue;
    let volumes = null;
    if (fs.existsSync(path.join(copy.dir, 'ace.yaml'))) {
      const down = await stackDown(copy.dir);
      if (!down.ok) { failed.push({copy, error: `its stack was not taken down (${down.error}); the copy is kept: run ace down --volumes there, then prune again`}); continue; }
      volumes = down.volumes;
    }
    try { await fs.promises.rm(copy.dir, {recursive: true, force: true}); removed.push(volumes ? {...copy, volumes} : copy); }
    catch (error) { failed.push({copy, error: error.message}); }
  }
  return {removed, failed};
}
