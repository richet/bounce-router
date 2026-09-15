import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createMainService} from '../src/main-service.js';

function fixture(t, provider = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-main-service-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const pending = [], calls = [];
  const adapter = {
    async launch(args) { calls.push(['launch', args]); return {turnId: 'vendor-turn'}; },
    async resume(args) { calls.push(['resume', args]); return {turnId: 'next-turn'}; },
    async *events() {
      yield {kind: 'native', provider, sessionId: 'native-thread'};
      yield {kind: 'assistant', text: 'Working'};
      yield await new Promise(resolve => pending.push(resolve));
    },
    async deliver(handle, args) { calls.push(['deliver', args]); return 'live'; },
    async cancel() { calls.push(['cancel']); pending.shift()?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
  const main = createMainService({session, adapters: {[provider]: adapter}, profile: {adapter: provider, mode: 'plan'}, settings: {executables: {}}, brief: 'Orders'});
  t.after(() => main.close());
  return {main, session, calls, pending};
}

function nextEvent(main, kind) {
  return new Promise(resolve => {
    const stop = main.subscribe(event => { if (event.kind === kind) { stop(); resolve(event); } });
  });
}

for (const provider of ['claude', 'codex', 'muse']) test(`${provider} roster uses generic delivery and is included on resumed orchestrator turns`, async t => {
  const f = fixture(t, provider);
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'before-setup', text: 'work'});
  await started;
  const notice = 'LocalWorker → local/qwen (read-only); never substitute a cloud worker';
  f.session.append({kind: 'local.profiles.activated', names: ['LocalWorker'], text: notice});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.find(([kind]) => kind === 'deliver')[1].text, notice);
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 0);
  const ended = nextEvent(f.main, 'main.terminal');
  f.pending.shift()({kind: 'result', status: 'completed'});
  await ended;
  const resumed = nextEvent(f.main, 'main.started');
  f.main.run({id: 'after-setup', text: 'test the local worker'});
  await resumed;
  assert.ok(f.calls.find(([kind]) => kind === 'resume')[1].message.includes(notice));
});

test('daemon main acknowledges immediately, steers the held turn and resumes native continuity', async t => {
  const f = fixture(t);
  const started = nextEvent(f.main, 'main.started');
  assert.equal((await f.main.run({id: 'request-1', text: 'work'})).accepted, true);
  assert.equal((await started).turnId, 'vendor-turn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.main.deliver({id: 'message-1', text: 'correction', expectedTurnId: 'vendor-turn'})).tier, 'live');
  assert.equal(f.calls.find(([kind]) => kind === 'deliver')[1].text, 'correction');
  assert.equal((await f.main.deliver({id: 'stale', text: 'wrong', expectedTurnId: 'old'})).reason, 'turn_changed');
  const completed = nextEvent(f.main, 'main.terminal');
  f.pending.shift()({kind: 'result', status: 'completed', text: 'Done'});
  assert.equal((await completed).status, 'completed');
  assert.equal(f.session.events.some(event => event.kind === 'assistant' && event.text === 'Working'), true);
  const resumed = nextEvent(f.main, 'main.started');
  await f.main.run({id: 'request-2', text: 'more'}); await resumed;
  assert.equal(f.calls.find(([kind]) => kind === 'resume')[1].native.sessionId, 'native-thread');
});

test('daemon main denies stale cancellation and refuses false completion on missing terminal result', async t => {
  const f = fixture(t);
  const started = nextEvent(f.main, 'main.started');
  await f.main.run({id: 'request-1', text: 'work'}); await started;
  assert.equal((await f.main.cancel({id: 'another-request'})).reason, 'turn_changed');
  assert.equal(f.calls.some(([kind]) => kind === 'cancel'), false);
  const ended = nextEvent(f.main, 'main.terminal');
  await f.main.cancel({id: 'request-1'});
  assert.equal((await ended).status, 'interrupted');
});

test('daemon main does not resume an unverified writer after a crash', async t => {
  const f = fixture(t);
  f.session.append({kind: 'main.started', requestId: 'lost', turnId: 'lost-turn', from: 'main'});
  let launches = 0;
  const main = createMainService({session: f.session, adapters: {codex: {launch: async () => { launches++; return {}; }}}, profile: {adapter: 'codex'}, settings: {}});
  assert.equal(main.state().state, 'blocked');
  assert.equal(main.run({text: 'more work'}).reason, 'termination_unverified');
  assert.equal((await main.cancel()).verified, false);
  assert.equal((await main.close()).verified, false);
  assert.equal(launches, 0);
});

test('main validates user attachments and passes only its saved image copies', async t => {
  const f = fixture(t);
  const file = path.join(f.session.cwd, 'sample.png');
  fs.writeFileSync(file, Buffer.from([137,80,78,71,13,10,26,10]));
  const started = nextEvent(f.main, 'main.started');
  assert.equal(f.main.run({text: 'describe this', files: [file]}).accepted, true);
  await started;
  const images = f.calls[0][1].userImages;
  assert.equal(images.length, 1);
  assert.notEqual(images[0].path, file);
  assert.equal(images[0].path.startsWith(path.join(f.session.dir, 'images')), true);
});

test('switching back to a native provider includes the intervening provider handoff', async t => {
  const f = fixture(t);
  const calls = [];
  const adapter = provider => ({
    async launch(args) { calls.push({provider, ...args}); return {}; },
    async resume(args) { calls.push({provider, ...args}); return {}; },
    async *events() { yield {kind: 'native', provider, sessionId: `${provider}-thread`}; yield {kind: 'assistant', text: `${provider} UNIQUE_RESULT`}; yield {kind: 'result', status: 'completed'}; },
    async cancel() { return {verified: true}; },
  });
  const main = createMainService({session: f.session, adapters: {codex: adapter('codex'), claude: adapter('claude')}, profile: {adapter: 'codex', mode: 'plan'}, settings: {}});
  t.after(() => main.close());
  for (const provider of ['codex', 'claude', 'codex']) {
    const terminal = nextEvent(main, 'main.terminal');
    main.run({provider, text: 'continue'});
    await terminal;
  }
  assert.equal(calls[2].native.sessionId, 'codex-thread');
  assert.match(calls[2].message, /claude UNIQUE_RESULT/);
});
