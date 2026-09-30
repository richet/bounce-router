import {createHash} from 'node:crypto';
import {tasks, TERMINAL} from './reducers.js';

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
const PARKED = new Set(['blocked', 'input_required']);
const SUCCESSFUL_TASK_OUTCOMES = new Set(['task.completed', 'task.accepted']);

const taskActionId = row => `outcome:${row.seq}`;

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
  const byTask = new Map();
  for (const row of events) {
    if (!OUTCOME_KINDS.has(row.kind)) continue;
    // What the orchestrator did itself is not news to hand back to it, and it settles the task's
    // earlier outcomes. Observed live (159f4746): its own override accept kept re-waking it with the
    // same task every turn. (A user's action still is news to the orchestrator.)
    if (row.from === 'orchestrator') { byTask.delete(row.task); continue; }
    const task = view[row.task];
    if (!task || carriedByAncestor(view, row.task) || !(TERMINAL.has(task.state) || PARKED.has(task.state))
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

// reload.js's own documented convention: an answer that ends the turn by asking the user for
// one prompt closes with a `Next: <prompt>` line. That is a question, not a dropped outcome.
const NEXT_LINE = /(^|\n)\s*Next:\s*\S/;
const closesWithNext = text => typeof text === 'string' && NEXT_LINE.test(text);

// A completed provider turn is transport success, not proof that an outcome was acted on.
// A successful task is settled by reporting it. A failure or a parked task needs a durable
// successor, a named wait, a `Next:` question, or a blocker written by this consuming turn.
export function taskDispositionEvidence(events, action, {afterSeq = 0, closingText = null} = {}) {
  if (!action?.task) return null;
  const submitted = events.find(row => row.kind === 'task.submitted' && row.task === action.task);
  if (!submitted) return null;
  if (SUCCESSFUL_TASK_OUTCOMES.has(action.kind)) return {disposition: 'reported'};
  const durableLater = events.filter(row => (row.seq ?? 0) > (action.outcomeSeq ?? 0));
  const turnLater = durableLater.filter(row => (row.seq ?? 0) > afterSeq);
  const successor = durableLater.find(row => row.kind === 'task.submitted' && row.task !== action.task && (
    row.retryOf === action.task || row.replaces === action.task
    || (submitted.jobId && row.jobId === submitted.jobId)));
  if (successor) return {disposition: 'scheduled', successor: successor.task};
  if (turnLater.some(namedWait) || closesWithNext(closingText)) return {disposition: 'waiting'};
  const blocker = turnLater.find(row => row.kind === 'main.blocked'
    || (row.kind === 'task.blocked' && row.task === action.task));
  return blocker ? {disposition: 'blocked'} : null;
}

export function pendingMainActions(events) {
  const disposed = disposedActionIds(events);
  return taskActions(events).filter(action => !disposed.has(action.actionId));
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
