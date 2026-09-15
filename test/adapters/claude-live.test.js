import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {createInterface} from 'node:readline';
import {spawn as realSpawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createClaudeLive, hookCommand, shellQuote} from '../../src/adapters/claude-live.js';

const fake = fileURLToPath(new URL('../helpers/fake-claude.js', import.meta.url));
const launcher = {executables: {claude: fake}};
const settingsOf = args => JSON.parse(args[args.indexOf('--settings') + 1]);
const expectedCommand = dir =>
  `node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({socket:process.env.CLAUDE_CODE_MESSAGING_SOCKET,token:process.env.CLAUDE_CODE_MESSAGING_TOKEN}),{mode:0o600})" '${dir.replace(/'/g, "'\\''")}/messaging.json'`;
const expectedSettings = dir => ({hooks: {SessionStart: [{hooks: [{type: 'command', command: expectedCommand(dir)}]}]}});

const tmp = (t, prefix = 'bcl-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
// Env is how the fake is configured; the adapter inherits process.env by design.
const withEnv = (t, vars) => {
  const old = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  t.after(() => { for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : process.env[k] = v; });
};
const waitFor = async (predicate, limit = 5000) => {
  for (let waited = 0; waited < limit; waited += 20) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 20));
  }
  return false;
};
const drain = async (adapter, handle) => { const out = []; for await (const e of adapter.events(handle)) out.push(e); return out; };
const lines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);

test('L1 launch: SessionStart hook is passed with --settings, the hook writes messaging.json, events yield raw before the native session', async t => {
  const dir = tmp(t), sock = path.join(dir, 's');
  withEnv(t, {FAKE_SOCKET: sock, FAKE_TOKEN: 'tok-l1', FAKE_SESSION: 'sess-l1', FAKE_HOLD: '', FAKE_TRAP_SIGTERM: '', FAKE_READY: '', FAKE_STDERR_LINES: ''});
  const adapter = createClaudeLive({});
  const handle = await adapter.launch({peer: {}, profile: {mode: 'yolo', ...launcher}, orders: 'do it', cwd: dir, dir});
  const events = await drain(adapter, handle);
  assert.deepEqual(settingsOf(handle.args), expectedSettings(dir));
  assert.equal(hookCommand(dir), expectedCommand(dir));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'messaging.json'), 'utf8')), {socket: `uds:${sock}`, token: 'tok-l1'});
  assert.deepEqual(events[0], {kind: 'raw', raw: {type: 'system', subtype: 'init', session_id: 'sess-l1', tools: []}});
  assert.deepEqual(events.find(e => e.kind === 'native'), {kind: 'native', provider: 'claude', sessionId: 'sess-l1'});
  assert.equal(events.filter(e => e.kind === 'raw').length, 2);
  assert.deepEqual(events.find(e => e.kind === 'result'), {kind: 'result', text: 'ok', success: true, status: 'completed'});
});

test('L1b hook literal: a task directory with a space or a quote still gets messaging.json at mode 0600', async t => {
  for (const prefix of ['bcl space-', "bcl'quote-"]) {
    const dir = tmp(t, prefix), sock = path.join(dir, 's');
    withEnv(t, {FAKE_SOCKET: sock, FAKE_TOKEN: 'tok-q', FAKE_SESSION: 'sess-q', FAKE_HOLD: '', FAKE_READY: '', FAKE_STDERR_LINES: ''});
    const adapter = createClaudeLive({});
    const handle = await adapter.launch({peer: {}, profile: {mode: 'yolo', ...launcher}, orders: 'x', cwd: dir, dir});
    await drain(adapter, handle);
    const file = path.join(dir, 'messaging.json');
    assert.equal(fs.existsSync(file), true, `no messaging.json for ${prefix}`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'tok-q');
  }
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('L2 deliver live: the message and its auth line reach the running turn over the socket', async t => {
  const dir = tmp(t), sock = path.join(dir, 's'), received = path.join(dir, 'received.log');
  withEnv(t, {FAKE_SOCKET: sock, FAKE_TOKEN: 'tok-l2', FAKE_SESSION: 'sess-l2', FAKE_RECEIVED: received, FAKE_HOLD: '1', FAKE_READY: '', FAKE_STDERR_LINES: ''});
  const adapter = createClaudeLive({});
  const handle = await adapter.launch({peer: {}, profile: {mode: 'yolo', ...launcher}, orders: 'hold', cwd: dir, dir});
  t.after(() => adapter.cancel(handle));
  assert.equal(await waitFor(() => fs.existsSync(path.join(dir, 'messaging.json'))), true);
  assert.equal(await adapter.deliver(handle, {text: 'ping'}), 'live');
  assert.equal(await waitFor(() => fs.existsSync(received) && lines(received).length === 2), true);
  assert.deepEqual(lines(received), ['{"type":"auth","token":"tok-l2"}', '{"type":"user","message":{"role":"user","content":"ping"}}']);
  assert.equal(fs.existsSync(path.join(dir, 'pending.jsonl')), false);
});

test("L2b deliver live: only Claude's authenticated user-envelope acknowledgement counts as an active-turn delivery", async t => {
  const dir = tmp(t), sock = path.join(dir, 's'), received = [];
  const server = net.createServer(socket => {
    let authenticated = false;
    createInterface({input: socket}).on('line', line => {
      const frame = JSON.parse(line);
      received.push(frame);
      if (frame.type === 'auth' && frame.token === 'protocol-test-token') authenticated = true;
    });
    socket.on('end', () => {
      const message = received[1];
      if (authenticated && message?.type === 'user' && message.message?.role === 'user' && message.message?.content === 'ping') socket.end();
    });
  });
  await new Promise(resolve => server.listen(sock, resolve));
  t.after(() => server.close());
  fs.writeFileSync(path.join(dir, 'messaging.json'), JSON.stringify({socket: `uds:${sock}`, token: 'protocol-test-token'}));
  const adapter = createClaudeLive({writeWait: 30});
  const handle = {dir, sessionId: 'sess', live: {exited: () => false}};
  assert.equal(await adapter.deliver(handle, {text: 'ping'}), 'live');
  assert.deepEqual(received, [
    {type: 'auth', token: 'protocol-test-token'},
    {type: 'user', message: {role: 'user', content: 'ping'}},
  ]);
  assert.equal(fs.existsSync(path.join(dir, 'pending.jsonl')), false);
});

test('L3 deliver next-turn: with no socket the message queues for --resume, one line per deliver', async t => {
  const dir = tmp(t);
  withEnv(t, {FAKE_SOCKET: '', FAKE_SESSION: 'sess-l3', FAKE_HOLD: '1', FAKE_READY: '', FAKE_STDERR_LINES: ''});
  const adapter = createClaudeLive({});
  const handle = await adapter.launch({peer: {}, profile: {mode: 'yolo', ...launcher}, orders: 'hold', cwd: dir, dir});
  t.after(() => adapter.cancel(handle));
  assert.equal(await adapter.deliver(handle, {text: 'a'}), 'next-turn');
  assert.equal(await adapter.deliver(handle, {text: 'b'}), 'next-turn');
  assert.deepEqual(lines(path.join(dir, 'pending.jsonl')), ['{"text":"a"}', '{"text":"b"}']);
  assert.deepEqual(adapter.pending(dir), ['a', 'b']);
});

test('L3b deliver: a forged non-string socket is refused without a connect attempt', async t => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'messaging.json'), JSON.stringify({socket: 123, token: 't'}));
  const attempts = [];
  const adapter = createClaudeLive({connect: target => { attempts.push(target); throw new Error('must not connect'); }});
  const handle = {dir, sessionId: 'sess', live: {exited: () => false}};
  assert.equal(await adapter.deliver(handle, {text: 'x'}), 'next-turn');
  assert.deepEqual(attempts, []); // a forged type is rejected before any connect, not rescued by the try
  assert.deepEqual(lines(path.join(dir, 'pending.jsonl')), ['{"text":"x"}']);
});

test('L4 resume: pending texts then the new message go on stdin, --resume carries the session id, pending empties', async t => {
  const dir = tmp(t), stdinFile = path.join(dir, 'stdin.txt');
  withEnv(t, {FAKE_SOCKET: '', FAKE_SESSION: 'sess-l4', FAKE_STDIN: stdinFile, FAKE_HOLD: '', FAKE_READY: '', FAKE_STDERR_LINES: ''});
  fs.writeFileSync(path.join(dir, 'pending.jsonl'), '{"text":"a"}\n{"text":"b"}\n');
  const adapter = createClaudeLive({});
  const handle = await adapter.resume({peer: {}, profile: {mode: 'yolo', ...launcher}, native: {sessionId: 's1'}, message: 'go', cwd: dir, dir});
  await drain(adapter, handle);
  const at = handle.args.indexOf('--resume');
  assert.deepEqual(handle.args.slice(at, at + 2), ['--resume', 's1']);
  assert.equal(fs.readFileSync(stdinFile, 'utf8'), 'a\nb\ngo');
  assert.equal(fs.readFileSync(path.join(dir, 'pending.jsonl'), 'utf8'), '');
});

test('L5 cancel: SIGTERM then SIGKILL only when needed, verified by ESRCH', async t => {
  const run = async (trap, marker) => {
    const dir = tmp(t), ready = path.join(dir, 'holding');
    withEnv(t, {FAKE_SOCKET: '', FAKE_SESSION: marker, FAKE_HOLD: '1', FAKE_TRAP_SIGTERM: trap, FAKE_READY: ready, FAKE_STDERR_LINES: ''});
    const calls = [];
    const adapter = createClaudeLive({kill: (pid, signal) => { calls.push([pid, signal]); return process.kill(pid, signal); }});
    const handle = await adapter.launch({peer: {}, profile: {mode: 'yolo', ...launcher}, orders: 'hold', cwd: dir, dir});
    // The marker is written only after the fake settled its SIGTERM disposition.
    assert.equal(await waitFor(() => fs.existsSync(ready)), true);
    return {result: await adapter.cancel(handle), calls, pid: handle.pid};
  };
  const stubborn = await run('1', 'sess-l5a');
  assert.deepEqual(stubborn.result, {verified: true});
  assert.deepEqual(stubborn.calls, [[stubborn.pid, 0], [-stubborn.pid, 'SIGTERM'], [stubborn.pid, 0],
    [-stubborn.pid, 'SIGKILL'], [stubborn.pid, 0]]);
  const polite = await run('', 'sess-l5b');
  assert.deepEqual(polite.result, {verified: true});
  assert.deepEqual(polite.calls, [[polite.pid, 0], [-polite.pid, 'SIGTERM']]);
});

test('L6 capabilities are reported honestly and no bus grant reaches the spawned CLI', async t => {
  const dir = tmp(t);
  withEnv(t, {BOUNCE_BUS: 'sock', BOUNCE_BUS_TOKEN_FILE: 'tok', BOUNCE_REMOTE_SESSION: 'r1', FAKE_SOCKET: '', FAKE_HOLD: '', FAKE_READY: '', FAKE_STDERR_LINES: ''});
  const seen = [];
  const adapter = createClaudeLive({spawn: (executable, args, options) => {
    seen.push({executable, args, options});
    return realSpawn(process.execPath, ['-e', ''], options); // spy on the call, never run a real claude
  }});
  assert.deepEqual(adapter.capabilities(), {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], executionPolicies: ['read-only', 'plan', 'yolo'], quota: 'stream'});
  const handle = await adapter.launch({peer: {}, profile: {mode: 'yolo', executables: {claude: 'claude'}}, orders: 'x', cwd: dir, dir});
  await drain(adapter, handle);
  assert.deepEqual(Object.keys(seen[0].options.env).filter(k => k.startsWith('BOUNCE_BUS')), []);
  assert.equal('BOUNCE_REMOTE_SESSION' in seen[0].options.env, false);
  assert.equal(seen[0].executable, 'claude');
  assert.deepEqual(seen[0].args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
});

test('L7 deliver: the 51st queued message is refused and the file stays at the 50-message cap', async t => {
  const dir = tmp(t);
  const adapter = createClaudeLive({});
  const handle = {dir, sessionId: 'sess', live: {exited: () => false}};
  for (let n = 0; n < 50; n++) assert.equal(await adapter.deliver(handle, {text: `m${n}`}), 'next-turn');
  assert.equal(await adapter.deliver(handle, {text: 'm50'}), 'queued');
  const written = lines(path.join(dir, 'pending.jsonl'));
  assert.equal(written.length, 50);
  assert.equal(written[49], '{"text":"m49"}');
});

test('L8 deliver: a message past the 1,000,000-character cap is refused and writes nothing', async t => {
  const dir = tmp(t);
  const adapter = createClaudeLive({connect: () => { throw new Error('must not connect'); }});
  const handle = {dir, sessionId: 'sess', live: {exited: () => false}};
  assert.equal(await adapter.deliver(handle, {text: 'x'.repeat(1_000_001)}), 'queued');
  assert.equal(fs.existsSync(path.join(dir, 'pending.jsonl')), false);
  assert.equal(await adapter.deliver(handle, {text: 'x'.repeat(1_000_000)}), 'next-turn');
  assert.equal(lines(path.join(dir, 'pending.jsonl')).length, 1);
});

test('L9 deliver: a socket that never closes times out into next-turn and leaks no handle over 12 tries', async t => {
  const dir = tmp(t), sock = path.join(dir, 's');
  // The server lives in its own process: its accepted sockets would otherwise be counted here
  // as handles of this process and hide (or fake) a client-side leak.
  const server = realSpawn(process.execPath, ['-e',
    "const net=require('net');const held=[];net.createServer(s=>held.push(s)).listen(process.argv[1],()=>console.log('up'));", sock],
    {stdio: ['ignore', 'pipe', 'ignore']});
  t.after(() => { try { process.kill(server.pid, 'SIGKILL'); } catch {} });
  await new Promise(r => server.stdout.once('data', r));
  server.stdout.destroy();
  fs.writeFileSync(path.join(dir, 'messaging.json'), JSON.stringify({socket: `uds:${sock}`, token: 't'}));
  const adapter = createClaudeLive({writeWait: 30});
  const handle = {dir, sessionId: 'sess', live: {exited: () => false}};
  assert.equal(await adapter.deliver(handle, {text: 'first'}), 'next-turn');
  const before = process._getActiveHandles().length;
  for (let n = 0; n < 12; n++) assert.equal(await adapter.deliver(handle, {text: `t${n}`}), 'next-turn');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(process._getActiveHandles().length <= before, true,
    `handles grew from ${before} to ${process._getActiveHandles().length}`);
  assert.equal(lines(path.join(dir, 'pending.jsonl')).length, 13);
});

test('L10 events: 1.1 MB of stderr still completes, and a missing executable ends as error/missing', async t => {
  const dir = tmp(t);
  withEnv(t, {FAKE_SOCKET: '', FAKE_SESSION: 'sess-l10', FAKE_HOLD: '', FAKE_READY: '', FAKE_STDERR_LINES: '1100'});
  const adapter = createClaudeLive({});
  const noisy = await adapter.launch({peer: {}, profile: {mode: 'yolo', ...launcher}, orders: 'x', cwd: dir, dir});
  const events = await drain(adapter, noisy);
  const diagnostics = events.filter(e => e.kind === 'diagnostic');
  assert.equal(diagnostics.length, 1100);
  assert.equal(diagnostics[0].text.length, 1000);
  assert.deepEqual(events.find(e => e.kind === 'result'), {kind: 'result', text: 'ok', success: true, status: 'completed'});

  const gone = await adapter.launch({peer: {}, profile: {mode: 'yolo', executables: {claude: path.join(dir, 'no-such-claude')}},
    orders: 'x', cwd: dir, dir});
  assert.deepEqual((await drain(adapter, gone)).map(e => ({kind: e.kind, code: e.code})), [{kind: 'error', code: 'missing'}]);
});

test('L11 a clean live-source EOF without a normalizer result fails the adapter protocol', async () => {
  const adapter = createClaudeLive({});
  const handle = {live: {events: (async function* () {})()}};
  assert.deepEqual(await drain(adapter, handle), [{
    kind: 'result', status: 'failed', text: 'protocol error: claude stream ended without result',
  }]);
});
