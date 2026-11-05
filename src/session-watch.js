// `bounce watch <session>`: one call that returns when a session is done, needs its controller, or has gone quiet,
// read from the journal alone, so it works with any daemon and no socket. Nirby control session, 2026-11-04: control
// polled `bounce tasks --json` every minute and kept its own idle counter. Pure: events in, outcome out.
import {tasks as taskStates, TERMINAL} from './reducers.js';

export const WATCH_EXIT = {done: 0, attention: 2, stuck: 3, waiting: 4};
export const DEFAULT_IDLE_MS = 10 * 60000;

// A row needs the controller while what it says still holds: a blocked task the orchestrator already accepted is not.
const STILL = {'task.blocked': 'blocked', 'task.input_required': 'input_required', 'task.failed': 'failed'};
function needsAttention(row, states) {
  if (STILL[row.kind]) return states[row.task]?.state === STILL[row.kind];
  if (row.kind === 'main.blocked') return true;
  return row.kind === 'main.terminal' && row.status === 'failed';
}
const brief = row => ({seq: row.seq, time: row.time, kind: row.kind, ...(row.task ? {task: row.task} : {}),
  ...(row.reason ? {reason: row.reason} : {}), ...(row.text ? {text: row.text} : {}), ...(row.paths ? {paths: row.paths} : {})});

function finalTasks(events, states) {
  const integrated = new Set(events.filter(e => e.kind === 'task.integrated' && e.delivery !== 'branch').map(e => e.task));
  return Object.entries(states).filter(([, t]) => t.state).map(([task, t]) => {
    const blocked = t.state === 'blocked' ? events.findLast(e => e.kind === 'task.blocked' && e.task === task) : null;
    return {task, state: t.state, integrated: integrated.has(task), ...(blocked ? {reason: blocked.reason ?? null, text: blocked.text ?? null} : {})};
  });
}

// What a job delivered on branches (src/branch-delivery.js), and the orchestrator's last answer before `seq`.
function delivered(events) {
  return events.filter(e => e.kind === 'task.integrated' && e.delivery === 'branch')
    .map(e => ({task: e.task, branch: e.branch, head: e.head, tree: e.tree, copy: e.copy, ...(e.checkStale ? {checkStale: true} : {})}));
}
const answerBefore = (events, seq) => events.findLast(e => e.seq <= seq && e.kind === 'assistant' && !e.task && !e.narration)?.text ?? null;

// `--done` (Nirby control, 2026-11-05): only the end of the job counts. A detached run's job ends at its `run.ended` row
// (src/cli.js) unless a message was sent after it; an interactive session's when every task ended and its turn did.
// Quiet stretches and held tasks the orchestrator is handling are not reported; a job that ended with tasks
// waiting on the user is.
function watchDone(events, {after, live, run}) {
  const seq = events.at(-1)?.seq ?? 0;
  const states = taskStates(events);
  const end = events.findLast(e => e.kind === 'run.ended');
  const restarted = end && events.some(e => e.seq > end.seq && ['send.queued', 'main.started'].includes(e.kind));
  const finished = !live || (run ? Boolean(end) && !restarted && end.seq > after : null);
  if (finished === null) return null;
  if (!finished) return {outcome: 'waiting', seq};
  const waiting = (end?.waiting ?? []).filter(task => states[task]?.state === 'input_required');
  return {outcome: waiting.length ? 'attention' : 'done', seq, ...(end ? {status: end.status} : {}), answer: answerBefore(events, end?.seq ?? seq),
    delivered: delivered(events), tasks: finalTasks(events, states), ...(waiting.length ? {waiting} : {})};
}

// `after` is the seq a previous call stopped at: what it reported is not reported again. `live`: the session's daemon
// is running. `run`: it is a detached `bounce run`, whose daemon exits when the job ends; until then its orchestrator
// may be between turns with every task ended, so only the exit says it is done.
export function watchSession(events, {after = 0, live, run = false, done = false, now = Date.now(), idleMs = DEFAULT_IDLE_MS} = {}) {
  if (done) {
    const result = watchDone(events, {after, live, run});
    if (result) return result;
  }
  const last = events.at(-1);
  const seq = last?.seq ?? 0;
  const states = taskStates(events);
  if (!live) return {outcome: 'done', seq, tasks: finalTasks(events, states)};
  const rows = events.filter(e => e.seq > after && needsAttention(e, states));
  if (rows.length) return {outcome: 'attention', seq, rows: rows.map(brief)};
  const turn = events.findLast(e => ['main.started', 'main.terminal', 'main.blocked'].includes(e.kind));
  const all = Object.values(states).filter(t => t.state);
  if (!run && seq > after && turn?.kind === 'main.terminal' && all.length && all.every(t => TERMINAL.has(t.state))) {
    return {outcome: 'done', seq, tasks: finalTasks(events, states)};
  }
  // --done in an interactive session: the end above, or keep waiting; quiet and held work are not its business.
  if (done) return {outcome: 'waiting', seq};
  const quiet = last ? now - Date.parse(last.time) : 0;
  if (quiet >= idleMs) return {outcome: 'stuck', seq, idleMinutes: Math.floor(quiet / 60000), last: brief(last)};
  return {outcome: 'waiting', seq};
}

export function formatWatch(result, id) {
  const head = {done: `Session ${id} is done`, attention: `Session ${id} needs you`, stuck: `Session ${id} has been quiet for ${result.idleMinutes} min`,
    waiting: `Session ${id} is still running`}[result.outcome];
  const lines = [`${head} · resume with --after ${result.seq}`];
  for (const t of result.tasks ?? []) lines.push(`${t.task.slice(0, 8)} ${t.state}${t.integrated ? ' · in the checkout' : ''}${t.reason ? ` · ${t.reason}` : ''}${t.text ? `: ${t.text}` : ''}`);
  for (const row of result.rows ?? []) lines.push(`#${row.seq} ${row.kind}${row.task ? ` ${row.task.slice(0, 8)}` : ''}${row.reason ? ` · ${row.reason}` : ''}${row.text ? `: ${row.text}` : ''}`);
  for (const d of result.delivered ?? []) lines.push(`delivered ${d.task.slice(0, 8)} as branch ${d.branch} · head ${String(d.head).slice(0, 12)} · tree ${String(d.tree).slice(0, 12)} · git fetch ${d.copy} ${d.branch}${d.checkStale ? ' · NOT CHECKED AS DELIVERED' : ''}`);
  if (result.answer) lines.push('', result.answer);
  if (result.last) lines.push(`last row #${result.last.seq} ${result.last.kind} at ${result.last.time}`);
  return lines.join('\n');
}
