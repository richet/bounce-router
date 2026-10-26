// `bounce send`: a message to a running session's orchestrator from outside its view, as if typed there. It connects
// as one more view (the daemon takes several), sends the turn the TUI would, and is marked `via: 'send'` so the
// journal and the TUI say who typed what. 2026-10-25: a Claude Code session watching a run needs to steer the
// orchestrator the way he does from the TUI.
import fs from 'node:fs';
import path from 'node:path';
import {createRemoteSession} from './remote.js';
import {connectView} from './view-transport.js';
import {pidAlive} from './core.js';

// A view channel to a live session's daemon, with what to do when there is none.
export async function connectSession(root, id) {
  let info = null;
  try { info = JSON.parse(fs.readFileSync(path.join(root, 'sessions', id, 'daemon.json'), 'utf8')); } catch {}
  if (!info || !pidAlive(info.pid)) throw new Error(`session ${id} is not running`);
  if (!info.view || info.protocol !== 1) throw new Error(`session ${id} runs an older daemon with no view socket; restart it first`);
  return connectView({path: info.view, token: fs.readFileSync(info.userToken, 'utf8').trim()});
}

// Follows one request's turn through the rows it is shown: started, its answers, its end.
function turnWatcher(requestId) {
  let started = false, answer = null, finish;
  const ended = new Promise(resolve => { finish = resolve; });
  const see = row => {
    if (row.kind === 'main.started' && row.requestId === requestId) started = true;
    else if (row.kind === 'assistant' && started && !row.narration) answer = row.text ?? answer;
    else if (row.kind === 'main.terminal' && row.requestId === requestId) finish({status: row.status, ...(row.status !== 'completed' && row.reason ? {reason: row.reason} : {})});
  };
  return {see, ended, answer: () => answer};
}

async function untilEnd(channel, watcher, timeoutMs) {
  let timer;
  const disconnected = new Promise(resolve => channel.once('disconnect', () => resolve({status: 'disconnected', reason: 'the session\'s daemon went away'})));
  const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve({status: 'waiting'}), timeoutMs); });
  const end = await Promise.race([watcher.ended, disconnected, timedOut]);
  clearTimeout(timer);
  return {...end, answer: watcher.answer()};
}

// `wait` holds until this message's own turn ends (a queued one waits behind the current turn) and returns the
// orchestrator's last answer in it; past `timeoutMs` it answers `status: 'waiting'` with the request to ask about
// later (answerOf). Without it, send returns as soon as the daemon took the message.
export async function sendToOrchestrator(channel, text, {wait = false, timeoutMs = 60 * 60_000} = {}) {
  const session = await createRemoteSession(channel);
  let watcher = null;
  const early = [];
  const unsubscribe = session.subscribe(row => (watcher ? watcher.see(row) : early.push(row)));
  try {
    const ack = await session.runMain({text, via: 'send'});
    if (!ack?.accepted) return {accepted: false, reason: ack?.reason ?? 'refused'};
    const sent = {accepted: true, requestId: ack.requestId, queued: Boolean(ack.queued)};
    if (!wait) return sent;
    watcher = turnWatcher(ack.requestId);
    for (const row of early.splice(0)) watcher.see(row);
    return {...sent, ...await untilEnd(channel, watcher, timeoutMs)};
  } finally {
    unsubscribe();
    await session.flush?.().catch(() => {});
    channel.close();
  }
}

// The end and answer of a request sent earlier: read from the session's history, or waited for up to `timeoutMs`.
export async function answerOf(channel, requestId, {timeoutMs = 0} = {}) {
  const watcher = turnWatcher(requestId);
  let unsubscribe = () => {};
  try {
    const session = await createRemoteSession(channel);
    unsubscribe = session.subscribe(watcher.see);
    for (const row of session.events) watcher.see(row);
    if (!session.events.some(row => row.requestId === requestId && ['user', 'main.requested'].includes(row.kind))) return {status: 'unknown', reason: `no request ${requestId} in this session`};
    return await untilEnd(channel, watcher, timeoutMs);
  } finally {
    unsubscribe();
    channel.close();
  }
}
