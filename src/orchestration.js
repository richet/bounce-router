const ACTION = 'orchestration.action.';

export function actionState(events) {
  const actions = new Map();
  for (const row of events) {
    if (!row.kind?.startsWith(ACTION) || !row.actionId) continue;
    if (row.kind === `${ACTION}requested`) {
      if (!actions.has(row.actionId)) actions.set(row.actionId, {...row, status: 'requested'});
    } else if (actions.has(row.actionId)) {
      actions.set(row.actionId, {...actions.get(row.actionId), ...row, status: row.kind.slice(ACTION.length)});
    }
  }
  return actions;
}

export function requestAction(session, {actionId, type, task, payload = {}, cause}, events = []) {
  const previous = actionState(session.events).get(actionId);
  if (previous) return previous;
  const intent = {kind: `${ACTION}requested`, actionId, type, task, payload, cause, from: 'bounce'};
  session.commit([...events, intent], {ref: `action:${actionId}`});
  return actionState(session.events).get(actionId);
}

// Exactly one in-process owner per action. An interrupted external effect requires a
// reconciliation decision; replay never assumes that a missing handle means no process ran.
// `gate`: an action stuck at 'requested' whose gate refuses stays there — never started, never
// counted against `reconcile`'s retry budget — until a later call to the runner's own
// `reconcile()` finds the gate open. This is a caller-level hold (an in-place task's
// integration lock), distinct from `reconcile`, which is crash recovery for an action already
// 'started' or 'blocked'.
export function createActionRunner({session, handlers, reconcile = () => 'blocked', gate = () => true}) {
  let closed = false;
  const running = new Map();
  function settle(action, status, fields = {}) {
    session.append({kind: `${ACTION}${status}`, actionId: action.actionId, type: action.type,
      task: action.task, ...fields, from: 'bounce'});
  }
  function execute(action) {
    if (closed || running.has(action.actionId) || !handlers[action.type]) return;
    if (action.status === 'requested' && !gate(action)) return;
    if (action.status === 'started' || action.status === 'blocked') {
      const decision = reconcile(action);
      if (decision === 'settled') return settle(action, 'settled', {recovered: true});
      if (decision !== 'retry') return action.status === 'blocked' ? undefined : settle(action, 'blocked', {reason: 'execution_uncertain', text: 'Reconcile the previous execution before retrying this action'});
    }
    if (!['requested', 'started', 'blocked'].includes(action.status)) return;
    // Reserve ownership before invoking the handler: admission runs synchronously up to
    // its first external await, so callers cannot observe unreserved submitted work.
    running.set(action.actionId, null);
    const promise = (async () => {
      if (closed) return;
      settle(action, 'started');
      try {
        await handlers[action.type](action);
        if (!closed) settle(action, 'settled');
      } catch (error) {
        if (!closed) settle(action, 'blocked', {reason: 'action_failed', text: error.message});
      }
    })().finally(() => running.delete(action.actionId));
    running.set(action.actionId, promise);
  }
  const unsubscribe = session.subscribe(row => {
    if (row.kind === `${ACTION}requested`) execute(actionState(session.events).get(row.actionId));
  });
  return {
    reconcile() { for (const action of actionState(session.events).values()) execute(action); },
    pending() { return [...actionState(session.events).values()].filter(action => !['settled', 'cancelled'].includes(action.status)); },
    close() { closed = true; unsubscribe(); },
  };
}
