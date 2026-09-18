import {spawn as spawnProcess} from 'node:child_process';
import fs from 'node:fs';
import codex from './codex.js';
import {connectBus} from '../bus.js';
import {resolveExecutable} from '../executable.js';
import {limitPattern} from '../providers.js';
import {spawnLive, vendorEnv, verifiedCancel, TEXT_MAX} from './live-common.js';
import {validateReport} from '../reporting.js';
import {version} from '../update.js';

// The Codex peer: one long-lived `codex app-server` process per worker, driven over stdio
// JSON-RPC ("lite": one object per line, `jsonrpc` omitted, numeric ids on requests). A thread
// is started once and every delivery is a turn on it, one turn at a time. A delivery carrying the
// active turn id can steer that turn; otherwise it waits for the next turn. A turn that ends with deliveries queued is a
// milestone and the next turn starts; a turn that ends with nothing queued is the task's result and
// the worker ends with it — continuing a completed task is resume(), never a lingering server.

// Every wire shape in one table: a vendor version bump is one edit.
const REQUESTS = {
  // codex-cli ≥ 0.154 refuses an initialize without clientInfo (`Invalid request: missing field
  // clientInfo`, observed live: every worker launch failed before any work).
  initialize: ({experimentalApi = false} = {}) => ({method: 'initialize', params: {
    clientInfo: {name: 'bounce', version}, ...(experimentalApi ? {capabilities: {experimentalApi: true}} : {}),
  }}),
  initialized: () => ({method: 'initialized'}),
  threadStart: permissions => ({method: 'thread/start', params: permissions.thread}),
  threadResume: ({threadId, permissions}) => ({method: 'thread/resume', params: {threadId, ...permissions.thread}}),
  turnStart: ({threadId, text, model, permissions, userImages = []}) => ({method: 'turn/start',
    params: {threadId, input: [{type: 'text', text}, ...userImages.map(image => ({type: 'localImage', path: image.path}))], ...permissions.turn, ...(model ? {model} : {})}}),
  turnSteer: ({threadId, expectedTurnId, text}) => ({method: 'turn/steer',
    params: {threadId, expectedTurnId, input: [{type: 'text', text}]}}),
  turnInterrupt: ({threadId, turnId}) => ({method: 'turn/interrupt', params: {threadId, turnId}}),
};

// CONTRACT.md #5: same usage-mapping obligation as claude-live.js, codex's own vendor field
// names — input_tokens→input, cached_input_tokens→cache_read, output_tokens→output (codex
// reports no cache_write). The classic normalizer (src/adapters/codex.js) is unchanged.
const USAGE_FIELDS = [['input_tokens', 'input'], ['cached_input_tokens', 'cache_read'], ['output_tokens', 'output']];
const mapUsage = raw => {
  const usage = {};
  for (const [from, to] of USAGE_FIELDS) if (Number.isInteger(raw?.[from])) usage[to] = raw[from];
  return usage;
};

const MAX_LINE = 1024 * 1024; // a line this long is a protocol fault, not a message
const MAX_QUEUE = 50;
const INTERRUPT_MS = 1000; // how long the polite interrupt gets before the signals start
const REQUEST_TIMEOUT_MS = 10_000;
const REPORT_TOOL = 'bounce_report';

// This is deliberately a dynamic function rather than a shell command. Codex's read-only
// sandbox cannot open the daemon's Unix socket, and the grant stays in this parent process.
// validateReport is still authoritative; this schema is the vendor-facing description only.
const REPORT_TOOL_SPEC = {
  type: 'function', name: REPORT_TOOL,
  description: 'Publish a progress or final report for this assigned worker attempt.',
  inputSchema: {type: 'object', properties: {
    op: {enum: ['milestone', 'blocked', 'input_required', 'final']},
    outcome: {enum: ['completed', 'failed', 'blocked', 'input_required']},
    phase: {type: 'string'}, text: {type: 'string'}, next: {type: 'string'}, summary: {type: 'string'},
    evidence: {type: 'array', items: {type: 'string'}}, remaining: {type: 'string'},
  }, required: ['op', 'phase', 'text', 'next']},
};

const reportGrant = (profile, peer) => {
  const grant = profile?.report;
  const task = typeof peer === 'string' && peer.startsWith('worker:') ? peer.slice('worker:'.length) : null;
  if (!task || !grant || typeof grant.BOUNCE_REPORT_BUS !== 'string' || !grant.BOUNCE_REPORT_BUS
    || typeof grant.BOUNCE_REPORT_TOKEN_FILE !== 'string' || !grant.BOUNCE_REPORT_TOKEN_FILE
    || (grant.task !== undefined && grant.task !== task)) return null;
  return grant;
};

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
  for (const pending of handle.pending.values()) {
    handle.clearTimeout(pending.timer);
    pending.reject(handle.launchError ?? new Error('codex app-server closed'));
  }
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
  const timer = handle.setTimeout(() => {
    if (!handle.pending.delete(id)) return;
    reject(new Error(`codex app-server request timed out: ${method}`));
  }, handle.requestTimeoutMs);
  handle.pending.set(id, {resolve, reject, timer});
  if (!write(handle, {id, method, params})) {
    handle.pending.delete(id);
    handle.clearTimeout(timer);
    reject(new Error('codex app-server closed'));
  }
});

function permissionsFor(profile = {}, peer) {
  const effective = profile.policy === 'read-only' ? 'read-only' : profile.mode === 'plan' ? 'plan' : 'yolo';
  const dynamicTools = reportGrant(profile, peer) ? {dynamicTools: [REPORT_TOOL_SPEC]} : {};
  if (effective === 'yolo') {
    return {thread: {approvalPolicy: 'never', sandbox: 'danger-full-access', ...dynamicTools},
      turn: {approvalPolicy: 'never', sandboxPolicy: {type: 'dangerFullAccess'}}};
  }
  return {thread: {approvalPolicy: 'on-request', sandbox: 'read-only', ...dynamicTools},
    turn: {approvalPolicy: 'on-request', sandboxPolicy: {type: 'readOnly'}}};
}

const toolResult = (success, text) => ({success, contentItems: [{type: 'inputText', text}]});

// A dynamic call is accepted only for this currently-running vendor turn. The task id is bound
// twice: to the worker peer here and to the bus grant (whose authenticated task list we check)
// before the bus invokes its own validateReport-backed report path.
async function handleReportTool(handle, message) {
  const params = message.params;
  const reject = () => write(handle, {id: message.id, result: toolResult(false, 'report rejected')});
  if (!Number.isInteger(message.id) || !params || typeof params !== 'object'
    || params.tool !== REPORT_TOOL || typeof params.callId !== 'string' || !params.callId
    || params.threadId !== handle.threadId || params.turnId !== handle.turnId
    || !handle.running || handle.cancelled || handle.resulted || !handle.report
    || validateReport(params.arguments)) return reject();
  if (handle.reportCalls.has(params.callId)) return reject();
  handle.reportCalls.add(params.callId);
  let client;
  try {
    const token = fs.readFileSync(handle.report.BOUNCE_REPORT_TOKEN_FILE, 'utf8').trim();
    if (!token) throw new Error('empty report grant');
    client = await handle.connectBus({path: handle.report.BOUNCE_REPORT_BUS, token});
    if (!Array.isArray(client.tasks) || !client.tasks.includes(handle.task)) throw new Error('report grant task mismatch');
    await client.report(params.arguments);
    write(handle, {id: message.id, result: toolResult(true, 'report accepted')});
  } catch {
    // Do not disclose socket paths, tokens, or the bus's authorization details to the worker.
    reject();
  } finally {
    try { await client?.close(); } catch {}
  }
}

async function startTurn(handle, text, userImages = []) {
  handle.running = true;
  try {
    const started = await request(handle, REQUESTS.turnStart({threadId: handle.threadId, text, model: handle.model, permissions: handle.permissions, userImages}));
    // A delivery is bound to this exact vendor turn.  Do not infer it from thread identity:
    // a thread may outlive many turns and late steering must never land on its successor.
    handle.turnId = started.turn?.id ?? started.turnId ?? null;
    return started;
  } catch (error) {
    handle.running = false;
    throw error;
  }
}

// The vendor's own rows, with two substitutions: a thread id is the peer's native id, and a
// turn's end is a milestone for this worker, not a result — the worker is still there.
function rows(handle, message) {
  if (message.method === 'thread/tokenUsage/updated') {
    const raw = message.params?.tokenUsage?.last;
    const usage = {};
    for (const [from, to] of [['inputTokens', 'input'], ['cachedInputTokens', 'cache_read'], ['cacheWriteInputTokens', 'cache_write'], ['outputTokens', 'output']]) {
      if (Number.isInteger(raw?.[from])) usage[to] = raw[from];
    }
    if (Object.keys(usage).length) handle.stream.push({kind: 'usage', usage});
    return;
  }
  for (const event of codex.normalize(message)) {
    if (event.kind === 'peer.native') handle.stream.push({kind: 'native', provider: 'codex', sessionId: event.sessionId});
    else if (event.kind === 'result') continue; // a turn's end is decided in receive(), by the queue
    else if (event.kind === 'usage') {
      const usage = mapUsage(event.usage);
      if (Object.keys(usage).length) handle.stream.push({kind: 'usage', usage});
    }
    else {
      if (event.kind === 'assistant') handle.lastAssistant = event.text;
      // Only the error channel can classify a failed turn as exhaustion; assistant text may quote errors.
      if (event.kind === 'error') handle.lastError = event.text;
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
    handle.clearTimeout(pending.timer);
    if (!message.error) return pending.resolve(message.result ?? {});
    // The vendor refuses a request (turn/start, observed live) with its usage-limit text when the
    // account is exhausted: the same detector the classic path uses (providers.limitPattern)
    // tags the rejection so a launch failure becomes task.failed{reason:'limited'}, not 'error'.
    const error = new Error(message.error.message ?? `codex error ${message.error.code}`);
    if (limitPattern.test(error.message)) error.code = 'limited';
    return pending.reject(error);
  }
  if (message.method === 'item/tool/call') {
    void handleReportTool(handle, message);
    return;
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
  const terminal = message.params?.turn?.status ?? message.params?.status ?? 'completed';
  const failure = message.params?.turn?.error?.message ?? message.params?.turn?.error?.detail
    ?? message.params?.error?.message ?? message.params?.error?.detail;
  // A failed turn whose error (the turn's own, or an error notification during it) is the
  // vendor's usage-limit text is `limited`: the scheduler's fallback chain reads that status.
  const limited = terminal === 'limited' || (terminal !== 'completed' && terminal !== 'interrupted'
    && [failure, handle.lastError].some(text => typeof text === 'string' && limitPattern.test(text)));
  const status = terminal === 'completed' ? 'completed' : terminal === 'interrupted' ? 'interrupted' : limited ? 'limited' : 'failed';
  const summary = status === 'completed' ? (handle.lastAssistant ?? 'turn completed') : (failure ?? handle.lastError ?? terminal ?? 'turn failed');
  handle.lastAssistant = null;
  handle.lastError = null;
  handle.turnId = null;
  if (status === 'completed' && handle.queue.length) {
    handle.stream.push({kind: 'milestone', text: summary});
    startTurn(handle, handle.queue.shift()).catch(error => {
      if (handle.cancelled || handle.resulted) return;
      handle.resulted = true;
      handle.stream.push({kind: 'result', status: error.code === 'limited' ? 'limited' : 'failed', text: error.message});
      try { handle.child.stdin.end(); } catch {}
    });
    return;
  }
  handle.resulted = true;
  handle.stream.push({kind: 'result', status, text: summary});
  // The server exits on EOF; the group kill is only the fallback for one that does not.
  try { handle.child.stdin.end(); } catch {}
  setTimeout(() => { if (!handle.exited) handle.stop().catch(() => {}); }, 1500).unref();
}

// The one place a process event becomes a log row. A result is the worker's own end.
async function pump(handle, source) {
  let terminalEvent = false;
  for await (const event of source) {
    if (event.kind === 'line') {
      if (event.text.length <= MAX_LINE) receive(handle, event.text);
      continue;
    }
    if (event.kind === 'diagnostic') { handle.stream.push(event); continue; }
    if (event.kind === 'error') {
      handle.launchError = Object.assign(new Error(event.text), {code: event.code});
      handle.stream.push({kind: 'error', code: event.code, text: event.text});
      terminalEvent = true;
      break;
    }
    if (!handle.cancelled && !handle.resulted) {
      handle.resulted = true;
      handle.stream.push({kind: 'result', status: 'failed', text: 'protocol error: codex app-server exited without turn/completed'});
    }
    terminalEvent = true;
    break;
  }
  if (!terminalEvent && !handle.cancelled && !handle.resulted) {
    handle.resulted = true;
    handle.stream.push({kind: 'result', status: 'failed', text: 'protocol error: codex app-server stream ended without turn/completed'});
  }
  finish(handle);
}

export function createCodexLive({spawn = spawnProcess, kill = process.kill, connectBus: connectBusImpl = connectBus, requestTimeoutMs = REQUEST_TIMEOUT_MS,
  setTimeout: setTimeoutImpl = setTimeout, clearTimeout: clearTimeoutImpl = clearTimeout} = {}) {
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) throw new Error('requestTimeoutMs must be a positive number');
  const stop = handle => verifiedCancel(handle.child, {kill});
  // A failed handshake leaves no orphan: the process is killed before the caller sees the error.
  const begin = async (handle, run) => {
    try { return await run(); } catch (error) {
      // Retain ownership for callers if cleanup cannot be verified, including launch failures.
      error.handle = handle;
      await stop(handle);
      throw error;
    }
  };

  async function connect({profile = {}, peer, cwd, dir}) {
    const executable = resolveExecutable('codex', profile.executables?.codex);
    // keepStdin: requests are written for the life of the peer, so the pipe is never ended early.
    const report = reportGrant(profile, peer);
    // dynamicTools is negotiated through initialize.capabilities.experimentalApi. The grant itself
    // is intentionally never inherited by the child environment.
    const live = spawnLive({executable, args: ['app-server'], cwd,
      env: vendorEnv(process.env, profile.orchestratorEnv), keepStdin: true, spawn});
    const handle = {provider: 'codex', peer, child: live.child, pid: live.child.pid, cwd, dir,
      task: report ? peer.slice('worker:'.length) : null, report, connectBus: connectBusImpl, model: profile.model ?? null,
      permissions: permissionsFor(profile, peer), threadId: null, queue: [], pending: new Map(), nextId: 1,
      reportCalls: new Set(), running: false, exited: false, cancelled: false, resulted: false, lastAssistant: null, lastError: null, turnId: null, stream: makeStream(), stop: () => stop(handle)};
    handle.requestTimeoutMs = requestTimeoutMs;
    handle.setTimeout = setTimeoutImpl;
    handle.clearTimeout = clearTimeoutImpl;
    pump(handle, live.events);
    await begin(handle, async () => {
      await request(handle, REQUESTS.initialize({experimentalApi: Boolean(handle.report)}));
      notify(handle, REQUESTS.initialized());
    });
    return handle;
  }

  const opened = (handle, threadId, text, userImages) => begin(handle, async () => {
    if (typeof threadId !== 'string' || !threadId) throw new Error('codex thread response did not include a thread id');
    handle.threadId = threadId;
    handle.stream.push({kind: 'native', provider: 'codex', sessionId: threadId});
    await startTurn(handle, text, userImages);
    return handle;
  });

  return {
    name: 'codex',
    capabilities: () => ({live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], executionPolicies: ['read-only', 'plan', 'yolo'], quota: 'query'}),

    async launch({peer, profile, orders = '', cwd, dir, userImages = []}) {
      const handle = await connect({profile, peer, cwd, dir});
      const started = await begin(handle, () => request(handle, REQUESTS.threadStart(handle.permissions)));
      // codex-cli ≥ 0.154 answers thread/start with {thread: {id, model, reasoningEffort, …}}; older
      // builds answered {threadId}. A null id here made turn/start fail with
      // `invalid type: null, expected a string` (observed live).
      return opened(handle, started.thread?.id ?? started.threadId ?? null, orders, userImages);
    },

    async resume({peer, profile, native = {}, message = '', cwd, dir, userImages = []}) {
      const handle = await connect({profile, peer, cwd, dir});
      const resumed = await begin(handle, () => request(handle, REQUESTS.threadResume({threadId: native.sessionId, permissions: handle.permissions})));
      return opened(handle, resumed.thread?.id ?? resumed.threadId ?? native.sessionId ?? null, message, userImages);
    },

    events: handle => handle.stream.iterator,

    // Live steering is only valid for the exact active turn; ordinary delivery stays serial on
    // the thread. `queued` is only for a peer that is gone, a queue that is full, or a turn that would not start.
    async deliver(handle, {text, expectedTurnId} = {}) {
      const coerced = String(text);
      if (coerced.length > TEXT_MAX) return 'queued';
      if (handle.exited || handle.cancelled) return 'queued';
      if (expectedTurnId !== undefined && expectedTurnId !== handle.turnId) return 'failed';
      // App-server accepts steer while the exact turn is active. Its request response is the
      // transport acknowledgement; no queued delivery is silently retargeted to a later turn.
      if (handle.running && expectedTurnId !== undefined) {
        try { await request(handle, REQUESTS.turnSteer({threadId: handle.threadId, expectedTurnId, text: coerced})); return 'live'; }
        catch { return 'failed'; }
      }
      if (!handle.running) return startTurn(handle, coerced).then(() => 'next-turn', () => 'queued');
      if (handle.queue.length >= MAX_QUEUE) return 'queued';
      handle.queue.push(coerced);
      return 'next-turn';
    },

    async cancel(handle) {
      handle.cancelled = true;
      if (!handle.exited && handle.threadId && handle.turnId) await bounded(request(handle, REQUESTS.turnInterrupt({threadId: handle.threadId, turnId: handle.turnId})));
      const result = await stop(handle);
      finish(handle);
      return result;
    },
  };
}
