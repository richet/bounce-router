import {createHash} from 'node:crypto';
import {tasks, TERMINAL} from './reducers.js';
import {admittedPlanDispatches} from './plan-admission.js';
import {campaigns} from './orchestration.js';

export const OUTCOME_KINDS = new Set([
  'task.completed',
  'task.accepted',
  'task.failed',
  'task.cancelled',
  'task.deadline',
  'task.rejected',
  'task.blocked',
  'task.input_required',
]);
export const PLAN_DECISIONS = new Set(['plan.accepted', 'plan.rejected', 'plan.unavailable']);
const PARKED = new Set(['blocked', 'input_required']);
const SUCCESSFUL_TASK_OUTCOMES = new Set(['task.completed', 'task.accepted']);

const taskActionId = row => `outcome:${row.seq}`;
const planActionId = row => `plan:${row.seq}`;

function orchestratorsTask(events, view, taskId) {
  let id = taskId;
  const seen = new Set();
  while (view[id]?.replaces && view[view[id].replaces] && !seen.has(id)) {
    seen.add(id);
    id = view[id].replaces;
  }
  return events.find(row => row.kind === 'task.submitted' && row.task === id)?.from === 'orchestrator';
}

const replaced = (events, taskId) => events.some(row => row.kind === 'task.submitted' && row.replaces === taskId && row.task !== taskId);

function carriedByAncestor(view, taskId) {
  const seen = new Set();
  let parent = view[taskId]?.parent;
  while (parent && view[parent] && !seen.has(parent)) {
    if (!TERMINAL.has(view[parent].state)) return true;
    seen.add(parent);
    parent = view[parent].parent;
  }
  return false;
}

function legacyDispositions(events) {
  const completed = new Set(events.filter(row => row.kind === 'main.terminal' && row.status === 'completed').map(row => row.requestId));
  const disposed = new Set();
  for (const handoff of events) {
    if (handoff.kind !== 'handoff' || handoff.actionIds || !completed.has(handoff.requestId)) continue;
    for (const task of handoff.tasks ?? []) {
      const row = events.findLast(candidate => candidate.seq < handoff.seq && candidate.task === task && OUTCOME_KINDS.has(candidate.kind));
      if (row) disposed.add(taskActionId(row));
    }
  }
  return disposed;
}

export function disposedActionIds(events) {
  const disposed = legacyDispositions(events);
  for (const row of events) if (row.kind === 'main.disposition' && row.actionId) disposed.add(row.actionId);
  return disposed;
}

function taskActions(events) {
  const view = tasks(events);
  const campaignView = campaigns(events);
  const byTask = new Map();
  for (const row of events) {
    if (!OUTCOME_KINDS.has(row.kind)) continue;
    // What the orchestrator did itself is not news to hand back to it, and it settles the task's
    // earlier outcomes. Observed live (159f4746): its own override accept kept re-waking it with the
    // same task every turn. (A user's action still is news to the orchestrator.)
    if (row.from === 'orchestrator') { byTask.delete(row.task); continue; }
    const task = view[row.task];
    const campaign = task?.campaignId ? campaignView[task.campaignId] : null;
    if (!task || carriedByAncestor(view, row.task) || !(TERMINAL.has(task.state) || PARKED.has(task.state))
      || ['needs-input', 'user-paused'].includes(campaign?.state)
      || replaced(events, row.task) || !orchestratorsTask(events, view, row.task)) continue;
    byTask.set(row.task, row);
  }
  return [...byTask.values()].filter(row => !events.some(disposition => disposition.kind === 'main.disposition'
    && disposition.task === row.task && (disposition.outcomeSeq >= row.seq || ['orchestrator', 'user'].includes(row.from))))
    .map(row => ({
    actionId: taskActionId(row),
    outcomeSeq: row.seq,
    kind: row.kind,
    task: row.task,
    row,
  }));
}

function namedWait(row) {
  if (row.kind !== 'state' || row.from !== 'orchestrator') return false;
  if (typeof row.waitingFor === 'string' && row.waitingFor.trim()) return true;
  return typeof row.text === 'string' && /\bwait(?:ing)?\s+(?:for|on)\s+\S+/i.test(row.text);
}

// A completed provider turn is transport success, not proof that an outcome was acted on.
// The narrow compatibility exception is a successful task outside a campaign: reporting that
// result to the user was the historical one-task flow. Failures and campaign work require a
// durable successor, named wait, scope closure, or blocker written by this consuming turn.
export function taskDispositionEvidence(events, action, {afterSeq = 0} = {}) {
  if (!action?.task) return null;
  const submitted = events.find(row => row.kind === 'task.submitted' && row.task === action.task);
  if (!submitted) return null;
  if (SUCCESSFUL_TASK_OUTCOMES.has(action.kind) && !submitted.campaignId) return {disposition: 'reported'};
  const durableLater = events.filter(row => (row.seq ?? 0) > (action.outcomeSeq ?? 0));
  const turnLater = durableLater.filter(row => (row.seq ?? 0) > afterSeq);
  const successor = durableLater.find(row => row.kind === 'task.submitted' && row.task !== action.task && (
    row.retryOf === action.task || row.replaces === action.task
    || (submitted.jobId && row.jobId === submitted.jobId)
    || (submitted.campaignId && row.campaignId === submitted.campaignId)));
  if (successor) return {disposition: 'scheduled', successor: successor.task};
  if (turnLater.some(namedWait)) return {disposition: 'waiting'};
  if (submitted.campaignId) {
    const transition = durableLater.find(row => row.campaignId === submitted.campaignId
      && ['campaign.completed', 'campaign.blocked'].includes(row.kind));
    if (transition) return {disposition: transition.kind === 'campaign.completed' ? 'closed' : 'blocked'};
    const scope = durableLater.findLast(row => row.campaignId === submitted.campaignId && row.kind === 'campaign.scope_changed');
    const campaign = campaigns(events)[submitted.campaignId];
    if (scope && campaign && campaign.remaining.length === 0) return {disposition: 'closed'};
  }
  const blocker = turnLater.find(row => row.kind === 'main.blocked'
    || (row.kind === 'task.blocked' && row.task === action.task));
  return blocker ? {disposition: 'blocked'} : null;
}

function planActions(events) {
  const campaignView = campaigns(events);
  const latest = new Map();
  for (const row of events) {
    if (!PLAN_DECISIONS.has(row.kind)) continue;
    latest.set(row.planId ?? row.plan ?? `seq:${row.seq}`, row);
  }
  return [...latest.values()].filter(row => !['needs-input', 'user-paused'].includes(campaignView[row.campaignId]?.state)).map(row => ({
    actionId: planActionId(row),
    outcomeSeq: row.seq,
    kind: row.kind,
    planId: row.planId ?? row.plan,
    phase: row.phase,
    expectedChunks: Number.isInteger(row.chunks) ? row.chunks : Array.isArray(row.chunks) ? row.chunks.length : null,
    row,
  }));
}

function campaignActions(continuationState) {
  const projected = continuationState?.() ?? [];
  const pending = Array.isArray(projected) ? projected : projected.pending ?? [];
  return pending.map((row, index) => ({
    actionId: row.actionId ?? `campaign:${row.campaignId}:${row.seq ?? row.revision ?? index}`,
    outcomeSeq: row.seq ?? null,
    kind: row.kind ?? 'campaign.pending',
    campaignId: row.campaignId,
    row,
  }));
}

export function pendingMainActions(events, {continuationState} = {}) {
  const disposed = disposedActionIds(events);
  return [...taskActions(events), ...planActions(events), ...campaignActions(continuationState)]
    .filter(action => !disposed.has(action.actionId));
}

export function actionSetKey(actions) {
  const ids = actions.map(action => action.actionId).sort().join('\n');
  return createHash('sha256').update(ids).digest('hex').slice(0, 24);
}

export function wakeAttempts(events, key) {
  return events.filter(row => row.kind === 'main.requested' && row.wake && row.actionKey === key).length;
}

export function blockedActionSet(events, key) {
  return events.some(row => row.kind === 'main.blocked' && row.actionKey === key
    && ['wake_retry_exhausted', 'plan_undispatched', 'campaign_blocked'].includes(row.reason));
}

export function planDispatches(events, action) {
  if (action.kind !== 'plan.accepted') return [];
  const decision = action.row;
  const linked = admittedPlanDispatches(events, action.planId).filter(row => row.seq > decision.seq);
  if (linked.length) return linked;
  // Old journals did not persist plan correlation. Retain their one-plan/one-dispatch behavior only
  // when the decision itself also lacks the new planId field.
  if (!decision.planId) return events.filter(row => row.kind === 'task.submitted' && row.seq > decision.seq && row.from === 'orchestrator');
  return [];
}

export function acceptedPlanSatisfied(events, action) {
  if (action.kind !== 'plan.accepted') return false;
  if (action.expectedChunks === 0) return true;
  const dispatches = planDispatches(events, action);
  if (action.expectedChunks === null) return dispatches.length > 0;
  const chunks = new Set(dispatches.map(row => row.chunkId ?? row.task));
  return chunks.size >= action.expectedChunks;
}
