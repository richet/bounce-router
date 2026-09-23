import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCodexLive} from '../../src/adapters/codex-live.js';
import {version} from '../../src/update.js';

// The fake stands in for `codex` itself: the adapter spawns it as the executable and talks the
// app-server protocol to it. No test ever spawns a real vendor CLI.
const fakeExecutable = fileURLToPath(new URL('../helpers/fake-codex-app-server.js', import.meta.url));

const waitFor = async (condition, what) => {
  for (let tries = 0; tries < 400; tries++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

// Reads exactly `count` events off one iterable without closing it: the iterator has no return(),
// so a break here leaves the stream open for the next turn.
async function take(iterable, count) {
  const rows = [];
  for await (const row of iterable) {
    rows.push(row);
    if (rows.length === count) break;
  }
  return rows;
}
// Drains an iterable to its end — the only honest way to assert a row is absent.
async function drain(iterable) {
  const rows = [];
  for await (const row of iterable) rows.push(row);
  return rows;
}

// --- the real fake process ------------------------------------------------
function harness(t, {delay = 0, env = {}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-live-'));
  const logPath = path.join(root, 'fake.log');
  const spawned = [];
  const adapter = createCodexLive({
    spawn(executable, args, options) {
      const child = spawn(executable, args, {...options, env: {...options.env, FAKE_LOG: logPath, FAKE_DELAY_MS: String(delay), ...env}});
      spawned.push({executable, args, options, child});
      return child;
    },
  });
  const handles = [];
  // The fake executable is applied last: no caller can accidentally reach the real `codex`.
  const open = async (method, {profile, ...rest} = {}) => {
    const handle = await adapter[method]({peer: 'worker:probe', cwd: root, dir: root, ...rest,
      profile: {...profile, executables: {codex: fakeExecutable}}});
    handles.push(handle);
    return handle;
  };
  t.after(async () => {
    for (const handle of handles) await adapter.cancel(handle);
    fs.rmSync(root, {recursive: true, force: true});
  });
  const received = () => {
    try { return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const methods = name => received().filter(message => message.method === name);
  return {adapter, spawned, received, methods, root,
    launch: extra => open('launch', extra), resume: extra => open('resume', extra)};
}

// --- a scripted server, for lines a well-behaved fake would never send ----
function scriptedServer() {
  const stdout = new PassThrough(), stderr = new PassThrough(), emitter = new EventEmitter();
  const written = [];
  const spawned = [];
  const child = {
    pid: 4242,
    stdin: {write: chunk => {written.push(chunk); return true;}, end() {}, on() {}, destroyed: false},
    stdout, stderr,
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    kill() {},
  };
  const lines = () => written.join('').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return {child, lines, spawned, spawn: (...args) => { spawned.push(args); return child; },
    send: message => stdout.write(typeof message === 'string' ? message + '\n' : JSON.stringify(message) + '\n'),
    close: (code, signal = null) => emitter.emit('close', code, signal),
    fail: error => emitter.emit('error', error),
    expect: count => waitFor(() => lines().length >= count, `${count} requests`)};
}
const goneKill = () => { throw Object.assign(new Error('no such process'), {code: 'ESRCH'}); };

async function scriptedLaunch({model, profile = {}, connectBus} = {}) {
  const server = scriptedServer();
  const adapter = createCodexLive({spawn: server.spawn, kill: goneKill, ...(connectBus ? {connectBus} : {})});
  const launching = adapter.launch({peer: 'worker:s', profile: {...profile, executables: {codex: 'codex'}, ...(model ? {model} : {})},
    orders: 'go', cwd: '/tmp', dir: '/tmp'});
  await server.expect(1);
  server.send({id: 1, result: {}});
  await server.expect(3); // initialized (a notification) and thread/start
  server.send({id: 2, result: {thread: {id: 't-9'}}});
  await server.expect(4);
  server.send({id: 3, result: {turn: {id: 'u-1'}}});
  const handle = await launching;
  return {adapter, handle, server};
}

async function scriptedResume({profile = {}, connectBus} = {}) {
  const server = scriptedServer();
  const adapter = createCodexLive({spawn: server.spawn, kill: goneKill, ...(connectBus ? {connectBus} : {})});
  const resuming = adapter.resume({peer: 'worker:s', profile: {...profile, executables: {codex: 'codex'}},
    native: {sessionId: 't-old'}, message: 'again', cwd: '/tmp', dir: '/tmp'});
  await server.expect(1);
  server.send({id: 1, result: {}});
  await server.expect(3);
  server.send({id: 2, result: {thread: {id: 't-current'}}});
  await server.expect(4);
  server.send({id: 3, result: {turn: {id: 'u-current'}}});
  return {adapter, handle: await resuming, server};
}

test('X1 launch drives the handshake; a turn that ends with nothing queued is the result and the server exits', async t => {
  const h = harness(t);
  const handle = await h.launch({orders: 'do the thing'});
  const rows = await take(h.adapter.events(handle), 4);

  assert.deepEqual(h.received().map(message => message.method),
    ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.deepEqual(h.received()[0], {id: 1, method: 'initialize', params: {clientInfo: {name: 'bounce', version}}});
  assert.deepEqual(h.received().map(message => message.id), [1, undefined, 2, 3]);
  const turn = h.methods('turn/start')[0];
  assert.deepEqual(turn.params.input, [{type: 'text', text: 'do the thing'}]);
  assert.equal(turn.params.threadId, 't-1');
  assert.equal(turn.params.model, undefined);

  assert.equal(handle.threadId, 't-1');
  assert.deepEqual(rows[0], {kind: 'native', provider: 'codex', sessionId: 't-1'});
  assert.equal(rows[0].sessionId, handle.threadId);
  assert.equal(rows[1].kind, 'assistant');
  assert.equal(rows[1].text, 'echo: do the thing');
  assert.equal(rows[2].kind, 'usage');
  // CONTRACT.md #5: mapped to {input, cache_read, cache_write, output} before yielding — the
  // fake's default usage carries no cached_input_tokens, so cache_read stays absent.
  assert.deepEqual(rows[2].usage, {input: 1, cache_read: 0, output: 1});
  assert.deepEqual(rows[3], {kind: 'result', status: 'completed', text: 'echo: do the thing'});
  await waitFor(() => handle.exited, 'the server exits on EOF after the result');
  assert.deepEqual((await take(h.adapter.events(handle), 1)), []); // one result, never a second on exit
});

test('X2 a delivery queued mid-turn makes the first turn a milestone and the second the result, on one iterable', async t => {
  const h = harness(t, {delay: 120});
  const handle = await h.launch({orders: 'first'});
  const stream = h.adapter.events(handle);
  assert.deepEqual(await take(stream, 1), [{kind: 'native', provider: 'codex', sessionId: 't-1'}]);
  assert.equal(await h.adapter.deliver(handle, {text: 'second'}), 'next-turn');
  assert.equal(h.adapter.events(handle), stream); // one iterable per handle, across turns

  const first = await take(stream, 3);
  assert.deepEqual(first[2], {kind: 'milestone', text: 'echo: first'});
  const second = await take(stream, 3);
  assert.equal(second[0].text, 'echo: second');
  assert.equal(second[1].kind, 'usage');
  assert.deepEqual(second[2], {kind: 'result', status: 'completed', text: 'echo: second'});

  const starts = h.methods('turn/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].params.input[0].text, 'second');
  assert.equal(starts[1].params.threadId, 't-1'); // the same thread, never a second one
  assert.equal(h.methods('thread/start').length, 1);
});

test('X2a App Server v2 uses policy-bearing thread and turn requests, and steering is bound by expectedTurnId', async t => {
  const h = harness(t, {delay: 120});
  const handle = await h.launch({orders: 'first', profile: {mode: 'plan'}});
  await take(h.adapter.events(handle), 1);

  assert.deepEqual(h.methods('thread/start')[0].params, {
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
  });
  assert.deepEqual(h.methods('turn/start')[0].params, {
    threadId: 't-1',
    input: [{type: 'text', text: 'first'}],
    approvalPolicy: 'on-request',
    sandboxPolicy: {type: 'readOnly'},
  });
  assert.equal(await h.adapter.deliver(handle, {text: 'steer', expectedTurnId: 'u-1'}), 'live');
  assert.deepEqual(h.methods('turn/steer')[0].params, {
    threadId: 't-1',
    expectedTurnId: 'u-1',
    input: [{type: 'text', text: 'steer'}],
  });
  assert.equal(h.adapter.capabilities().live, true);
});

test('X2b read-only policy wins over yolo mode in App Server thread and turn settings', async t => {
  const h = harness(t);
  const handle = await h.launch({orders: 'inspect only', profile: {mode: 'yolo', policy: 'read-only'}});
  await take(h.adapter.events(handle), 1);
  assert.deepEqual(h.methods('thread/start')[0].params, {
    approvalPolicy: 'on-request', sandbox: 'read-only',
  });
  assert.deepEqual(h.methods('turn/start')[0].params, {
    threadId: 't-1', input: [{type: 'text', text: 'inspect only'}],
    approvalPolicy: 'on-request', sandboxPolicy: {type: 'readOnly'},
  });
});

test('X2c a probe worker gets the read-only sandbox: it runs commands, the OS refuses writes', async t => {
  const h = harness(t);
  const handle = await h.launch({orders: 'probe it', profile: {mode: 'yolo', policy: 'probe'}});
  await take(h.adapter.events(handle), 1);
  assert.deepEqual(h.methods('thread/start')[0].params, {approvalPolicy: 'on-request', sandbox: 'read-only'});
  assert.equal(h.adapter.capabilities().executionPolicies.includes('probe'), true);
});

test('X3 a mid-turn deliver waits: the second turn/start follows the first turn/completed', async t => {
  const h = harness(t, {delay: 120});
  const handle = await h.launch({orders: 'first'});
  const stream = h.adapter.events(handle);
  assert.deepEqual(await take(stream, 1), [{kind: 'native', provider: 'codex', sessionId: 't-1'}]);

  assert.equal(handle.running, true);
  assert.equal(await h.adapter.deliver(handle, {text: 'second'}), 'next-turn');
  assert.deepEqual(handle.queue, ['second']);
  assert.equal(h.methods('turn/start').length, 1); // nothing sent while the first turn runs

  const rows = await take(stream, 6);
  assert.deepEqual(rows.map(row => row.kind), ['assistant', 'usage', 'milestone', 'assistant', 'usage', 'result']);
  assert.equal(rows[2].text, 'echo: first');
  assert.equal(rows[5].text, 'echo: second');
  assert.equal(h.methods('turn/start').length, 2);
  assert.deepEqual(handle.queue, []);
});

test('X3a stale steering fails at its original turn and is never queued onto a successor', async t => {
  const h = harness(t, {delay: 120});
  const handle = await h.launch({orders: 'first'});
  await take(h.adapter.events(handle), 1);
  assert.equal(await h.adapter.deliver(handle, {text: 'stale', expectedTurnId: 'u-old'}), 'failed');
  assert.deepEqual(handle.queue, []);
  await waitFor(() => handle.resulted, 'the original turn to finish');
  assert.equal(h.methods('turn/start').length, 1);
});

test('X4 resume re-attaches to the thread and starts a turn on it', async t => {
  const h = harness(t);
  const handle = await h.resume({native: {sessionId: 't-42'}, message: 'again'});
  const rows = await take(h.adapter.events(handle), 4);

  assert.deepEqual(h.received().map(message => message.method),
    ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  assert.deepEqual(h.methods('thread/resume')[0].params, {
    threadId: 't-42', approvalPolicy: 'never', sandbox: 'danger-full-access',
  });
  assert.deepEqual(h.methods('turn/start')[0].params, {
    threadId: 't-42', input: [{type: 'text', text: 'again'}],
    approvalPolicy: 'never', sandboxPolicy: {type: 'dangerFullAccess'},
  });
  assert.equal(handle.threadId, 't-42');
  assert.deepEqual(rows[0], {kind: 'native', provider: 'codex', sessionId: 't-42'});
  assert.deepEqual(rows[3], {kind: 'result', status: 'completed', text: 'echo: again'});
  assert.equal(h.methods('thread/start').length, 0);
});

test('X5 cancel mid-turn interrupts, kills the group, and the turn reports nothing', async t => {
  const h = harness(t, {delay: 5000});
  const handle = await h.launch({orders: 'a turn that never ends'});
  const stream = h.adapter.events(handle);
  assert.deepEqual(await take(stream, 1), [{kind: 'native', provider: 'codex', sessionId: 't-1'}]);
  const {pid} = handle;

  const rest = drain(stream); // the iterable must end, so this must resolve
  assert.deepEqual(await h.adapter.cancel(handle), {verified: true});
  assert.deepEqual(h.methods('turn/interrupt')[0].params, {threadId: 't-1', turnId: 'u-1'});
  assert.equal(handle.exited, true);

  assert.deepEqual(await rest, []); // no result, no usage, no milestone for an interrupted turn
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }, 'the process group to be gone');
});

test('an interrupted or cancelled turn/completed never drains the queue', async t => {
  const h = harness(t, {delay: 120});
  const handle = await h.launch({orders: 'first'});
  assert.equal(await h.adapter.deliver(handle, {text: 'second'}), 'next-turn');
  assert.deepEqual(handle.queue, ['second']);

  handle.cancelled = true; // what cancel() sets before the interrupt goes out
  await waitFor(() => handle.running === false, 'the first turn to complete');

  assert.deepEqual(handle.queue, ['second']); // still queued: nothing was handed to a dying process
  assert.equal(h.methods('turn/start').length, 1);

  // The same window from the other side: the peer is idle, but it is being cancelled.
  assert.equal(await h.adapter.deliver(handle, {text: 'third'}), 'queued');
  assert.equal(h.methods('turn/start').length, 1);
});

test('X6 the reader ignores malformed, null, oversized and unmatched lines', async t => {
  const {adapter, handle, server} = await scriptedLaunch();
  const stream = adapter.events(handle);

  server.send('{not json');
  server.send('null');
  server.send('[1,2,3]');
  server.send({id: 99, result: {threadId: 'forged'}}); // no request ever carried id 99
  server.send(JSON.stringify({method: 'item/completed',
    params: {item: {type: 'agentMessage', text: 'x'.repeat(1_048_756)}}})); // over 1 MiB
  server.send({method: 'item/completed', params: {threadId: 't-9', turnId: 'u-1', completedAtMs: 1,
    item: {id: 'i-1', type: 'agentMessage', text: 'survivor'}}});
  server.send({method: 'thread/tokenUsage/updated', params: {threadId: 't-9', turnId: 'u-1', tokenUsage: {
    last: {inputTokens: 2, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 5},
    total: {inputTokens: 2, cachedInputTokens: 0, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 5},
  }}});
  server.send({method: 'turn/completed', params: {threadId: 't-9', turn: {id: 'u-1', items: [], status: 'completed'}}});

  const rows = await take(stream, 4);
  assert.deepEqual(rows[0], {kind: 'native', provider: 'codex', sessionId: 't-9'});
  assert.deepEqual(rows[1], {kind: 'assistant', text: 'survivor'});
  assert.equal(rows[2].kind, 'usage');
  assert.deepEqual(rows[3], {kind: 'result', status: 'completed', text: 'survivor'});
  assert.equal(handle.threadId, 't-9'); // the forged id resolved nothing
  assert.deepEqual(adapter.capabilities(),
    {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], executionPolicies: ['read-only', 'probe', 'plan', 'yolo'], quota: 'query'});
});

test('the vendor process sees no bus keys, is detached, and gets the task cwd', async t => {
  const h = harness(t);
  process.env.BOUNCE_BUS = '/tmp/bus.sock';
  process.env.BOUNCE_BUS_TOKEN_FILE = '/tmp/bus.token';
  process.env.BOUNCE_REMOTE_SESSION = 'session-1';
  t.after(() => {
    delete process.env.BOUNCE_BUS; delete process.env.BOUNCE_BUS_TOKEN_FILE; delete process.env.BOUNCE_REMOTE_SESSION;
  });

  const handle = await h.launch({orders: 'go'});
  const {executable, args, options} = h.spawned[0];
  assert.equal(executable, fakeExecutable);
  assert.deepEqual(args, ['app-server']);
  assert.equal(options.cwd, h.root);
  assert.equal(options.detached, true);
  assert.equal(options.env.BOUNCE_BUS, undefined);
  assert.equal(options.env.BOUNCE_BUS_TOKEN_FILE, undefined);
  assert.equal(options.env.BOUNCE_REMOTE_SESSION, undefined);
  assert.equal(options.env.PATH, process.env.PATH);
  assert.equal(handle.cwd, h.root);
});

test('a scoped report grant is a parent-side experimental dynamic tool, never child socket authority', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-report-'));
  const tokenFile = path.join(root, 'report-token');
  fs.writeFileSync(tokenFile, 'test-token', {mode: 0o600});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const reported = [], connections = [];
  const connectBus = async connection => {
    connections.push(connection);
    return {tasks: ['s'], report: async report => { reported.push(report); }, close: async () => {}};
  };
  const report = {op: 'final', outcome: 'completed', phase: 'done', text: 'finished', next: 'none', summary: 'done'};
  const {handle, server} = await scriptedLaunch({profile: {mode: 'plan', report: {
    BOUNCE_REPORT_BUS: '/private/tmp/not-in-child.sock', BOUNCE_REPORT_TOKEN_FILE: tokenFile, task: 's',
  }}, connectBus});

  assert.deepEqual(server.spawned[0][1], ['app-server']);
  assert.deepEqual(server.lines()[0].params.capabilities, {experimentalApi: true});
  assert.equal(server.spawned[0][2].env.BOUNCE_REPORT_BUS, undefined);
  assert.equal(server.spawned[0][2].env.BOUNCE_REPORT_TOKEN_FILE, undefined);
  assert.deepEqual(server.lines().find(line => line.method === 'thread/start').params.dynamicTools, [{
    type: 'function', name: 'bounce_report', description: 'Publish a progress or final report for this assigned worker attempt.',
    inputSchema: {type: 'object', properties: {
      op: {enum: ['milestone', 'blocked', 'input_required', 'final']},
      outcome: {enum: ['completed', 'failed', 'blocked', 'input_required']},
      phase: {type: 'string'}, text: {type: 'string'}, next: {type: 'string'}, summary: {type: 'string'},
      evidence: {type: 'array', items: {type: 'string'}}, remaining: {type: 'string'},
    }, required: ['op', 'phase', 'text', 'next']},
  }]);

  server.send({id: 40, method: 'item/tool/call', params: {
    threadId: handle.threadId, turnId: handle.turnId, callId: 'report-1', tool: 'bounce_report', arguments: report,
  }});
  await server.expect(5);
  assert.deepEqual(server.lines().at(-1), {id: 40, result: {success: true, contentItems: [{type: 'inputText', text: 'report accepted'}]}});
  assert.deepEqual(connections, [{path: '/private/tmp/not-in-child.sock', token: 'test-token'}]);
  assert.deepEqual(reported, [report]);

  // A stale turn, another tool, and a replay are all rejected before the bus is contacted.
  server.send({id: 41, method: 'item/tool/call', params: {threadId: handle.threadId, turnId: 'u-stale',
    callId: 'stale', tool: 'bounce_report', arguments: report}});
  server.send({id: 42, method: 'item/tool/call', params: {threadId: handle.threadId, turnId: handle.turnId,
    callId: 'wrong-tool', tool: 'not_bounce_report', arguments: report}});
  server.send({id: 43, method: 'item/tool/call', params: {threadId: handle.threadId, turnId: handle.turnId,
    callId: 'report-1', tool: 'bounce_report', arguments: report}});
  await server.expect(8);
  assert.deepEqual(server.lines().slice(-3).map(line => line.result), [
    {success: false, contentItems: [{type: 'inputText', text: 'report rejected'}]},
    {success: false, contentItems: [{type: 'inputText', text: 'report rejected'}]},
    {success: false, contentItems: [{type: 'inputText', text: 'report rejected'}]},
  ]);
  assert.equal(connections.length, 1);
});

test('resume re-declares the report tool, binds it to the current turn, and rejects an old task grant', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-report-resume-'));
  const tokenFile = path.join(root, 'report-token');
  fs.writeFileSync(tokenFile, 'test-token', {mode: 0o600});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let connected = 0;
  const {handle, server} = await scriptedResume({profile: {report: {
    BOUNCE_REPORT_BUS: '/private/tmp/not-in-child.sock', BOUNCE_REPORT_TOKEN_FILE: tokenFile, task: 's',
  }}, connectBus: async () => {
    connected++;
    return {tasks: ['previous-task'], report: async () => assert.fail('old grant must not report'), close: async () => {}};
  }});
  assert.deepEqual(server.spawned[0][1], ['app-server']);
  assert.deepEqual(server.lines()[0].params.capabilities, {experimentalApi: true});
  const resumed = server.lines().find(line => line.method === 'thread/resume');
  assert.equal(resumed.params.threadId, 't-old');
  assert.equal(resumed.params.dynamicTools[0].name, 'bounce_report');
  assert.equal(handle.threadId, 't-current');
  assert.equal(handle.turnId, 'u-current');
  server.send({id: 50, method: 'item/tool/call', params: {threadId: 't-old', turnId: 'u-current',
    callId: 'old-turn', tool: 'bounce_report', arguments: {op: 'milestone', phase: 'p', text: 't', next: 'n'}}});
  server.send({id: 51, method: 'item/tool/call', params: {threadId: 't-current', turnId: 'u-current',
    callId: 'old-grant', tool: 'bounce_report', arguments: {op: 'milestone', phase: 'p', text: 't', next: 'n'}}});
  await server.expect(6);
  assert.deepEqual(server.lines().slice(-2).map(line => line.result), [
    {success: false, contentItems: [{type: 'inputText', text: 'report rejected'}]},
    {success: false, contentItems: [{type: 'inputText', text: 'report rejected'}]},
  ]);
  assert.equal(connected, 1); // only the current turn reaches the bus, where its old token is refused
});

test('a clean process EOF without turn/completed fails the adapter protocol', async () => {
  for (const [code, stderr] of [[0, ''], [1, ''], [1, 'rate limit exceeded']]) {
    const {adapter, handle, server} = await scriptedLaunch();
    const rows = drain(adapter.events(handle));
    if (stderr) server.child.stderr.write(stderr + '\n');
    await new Promise(resolve => setTimeout(resolve, 20)); // let readline hand the line to spawnLive
    server.close(code);
    assert.deepEqual((await rows).filter(row => row.kind === 'result'), [{
      kind: 'result', status: 'failed', text: 'protocol error: codex app-server exited without turn/completed',
    }], `exit ${code} with stderr ${JSON.stringify(stderr)}`);
    assert.equal(handle.exited, true);
  }
});

test('a cancelled worker reports no result when its process ends', async () => {
  const {adapter, handle, server} = await scriptedLaunch();
  const rows = drain(adapter.events(handle));
  handle.cancelled = true; // what cancel() sets before the signals go out
  server.close(0);         // the exit those signals cause: cancel() already journals the outcome
  assert.deepEqual(await rows, [{kind: 'native', provider: 'codex', sessionId: 't-9'}]);
  assert.equal(handle.exited, true);
});

test('a failed or interrupted terminal status wins over assistant preamble', async () => {
  for (const [status, expected] of [['failed', 'failed'], ['interrupted', 'interrupted'], ['completed', 'completed']]) {
    const {adapter, handle, server} = await scriptedLaunch();
    server.send({method: 'item/completed', params: {threadId: 't-9', turnId: 'u-1', completedAtMs: 1,
      item: {id: 'i-1', type: 'agentMessage', text: 'opening text'}}});
    server.send({method: 'turn/completed', params: {threadId: 't-9', turn: {
      id: 'u-1', items: [], status, ...(status === 'failed' ? {error: {message: `${status} detail`}} : {}),
    }}});
    await waitFor(() => handle.resulted, 'terminal result');
    const rows = drain(adapter.events(handle));
    server.close(0);
    assert.deepEqual((await rows).filter(row => row.kind === 'result'),
      [{kind: 'result', status: expected, text: status === 'completed' ? 'opening text' : status === 'failed' ? `${status} detail` : status}]);
  }
});

test('a process error ends the stream with its own code', async () => {
  const {adapter, handle, server} = await scriptedLaunch();
  const rows = drain(adapter.events(handle));
  server.fail(Object.assign(new Error('spawn codex ENOENT'), {code: 'ENOENT'}));
  assert.deepEqual(await rows, [{kind: 'native', provider: 'codex', sessionId: 't-9'},
    {kind: 'error', code: 'missing', text: 'spawn codex ENOENT'}]);
  assert.equal(handle.exited, true);
});

test('deliver is bounded and never throws: cap at 50, queued once the peer is gone', async t => {
  const h = harness(t, {delay: 2000});
  const handle = await h.launch({orders: 'long'});
  for (let i = 0; i < 50; i++) assert.equal(await h.adapter.deliver(handle, {text: `m${i}`}), 'next-turn');
  assert.equal(handle.queue.length, 50);
  assert.equal(await h.adapter.deliver(handle, {text: 'over'}), 'queued');
  assert.equal(handle.queue.length, 50); // the 51st is not enqueued either
  assert.equal(handle.queue[49], 'm49');

  await h.adapter.cancel(handle);
  assert.equal(await h.adapter.deliver(handle, {text: 'after'}), 'queued');
  assert.equal(h.methods('turn/start').length, 1);
});

test('a pinned model rides on every turn/start', async t => {
  const h = harness(t, {delay: 120});
  const handle = await h.launch({orders: 'first', profile: {model: 'gpt-5-codex'}});
  await take(h.adapter.events(handle), 1);
  assert.equal(await h.adapter.deliver(handle, {text: 'second'}), 'next-turn'); // queued mid-turn
  await waitFor(() => h.methods('turn/start').length === 2, 'the second turn');
  assert.deepEqual(h.methods('turn/start').map(message => message.params.model), ['gpt-5-codex', 'gpt-5-codex']);
});

test('a missing executable during handshake retains classification and process ownership', async () => {
  const server = scriptedServer();
  let killed = 0;
  const adapter = createCodexLive({spawn: () => server.child, kill: (...args) => { killed++; return goneKill(); }});
  const launching = adapter.launch({peer: 'worker:x', profile: {executables: {codex: 'codex'}},
    orders: 'go', cwd: '/tmp', dir: '/tmp'});
  await server.expect(1);
  server.fail(Object.assign(new Error('spawn codex ENOENT'), {code: 'ENOENT'}));
  await assert.rejects(launching, error => {
    assert.equal(error.code, 'missing');
    assert.equal(error.handle.child, server.child);
    return true;
  });
  assert.equal(killed >= 1, true); // verifiedCancel probed the pid rather than leaving it running
});

test('a request deadline rejects an unanswered App Server request and cancels its process', async () => {
  const server = scriptedServer();
  let killed = 0;
  const adapter = createCodexLive({spawn: () => server.child, kill: (...args) => { killed++; return goneKill(); }, requestTimeoutMs: 20});
  const launching = adapter.launch({peer: 'worker:x', profile: {executables: {codex: 'codex'}},
    orders: 'go', cwd: '/tmp', dir: '/tmp'});
  await server.expect(1);
  const outcome = await Promise.race([
    launching.then(() => 'resolved', () => 'rejected'),
    new Promise(resolve => setTimeout(() => resolve('timed out'), 100)),
  ]);
  assert.equal(outcome, 'rejected');
  assert.equal(killed >= 1, true);
  // An App Server that does not answer is an unavailable backend, not a bare error: that code is
  // what lets the scheduler try the task's next AI (found live on a timed-out thread/resume).
  const error = await launching.catch(e => e);
  assert.deepEqual([error.code, error.message], ['backend_unavailable', 'codex app-server request timed out: initialize']);
});

test('a thread response without an id rejects at the adapter boundary and leaves no process behind', async () => {
  const server = scriptedServer();
  let killed = 0;
  const adapter = createCodexLive({spawn: () => server.child, kill: (...args) => { killed++; return goneKill(); }});
  const launching = adapter.launch({peer: 'worker:x', profile: {executables: {codex: 'codex'}},
    orders: 'go', cwd: '/tmp', dir: '/tmp'});
  const rejected = assert.rejects(launching, /codex thread response did not include a thread id/);
  await server.expect(1);
  server.send({id: 1, result: {}});
  await server.expect(3);
  server.send({id: 2, result: {thread: {id: null}}});

  await rejected;
  assert.equal(server.lines().length, 3); // invalid state is never forwarded into turn/start
  assert.equal(killed >= 1, true);
});

// --- vendor usage limits become `limited`, so the scheduler's fallback chain fires ---------------
// Observed live: a `build` task on codex died as task.failed{reason:'error'} with "You've hit your
// usage limit …" three seconds after task.started, and its configured fallback never ran.
import {Session} from '../../src/core.js';
import {createScheduler} from '../../src/scheduler.js';
import {fakeAdapter} from '../helpers/fake-adapter.js';

test('a turn/start refused with the usage-limit text rejects launch with code limited and leaves no process', async t => {
  const h = harness(t, {env: {FAKE_LIMIT: 'launch'}});
  await assert.rejects(h.launch({orders: 'go'}), error => error.code === 'limited' && /hit your usage limit/.test(error.message));
  await waitFor(() => h.spawned[0].child.exitCode !== null || h.spawned[0].child.signalCode !== null, 'the refused server to be gone');
});

test('a turn that fails with the usage-limit text — in turn/completed or an error notification — is a limited result', async t => {
  for (const mode of ['turn', 'notify']) {
    const h = harness(t, {env: {FAKE_LIMIT: mode}});
    const handle = await h.launch({orders: 'go'});
    const rows = await drain(h.adapter.events(handle));
    const result = rows.find(row => row.kind === 'result');
    assert.equal(result.status, 'limited', mode);
    assert.match(result.text, /hit your usage limit/);
  }
});

test('a plain failed turn stays failed: only the error channel classifies exhaustion', async () => {
  const {adapter, handle, server} = await scriptedLaunch();
  server.send({method: 'item/completed', params: {threadId: 't-9', turnId: 'u-1', completedAtMs: 1,
    item: {id: 'i-1', type: 'agentMessage', text: 'the docs mention a rate limit of 429 per hour'}}});
  server.send({method: 'turn/completed', params: {threadId: 't-9', turn: {id: 'u-1', items: [], status: 'failed', error: {message: 'sandbox denied'}}}});
  await waitFor(() => handle.resulted, 'terminal result');
  const rows = drain(adapter.events(handle));
  server.close(0);
  assert.deepEqual((await rows).filter(row => row.kind === 'result'), [{kind: 'result', status: 'failed', text: 'sandbox denied'}]);
});

// Through the scheduler, with the real adapter over the fake app-server: the quota failure is
// task.failed{reason:'limited'} and the task is replaced on the profile's fallback.
for (const mode of ['launch', 'turn']) test(`a codex worker limited at ${mode} falls back to the next profile`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-fallback-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const codex = createCodexLive({spawn: (executable, args, options) => spawn(executable, args, {...options, env: {...options.env, FAKE_LIMIT: mode}})});
  const claude = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done on claude'}]);
  const profiles = {
    build: {adapter: 'codex', model: 'gpt-6-astra', mode: 'yolo', fallback: ['build_claude'], executables: {codex: fakeExecutable}},
    build_claude: {adapter: 'claude', mode: 'yolo', fallback: []},
  };
  const scheduler = createScheduler({session, adapters: {codex, claude}, profiles});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'build', orders: 'write the note', deadline: null});
  const failed = session.events.find(e => e.kind === 'task.failed' && e.task === row.task) ?? await new Promise(resolve => {
    const stop = session.subscribe(e => { if (e.kind === 'task.failed' && e.task === row.task) { stop(); resolve(e); } });
  });
  assert.equal(failed.reason, 'limited');
  assert.match(failed.text, /hit your usage limit/);
  await waitFor(() => session.events.some(e => e.kind === 'policy.fallback' && e.task === row.task), 'fallback');
  const fallback = session.events.find(e => e.kind === 'policy.fallback' && e.task === row.task);
  assert.deepEqual([fallback.from_profile, fallback.to_profile, fallback.reason], ['build', 'build_claude', 'limited']);
  const retry = session.events.find(e => e.kind === 'task.submitted' && e.replaces === row.task);
  assert.equal(retry.profile, 'build_claude');
  await waitFor(() => scheduler.tasks()[retry.task]?.state === 'completed', 'fallback completion');
  assert.equal(claude.calls.launch, 1);
});

// Found live: codex's own tracing went to stderr and every line landed in the
// transcript — 23 copies of an `rmcp::transport` MCP error the user cannot act on from here. Its tracing
// is counted and summarised once; anything else it says on stderr still comes through untouched.
test('X9 codex tracing on stderr is summarised, not repeated; real stderr still shows', async t => {
  const {vendorTracing} = await import('../../src/adapters/codex-live.js');
  assert.equal(vendorTracing('\u001b[2m2026-09-22T17:40:53.830094Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mrmcp::transport::worker\u001b[0m: worker quit with fatal: Transport channel closed'), true);
  assert.equal(vendorTracing('2026-09-22T17:40:53Z  WARN codex_core::config: two servers need OAuth'), true);
  assert.equal(vendorTracing('error: could not find codex home'), false, 'a plain message is not tracing');
  assert.equal(vendorTracing(''), false);
});
