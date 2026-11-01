// `bounce lineage`: which vendor session did what in a bounce session, so a reader of those sessions can walk user
// message → orchestrator turn → task → worker. One row per binding, derived from the journal alone, so it covers past
// sessions and needs no marker in a vendor's files. A vendor session can serve several tasks, so a reader joins a
// message by provider, native session and the row's [from, to] window. Rows hold ids, roles and times: no message,
// orders or path.
import path from 'node:path';
import {readJournal} from './core.js';

export const LINEAGE_VERSION = 1;
const ROLES = new Set(['analyst', 'builder', 'debugger', 'integrator', 'reviewer', 'scout']);
const PEER = /^(worker|review):([^:]+)/;
const roleOf = profile => {
  const name = String(profile ?? '').split(/[@~#]/)[0];
  return ROLES.has(name) ? name : null;
};

// A peer's rows cut where its attempt or its vendor session changes; each piece is one binding.
function track(pieces, event) {
  const piece = (attempt, previous) => {
    if (previous) previous.to = event.time;
    const next = {attempt, provider: null, nativeSession: null, from: event.time, to: event.time};
    pieces.push(next);
    return next;
  };
  let current = pieces.at(-1) ?? piece(event.attempt ?? null);
  if (event.kind === 'task.started') {
    if (current.attempt === null) current.attempt = event.attempt ?? null;
    else if (current.attempt !== event.attempt) current = piece(event.attempt ?? null, current);
  }
  if (event.kind === 'peer.native') {
    if (current.nativeSession && current.nativeSession !== event.sessionId) current = piece(current.attempt, current);
    current.provider = event.provider;
    current.nativeSession = event.sessionId;
  }
  current.to = event.time;
}

export function lineageRows(events, bounceSession) {
  const users = new Map(), tasks = new Map(), peers = new Map(), turns = [];
  let turn = null, native = null, previous = null;
  for (const event of events) {
    if (turn) turn.to = event.time;
    if (event.kind === 'user' && event.requestId) users.set(event.requestId, event);
    else if (event.kind === 'main.requested' && previous?.kind === 'user' && !previous.requestId) users.set(event.requestId, previous);
    else if (event.kind === 'main.started') {
      turn = {requestId: event.requestId ?? null, provider: native?.provider ?? null, nativeSession: native?.sessionId ?? null, from: event.time, to: event.time};
      turns.push(turn);
    } else if (event.kind === 'main.terminal') turn = null;
    else if (event.kind === 'peer.native' && event.from === 'main') {
      native = event;
      if (turn) { turn.provider = event.provider; turn.nativeSession = event.sessionId; }
    } else if (event.kind === 'task.submitted') {
      const inferred = !event.turnRequestId && event.from === 'orchestrator' && Boolean(turn?.requestId);
      tasks.set(event.task, {role: roleOf(event.profile), parentTask: event.parent ?? null, continues: event.continues ?? null, replaces: event.replaces ?? null,
        requestId: event.turnRequestId ?? (inferred ? turn.requestId : null), requestInferred: inferred});
    }
    if (PEER.test(event.from ?? '')) {
      if (!peers.has(event.from)) peers.set(event.from, []);
      track(peers.get(event.from), event);
    }
    previous = event;
  }
  const shaped = ({provider, nativeSession, level, role, task, attempt, parentTask, continues, replaces, requestInferred, requestId, from, to}) => {
    const user = users.get(requestId);
    return {v: LINEAGE_VERSION, bounceSession, provider, nativeSession, level, role, task, attempt, parentTask, continues, replaces,
      requestId: requestId ?? null, requestInferred: requestInferred ?? false, via: user ? user.via ?? 'tui' : null, control: user?.caller ?? null, from, to};
  };
  const rows = turns.map(({requestId, ...binding}) => shaped({...binding, requestId, level: 'orchestrator', role: 'orchestrator', task: null, attempt: null,
    parentTask: null, continues: null, replaces: null}));
  for (const [peer, pieces] of peers) {
    const [, kind, id] = PEER.exec(peer);
    const task = tasks.get(id);
    for (const piece of pieces) {
      if (!piece.nativeSession) continue;
      rows.push(shaped({...piece, level: kind === 'worker' ? 'task' : 'review', role: kind === 'worker' ? task?.role ?? null : 'reviewer', task: id,
        parentTask: task?.parentTask ?? null, continues: task?.continues ?? null, replaces: task?.replaces ?? null,
        requestId: task?.requestId, requestInferred: task?.requestInferred}));
    }
  }
  return rows.sort((a, b) => a.from.localeCompare(b.from));
}

export const sessionLineage = (root, id) => lineageRows(readJournal(path.join(root, 'sessions', id, 'journal.jsonl')).events, id);

const short = id => (id ? id.slice(0, 8) : '—');
export const lineageLine = row => [row.from.slice(0, 16).replace('T', ' '), row.level.padEnd(12), (row.role ?? '—').padEnd(12), `task ${short(row.task)}`, `turn ${short(row.requestId)}${row.requestInferred ? '?' : ''}`,
  `${row.provider ?? '?'}:${row.nativeSession ?? '?'}`].join('  ');
