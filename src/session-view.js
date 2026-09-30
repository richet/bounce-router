// Where the work is, derived from the log (docs/plans/orchestrator-memory.md). The orchestrator's own
// state note says what it decided and why; this says what happened. Found live: ten reviewer
// tasks in two hours, the same job failing the same way — invisible turn by turn, obvious here.
import {sameJob} from './loop-guard.js';
import {tasks as taskStates} from './reducers.js';

export const STATE_MAX = 2000;   // its note: asked to shorten, never cut
export const VIEW_MAX = 4000;    // these facts: bounce's own, mechanically bounded
const DEAD_ENDS = new Set(['ceiling', 'no_progress', 'stuck', 'deadline', 'watchdog']);
const cut = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

// One row per job (an agent plus what it was asked for), with how its attempts ended.
export function sessionView(events, {now = Date.now()} = {}) {
  const jobs = [];
  const states = taskStates(events);
  for (const row of events.filter(e => e.kind === 'task.submitted')) {
    const ending = [...events].reverse().find(e => e.task === row.task && ['task.deadline', 'task.completed', 'task.failed', 'task.cancelled', 'task.accepted', 'task.rejected', 'task.blocked'].includes(e.kind));
    const dead = ending && (ending.kind === 'task.deadline' || (ending.kind === 'task.cancelled' && DEAD_ENDS.has(ending.reason)) || ending.kind === 'task.failed');
    const job = jobs.find(candidate => row.jobId ? candidate.jobId === row.jobId : sameJob(candidate, row)) ?? (jobs.push({jobId: row.jobId ?? null, profile: row.profile, orders: row.orders, asked: cut(row.orders, 120), attempts: 0, failed: 0, accepted: 0, live: 0, endings: [], outcome: null}), jobs.at(-1));
    job.attempts += 1;
    if (!ending) job.live += 1;
    else if (dead) { job.failed += 1; job.endings.push(ending.reason ?? 'deadline'); }
    else if (states[row.task]?.state === 'accepted') job.accepted += 1;
    job.outcome = states[row.task]?.state ?? job.outcome;
  }
  for (const job of jobs) { job.repeating = job.failed >= 2 && new Set(job.endings).size === 1; delete job.orders; }
  const current = [...events].reverse().find(e => e.kind === 'task.submitted' && e.jobId);
  return {current: current ? {job: current.jobId ?? current.task} : null, jobs, at: now};
}

export const formatSessionView = view => [
  view.current ? `Current: job ${view.current.job}` : null,
  ...view.jobs.map(job => `  ${job.profile} · ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}`
    + `${job.failed ? ` · ${job.failed} failed (${job.endings.join(', ')})` : ''}`
    + `${job.accepted ? ` · ${job.accepted} accepted` : ''}${job.live ? ` · ${job.live} running` : ''}`
    + `${job.repeating ? ' · REPEATING: change the scope or the AI' : ''}\n      asked: ${job.asked}`),
].filter(Boolean).join('\n').slice(0, VIEW_MAX);
