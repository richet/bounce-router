// Remote session over IPC (Phase 2 process model): the supervisor stays the single
// writer of a session's journal; a child (the TUI/run process) gets a synchronous
// proxy that looks like Session. hostSession runs in the parent; createRemoteSession
// runs in the child. See docs/local-orchestration.md "Process model".
import {randomUUID} from 'node:crypto';
import {LIVE_KINDS} from './core.js';

const MAIN_RPC_TIMEOUT = 5000;

const defaultFrom = e => e.from ?? (e.kind === 'user' ? 'user' : e.provider ? 'main' : 'bounce');

// Parent side: forwards every row the session emits, answers append/publish/active
// requests from the child by calling straight into the real Session.
// `main` is deliberately an explicit daemon capability, rather than exposing Router or its
// process handle to the view.  This keeps the provider alive when the view detaches and gives
// every command a bounded request/reply path over the existing IPC channel.
export function hostSession({session, child, main = null}) {
  const forward = row => { try { child.send({type: 'session.event', row}); } catch {} };
  const unsubscribe = session.subscribe(forward);
  const onMessage = msg => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'session.append' || msg.type === 'session.publish') {
      const method = msg.type === 'session.append' ? 'append' : 'publish';
      try { child.send({type: method === 'append' ? 'session.appended' : 'session.published', seq: msg.seq, row: session[method](msg.event)}); }
      catch (error) { child.send({type: 'session.error', seq: msg.seq, message: error.message}); }
    } else if (msg.type === 'session.active') {
      session.active = msg.provider;
    } else if (msg.type?.startsWith('main.')) {
      const method = msg.type.slice('main.'.length);
      const fn = ['run', 'deliver', 'cancel'].includes(method) ? main?.[method] : null;
      if (typeof fn !== 'function') {
        child.send({type: 'main.error', seq: msg.seq, message: 'main provider is unavailable'});
        return;
      }
      Promise.resolve().then(() => fn(msg.params ?? {})).then(result => {
        try { child.send({type: 'main.result', seq: msg.seq, result}); } catch {}
      }, error => { try { child.send({type: 'main.error', seq: msg.seq, message: error.message}); } catch {} });
    }
  };
  child.on('message', onMessage);
  child.send({type: 'session.replay', id: session.id, dir: session.dir, file: session.file, cwd: session.cwd, context: session.context, events: session.events, active: session.active,
    mainState: main?.state ? main.state() : {state: 'unavailable', currentTurnId: null}});
  const unsubscribeMain = main?.subscribe ? main.subscribe(event => {
    try { child.send({type: 'main.event', event}); } catch {}
  }) : () => {};
  if (main?.state) child.send({type: 'main.state', state: main.state()});
  return {detach() { unsubscribe(); unsubscribeMain(); child.off('message', onMessage); }};
}

// Child side: a synchronous proxy with the same public shape as Session. append/publish
// build a provisional row immediately (no seq), then the parent's reply (or its broadcast
// of the same row, whichever arrives first) replaces it in place.
export function createRemoteSession(channel) {
  return new Promise(resolve => {
    const listeners = new Set();
    let clientSeq = 0;
    const pendingBySeq = new Map(); // client seq -> provisional row id
    const pendingById = new Map();  // provisional row id -> client seq
    const pendingLiveIds = new Set(); // ids of our own live (never-replaced) publishes, to swallow the echo
    const refIndex = new Map();
    const flushWaiters = new Set(); // {resolve, reject} pairs waiting for pendingBySeq to drain
    let resolved = false;

    // Resolves once every currently in-flight append/publish has been acknowledged
    // (immediately if nothing is pending) — a caller (cli.js, before process.exit())
    // awaits this so a synchronous run's tail rows aren't lost to a process that exits
    // before their IPC round trip completes. Rejects with code 'closed' instead of
    // hanging forever if the channel disconnects while something is still pending.
    function flush() {
      if (pendingBySeq.size === 0) return Promise.resolve();
      return new Promise((res, rej) => flushWaiters.add({resolve: res, reject: rej}));
    }
    function checkFlush() {
      if (pendingBySeq.size !== 0) return;
      for (const waiter of flushWaiters) waiter.resolve();
      flushWaiters.clear();
    }

    const pendingMain = new Map();
    const callMain = (method, params = {}) => new Promise((resolveCall, rejectCall) => {
      const seq = ++clientSeq;
      const timer = setTimeout(() => {
        if (pendingMain.delete(seq)) rejectCall(Object.assign(new Error(`main ${method} request timed out`), {code: 'timeout'}));
      }, MAIN_RPC_TIMEOUT);
      timer.unref?.();
      pendingMain.set(seq, {resolve: resolveCall, reject: rejectCall, timer});
      channel.send({type: `main.${method}`, seq, params});
    });
    const remote = {
      id: undefined, dir: undefined, file: undefined, cwd: undefined, context: undefined,
      events: [], onEvent: undefined,
      append: event => doJournaled('session.append', event),
      publish: event => LIVE_KINDS.has(event.kind) ? doLive(event) : doJournaled('session.publish', event),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // Immediate daemon commands: accepted responses are intentionally distinct from a later
      // `main.event` terminal outcome. Consumers must never await provider completion here.
      runMain: params => callMain('run', params),
      deliverMain: params => callMain('deliver', params),
      cancelMain: params => callMain('cancel', params),
      main: {state: 'unknown', currentTurnId: null},
      flush,
      lock() {}, unlock() {},
    };
    let activeValue;
    Object.defineProperty(remote, 'active', {
      enumerable: true, configurable: true,
      get: () => activeValue,
      set(provider) { activeValue = provider; channel.send({type: 'session.active', provider}); },
    });

    const emit = row => {
      if (row.kind === 'main.starting' && row.provider) {
        activeValue = row.provider;
        remote.main = {...remote.main, provider: row.provider, model: row.model, mode: row.mode, policy: row.policy, currentTurnId: null, state: 'starting', requestId: row.requestId};
      }
      remote.onEvent?.(row);
      for (const fn of listeners) fn(row);
    };

    // The provisional row is inserted synchronously so events.length/at(-1) reflect
    // it immediately, but it is never delivered to onEvent/subscribers — only the
    // authoritative replacement is (see settle()), so each row is delivered exactly
    // once. `provisional` is non-enumerable so a stray JSON.stringify of a row still
    // sitting in `events` before settlement never leaks it.
    function doJournaled(type, event) {
      if (typeof event.ref === 'string' && refIndex.has(event.ref)) return refIndex.get(event.ref);
      const row = {id: randomUUID(), time: new Date().toISOString(), ...event, from: defaultFrom(event), context: event.context ?? remote.context};
      Object.defineProperty(row, 'provisional', {value: true, enumerable: false, configurable: true});
      remote.events.push(row);
      if (typeof row.ref === 'string') refIndex.set(row.ref, row);
      const seq = ++clientSeq;
      pendingBySeq.set(seq, row.id);
      pendingById.set(row.id, seq);
      channel.send({type, seq, event: {...event, id: row.id}});
      return row;
    }

    function doLive(event) {
      const row = {id: randomUUID(), time: new Date().toISOString(), ...event, from: defaultFrom(event), context: event.context ?? remote.context};
      emit(row);
      pendingLiveIds.add(row.id);
      channel.send({type: 'session.publish', seq: ++clientSeq, event: {...event, id: row.id}});
      return row;
    }

    // Replaces a provisional row in place with the parent's authoritative version
    // (matched by our own client seq, not by id — a ref-dedupe collision at the
    // parent returns a row whose id differs from the child's provisional). The
    // provisional's current index is looked up fresh here rather than cached at
    // append time, because an earlier settle() in the same batch may already have
    // spliced the array (see the alreadyPresent branch below) and shifted it.
    function settle(seq, row) {
      const provisionalId = pendingBySeq.get(seq);
      if (provisionalId === undefined) return; // already settled via the broadcast, or a live ack (nothing to replace)
      pendingBySeq.delete(seq);
      pendingById.delete(provisionalId);
      const provisionalIndex = remote.events.findIndex(e => e.id === provisionalId);
      if (provisionalIndex === -1) { checkFlush(); return; } // defensive; a replay reset events under us
      const alreadyPresent = remote.events.some((e, i) => i !== provisionalIndex && e.id === row.id);
      if (alreadyPresent) {
        // A ref-dedupe collision: the authoritative row already arrived via the
        // ordinary broadcast (it forwarded before our own ack came back) and was
        // pushed in as a foreign row — and already delivered once. Drop the now-
        // redundant provisional slot instead of writing a second copy of the row.
        remote.events.splice(provisionalIndex, 1);
      } else {
        remote.events[provisionalIndex] = row;
        if (typeof row.ref === 'string') refIndex.set(row.ref, row);
        emit(row);
      }
      checkFlush();
    }

    function settleError(seq, message) {
      const provisionalId = pendingBySeq.get(seq);
      if (provisionalId === undefined) return;
      pendingBySeq.delete(seq);
      pendingById.delete(provisionalId);
      const provisionalIndex = remote.events.findIndex(e => e.id === provisionalId);
      if (provisionalIndex === -1) { checkFlush(); return; }
      const row = remote.events[provisionalIndex];
      row.error = message;
      emit(row);
      checkFlush();
    }

    function applyReplay(msg) {
      remote.id = msg.id; remote.dir = msg.dir; remote.file = msg.file; remote.cwd = msg.cwd; remote.context = msg.context;
      activeValue = msg.active;
      remote.main = {...remote.main, ...(msg.mainState ?? {})};
      remote.events = [...msg.events];
      refIndex.clear();
      for (const e of remote.events) if (typeof e.ref === 'string' && !refIndex.has(e.ref)) refIndex.set(e.ref, e);
      pendingBySeq.clear(); pendingById.clear(); pendingLiveIds.clear();
    }

    channel.on('message', msg => {
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'session.replay') {
        applyReplay(msg);
        if (!resolved) { resolved = true; resolve(remote); }
        return;
      }
      if (msg.type === 'session.event') {
        const row = msg.row;
        if (typeof row.seq === 'number') {
          const seq = pendingById.get(row.id);
          if (seq !== undefined) return settle(seq, row);
          if (remote.events.some(e => e.id === row.id)) return; // duplicate delivery of an already-settled row
          remote.events.push(row);
          if (typeof row.ref === 'string' && !refIndex.has(row.ref)) refIndex.set(row.ref, row);
          emit(row);
        } else {
          if (pendingLiveIds.delete(row.id)) return; // our own live row's echo; already emitted once locally
          emit(row);
        }
        return;
      }
      if (msg.type === 'session.appended' || msg.type === 'session.published') return settle(msg.seq, msg.row);
      if (msg.type === 'session.error') return settleError(msg.seq, msg.message);
      if (msg.type === 'main.state') {
        remote.main = {...remote.main, ...msg.state};
        return;
      }
      if (msg.type === 'main.event') {
        const event = msg.event;
        if (event?.turnId !== undefined) remote.main.currentTurnId = event.turnId;
        if (event?.state !== undefined) remote.main.state = event.state;
        if (event?.requestId !== undefined) remote.main.requestId = event.requestId;
        if (event?.kind === 'main.terminal') remote.main.currentTurnId = null;
        // Keep the domain kind intact; wrapping by overwriting it loses terminal events.
        if (event && !remote.events.some(row => row.id && row.id === event.id)) emit(event);
        return;
      }
      if (msg.type === 'main.result' || msg.type === 'main.error') {
        const pending = pendingMain.get(msg.seq);
        if (!pending) return;
        pendingMain.delete(msg.seq);
        clearTimeout(pending.timer);
        if (msg.type === 'main.error') pending.reject(Object.assign(new Error(msg.message), {code: 'main'}));
        else pending.resolve(msg.result);
      }
    });

    // A disconnected channel will never deliver the acks flush() is waiting on;
    // reject rather than let a caller (cli.js, before process.exit()) hang forever.
    channel.on('disconnect', () => {
      const error = Object.assign(new Error('remote session channel disconnected'), {code: 'closed'});
      for (const waiter of flushWaiters) waiter.reject(error);
      flushWaiters.clear();
      for (const pending of pendingMain.values()) { clearTimeout(pending.timer); pending.reject(error); }
      pendingMain.clear();
      // A main-client wait is event-driven; without this final notification a detached view
      // could wait forever for a terminal event from a daemon it can no longer reach.
      emit({kind: 'main.disconnected', text: error.message, state: 'disconnected'});
    });
  });
}
