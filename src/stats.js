// Analytics (docs/plans/analytics.md, Daniel, 2026-10-01): what a session cost and what it got, folded from
// the journal alone. Every figure names what it counts, over which span, in which unit; a figure that cannot
// be known from the journal says so instead of guessing. The numbers that drove this week's decisions came
// from scratch scripts over the same rows; this is those scripts, kept.
import {tasks as taskStates, TERMINAL} from './reducers.js';

const T = e => Date.parse(e.time);
const minutes = ms => Math.round(ms / 60000);
const median = values => { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2; };
const NOISE = new Set(['task.usage', 'usage', 'raw', 'delta', 'model', 'checkpoint', 'main.wake.scheduled', 'tool', 'wait.served']);
export const QUIET_GAP_MS = 20 * 60000;

// The AI that played a task: the local model it was given, else the profile name.
function aiOf(events, task, profile) {
  const local = events.find(e => e.kind === 'task.local_selected' && e.task === task);
  const model = local?.selection?.model ?? local?.selection?.modelID ?? null;
  return model ? `local:${model}` : profile ?? 'unknown';
}

export function sessionStats(events, {now = Date.now()} = {}) {
  const rows = events.filter(e => typeof e.time === 'string' && Number.isFinite(T(e)));
  const start = rows.length ? T(rows[0]) : null;
  const end = rows.length ? T(rows.at(-1)) : null;
  const submitted = new Map(rows.filter(e => e.kind === 'task.submitted').map(e => [e.task, e]));
  const view = taskStates(events);
  const outcomeOf = task => {
    const state = view[task]?.state;
    return state === 'accepted' ? 'accepted' : state === 'blocked' ? 'held' : ['failed', 'cancelled', 'timed_out', 'rejected'].includes(state) ? 'failed' : TERMINAL.has(state) ? 'ended' : 'open';
  };
  const byAgent = {};
  const bump = (agent, key) => { byAgent[agent] ??= {submitted: 0, accepted: 0, held: 0, failed: 0, open: 0}; byAgent[agent][key] += 1; };
  for (const [task, row] of submitted) { bump(row.profile, 'submitted'); const o = outcomeOf(task); if (o in {accepted: 1, held: 1, failed: 1, open: 1}) bump(row.profile, o); }
  const reworkedTasks = new Set(rows.filter(e => e.kind === 'task.rework').map(e => e.task));
  // A correction: a task that redoes work bounce had already accepted (retryOf on an accepted task).
  const corrections = [...submitted.values()].filter(row => row.retryOf && rows.some(e => e.kind === 'task.accepted' && e.task === row.retryOf && e.seq < row.seq));
  const corrected = new Set(corrections.map(row => row.retryOf));
  const accepted = [...submitted.keys()].filter(task => outcomeOf(task) === 'accepted');
  const firstAttempt = accepted.filter(task => !reworkedTasks.has(task) && !corrected.has(task));

  // Worker attempts: started → attempt.ended, per task in order.
  const open = new Map(), attempts = [];
  for (const e of rows) {
    if (e.kind === 'task.started') open.set(e.task, T(e));
    if (e.kind === 'task.attempt.ended' && open.has(e.task)) { attempts.push({task: e.task, ai: aiOf(events, e.task, submitted.get(e.task)?.profile), ms: T(e) - open.get(e.task), end: T(e), start: open.get(e.task)}); open.delete(e.task); }
  }
  const workerByAI = {};
  for (const a of attempts) { const w = workerByAI[a.ai] ??= {attempts: 0, totalMs: 0, durations: []}; w.attempts += 1; w.totalMs += a.ms; w.durations.push(a.ms); }
  for (const w of Object.values(workerByAI)) { w.medianMs = median(w.durations); delete w.durations; }
  // Orchestrator turns.
  let turnStart = null; const turns = [];
  for (const e of rows) {
    if (e.kind === 'main.started') turnStart = T(e);
    if (e.kind === 'main.terminal' && turnStart !== null) { turns.push({ms: T(e) - turnStart, start: turnStart, end: T(e)}); turnStart = null; }
  }
  // Busy: any worker attempt or orchestrator turn in flight; quiet gaps: no row of anyone's for 20 min.
  const spans = [...attempts.map(a => [a.start, a.end]), ...turns.map(t => [t.start, t.end])].sort((a, b) => a[0] - b[0]);
  let busy = 0, cursor = start ?? 0;
  for (const [a, b] of spans) { const from = Math.max(a, cursor); if (b > from) { busy += b - from; cursor = b; } }
  const quietGaps = [];
  const live = rows.filter(e => !NOISE.has(e.kind));
  for (let i = 1; i < live.length; i += 1) { const gap = T(live[i]) - T(live[i - 1]); if (gap > QUIET_GAP_MS) quietGaps.push({from: live[i - 1].time, to: live[i].time, minutes: minutes(gap)}); }

  // Tokens from usage rows, by the AI that spent them; the orchestrator's own usage under 'orchestrator'.
  const tokensByAI = {};
  const add = (ai, usage = {}) => { const t = tokensByAI[ai] ??= {input: 0, output: 0, cacheRead: 0, reasoning: 0}; t.input += usage.input ?? 0; t.output += usage.output ?? 0; t.cacheRead += usage.cache_read ?? 0; t.reasoning += usage.reasoning ?? 0; };
  for (const e of rows) {
    if (e.kind === 'task.usage' && e.usage) add(aiOf(events, e.task, submitted.get(e.task)?.profile), e.usage);
    if (e.kind === 'usage' && e.usage) add('orchestrator', e.usage);
  }
  const totalOutput = Object.values(tokensByAI).reduce((sum, t) => sum + t.output, 0);
  const totalInput = Object.values(tokensByAI).reduce((sum, t) => sum + t.input + t.cacheRead, 0);

  // Checks and reviews.
  const checkRows = rows.filter(e => e.kind === 'task.check' && typeof e.passed === 'boolean');
  const checks = {run: checkRows.length, passed: checkRows.filter(e => e.passed).length, failed: checkRows.filter(e => !e.passed).length, weak: checkRows.filter(e => e.weak).length, unrunnable: checkRows.filter(e => e.unrunnable).length, sendBacks: rows.filter(e => e.kind === 'task.rework').length};
  const verdicts = {accept: 0, rework: 0, unavailable: 0, unreadable: 0, other: 0}; let belowBar = 0;
  for (const e of rows.filter(e => e.kind === 'review.finished')) {
    let v = null; try { v = JSON.parse(e.text); } catch { v = null; }
    const kind = v?.verdict ?? 'unreadable';
    verdicts[kind in verdicts ? kind : 'other'] += 1;
    if (kind === 'unavailable' && v?.choice) belowBar += 1;
  }
  const refusedForLength = rows.filter(e => e.kind === 'task.diagnostic' && /max_tokens_exceeded|exceeds the available context/.test(String(e.text))).length;

  // Standing workers, lessons, sweeps.
  const launches = rows.filter(e => e.kind === 'task.launch.requested');
  const workers = {fresh: launches.filter(e => !e.continued).length, continued: launches.filter(e => e.continued === true).length, retired: rows.filter(e => e.kind === 'worker.retired').length, compacted: rows.filter(e => e.kind === 'worker.compacted').length};
  const lessons = rows.filter(e => e.kind === 'lesson.learned').length;
  const sweepRows = rows.filter(e => e.kind === 'main.requested' && e.sweep);
  const sweeps = {fired: sweepRows.length, withHeld: sweepRows.filter(e => rows.some(h => h.kind === 'handoff' && h.sweep && h.requestId === e.requestId && (h.tasks ?? []).length)).length};

  return {
    span: {start: rows[0]?.time ?? null, end: rows.at(-1)?.time ?? null, hours: start !== null ? Math.round((end - start) / 360000) / 10 : null},
    outcome: {submitted: submitted.size, accepted: accepted.length, held: [...submitted.keys()].filter(t => outcomeOf(t) === 'held').length, failed: [...submitted.keys()].filter(t => outcomeOf(t) === 'failed').length, open: [...submitted.keys()].filter(t => outcomeOf(t) === 'open').length, firstAttempt: firstAttempt.length, corrections: corrections.length, byAgent},
    time: {workerByAI, orchestrator: {turns: turns.length, totalMs: turns.reduce((s, t) => s + t.ms, 0), medianMs: median(turns.map(t => t.ms))}, busyMs: busy, quietGaps},
    tokens: {byAI: tokensByAI, totalInput, totalOutput, perAcceptedTask: accepted.length ? Math.round((totalInput + totalOutput) / accepted.length) : null},
    checks, reviews: {verdicts, belowBar, refusedForLength},
    workers, lessons, sweeps,
  };
}

const n = v => (v === null || v === undefined ? 'unmeasured' : typeof v === 'number' && Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : typeof v === 'number' && Math.abs(v) >= 1e4 ? `${Math.round(v / 1e3)}k` : String(v));
const min = ms => (ms === null || ms === undefined ? 'unmeasured' : `${(ms / 60000).toFixed(1)} min`);

// Plain lines, one section each; every number says what it is.
export function formatStats(s, {title = 'Session'} = {}) {
  const stamp = iso => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');
  const lines = [`${title} · ${stamp(s.span.start)} → ${stamp(s.span.end)} UTC · ${n(s.span.hours)} h from first row to last (a session resumed over days counts the gaps)`];
  lines.push(`Outcome: ${s.outcome.submitted} tasks submitted · ${s.outcome.accepted} accepted (${s.outcome.firstAttempt} at the first attempt) · ${s.outcome.held} held · ${s.outcome.failed} failed${s.outcome.open ? ` · ${s.outcome.open} still open` : ''} · ${s.outcome.corrections} corrections of accepted work`);
  for (const [agent, c] of Object.entries(s.outcome.byAgent)) lines.push(`  ${agent}: ${c.submitted} submitted, ${c.accepted} accepted, ${c.held} held, ${c.failed} failed`);
  lines.push(`Time: busy ${min(s.time.busyMs)} of ${n(s.span.hours)} h (someone running) · orchestrator ${s.time.orchestrator.turns} turns, ${min(s.time.orchestrator.totalMs)} in all, median ${min(s.time.orchestrator.medianMs)} · ${s.time.quietGaps.length} quiet gap${s.time.quietGaps.length === 1 ? '' : 's'} over 20 min`);
  for (const [ai, w] of Object.entries(s.time.workerByAI)) lines.push(`  ${ai}: ${w.attempts} attempts, ${min(w.totalMs)} in all, median ${min(w.medianMs)}`);
  lines.push(`Tokens: ${n(s.tokens.totalInput)} in (cache reads included) · ${n(s.tokens.totalOutput)} out · ${s.tokens.perAcceptedTask === null ? 'no accepted task' : `${n(s.tokens.perAcceptedTask)} per accepted task`}`);
  for (const [ai, t] of Object.entries(s.tokens.byAI)) lines.push(`  ${ai}: ${n(t.input + t.cacheRead)} in · ${n(t.output)} out${t.reasoning ? ` · ${n(t.reasoning)} thinking` : ''}`);
  lines.push(`Checks: ${s.checks.run} run · ${s.checks.passed} passed · ${s.checks.failed} failed · ${s.checks.weak} only looked · ${s.checks.unrunnable} could not run · ${s.checks.sendBacks} send-backs`);
  const v = s.reviews.verdicts;
  lines.push(`Reviews: ${v.accept} accept · ${v.rework} send back · ${v.unavailable} below the bar · ${v.unreadable + v.other} unreadable · ${s.reviews.refusedForLength} refused for length`);
  lines.push(`Workers: ${s.workers.fresh} fresh launches · ${s.workers.continued} continuations · ${s.workers.retired} retired · ${s.workers.compacted} compacted`);
  lines.push(`Lessons recorded: ${s.lessons} · Sweeps: ${s.sweeps.fired} fired, ${s.sweeps.withHeld} with held work`);
  lines.push('Not in the journal, so not here: thinking tokens of Claude and Codex workers (OpenCode reports them, the others do not); money (no price table).');
  return lines;
}

// Two sessions side by side: the second's figure, and the change against the first, per line.
export function compareStats(a, b) {
  const delta = (x, y, unit = '') => (x === null || y === null || x === undefined || y === undefined) ? 'unmeasured' : `${n(y)}${unit} (${y - x >= 0 ? '+' : ''}${n(y - x)}${unit} vs ${n(x)}${unit})`;
  return [
    `Against: ${a.span.start?.slice(0, 10) ?? '?'} → ${b.span.start?.slice(0, 10) ?? '?'}`,
    `Accepted of submitted: ${b.outcome.accepted}/${b.outcome.submitted} vs ${a.outcome.accepted}/${a.outcome.submitted}`,
    `First-attempt acceptance: ${delta(a.outcome.firstAttempt, b.outcome.firstAttempt)}`,
    `Corrections of accepted work: ${delta(a.outcome.corrections, b.outcome.corrections)}`,
    `Busy minutes: ${delta(minutes(a.time.busyMs), minutes(b.time.busyMs), ' min')}`,
    `Orchestrator turns: ${delta(a.time.orchestrator.turns, b.time.orchestrator.turns)}`,
    `Tokens out: ${delta(a.tokens.totalOutput, b.tokens.totalOutput)} · in: ${delta(a.tokens.totalInput, b.tokens.totalInput)}`,
    `Checks failed: ${delta(a.checks.failed, b.checks.failed)} · send-backs: ${delta(a.checks.sendBacks, b.checks.sendBacks)}`,
    `Quiet gaps over 20 min: ${delta(a.time.quietGaps.length, b.time.quietGaps.length)}`,
    `Continuations: ${delta(a.workers.continued, b.workers.continued)} · lessons: ${delta(a.lessons, b.lessons)}`,
  ];
}

// One line per task: agent, AI, attempts, minutes, tokens, checks, outcome, and what ate the time.
export function taskLines(events) {
  const rows = events.filter(e => typeof e.time === 'string');
  const submitted = rows.filter(e => e.kind === 'task.submitted');
  const view = taskStates(events);
  return submitted.map(row => {
    const task = row.task;
    const starts = rows.filter(e => e.kind === 'task.started' && e.task === task);
    const ends = rows.filter(e => e.kind === 'task.attempt.ended' && e.task === task);
    let ms = 0; for (let i = 0; i < Math.min(starts.length, ends.length); i += 1) ms += T(ends[i]) - T(starts[i]);
    const usage = rows.filter(e => e.kind === 'task.usage' && e.task === task).reduce((s, e) => s + (e.usage?.input ?? 0) + (e.usage?.cache_read ?? 0) + (e.usage?.output ?? 0), 0);
    const checks = rows.filter(e => e.kind === 'task.check' && e.task === task && typeof e.passed === 'boolean');
    const held = rows.findLast(e => e.kind === 'task.blocked' && e.task === task);
    const heldMs = held ? (rows.find(e => e.seq > held.seq && e.task === task && ['task.accepted', 'task.started', 'task.failed', 'task.cancelled'].includes(e.kind))?.time ? T(rows.find(e => e.seq > held.seq && e.task === task && ['task.accepted', 'task.started', 'task.failed', 'task.cancelled'].includes(e.kind))) - T(held) : null) : null;
    const ate = [];
    if (starts.length > 1) ate.push(`${starts.length} attempts`);
    if (heldMs !== null && heldMs > 10 * 60000) ate.push(`held ${minutes(heldMs)} min before a decision`);
    if (rows.some(e => e.kind === 'task.deadline' && e.task === task)) ate.push('ran to its ceiling');
    if (checks.filter(e => !e.passed).length >= 2) ate.push('check failed twice');
    return `${task.slice(0, 8)} · ${row.profile} · ${aiOf(events, task, row.profile)} · ${starts.length} attempt${starts.length === 1 ? '' : 's'} · ${(ms / 60000).toFixed(1)} min · ${n(usage)} tokens · checks ${checks.map(e => (e.passed ? 'pass' : 'fail')).join('/') || 'none'} · ${view[task]?.state ?? '?'}${ate.length ? ` · ${ate.join(', ')}` : ''}`;
  });
}
