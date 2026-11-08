// A detached orchestrated `bounce run` has no main service: its child process drives the orchestrator itself. The
// inbox is what the daemon's view socket offers in its place, so `bounce send` can steer the run: a sent message is
// journaled as `send.queued` and the run takes it as its next orchestrator turn (src/cli.js carryJob), journaling
// main.started and main.terminal under the same requestId so the sender can follow it. Found live,
// 2026-11-04: send refused every detached run, so control started one run per batch of orders.
import {randomUUID} from 'node:crypto';
import {sentByError} from './main-service.js';
import {applyVerify} from './verify-mode.js';

export function createRunInbox({session}) {
  function run(params = {}) {
    if (typeof params.text !== 'string' || !params.text.trim()) return {accepted: false, reason: 'empty_prompt'};
    if (params.via !== 'send') return {accepted: false, reason: 'invalid_via'};
    const senderError = sentByError(params);
    if (senderError) return {accepted: false, reason: senderError};
    const requestId = randomUUID();
    const text = applyVerify(session, params.text) ?? params.text;
    session.append({kind: 'send.queued', requestId, text, via: 'send', ...(params.caller ? {caller: params.caller} : {})});
    return {accepted: true, queued: true, requestId};
  }
  return {run, state: () => ({state: pendingSends(session.events).length ? 'queued' : 'idle', currentTurnId: null})};
}

// Sent messages the run has not started yet, oldest first.
export function pendingSends(events) {
  const started = new Set(events.filter(e => e.kind === 'main.started' && e.requestId).map(e => e.requestId));
  return events.filter(e => e.kind === 'send.queued' && !started.has(e.requestId));
}
