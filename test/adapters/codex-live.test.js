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
function harness(t, {delay = 0} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-live-'));
  const logPath = path.join(root, 'fake.log');
  const spawned = [];
  const adapter = createCodexLive({
    spawn(executable, args, options) {
      spawned.push({executable, args, options});
      return spawn(executable, args, {...options, env: {...options.env, FAKE_LOG: logPath, FAKE_DELAY_MS: String(delay)}});
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
  return {child, lines, spawn: () => child,
    send: message => stdout.write(typeof message === 'string' ? message + '\n' : JSON.stringify(message) + '\n'),
    close: (code, signal = null) => emitter.emit('close', code, signal),
    fail: error => emitter.emit('error', error),
    expect: count => waitFor(() => lines().length >= count, `${count} requests`)};
}
const goneKill = () => { throw Object.assign(new Error('no such process'), {code: 'ESRCH'}); };

async function scriptedLaunch({model} = {}) {
  const server = scriptedServer();
  const adapter = createCodexLive({spawn: server.spawn, kill: goneKill});
  const launching = adapter.launch({peer: 'worker:s', profile: {executables: {codex: 'codex'}, model},
    orders: 'go', cwd: '/tmp', dir: '/tmp'});
  await server.expect(1);
  server.send({id: 1, result: {}});
  await server.expect(3); // initialized (a notification) and thread/start
  server.send({id: 2, result: {threadId: 't-9'}});
  await server.expect(4);
  server.send({id: 3, result: {turnId: 'u-1'}});
  const handle = await launching;
  return {adapter, handle, server};
}

test('X1 launch drives the handshake; a turn that ends with nothing queued is the result and the server exits', async t => {
  const h = harness(t);
  const handle = await h.launch({orders: 'do the thing'});
  const rows = await take(h.adapter.events(handle), 4);

  assert.deepEqual(h.received().map(message => message.method),
    ['initialize', 'initialized', 'thread/start', 'turn/start']);
  assert.deepEqual(h.received()[0], {id: 1, method: 'initialize', params: {}});
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
  assert.deepEqual(rows[2].usage, {input: 1, output: 1});
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

test('X4 resume re-attaches to the thread and starts a turn on it', async t => {
  const h = harness(t);
  const handle = await h.resume({native: {sessionId: 't-42'}, message: 'again'});
  const rows = await take(h.adapter.events(handle), 4);

  assert.deepEqual(h.received().map(message => message.method),
    ['initialize', 'initialized', 'thread/resume', 'turn/start']);
  assert.deepEqual(h.methods('thread/resume')[0].params, {threadId: 't-42'});
  assert.deepEqual(h.methods('turn/start')[0].params, {threadId: 't-42', input: [{type: 'text', text: 'again'}]});
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
  assert.deepEqual(h.methods('turn/interrupt')[0].params, {threadId: 't-1'});
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
    params: {item: {type: 'agent_message', text: 'x'.repeat(1_048_756)}}})); // over 1 MiB
  server.send({method: 'thread/started', params: {thread_id: 't-9'}}); // the vendor's own native row
  server.send({method: 'item/completed', params: {item: {type: 'agent_message', text: 'survivor'}}});
  server.send({method: 'turn/completed', params: {turnId: 'u-1', usage: {input_tokens: 2, output_tokens: 3}}});

  const rows = await take(stream, 5);
  assert.deepEqual(rows[0], {kind: 'native', provider: 'codex', sessionId: 't-9'});
  assert.deepEqual(rows[1], {kind: 'native', provider: 'codex', sessionId: 't-9'}); // never `peer.native`
  assert.deepEqual(rows[2], {kind: 'assistant', text: 'survivor'});
  assert.equal(rows[3].kind, 'usage');
  assert.deepEqual(rows[4], {kind: 'result', status: 'completed', text: 'survivor'});
  assert.equal(handle.threadId, 't-9'); // the forged id resolved nothing
  assert.deepEqual(adapter.capabilities(),
    {live: false, resume: true, modelPin: true, policies: ['yolo', 'plan'], quota: 'query'});
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

test('the result row is the process exit, and its status is that exit', async () => {
  for (const [code, stderr, status] of [[0, '', 'completed'], [1, '', 'failed'], [1, 'rate limit exceeded', 'limited']]) {
    const {adapter, handle, server} = await scriptedLaunch();
    const rows = drain(adapter.events(handle));
    if (stderr) server.child.stderr.write(stderr + '\n');
    await new Promise(resolve => setTimeout(resolve, 20)); // let readline hand the line to spawnLive
    server.close(code);
    assert.deepEqual((await rows).filter(row => row.kind === 'result'), [{kind: 'result', status}],
      `exit ${code} with stderr ${JSON.stringify(stderr)}`);
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

test('a handshake that never answers rejects launch and leaves no process behind', async () => {
  const server = scriptedServer();
  let killed = 0;
  const adapter = createCodexLive({spawn: () => server.child, kill: (...args) => { killed++; return goneKill(); }});
  const launching = adapter.launch({peer: 'worker:x', profile: {executables: {codex: 'codex'}},
    orders: 'go', cwd: '/tmp', dir: '/tmp'});
  await server.expect(1);
  server.fail(Object.assign(new Error('spawn codex ENOENT'), {code: 'ENOENT'}));
  await assert.rejects(launching, /codex app-server closed/);
  assert.equal(killed >= 1, true); // verifiedCancel probed the pid rather than leaving it running
});
