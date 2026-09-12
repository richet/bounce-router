import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnLive, vendorEnv, appendPending, readPending, takePending, promptSafe, verifiedCancel, PENDING_MAX, TEXT_MAX} from '../../src/adapters/live-common.js';
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'live-common-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const collect = async events => { const out = []; for await (const e of events) out.push(e); return out; };

test('spawnLive drains a megabyte of stderr, yields diagnostics, and still reaches exit', async () => {
  const {events} = spawnLive({executable: process.execPath, args: ['-e', "process.stderr.write('e'.repeat(1_100_000)); console.log('done')"]});
  const out = await collect(events);
  assert.equal(out.filter(e => e.kind === 'line').at(0).text, 'done');
  assert.ok(out.filter(e => e.kind === 'diagnostic').length >= 1);
  assert.equal(out.at(-1).kind, 'exit');
  assert.equal(out.at(-1).code, 0);
});
test('spawnLive classifies limited from the stderr tail and reports a missing executable without throwing', async () => {
  const limited = await collect(spawnLive({executable: process.execPath, args: ['-e', "console.error('rate limit exceeded'); process.exit(1)"]}).events);
  assert.equal(limited.at(-1).limited, true);
  assert.equal(limited.at(-1).code, 1);
  const missing = await collect(spawnLive({executable: '/nonexistent/bounce-live-fixture', args: []}).events);
  assert.equal(missing[0].kind, 'error');
  assert.equal(missing[0].code, 'missing');
});
test('vendorEnv strips every bus key and the remote-session flag, nothing else', () => {
  const env = vendorEnv({PATH: '/bin', BOUNCE_BUS: 'x', BOUNCE_BUS_TOKEN_FILE: 'y', BOUNCE_BUS_EXTRA: 'z', BOUNCE_REMOTE_SESSION: '1', BOUNCE_HOME: '/h'});
  assert.deepEqual(env, {PATH: '/bin', BOUNCE_HOME: '/h'});
});
test('pending queue: torn lines are skipped but still count toward the cap; caps and types are enforced; take empties the file', t => {
  const file = path.join(tmp(t), 'pending.jsonl');
  assert.equal(appendPending(file, 'a'), true);
  fs.appendFileSync(file, '{"text":\n');
  assert.equal(appendPending(file, 'b'), true);
  assert.deepEqual(readPending(file), ['a', 'b']);
  for (let i = 0; i < PENDING_MAX; i++) appendPending(file, 'x' + i);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, PENDING_MAX);
  assert.equal(appendPending(file, 'overflow'), false);
  assert.equal(appendPending(path.join(tmp(t), 'p2.jsonl'), 'y'.repeat(TEXT_MAX + 1)), false);
  assert.equal(appendPending(path.join(tmp(t), 'p3.jsonl'), 42), false);
  assert.equal(takePending(file).length, PENDING_MAX - 1); // 50 raw lines, one of them torn
  assert.equal(fs.statSync(file).size, 0);
});
test('promptSafe flattens newlines and cuts to 1000 characters; non-strings are coerced', () => {
  assert.equal(promptSafe('a\nb\r\nc'), 'a b c');
  assert.equal(promptSafe('x'.repeat(1500)).length, 1000);
  assert.equal(promptSafe(null), 'null');
});
test('verifiedCancel: SIGTERM suffices for a cooperative child; a SIGTERM-trapping child needs SIGKILL; both verified within bounds', async () => {
  const kills = [];
  const spy = (pid, sig) => { kills.push(sig); return process.kill(pid, sig); };
  const ready = async live => { for await (const e of live.events) if (e.kind === 'line' && e.text === 'ready') return; };
  const nice = spawnLive({executable: process.execPath, args: ['-e', "console.log('ready'); setInterval(() => {}, 1000)"]});
  await ready(nice);
  const t0 = Date.now();
  assert.deepEqual(await verifiedCancel(nice.child, {kill: spy}), {verified: true});
  assert.ok(kills.includes('SIGTERM') && !kills.includes('SIGKILL'));
  assert.ok(Date.now() - t0 < 1500);
  kills.length = 0;
  const stubborn = spawnLive({executable: process.execPath, args: ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"]});
  await ready(stubborn);
  assert.deepEqual(await verifiedCancel(stubborn.child, {kill: spy, termWait: 300}), {verified: true});
  assert.ok(kills.includes('SIGTERM') && kills.includes('SIGKILL'));
  assert.deepEqual(await verifiedCancel(stubborn.child, {kill: spy}), {verified: true});
});

test('spawnLive keepStdin leaves stdin open for a persistent peer; the default still sends EOF', async () => {
  const echo = "process.stdin.on('data', d => process.stdout.write('got:' + d)); process.stdin.on('end', () => { console.log('eof'); process.exit(0); })";
  const closed = spawnLive({executable: process.execPath, args: ['-e', echo], stdin: 'a\n'});
  const lines = []; for await (const e of closed.events) if (e.kind === 'line') lines.push(e.text);
  assert.deepEqual(lines, ['got:a', 'eof']);
  const open = spawnLive({executable: process.execPath, args: ['-e', echo], keepStdin: true});
  open.child.stdin.write('b\n');
  const it = open.events[Symbol.asyncIterator]();
  const next = async () => (await it.next()).value;
  let e = await next(); while (e.kind !== 'line') e = await next();
  assert.equal(e.text, 'got:b');
  open.child.stdin.end();
  const rest = []; for (e = await next(); e; e = await next()) { rest.push(e.kind === 'line' ? e.text : e.kind); if (e.kind === 'exit') break; }
  assert.deepEqual(rest, ['eof', 'exit']);
});
