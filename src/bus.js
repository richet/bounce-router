// A local socket through which any peer publishes to, and waits on, a Session's
// log with scoped authority. One JSON-RPC 2.0 object per line (see src/query.js).
// The bus never holds state of its own: every accepted event goes through
// session.publish, so LIVE_KINDS folding and ref dedupe stay the log's job alone.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Peers publish from a positive allowlist: everything a session, the scheduler or the daemon writes is refused regardless of `from`,
// because handoff() folds user/note rows into every later prompt and Router reads cooldown rows.
const PEER_KINDS = new Set(['task.submitted', 'task.milestone', 'task.blocked', 'task.input_required', 'task.usage', 'task.activity', 'message', 'task.accepted']);
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
export function createBus({session, dir, platform, uid, tmpRoot, authTimeout = AUTH_TIMEOUT, validate = () => null}) {
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
      if (method === 'publish') return handlePublish(id, params.event ?? {});
      if (method === 'wait') return handleWait(id, params);
      if (method === 'events') return handleEvents(id, params);
      send({jsonrpc: '2.0', id, error: {code: -32601, message: 'method not found'}});
    }

    function refuse(id, code, message) { send({jsonrpc: '2.0', id, error: {code, message}}); }

    function handlePublish(id, event) {
      const peer = authenticated.peer;
      const e = {...event};
      // A peer never sets its own id/time/seq (Session.append/publish would keep a
      // forged one), and never picks its own context — that's the grant's job, so
      // a worker cannot write into a thread it wasn't assigned.
      delete e.id; delete e.time; delete e.seq;
      if (authenticated.context) e.context = authenticated.context;
      else delete e.context;
      if (e.from === undefined) e.from = peer;
      else if (e.from !== peer) return refuse(id, -32001, 'unauthorized');
      if (typeof e.kind !== 'string') return refuse(id, -32602, 'invalid event');
      if (e.kind.startsWith(USER_ONLY_PREFIX) ? peer !== 'user' : !PEER_KINDS.has(e.kind)) return refuse(id, -32001, 'unauthorized');
      if (e.kind === 'task.submitted') {
        // A canSubmit grant may open a root (parent explicitly null); anything with a parent needs that parent in its own tasks.
        if (!authenticated.canSubmit || !(e.parent === null || authenticated.tasks.includes(e.parent))) return refuse(id, -32001, 'unauthorized');
        delete e.replaces; delete e.budget;
        if (e.task === e.parent) return refuse(id, -32602, 'invalid event');
        if (session.events.some(row => row.kind === 'task.submitted' && row.task === e.task)) return refuse(id, -32602, 'invalid event');
        if (typeof e.profile !== 'string' || !e.profile) return refuse(id, -32602, 'invalid event');
        const problem = validate(e);
        if (problem) return refuse(id, -32602, `invalid event: ${problem}`);
      } else if (e.kind.startsWith('task.')) {
        if (!authenticated.tasks.includes(e.task)) return refuse(id, -32001, 'unauthorized');
        // A peer may close out a task that has no completion reviewer of its own; one with
        // review.completion set is only ever accepted by the review policy (task.rejected/
        // task.rework/policy.* stay unpublishable to peers, so this is the one remaining gap).
        if (e.kind === 'task.accepted') {
          const submitted = session.events.find(row => row.kind === 'task.submitted' && row.task === e.task);
          if (submitted?.review?.completion) return refuse(id, -32602, 'invalid event: review');
        }
      } else if (e.kind === 'message') {
        if (typeof e.to !== 'string' || !e.to) return refuse(id, -32602, 'invalid event');
        // A worker is addressable only by a grant that owns its task (the scheduler turns the text into
        // adapter input): the same boundary as reporting on it. The user peer addresses anyone.
        if (e.to.startsWith('worker:') && peer !== 'user' && !authenticated.tasks.includes(e.to.slice('worker:'.length))) return refuse(id, -32001, 'unauthorized');
      }
      const row = session.publish(e);
      send({jsonrpc: '2.0', id, result: row});
    }

    function handleWait(id, {match = {}, timeout, afterSeq = 0}) {
      if (!Number.isInteger(timeout) || timeout > 600000) return refuse(id, -32602, 'invalid params');
      const matches = row => Object.entries(match).every(([key, value]) => row[key] === value)
        && (row.seq !== undefined ? row.seq > afterSeq : afterSeq === 0);
      let settled = false;
      const cleanup = () => { clearTimeout(timer); unsubscribe(); pendingWaits.delete(cleanup); };
      const finish = row => {
        if (settled) return;
        settled = true;
        cleanup();
        send({jsonrpc: '2.0', id, result: row ?? null});
      };
      const unsubscribe = session.subscribe(row => { if (matches(row)) finish(row); });
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

  function grant({peer, tasks = [], canSubmit = false, context}) {
    const previous = grants.get(peer);
    if (previous) { tokenToPeer.delete(previous.token); for (const socket of previous.sockets) socket.destroy(); try { fs.unlinkSync(previous.file); } catch {} }
    const token = crypto.randomBytes(32).toString('hex');
    // Sanitizing collapses distinct peer names (worker:a, worker/a) onto the same
    // file; a hash suffix of the real name keeps them distinct on disk.
    const sanitized = peer.replace(/[^a-zA-Z0-9_-]/g, '_');
    const suffix = crypto.createHash('sha256').update(peer).digest('hex').slice(0, 8);
    const file = path.join(tokensDir, `${sanitized}-${suffix}`);
    fs.writeFileSync(file, token, {mode: 0o600});
    grants.set(peer, {peer, tasks: [...tasks], canSubmit, context, token, file, sockets: new Set()});
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
