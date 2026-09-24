// Where the campaign is, derived from the log (docs/plans/orchestrator-memory.md). The orchestrator's own
// state note says what it decided and why; this says what happened. Found live: ten reviewer
// tasks in two hours, the same job failing the same way — invisible turn by turn, obvious here.
import {sameJob} from './loop-guard.js';

export const STATE_MAX = 2000;   // its note: asked to shorten, never cut
export const VIEW_MAX = 4000;    // these facts: bounce's own, mechanically bounded
const DEAD_ENDS = new Set(['ceiling', 'no_progress', 'stuck', 'deadline', 'watchdog']);
const cut = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

// One row per job (an agent plus what it was asked for), with how its attempts ended.
export function sessionView(events, {now = Date.now()} = {}) {
  const plan = [...events].reverse().find(e => e.kind === 'plan.submitted') ?? null;
  const accepted = plan ? events.some(e => e.kind === 'plan.accepted' && (e.plan === plan.phase || e.plan === plan.plan)) : false;
  const jobs = [];
  for (const row of events.filter(e => e.kind === 'task.submitted')) {
    const ending = events.find(e => e.task === row.task && ['task.deadline', 'task.completed', 'task.failed', 'task.cancelled', 'task.accepted'].includes(e.kind));
    const dead = ending && (ending.kind === 'task.deadline' || (ending.kind === 'task.cancelled' && DEAD_ENDS.has(ending.reason)) || ending.kind === 'task.failed');
    const job = jobs.find(candidate => sameJob(candidate, row)) ?? (jobs.push({profile: row.profile, orders: row.orders, asked: cut(row.orders, 120), attempts: 0, failed: 0, accepted: 0, live: 0, endings: []}), jobs.at(-1));
    job.attempts += 1;
    if (!ending) job.live += 1;
    else if (dead) { job.failed += 1; job.endings.push(ending.reason ?? 'deadline'); }
    else if (events.some(e => e.kind === 'task.accepted' && e.task === row.task)) job.accepted += 1;
  }
  for (const job of jobs) { job.repeating = job.failed >= 2 && new Set(job.endings).size === 1; delete job.orders; }
  return {phase: plan ? {name: plan.phase ?? plan.plan ?? null, chunks: (plan.chunks ?? []).length, accepted} : null, jobs, at: now};
}

export const formatSessionView = view => [
  view.phase ? `Campaign: phase ${view.phase.name ?? '(unnamed)'} · ${view.phase.chunks} chunks · ${view.phase.accepted ? 'plan accepted' : 'plan not accepted'}` : 'Campaign: no plan submitted yet',
  ...view.jobs.map(job => `  ${job.profile} · ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}`
    + `${job.failed ? ` · ${job.failed} failed (${job.endings.join(', ')})` : ''}`
    + `${job.accepted ? ` · ${job.accepted} accepted` : ''}${job.live ? ` · ${job.live} running` : ''}`
    + `${job.repeating ? ' · REPEATING: change the scope or the AI' : ''}\n      asked: ${job.asked}`),
].join('\n').slice(0, VIEW_MAX);
