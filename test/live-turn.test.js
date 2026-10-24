// Classic turns on a live adapter (docs/ARCHITECTURE.md § Classic mode): codex runs on its app-server, as the
// orchestrator does, so its answer streams instead of landing whole after `codex exec` is done.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import codex from '../src/adapters/codex.js';
import {runLiveTurn} from '../src/live-turn.js';
import {Session, Router, defaults} from '../src/core.js';

test('codex app-server answer fragments become delta rows', () => {
  assert.deepEqual(codex.normalize({method: 'item/agentMessage/delta', params: {threadId: 't', turnId: 'u', itemId: 'm', delta: 'Hel'}}), [{kind: 'delta', text: 'Hel'}]);
});

function fakeLive(script) {
  const calls = [];
  return {calls, adapter: {
    async launch(options) { calls.push(['launch', options.orders, options.profile.mode, options.profile.model]); return {script}; },
    async resume(options) { calls.push(['resume', options.native.sessionId, options.message]); return {script}; },
    async *events(handle) { for (const event of handle.script) yield event; },
    async cancel() { calls.push(['cancel']); return {verified: true}; },
  }};
}

test('runLiveTurn launches or resumes, passes the events on, and ends with the result status', async () => {
  const {adapter, calls} = fakeLive([{kind: 'native', provider: 'codex', sessionId: 'th-1'}, {kind: 'delta', text: 'Hi'}, {kind: 'assistant', text: 'Hi'}, {kind: 'usage', usage: {input: 3}}, {kind: 'result', status: 'completed', text: 'Hi'}]);
  const emitted = [];
  const result = await runLiveTurn({adapter, provider: 'codex', prompt: 'hello', model: 'gpt-x', mode: 'plan', cwd: '/w', dir: '/d', emit: e => emitted.push(e)});
  assert.equal(result.status, 'completed');
  assert.deepEqual(emitted.map(e => e.kind), ['peer.native', 'delta', 'assistant', 'usage']);
  assert.equal(emitted[0].sessionId, 'th-1');
  await runLiveTurn({adapter, provider: 'codex', prompt: 'again', resume: 'th-1', mode: 'yolo', cwd: '/w', dir: '/d', emit: () => {}});
  assert.deepEqual(calls, [['launch', 'hello', 'plan', 'gpt-x'], ['cancel'], ['resume', 'th-1', 'again'], ['cancel']]);
});

test('a cancelled live turn is cancelled, and a limited one is limited', async () => {
  const controller = new AbortController(); controller.abort();
  const {adapter} = fakeLive([{kind: 'result', status: 'interrupted'}]);
  assert.equal((await runLiveTurn({adapter, provider: 'codex', prompt: 'x', signal: controller.signal, emit: () => {}})).status, 'cancelled');
  const limited = fakeLive([{kind: 'result', status: 'limited', text: 'usage limit'}]);
  assert.equal((await runLiveTurn({adapter: limited.adapter, provider: 'codex', prompt: 'x', emit: () => {}})).status, 'limited');
});

test('a classic codex turn streams through its live adapter and journals the answer once', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-live-turn-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const {adapter} = fakeLive([{kind: 'native', provider: 'codex', sessionId: 'th-9'}, {kind: 'delta', text: 'Hel'}, {kind: 'delta', text: 'lo.'}, {kind: 'assistant', text: 'Hello.'}, {kind: 'result', status: 'completed', text: 'Hello.'}]);
  const router = new Router(session, {...defaults(), order: ['codex']}, {live: {codex: adapter}});
  assert.equal(await router.run('hi'), 'completed');
  const answers = session.events.filter(e => e.kind === 'assistant');
  assert.deepEqual(answers.map(e => [e.text, e.streamed]), [['Hello.', true]]);
  assert.equal(session.events.findLast(e => e.kind === 'peer.native').sessionId, 'th-9');
});

test('a codex whose app-server will not start falls back to codex exec for the rest of the session, and says so', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-live-fallback-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  let launches = 0;
  const adapter = {async launch() { launches++; throw new Error('unexpected argument app-server'); }, async *events() {}, async cancel() { return {verified: true}; }};
  const ran = [];
  const runner = async options => { ran.push(options.args[0]); options.emit({kind: 'assistant', text: 'from exec'}); return {status: 'completed'}; };
  const router = new Router(session, {...defaults(), order: ['codex']}, {runner, live: {codex: adapter}});
  assert.equal(await router.run('one'), 'completed');
  assert.equal(await router.run('two'), 'completed');
  assert.equal(launches, 1, 'the app-server is not tried again this session');
  assert.deepEqual(ran, ['exec', 'exec']);
  assert.match(session.events.find(e => e.kind === 'status' && /app-server/.test(e.text)).text, /codex app-server did not start \(unexpected argument app-server\); this session uses codex exec, whose answers arrive whole/);
});

test('a turn whose provider streams from a side channel takes the answer from it and holds the result until it settles', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-side-channel-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const order = [];
  let side;
  const prepare = async (provider, options) => {
    side = options.emit;
    return {args: ['run', '--server', 'http://x'], env: {OPENCODE_PASSWORD: 'p'}, ownsText: true,
      async close() { side({kind: 'delta', text: 'lo.'}); side({kind: 'assistant', text: 'Hello.'}); order.push('closed'); }};
  };
  const runner = async options => {
    order.push(`ran ${options.args.join(' ')} ${options.env.OPENCODE_PASSWORD}`);
    side({kind: 'progress', text: 'Thinking · ~25 tokens'});
    side({kind: 'delta', text: 'Hel'});
    options.emit({kind: 'assistant', text: 'Hello.'});
    options.emit({kind: 'result', text: 'Hello.', success: true});
    return {status: 'completed'};
  };
  const settings = {...defaults(), order: ['opencode'], models: {opencode: 'lmstudio/m'}};
  const router = new Router(session, settings, {runner, prepare});
  assert.equal(await router.run('hi'), 'completed');
  assert.deepEqual(order, ['ran run --server http://x p', 'closed']);
  assert.deepEqual(session.events.filter(e => e.kind === 'assistant').map(e => [e.text, e.streamed]), [['Hello.', true]], 'one copy, from the side channel');
  const kinds = session.events.map(e => e.kind);
  assert.ok(kinds.indexOf('result') > kinds.indexOf('assistant'), 'the run\'s result lands after the streamed answer');
});
