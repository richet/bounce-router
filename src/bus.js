// A local socket through which any peer publishes to, and waits on, a Session's
// log with scoped authority. One JSON-RPC 2.0 object per line (see src/query.js).
// The bus never holds state of its own: every accepted event goes through
// session.publish, so LIVE_KINDS folding and ref dedupe stay the log's job alone.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {actionState, requestAction} from './orchestration.js';
import {tasks, TERMINAL} from './reducers.js';

// States in which a task has finished work the orchestrator can accept or send back by hand.
const DECIDABLE = new Set(['blocked', 'reviewing', 'input_required']);

// Peers publish from a positive allowlist: everything a session, the scheduler or the daemon writes is refused regardless of `from`,
// because handoff() folds user/note rows into every later prompt and Router reads cooldown rows.
const PEER_KINDS = new Set(['plan.submitted', 'task.submitted', 'task.milestone', 'task.blocked', 'task.input_required', 'task.usage', 'task.activity', 'message', 'task.accepted', 'task.rework', 'task.cancel', 'agents.defined', 'state', 'lesson.learned', 'worker.retire', 'worker.compact']);
const USER_ONLY_PREFIX = 'control.';
// The scheduler alone owns task lifecycle transitions; a peer may report progress
// (milestone/blocked/input_required/usage/activity), ask for work (submitted) or
// talk (message), but never assert that a task started, finished or died.
const AUTH_TIMEOUT = 30000;
const MAX_LINE_BUFFER = 1024 * 1024; // 1 MiB: a partial line past this is abuse, not a slow write.

// A session dir under a deep BOUNCE_HOME can push `${dir}/bus.sock` past the
// platform's sockaddr_un limit (~104 bytes on macOS, ~108 on Linux); a bind past
// that silently truncates instead of failing, so anything over 100 bytes falls
// back to a short path under a per-uid directory we control the safety of. If
// even that fallback would still be too long (a very long session id), the
// filename itself is replaced by a short hash of it.
export function socketPathFor(dir, {platform = process.platform, uid = process.getuid?.(), tmpRoot = '/tmp'} = {}) {
  if (platform === 'win32') return `\\\\.\\pipe\\bounce-${path.basename(dir)}`;
  const short = path.join(dir, 'bus.sock');
  if (Buffer.byteLength(short) <= 100) return short;
  const safeDir = path.join(tmpRoot, `bounce-${uid}`);
  try { fs.mkdirSync(safeDir, {mode: 0o700}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.statSync(safeDir);
  if (stat.uid !== uid || (stat.mode & 0o777) !== 0o700) throw new Error('unsafe socket directory');
  const basename = path.basename(dir);
  const long = path.join(safeDir, `${basename}.sock`);
  if (Buffer.byteLength(long) <= 100) return long;
  const hash = crypto.createHash('sha256').update(basename).digest('hex').slice(0, 16);
  return path.join(safeDir, `${hash}.sock`);
}

// Probes a unix socket path: 'live' if something is listening (or the connect hangs
// past the short timeout — treated as live, never reaped on doubt), 'dead' if the path
// has no listener (ECONNREFUSED) or is not a socket at all (ENOTSOCK).
function probeSocket(p, timeout) {
  return new Promise(resolve => {
    const sock = net.connect(p);
    const finish = verdict => { try { sock.destroy(); } catch {} resolve(verdict); };
    const timer = setTimeout(() => finish('live'), timeout); timer.unref?.();
    sock.once('connect', () => { clearTimeout(timer); finish('live'); });
    sock.once('error', error => { clearTimeout(timer); finish(error.code === 'ECONNREFUSED' || error.code === 'ENOTSOCK' ? 'dead' : 'live'); });
  });
}

// A socket is "dead" only if it refuses on EVERY probe of a short retry series: a live
// daemon that is momentarily not accepting (starting up, or its listen backlog full under
// heavy parallel load) refuses one connect then accepts the next, and must never be reaped.
async function probeDead(p, timeout, tries = 3, gap = 60) {
  for (let i = 0; i < tries; i++) {
    if (await probeSocket(p, timeout) === 'live') return false;
    if (i < tries - 1) await new Promise(r => { const t = setTimeout(r, gap); t.unref?.(); });
  }
  return true;
}

// Sweeps the shared per-uid fallback directory (/tmp/bounce-<uid>/) of orphaned bus sockets:
// a daemon killed with SIGKILL never runs close(), so its socket file survives with no
// listener. Reaping is deliberately conservative — deleting a socket another live daemon
// owns breaks that daemon's peers with ENOENT (observed: a sibling reaper unlinked a live
// orchestrator's socket under parallel load, so its main peer's connectBus failed). So a
// socket is reaped only when it is BOTH older than `minAgeMs` (a freshly-created socket
// belongs to a starting/live daemon and is never touched — this is the load-race guard) AND
// refuses every probe in a retry series (a live-but-busy daemon accepts on a retry). A live
// socket, a non-.sock file and the caller's own `keep` path are left untouched; never throws.
export async function reapStaleSockets({platform = process.platform, uid = process.getuid?.(), tmpRoot = '/tmp', keep, connectTimeout = 200, minAgeMs = 3000} = {}) {
  if (platform === 'win32') return [];
  const safeDir = path.join(tmpRoot, `bounce-${uid}`);
  let stat;
  try { stat = fs.statSync(safeDir); }
  catch { return []; } // no fallback dir yet: nothing to sweep
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) return []; // not a directory we own safely
  const keepName = keep ? path.basename(keep) : null;
  let names;
  try { names = fs.readdirSync(safeDir); }
  catch { return []; }
  const now = Date.now();
  const reaped = [];
  await Promise.all(names.filter(name => name.endsWith('.sock') && name !== keepName).map(async name => {
    const target = path.join(safeDir, name);
    let mtime;
    try { mtime = fs.statSync(target).mtimeMs; } catch { return; } // vanished between readdir and stat
    if (now - mtime < minAgeMs) return; // fresh: a starting/live daemon's socket, never reap
    if (await probeDead(target, connectTimeout)) { try { fs.unlinkSync(target); reaped.push(target); } catch {} }
  }));
  return reaped.sort();
}

// Resolves once actually listening; rejects (never throws async/uncaught) on any
// bind/chmod failure — a stale non-socket file at the chosen path, EADDRINUSE, etc.
// Plans are no longer reviewed: a plan.submitted publish is answered ok with this note instead of
// being refused, so it never costs the orchestrator a whole turn over an old habit.
const PLAN_NOT_REVIEWED_NOTE = 'plans are no longer reviewed: dispatch the tasks themselves (task.submitted)';

export function createBus({session, dir, platform, uid, tmpRoot, authTimeout = AUTH_TIMEOUT, validate = () => null, prepare = null, report: receiveReport = null, lesson: receiveLesson = null, retire: retireWorker = null, compact: compactWorker = null, accept: acceptOverride = null, rework: reworkOverride = null, cancel: cancelOverride = null}) {
  const grants = new Map(); // peer -> {peer, tasks, canSubmit, context, token, file, sockets}
  const tokenToPeer = new Map();
  const tokensDir = path.join(dir, 'tokens');
  fs.mkdirSync(tokensDir, {recursive: true, mode: 0o700});
  const spath = socketPathFor(dir, {platform, uid, tmpRoot});
  if (process.platform !== 'win32') { try { fs.unlinkSync(spath); } catch {} }
  // Reap any orphaned fallback sockets a SIGKILLed daemon left behind (never our own spath).
  // Fire-and-forget: sweeping must never delay or fail this daemon coming up.
  void reapStaleSockets({platform, uid, tmpRoot, keep: spath});
  const server = net.createServer(socket => handleConnection(socket));

  function handleConnection(socket) {
    let buffer = '', authenticated = null;
    const pendingWaits = new Set(); // cleanup functions for in-flight `wait` calls on this socket
    const send = obj => { try { socket.write(JSON.stringify(obj) + '\n'); } catch {} };
    const authTimer = setTimeout(() => socket.destroy(), authTimeout);
    authTimer.unref?.();

    socket.on('data', chunk => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line);
      }
      if (buffer.length > MAX_LINE_BUFFER) socket.destroy();
    });
    socket.on('close', () => {
      if (authenticated) authenticated.sockets.delete(socket);
      for (const cleanup of pendingWaits) cleanup();
      pendingWaits.clear();
    });

    function handleLine(line) {
      let msg, parseError = false;
      try { msg = JSON.parse(line); } catch { parseError = true; }
      const isRequest = !parseError && msg && typeof msg === 'object' && !Array.isArray(msg);
      if (!authenticated) {
        clearTimeout(authTimer);
        const token = isRequest && msg.method === 'auth' ? msg.params?.token : undefined;
        const peerName = typeof token === 'string' ? tokenToPeer.get(token) : undefined;
        const grant = peerName && grants.get(peerName);
        if (!grant) { send({jsonrpc: '2.0', id: isRequest ? msg.id ?? 0 : 0, error: {code: -32001, message: 'unauthorized'}}); socket.end(); return; }
        authenticated = grant;
        grant.sockets.add(socket);
        send({jsonrpc: '2.0', id: msg.id, result: {peer: grant.peer, tasks: [...grant.tasks], canSubmit: grant.canSubmit}});
        return;
      }
      // A malformed or non-object line after auth is a bad request, not an auth failure:
      // answer -32600 and keep the connection open (only auth failures close the socket).
      if (!isRequest) return refuse(msg?.id ?? null, -32600, 'invalid request');
      dispatch(msg);
    }

    function dispatch(msg) {
      const {id, method, params = {}} = msg;
      // A reporting token is write-only and task/attempt bound. In particular it cannot read
      // the session journal or wait on another actor's events.
      if (authenticated.report && method !== 'report') return refuse(id, -32001, 'unauthorized');
      if (method === 'publish') return handlePublish(id, params.event ?? {});
      if (method === 'wait') return handleWait(id, params);
      if (method === 'events') return handleEvents(id, params);
      if (method === 'report') return handleReport(id, params.report);
      send({jsonrpc: '2.0', id, error: {code: -32601, message: 'method not found'}});
    }

    function refuse(id, code, message) { send({jsonrpc: '2.0', id, error: {code, message}}); }

    async function handlePublish(id, event) {
      const peer = authenticated.peer;
      if (authenticated.report) return refuse(id, -32001, 'unauthorized');
      let e = {...event};
      // A peer never sets its own id/time/seq (Session.append/publish would keep a
      // forged one), and never picks its own context — that's the grant's job, so
      // a worker cannot write into a thread it wasn't assigned.
      delete e.id; delete e.time; delete e.seq;
      if (authenticated.context) e.context = authenticated.context;
      else delete e.context;
      if (e.from === undefined) e.from = peer;
      else if (e.from !== peer) return refuse(id, -32001, 'unauthorized');
      if (typeof e.kind !== 'string') return refuse(id, -32602, 'invalid event');
      // Campaigns were removed (a plan, or plain tasks, is enough): say what to send instead of a bare refusal.
      if (e.kind.startsWith('campaign.')) return refuse(id, -32602, `invalid event: ${e.kind}: campaigns no longer exist — submit the work as tasks (task.submitted); record a blocker only when the user must decide something`);
      if (e.kind.startsWith(USER_ONLY_PREFIX) ? peer !== 'user' : !PEER_KINDS.has(e.kind)) return refuse(id, -32001, 'unauthorized');
      if (e.kind === 'task.submitted') {
        // A canSubmit grant may open a root (parent explicitly null); anything with a parent needs that parent in its own tasks.
        if (!authenticated.canSubmit || !(e.parent === null || authenticated.tasks.includes(e.parent))) return refuse(id, -32001, 'unauthorized');
        delete e.replaces; delete e.budget;
        // A peer may leave the id to the bus (scheduler.submit does the same): a journaled
        // task.submitted always carries one — a row without it crashed every task view.
        if (typeof e.task !== 'string' || !e.task) e.task = crypto.randomUUID();
        if (e.task === e.parent) return refuse(id, -32602, 'invalid event');
        if (session.events.some(row => row.kind === 'task.submitted' && row.task === e.task)) return refuse(id, -32602, `invalid event: task id ${e.task} is already used; omit task to get a fresh one`);
        // The scheduler corrects what it can (an unknown or named profile, invalid owns — each said in the
        // row's `corrections`) and decorates the row (a Jev completion reviewer); only what is still wrong
        // after that is refused. The prepared row is what everyone reads.
        if (typeof prepare === 'function') e = prepare(e);
        if (typeof e.profile !== 'string' || !e.profile) return refuse(id, -32602, 'invalid event: profile: name an agent (or `auto`)');
        const problem = validate(e);
        if (problem) return refuse(id, -32602, `invalid event: ${problem}`);
        if (e.retryOf !== undefined && (!authenticated.tasks.includes(e.retryOf) || typeof e.retryOf !== 'string')) return refuse(id, -32001, 'unauthorized retry');
        // A continuation resumes another task's worker (docs/plans/standing-workers.md): only a task of one's own.
        if (e.continues !== undefined && (!authenticated.tasks.includes(e.continues) || typeof e.continues !== 'string')) return refuse(id, -32001, 'unauthorized continuation');
      } else if (e.kind === 'plan.submitted') {
        // Plans are no longer reviewed (2026-09-29): a refusal here cost the orchestrator a whole turn
        // for an old habit, so an authorized peer gets an ok with a note instead — nothing is journaled.
        if (!authenticated.canSubmit || !['user', 'orchestrator'].includes(peer)) return refuse(id, -32001, 'unauthorized');
        send({jsonrpc: '2.0', id, result: {kind: 'plan.submitted', notes: [PLAN_NOT_REVIEWED_NOTE]}});
        return;
      } else if (e.kind.startsWith('task.')) {
        // A task.* row without its task is a malformed event, not an authority failure: say so
        // (observed live: an orchestrator publishing a task.milestone with no `task` got a bare
        // `unauthorized` and could not tell what it had done wrong).
        if (typeof e.task !== 'string' || !e.task) return refuse(id, -32602, `invalid event: ${e.kind} requires task`);
        if (!authenticated.tasks.includes(e.task)) return refuse(id, -32001, 'unauthorized');
        // A peer may close out a task that has no completion reviewer of its own. One with review.completion is
        // decided by its review — unless the orchestrator decides first: while the task holds finished work
        // (blocked, under review, or asking for input) its owner may accept it (task.accepted) or send it back to
        // the same worker (task.rework). 2026-09-27: this used to be allowed only at an unconfident review gate,
        // and the refusals cost orchestrator turns; the review sends work back at most once now anyway.
        if (e.kind === 'task.accepted') {
          const submitted = session.events.find(row => row.kind === 'task.submitted' && row.task === e.task);
          if (submitted?.review?.completion) {
            const state = tasks(session.events)[e.task]?.state;
            if (!DECIDABLE.has(state)) return refuse(id, -32602, `invalid event: task.accepted: task ${e.task} is ${state ?? 'unknown'}, with no finished work to accept yet; wait for its outcome${state === 'accepted' ? ' (it is already accepted)' : ''}`);
            const blocked = state === 'blocked' ? session.events.findLast(row => row.kind === 'task.blocked' && row.task === e.task) : null;
            e = {...e, overrides: blocked?.reason ?? state, text: typeof e.text === 'string' && e.text.trim() ? e.text : 'Accepted by the orchestrator'};
          }
        } else if (e.kind === 'task.rework') {
          if (peer !== 'orchestrator') return refuse(id, -32001, 'unauthorized');
          const state = tasks(session.events)[e.task]?.state;
          if (!DECIDABLE.has(state)) return refuse(id, -32602, `invalid event: task.rework: task ${e.task} is ${state ?? 'unknown'}; only work that is blocked, under review or asking for input goes back to its worker — for finished work submit a follow-up task with retryOf ${e.task}`);
          if (typeof e.text !== 'string' || !e.text.trim()) return refuse(id, -32602, 'invalid event: task.rework needs text naming what must be fixed, e.g. {"kind":"task.rework","task":"<id>","text":"<what to fix>"}');
          const blocked = state === 'blocked' ? session.events.findLast(row => row.kind === 'task.blocked' && row.task === e.task) : null;
          e = {...e, overrides: blocked?.reason ?? state};
        } else if (e.kind === 'task.cancel') {
          // The orchestrator's own withdrawal of a task it opened — e.g. after replacing a blocked
          // task with a fresh one and no longer needing the old id to answer. Only the orchestrator
          // may ask (a worker or reviewer cancelling itself is not a request this bus models), it
          // must say why, and a task already terminal has nothing left to cancel.
          if (peer !== 'orchestrator') return refuse(id, -32001, 'unauthorized');
          if (typeof e.text !== 'string' || !e.text.trim()) e = {...e, text: 'Cancelled by the orchestrator (no reason given)'};
          if (TERMINAL.has(tasks(session.events)[e.task]?.state)) return refuse(id, -32602, 'invalid event: task is already terminal, nothing to cancel');
        }
      } else if (e.kind === 'worker.retire') {
        // The orchestrator ends a standing worker (docs/plans/standing-workers.md §3); the scheduler says why not.
        if (peer !== 'orchestrator' && peer !== 'user') return refuse(id, -32001, 'unauthorized');
        if (typeof retireWorker !== 'function') return refuse(id, -32601, 'workers are not kept in this session');
        if (typeof e.worker !== 'string' || !e.worker) return refuse(id, -32602, 'invalid event: worker.retire needs the worker name, e.g. builder#1');
        let retired;
        try { retired = await retireWorker({worker: e.worker, handoff: e.handoff ?? null, ask: e.ask === true, by: peer}); }
        catch (error) { return refuse(id, -32602, `invalid event: ${error.message}`); }
        send({jsonrpc: '2.0', id, result: retired});
        return;
      } else if (e.kind === 'worker.compact') {
        if (peer !== 'orchestrator' && peer !== 'user') return refuse(id, -32001, 'unauthorized');
        if (typeof compactWorker !== 'function') return refuse(id, -32601, 'workers are not kept in this session');
        if (typeof e.worker !== 'string' || !e.worker) return refuse(id, -32602, 'invalid event: worker.compact needs the worker name, e.g. builder#1');
        let compacted;
        try { compacted = await compactWorker({worker: e.worker, by: peer}); }
        catch (error) { return refuse(id, -32602, `invalid event: ${error.message}`); }
        send({jsonrpc: '2.0', id, result: compacted});
        return;
      } else if (e.kind === 'lesson.learned') {
        // A lesson is the orchestrator's (docs/plans/lessons-and-sweep.md): one line for a job in this
        // project, kept in .bounce/LESSONS.md by the hook, which says in plain words why one is refused.
        if (peer !== 'orchestrator' && peer !== 'user') return refuse(id, -32001, 'unauthorized');
        if (typeof receiveLesson !== 'function') return refuse(id, -32601, 'lessons are not kept in this session');
        const kept = receiveLesson({agent: e.agent, text: e.text});
        if (!kept.ok) return refuse(id, -32602, `invalid event: ${kept.reason}`);
        e = {...e, ...kept.lesson};
      } else if (e.kind === 'message') {
        if (typeof e.to !== 'string' || !e.to) return refuse(id, -32602, 'invalid event');
        // A worker is addressable only by a grant that owns its task (the scheduler turns the text into
        // adapter input): the same boundary as reporting on it. The user peer addresses anyone.
        if (/^(worker|review):/.test(e.to) && peer !== 'user' && !authenticated.tasks.includes(e.to.slice(e.to.indexOf(':') + 1))) return refuse(id, -32001, 'unauthorized');
        if (e.to.startsWith('review:') && !['user', 'orchestrator'].includes(peer)) return refuse(id, -32001, 'unauthorized');
      }
      let row;
      if (e.kind === 'task.submitted') {
        requestAction(session, {actionId: `dispatch:${e.task}:0`, type: 'dispatch', task: e.task}, [e]);
        row = session.events.findLast(event => event.kind === e.kind && event.task === e.task);
        // What bounce corrected or noticed about this submission, in the reply the orchestrator reads now.
        const notes = session.events.filter(event => event.kind === 'task.corrected' && event.task === e.task).map(event => event.text);
        if (row && notes.length) row = {...row, notes};
      } else if (e.kind === 'task.accepted' && e.overrides && typeof acceptOverride === 'function') row = acceptOverride(e);
      else if (e.kind === 'task.rework' && e.overrides && typeof reworkOverride === 'function') row = reworkOverride(e);
      else if (e.kind === 'task.cancel') {
        if (typeof cancelOverride !== 'function') return refuse(id, -32001, 'unauthorized');
        try { row = await cancelOverride(e); }
        catch (error) { return refuse(id, -32602, error.message); }
      } else row = session.publish(e);
      send({jsonrpc: '2.0', id, result: row});
    }

    function handleReport(id, report) {
      if (!authenticated.report || typeof receiveReport !== 'function') return refuse(id, -32001, 'unauthorized');
      try {
        const row = receiveReport({task: authenticated.report.task, attempt: authenticated.report.attempt,
          report, from: authenticated.peer, context: authenticated.context});
        send({jsonrpc: '2.0', id, result: row});
      } catch (error) { refuse(id, -32602, error.message); }
    }

    // A wait for one task's outcome (`{kind: 'task.<terminal>', task}`) resolves on ANY terminal row
    // of that task: a peer waiting for task.completed on a task that has already failed was
    // observed sitting the full timeout — six minutes of "doing nothing" — for a row that could
    // never come. The caller reads `kind` to learn which outcome it got.
    const TASK_TERMINAL = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.deadline', 'task.rejected', 'task.accepted']);
    function handleWait(id, {match = {}, timeout, afterSeq = 0}) {
      if (!Number.isInteger(timeout) || timeout > 600000) return refuse(id, -32602, 'invalid params: timeout must be an integer number of ms, at most 600000 (10 minutes); wait again to keep waiting');
      const outcomeWait = typeof match.task === 'string' && TASK_TERMINAL.has(match.kind);
      const latestReplacement = task => {
        let current = task;
        const visited = new Set();
        while (!visited.has(current)) {
          visited.add(current);
          const replacement = session.events.findLast(e => e.kind === 'task.submitted' && e.replaces === current);
          if (!replacement || visited.has(replacement.task)) break;
          current = replacement.task;
        }
        return current;
      };
      const matches = row => (outcomeWait
        ? row.task === latestReplacement(match.task) && TASK_TERMINAL.has(row.kind)
          && ![...actionState(session.events).values()].some(action => action.task === row.task && action.type === 'terminal' && ['requested', 'started'].includes(action.status))
          && !(row.kind === 'task.completed' && session.events.find(event => event.kind === 'task.submitted' && event.task === row.task)?.review?.completion)
          && Object.entries(match).every(([key, value]) => key === 'kind' || key === 'task' || row[key] === value)
        : Object.entries(match).every(([key, value]) => row[key] === value))
        && (row.seq !== undefined ? row.seq > afterSeq : afterSeq === 0);
      let settled = false;
      const cleanup = () => { clearTimeout(timer); unsubscribe(); pendingWaits.delete(cleanup); };
      const finish = row => {
        if (settled) return;
        settled = true;
        cleanup();
        send({jsonrpc: '2.0', id, result: row ?? null});
        // The orchestrator has now been handed this outcome by its own `wait`: main-service's
        // wake-up on terminal rows (pendingHandoffs) treats the task as seen, nothing else does.
        if (row && authenticated.peer === 'orchestrator' && typeof row.task === 'string' && TASK_TERMINAL.has(row.kind)) {
          session.append({kind: 'wait.served', task: row.task, served: row.seq ?? null, outcome: row.kind, from: 'orchestrator', context: authenticated.context});
        }
      };
      // A message delivered live into the orchestrator's turn is only read when its current tool
      // call returns (observed: acknowledged at 07:01, read at 07:08 when a 7-minute wait came
      // back), so a live delivery ends the orchestrator's wait with a row saying why.
      const interruption = row => authenticated.peer === 'orchestrator' && row.kind === 'main.delivery' && row.state === 'acknowledged'
        && {kind: 'wait.interrupted', from: 'bounce', reason: 'message', messageId: row.messageId,
          text: 'A message from the user was delivered to your turn: read it and act on it before waiting again'};
      const unsubscribe = session.subscribe(row => {
        const outcome = outcomeWait ? session.events.findLast(matches) : matches(row) ? row : null;
        if (outcome) finish(outcome);
        else { const cut = interruption(row); if (cut) finish(cut); }
      });
      const timer = setTimeout(() => finish(null), timeout);
      timer.unref?.();
      pendingWaits.add(cleanup);
      const existing = session.events.find(matches);
      if (existing) finish(existing);
    }

    function handleEvents(id, {afterSeq = 0}) {
      send({jsonrpc: '2.0', id, result: session.events.filter(row => (row.seq ?? 0) > afterSeq)});
    }
  }

  function grant({peer, tasks = [], canSubmit = false, context, report = null}) {
    const previous = grants.get(peer);
    if (previous) { tokenToPeer.delete(previous.token); for (const socket of previous.sockets) socket.destroy(); try { fs.unlinkSync(previous.file); } catch {} }
    const token = crypto.randomBytes(32).toString('hex');
    // Sanitizing collapses distinct peer names (worker:a, worker/a) onto the same
    // file; a hash suffix of the real name keeps them distinct on disk.
    const sanitized = peer.replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix = crypto.createHash('sha256').update(peer).digest('hex').slice(0, 8);
    const file = path.join(tokensDir, `${sanitized}-${suffix}`);
    fs.writeFileSync(file, token, {mode: 0o600});
    if (report && (!tasks.includes(report.task) || !Number.isInteger(report.attempt) || report.attempt < 1)) throw new Error('invalid report grant');
    grants.set(peer, {peer, tasks: [...tasks], canSubmit, context, report, token, file, sockets: new Set()});
    tokenToPeer.set(token, peer);
    return {token, file};
  }

  // Resolves once every socket that was open under this grant has actually closed
  // (not merely destroyed), so a caller can rely on server-side teardown (wait
  // subscriptions, timers) having run by the time this settles.
  // Widens a grant in place (the orchestrator learns of each task it opens); the token is not rotated, so open connections keep working.
  function extendGrant(peer, tasks) { const entry = grants.get(peer); if (entry) for (const task of tasks) if (!entry.tasks.includes(task)) entry.tasks.push(task); }

  function revoke(peer) {
    const entry = grants.get(peer);
    if (!entry) return Promise.resolve();
    const closed = [...entry.sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    grants.delete(peer);
    tokenToPeer.delete(entry.token);
    try { fs.unlinkSync(entry.file); } catch {}
    return Promise.all(closed).then(() => {});
  }

  function close() {
    return new Promise(resolve => {
      const closed = [];
      for (const entry of grants.values()) {
        for (const socket of entry.sockets) closed.push(new Promise(res => { socket.once('close', res); socket.destroy(); }));
        try { fs.unlinkSync(entry.file); } catch {}
      }
      Promise.all(closed).then(() => server.close(() => {
        if (process.platform !== 'win32') { try { fs.unlinkSync(spath); } catch {} }
        resolve();
      }));
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    server.on('error', error => { if (!settled) { settled = true; reject(error); } });
    server.listen(spath, () => {
      if (process.platform !== 'win32') {
        try { fs.chmodSync(spath, 0o600); }
        catch (error) { if (!settled) { settled = true; reject(error); } return; }
      }
      if (settled) return;
      settled = true;
      resolve({path: spath, grant, extendGrant, revoke, close});
    });
  });
}

// Retries briefly: createBus's own promise only resolves once listening, but a
// caller may still race a server that is mid-teardown. ENOENT/ECONNREFUSED are
// retried; anything else (including an auth refusal) is not.
function connectSocket(path, deadline) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once('connect', () => { socket.removeListener('error', onError); resolve(socket); });
    const onError = error => {
      if ((error.code === 'ENOENT' || error.code === 'ECONNREFUSED') && Date.now() < deadline) {
        setTimeout(() => connectSocket(path, deadline).then(resolve, reject), 5);
      } else reject(error);
    };
    socket.once('error', onError);
  });
}

export function connectBus({path, token}) {
  return new Promise((resolve, reject) => {
    connectSocket(path, Date.now() + 2000).then(socket => {
      let buffer = '', nextId = 1, authSettled = false, closed = false;
      const pending = new Map();
      const send = obj => socket.write(JSON.stringify(obj) + '\n');
      const call = (method, params) => new Promise((res, rej) => {
        const id = nextId++;
        pending.set(id, {res, rej});
        send({jsonrpc: '2.0', id, method, params});
      });
      // The socket ending (a revoke, a server-side close, a network drop) must
      // reject every call still in flight — otherwise a revoked peer's `wait`
      // hangs forever instead of surfacing the disconnect.
      const failAll = error => {
        if (closed) return;
        closed = true;
        if (!authSettled) { authSettled = true; reject(error); }
        for (const waiting of pending.values()) waiting.rej(error);
        pending.clear();
      };

      socket.on('data', chunk => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); }
          catch {
            // A malformed line from the server should never throw out of the 'data'
            // handler; we cannot tell which call it was meant to answer, so every
            // still-pending call is rejected rather than left hanging forever.
            const error = new Error('malformed response line from bus');
            if (!authSettled) { authSettled = true; reject(error); }
            for (const waiting of pending.values()) waiting.rej(error);
            pending.clear();
            continue;
          }
          if (!authSettled) {
            authSettled = true;
            if (msg.error) reject(Object.assign(new Error(msg.error.message), {code: msg.error.code}));
            else {
              const {peer, tasks} = msg.result;
              resolve({
                peer, tasks,
                publish: event => call('publish', {event}),
                report: report => call('report', {report}),
                wait: ({match, timeout, afterSeq = 0} = {}) => call('wait', {match, timeout, afterSeq}),
                events: ({afterSeq = 0} = {}) => call('events', {afterSeq}),
                close: () => new Promise(r => socket.end(r)),
              });
            }
            continue;
          }
          const waiting = pending.get(msg.id);
          if (!waiting) continue;
          pending.delete(msg.id);
          if (msg.error) waiting.rej(Object.assign(new Error(msg.error.message), {code: msg.error.code}));
          else waiting.res(msg.result);
        }
      });
      socket.on('close', () => failAll(Object.assign(new Error('bus connection closed'), {code: 'closed'})));
      socket.on('error', error => failAll(error));
      send({jsonrpc: '2.0', id: 0, method: 'auth', params: {token}});
    }, reject);
  });
}
