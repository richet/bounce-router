import {randomUUID} from 'node:crypto';
import {tasks, TERMINAL} from './reducers.js';

export const ORCHESTRATION_VERSION = 2;
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
export function createActionRunner({session, handlers, reconcile = () => 'blocked'}) {
  let closed = false;
  const running = new Map();
  function settle(action, status, fields = {}) {
    session.append({kind: `${ACTION}${status}`, actionId: action.actionId, type: action.type,
      task: action.task, ...fields, from: 'bounce'});
  }
  function execute(action) {
    if (closed || running.has(action.actionId) || !handlers[action.type]) return;
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

export function campaigns(events) {
  const result = {};
  for (const row of events) {
    if (row.kind === 'campaign.started' && !result[row.campaignId]) result[row.campaignId] = {
      id: row.campaignId, objective: row.objective, required: [...row.required], state: 'active', revision: 1, reason: null,
    };
    const campaign = result[row.campaignId];
    if (!campaign) continue;
    if (row.kind === 'campaign.extended') {
      campaign.required = [...new Set([...campaign.required, ...row.required])]; campaign.revision++;
    }
    if (row.kind === 'campaign.scope_changed') { campaign.required = [...row.required]; campaign.revision++; }
    if (row.kind === 'campaign.blocked') { campaign.state = 'needs-input'; campaign.reason = row.reason; }
    if (row.kind === 'campaign.paused') campaign.state = 'user-paused';
    if (row.kind === 'campaign.resumed') { campaign.state = 'active'; campaign.reason = null; }
    if (row.kind === 'campaign.completed') campaign.state = 'completed';
  }
  const view = tasks(events);
  for (const campaign of Object.values(result)) {
    campaign.obligations = campaign.required.map(gate => {
      const submitted = events.filter(e => e.kind === 'task.submitted' && e.campaignId === campaign.id && e.gate === gate);
      const latest = submitted.at(-1);
      const state = latest ? view[latest.task]?.state : 'undispatched';
      return {gate, task: latest?.task ?? null, jobId: latest?.jobId ?? null, state,
        satisfied: state === 'accepted' || (state === 'completed' && !view[latest.task]?.review?.completion)};
    });
    campaign.remaining = campaign.obligations.filter(item => !item.satisfied).map(item => item.gate);
  }
  return result;
}

export function campaignCommand(session, event) {
  const actor = event.from;
  if (!['user', 'orchestrator'].includes(actor)) throw new Error('unauthorized campaign command');
  const view = campaigns(session.events);
  const id = event.campaignId ?? (event.kind === 'campaign.start' ? randomUUID() : null);
  const current = view[id];
  const requiredValid = value => Array.isArray(value) && value.length > 0 && value.length <= 128 && value.every(gate => typeof gate === 'string' && gate.trim() && gate.length <= 200);
  if (event.kind === 'campaign.start') {
    if (current) return session.events.find(e => e.kind === 'campaign.started' && e.campaignId === id);
    if (typeof event.objective !== 'string' || !event.objective.trim() || !requiredValid(event.required)) throw new Error('campaign objective and required gates are required');
    return session.commit([{kind: 'campaign.started', campaignId: id, objective: event.objective, required: [...new Set(event.required)], from: actor, version: ORCHESTRATION_VERSION}], {ref: `campaign:${id}`})[0];
  }
  if (!current) throw new Error('unknown campaign');
  const base = {campaignId: id, from: actor};
  if (event.kind === 'campaign.complete') {
    if (current.state === 'completed') return session.events.findLast(e => e.kind === 'campaign.completed' && e.campaignId === id);
    if (current.remaining.length) throw new Error(`campaign gates unmet: ${current.remaining.join(', ')}`);
    const active = Object.values(tasks(session.events)).filter(t => t.campaignId === id && !TERMINAL.has(t.state));
    if (active.length) throw new Error('campaign still has active work');
    return session.append({...base, kind: 'campaign.completed'});
  }
  if (event.kind === 'campaign.extend') {
    if (!requiredValid(event.required) || current.state === 'completed') throw new Error('invalid campaign extension');
    return session.append({...base, kind: 'campaign.extended', required: event.required});
  }
  if (event.kind === 'campaign.scope') {
    if (actor !== 'user' || !requiredValid(event.required)) throw new Error('only the user can reduce authorized scope');
    return session.append({...base, kind: 'campaign.scope_changed', required: event.required});
  }
  if (event.kind === 'campaign.block') {
    if (typeof event.reason !== 'string' || !event.reason.trim()) throw new Error('a concrete blocker is required');
    return session.append({...base, kind: 'campaign.blocked', reason: event.reason});
  }
  if (['campaign.pause', 'campaign.resume'].includes(event.kind)) {
    if (actor !== 'user') throw new Error('only the user can pause or resume a campaign');
    if (current.state === 'completed') throw new Error('campaign is complete');
    return session.append({...base, kind: event.kind === 'campaign.pause' ? 'campaign.paused' : 'campaign.resumed'});
  }
  throw new Error('unknown campaign command');
}
