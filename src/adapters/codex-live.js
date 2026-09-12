import {spawn as spawnProcess} from 'node:child_process';
import codex from './codex.js';
import {resolveExecutable} from '../executable.js';
import {spawnLive, vendorEnv, verifiedCancel, TEXT_MAX} from './live-common.js';

// The Codex peer: one long-lived `codex app-server` process per worker, driven over stdio
// JSON-RPC ("lite": one object per line, `jsonrpc` omitted, numeric ids on requests). A thread
// is started once and every delivery is a turn on it, one turn at a time — which is why no
// delivery here is ever better than `next-turn`. A turn that ends with deliveries queued is a
// milestone and the next turn starts; a turn that ends with nothing queued is the task's result and
// the worker ends with it — continuing a completed task is resume(), never a lingering server.

// Every wire shape in one table: a vendor version bump is one edit.
const REQUESTS = {
  initialize: () => ({method: 'initialize', params: {}}),
  initialized: () => ({method: 'initialized'}),
  threadStart: () => ({method: 'thread/start', params: {}}),
  threadResume: threadId => ({method: 'thread/resume', params: {threadId}}),
  turnStart: ({threadId, text, model}) => ({method: 'turn/start',
    params: {threadId, input: [{type: 'text', text}], ...(model ? {model} : {})}}),
  turnInterrupt: threadId => ({method: 'turn/interrupt', params: {threadId}}),
};

const MAX_LINE = 1024 * 1024; // a line this long is a protocol fault, not a message
const MAX_QUEUE = 50;
const INTERRUPT_MS = 1000; // how long the polite interrupt gets before the signals start

// A server that never answers must not hold cancel() open: every outcome here is a resolution.
const bounded = promise => Promise.race([promise.then(() => {}, () => {}),
  new Promise(resolve => setTimeout(resolve, INTERRUPT_MS))]);

// One iterable per handle, alive across turns: the reader pushes, the consumer pulls.
// No return() — a `break` in a for-await leaves the stream open for the next turn.
function makeStream() {
  const ready = [], waiting = [];
  let ended = false;
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    next() {
      if (ready.length) return Promise.resolve({value: ready.shift(), done: false});
      if (ended) return Promise.resolve({value: undefined, done: true});
      return new Promise(resolve => waiting.push(resolve));
    },
  };
  return {
    iterator,
    push(event) {
      if (ended) return;
      const waiter = waiting.shift();
      waiter ? waiter({value: event, done: false}) : ready.push(event);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiting.splice(0)) waiter({value: undefined, done: true});
    },
  };
}

function finish(handle) {
  if (handle.exited) return;
  handle.exited = true;
  handle.running = false;
  for (const pending of handle.pending.values()) pending.reject(new Error('codex app-server closed'));
  handle.pending.clear();
  handle.stream.end();
}

function write(handle, message) {
  if (handle.exited || handle.child.stdin.destroyed) return false;
  handle.child.stdin.write(JSON.stringify(message) + '\n');
  return true;
}
const notify = (handle, {method, params}) => write(handle, params === undefined ? {method} : {method, params});
const request = (handle, {method, params}) => new Promise((resolve, reject) => {
  const id = handle.nextId++; // ids are single-use, so a late response can never resolve an older request
  handle.pending.set(id, {resolve, reject});
  if (!write(handle, {id, method, params})) {
    handle.pending.delete(id);
    reject(new Error('codex app-server closed'));
  }
});

function startTurn(handle, text) {
  handle.running = true;
  return request(handle, REQUESTS.turnStart({threadId: handle.threadId, text, model: handle.model}));
}

// The vendor's own rows, with two substitutions: a thread id is the peer's native id, and a
// turn's end is a milestone for this worker, not a result — the worker is still there.
function rows(handle, message) {
  for (const event of codex.normalize(message)) {
    if (event.kind === 'peer.native') handle.stream.push({kind: 'native', provider: 'codex', sessionId: event.sessionId});
    else if (event.kind === 'result') continue; // a turn's end is decided in receive(), by the queue
    else {
      if (event.kind === 'assistant') handle.lastAssistant = event.text;
      handle.stream.push(event);
    }
  }
}

function receive(handle, line) {
  let message;
  try { message = JSON.parse(line); } catch { return; } // a malformed line never escapes the reader
  if (!message || typeof message !== 'object') return; // `null` and bare scalars are not messages
  if (message.method === undefined) {
    const pending = handle.pending.get(message.id);
    if (!pending) return; // an unmatched response id is ignored
    handle.pending.delete(message.id);
    return message.error ? pending.reject(new Error(message.error.message ?? `codex error ${message.error.code}`))
      : pending.resolve(message.result ?? {});
  }
  const completed = message.method === 'turn/completed';
  if (completed) {
    handle.running = false;
    // An interrupted turn is already reported by cancel(): it reports nothing of its own, and
    // above all it does not hand the queue to a process that is about to be killed.
    if (message.params?.interrupted === true || handle.cancelled) return;
  }
  rows(handle, message);
  if (!completed) return;
  const summary = handle.lastAssistant ?? 'turn completed';
  handle.lastAssistant = null;
  if (handle.queue.length) {
    handle.stream.push({kind: 'milestone', text: summary});
    startTurn(handle, handle.queue.shift()).catch(() => {});
    return;
  }
  handle.resulted = true;
  handle.stream.push({kind: 'result', status: 'completed', text: summary});
  // The server exits on EOF; the group kill is only the fallback for one that does not.
  try { handle.child.stdin.end(); } catch {}
  setTimeout(() => { if (!handle.exited) handle.stop().catch(() => {}); }, 1500).unref();
}

// The one place a process event becomes a log row. A result is the worker's own end.
async function pump(handle, source) {
  for await (const event of source) {
    if (event.kind === 'line') {
      if (event.text.length <= MAX_LINE) receive(handle, event.text);
      continue;
    }
    if (event.kind === 'diagnostic') { handle.stream.push(event); continue; }
    if (event.kind === 'error') { handle.stream.push({kind: 'error', code: event.code, text: event.text}); break; }
    if (!handle.cancelled && !handle.resulted) handle.stream.push({kind: 'result',
      status: event.limited ? 'limited' : event.code === 0 ? 'completed' : 'failed'});
    break;
  }
  finish(handle);
}

export function createCodexLive({spawn = spawnProcess, kill = process.kill} = {}) {
  const stop = handle => verifiedCancel(handle.child, {kill});
  // A failed handshake leaves no orphan: the process is killed before the caller sees the error.
  const begin = async (handle, run) => {
    try { return await run(); } catch (error) { await stop(handle); throw error; }
  };

  async function connect({profile = {}, peer, cwd, dir}) {
    const executable = resolveExecutable('codex', profile.executables?.codex);
    // keepStdin: requests are written for the life of the peer, so the pipe is never ended early.
    const live = spawnLive({executable, args: ['app-server'], cwd, env: vendorEnv(), keepStdin: true, spawn});
    const handle = {provider: 'codex', peer, child: live.child, pid: live.child.pid, cwd, dir,
      model: profile.model ?? null, threadId: null, queue: [], pending: new Map(), nextId: 1,
      running: false, exited: false, cancelled: false, resulted: false, lastAssistant: null, stream: makeStream(), stop: () => stop(handle)};
    pump(handle, live.events);
    await begin(handle, async () => {
      await request(handle, REQUESTS.initialize());
      notify(handle, REQUESTS.initialized());
    });
    return handle;
  }

  const opened = (handle, threadId, text) => begin(handle, async () => {
    handle.threadId = threadId;
    handle.stream.push({kind: 'native', provider: 'codex', sessionId: threadId});
    await startTurn(handle, text);
    return handle;
  });

  return {
    name: 'codex',
    capabilities: () => ({live: false, resume: true, modelPin: true, policies: ['yolo', 'plan'], quota: 'query'}),

    async launch({peer, profile, orders = '', cwd, dir}) {
      const handle = await connect({profile, peer, cwd, dir});
      const started = await begin(handle, () => request(handle, REQUESTS.threadStart()));
      return opened(handle, started.threadId ?? null, orders);
    },

    async resume({peer, profile, native = {}, message = '', cwd, dir}) {
      const handle = await connect({profile, peer, cwd, dir});
      const resumed = await begin(handle, () => request(handle, REQUESTS.threadResume(native.sessionId)));
      return opened(handle, resumed.threadId ?? native.sessionId ?? null, message);
    },

    events: handle => handle.stream.iterator,

    // Never `live`: one turn at a time per thread, so a mid-turn message waits for the next one.
    // `queued` is only for a peer that is gone, a queue that is full, or a turn that would not start.
    async deliver(handle, {text}) {
      const coerced = String(text);
      if (coerced.length > TEXT_MAX) return 'queued';
      if (handle.exited || handle.cancelled) return 'queued';
      if (!handle.running) return startTurn(handle, coerced).then(() => 'next-turn', () => 'queued');
      if (handle.queue.length >= MAX_QUEUE) return 'queued';
      handle.queue.push(coerced);
      return 'next-turn';
    },

    async cancel(handle) {
      handle.cancelled = true;
      if (!handle.exited && handle.threadId) await bounded(request(handle, REQUESTS.turnInterrupt(handle.threadId)));
      const result = handle.exited ? {verified: true} : await stop(handle);
      finish(handle);
      return result;
    },
  };
}
