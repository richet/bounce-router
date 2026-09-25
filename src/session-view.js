// Where the campaign is, derived from the log (docs/plans/orchestrator-memory.md). The orchestrator's own
// state note says what it decided and why; this says what happened. Found live: ten reviewer
// tasks in two hours, the same job failing the same way — invisible turn by turn, obvious here.
import {sameJob} from './loop-guard.js';
import {tasks as taskStates, TERMINAL} from './reducers.js';
import {campaigns, actionState} from './orchestration.js';
import {pendingMainActions} from './continuations.js';

export const STATE_MAX = 2000;   // its note: asked to shorten, never cut
export const VIEW_MAX = 4000;    // these facts: bounce's own, mechanically bounded
const DEAD_ENDS = new Set(['ceiling', 'no_progress', 'stuck', 'deadline', 'watchdog']);
const cut = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

// One row per job (an agent plus what it was asked for), with how its attempts ended.
export function sessionView(events, {now = Date.now()} = {}) {
  const plan = [...events].reverse().find(e => e.kind === 'plan.submitted') ?? null;
  const accepted = plan ? events.some(e => e.kind === 'plan.accepted' && (e.plan === plan.phase || e.plan === plan.plan)) : false;
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
  const current = [...events].reverse().find(e => e.kind === 'task.submitted' && (e.campaignId || e.gate || e.jobId));
  const actions = [...actionState(events).values()].filter(action => !['settled', 'cancelled'].includes(action.status));
  const pendingOutcomes = pendingMainActions(events);
  const health = Object.values(campaigns(events)).map(campaign => {
    const owned = Object.values(states).filter(task => task.campaignId === campaign.id);
    const active = owned.filter(task => !TERMINAL.has(task.state));
    const blockers = active.filter(task => ['blocked', 'input_required'].includes(task.state));
    const taskIds = new Set(owned.map(task => task.id));
    const progress = events.findLast(row => taskIds.has(row.task) && ['task.milestone', 'task.artifact', 'task.integrated', 'task.accepted'].includes(row.kind));
    const elapsed = progress ? now - Date.parse(progress.time) : null;
    const pending = actions.filter(action => taskIds.has(action.task));
    return {id: campaign.id, state: campaign.state, remaining: campaign.remaining,
      nextAction: campaign.state === 'completed' ? 'complete' : campaign.state === 'user-paused' ? 'await_user_resume'
        : campaign.state === 'needs-input' || blockers.length ? 'resolve_blocker' : active.length ? 'await_task_outcome' : 'continue_campaign',
      blocker: campaign.reason ?? blockers[0]?.blocker ?? null,
      owner: blockers[0]?.id ?? (active.length ? active[0].id : 'orchestrator'),
      sinceUsefulProgressMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
      pendingActions: pending.map(action => ({id: action.actionId, type: action.type, status: action.status})),
      pendingOutcomes: pendingOutcomes.filter(action => taskIds.has(action.task) || action.row.campaignId === campaign.id).length};
  });
  return {phase: plan ? {name: plan.phase ?? plan.plan ?? null, chunks: (plan.chunks ?? []).length, accepted} : null,
    campaign: current ? {id: current.campaignId ?? null, gate: current.gate ?? null, job: current.jobId ?? current.task} : null, campaigns: health, jobs, at: now};
}

export const formatSessionView = view => [
  view.phase ? `Campaign: phase ${view.phase.name ?? '(unnamed)'} · ${view.phase.chunks} chunks · ${view.phase.accepted ? 'plan accepted' : 'plan not accepted'}` : 'Campaign: no plan submitted yet',
  view.campaign ? `Current: campaign ${view.campaign.id ?? '(legacy)'} · gate ${view.campaign.gate ?? '(none)'} · job ${view.campaign.job}` : null,
  ...(view.campaigns ?? []).map(campaign => `Scope ${campaign.id}: ${campaign.state} · next ${campaign.nextAction} · remaining ${campaign.remaining.join(', ') || 'none'}${campaign.blocker ? ` · ${campaign.blocker}` : ''}`),
  ...view.jobs.map(job => `  ${job.profile} · ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}`
    + `${job.failed ? ` · ${job.failed} failed (${job.endings.join(', ')})` : ''}`
    + `${job.accepted ? ` · ${job.accepted} accepted` : ''}${job.live ? ` · ${job.live} running` : ''}`
    + `${job.repeating ? ' · REPEATING: change the scope or the AI' : ''}\n      asked: ${job.asked}`),
].filter(Boolean).join('\n').slice(0, VIEW_MAX);
