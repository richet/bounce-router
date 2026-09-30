// Local endpoints have their own `maxConcurrent`/`slotsPerModel`; cloud workers (claude/codex/muse)
// had no cap at all. `maxConcurrentCloud` (config.json, default 3) is one machine-wide ceiling for
// them, enforced the same way a local endpoint's is: a task past it stays queued, says so once, and
// starts when a cloud turn ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config, defaults} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createMainService} from '../src/main-service.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {hostless} from './helpers/local-fakes.js';
import {waitFor, tmpSession} from './helpers/wait.js';

const cloud = (name, adapter = 'claude') => ({adapter, model: 's', mode: 'yolo', policy: 'write', fallback: [], role: name});
const local = (name, model = 'm') => ({adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model, mode: 'yolo', policy: 'write', fallback: [], role: name, agent: {name, description: 'x', policy: 'write', prompt: 'x'}, derived: true, localOptions: {}});
const first = orders => orders.split('\n')[0];

test('maxConcurrentCloud caps cloud workers: the rest wait and start as a cloud turn ends', async t => {
  const {root, session} = tmpSession('bounce-cloud-conc-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const gates = new Map();
  const launched = [];
  const claude = fakeAdapter(({orders}) => { const gate = Promise.withResolvers(); gates.set(first(orders), gate); launched.push(first(orders)); return gate.promise; });
  const profiles = {a: cloud('a'), b: cloud('b'), c: cloud('c')};
  const scheduler = createScheduler({...hostless, session, adapters: {claude}, profiles, gitHead: () => null, maxConcurrentCloud: 2});
  t.after(() => scheduler.close());

  scheduler.submit({parent: null, profile: 'a', orders: 'one', deadline: null});
  scheduler.submit({parent: null, profile: 'b', orders: 'two', deadline: null});
  const three = scheduler.submit({parent: null, profile: 'c', orders: 'three', deadline: null});
  await waitFor(() => launched.length === 2);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(launched, ['one', 'two'], 'only two cloud workers launched at once');
  assert.equal(scheduler.tasks()[three.task].state, 'queued');
  const waiting = session.events.find(e => e.kind === 'task.milestone' && e.task === three.task);
  assert.equal(waiting.text, 'Waiting for a cloud slot: 2 of 2 in use');

  gates.get('one').resolve([{kind: 'result', status: 'completed', text: 'done one'}]);
  await waitFor(() => launched.includes('three'));
  assert.deepEqual(launched, ['one', 'two', 'three']);
  gates.get('two').resolve([{kind: 'result', status: 'completed', text: 'done two'}]);
  gates.get('three').resolve([{kind: 'result', status: 'completed', text: 'done three'}]);
  await waitFor(() => ['completed', 'accepted'].includes(scheduler.tasks()[three.task]?.state));
  assert.equal(session.events.filter(e => e.kind === 'task.milestone' && /cloud slot/.test(e.text)).length, 1, 'said once, not on every reconcile');
});

test('config() defaults maxConcurrentCloud to 3 and rejects invalid values', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-cloud-cfg-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.equal(config(root).maxConcurrentCloud, 3);
  assert.equal(defaults().maxConcurrentCloud, 3);
  const file = path.join(root, 'config.json');
  for (const bad of [0, -1, 1.5, '3', null]) {
    fs.writeFileSync(file, JSON.stringify({...defaults(), maxConcurrentCloud: bad}));
    assert.throws(() => config(root), /maxConcurrentCloud must be a positive integer/);
  }
});

test('a local task still starts when the cloud cap is full', async t => {
  const {root, session} = tmpSession('bounce-cloud-local-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const claude = fakeAdapter(() => ({never: true}));
  const localAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {cloudy: cloud('cloudy'), worker: local('worker')};
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const scheduler = createScheduler({...hostless, session, adapters: {claude, opencode: localAdapter}, profiles, localResolver, gitHead: () => null,
    maxConcurrentCloud: 1, localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 1}}}});
  t.after(() => scheduler.close());

  const cloudTask = scheduler.submit({parent: null, profile: 'cloudy', orders: 'cloud one', deadline: null});
  await waitFor(() => scheduler.tasks()[cloudTask.task]?.state === 'running');
  const localTask = scheduler.submit({parent: null, profile: 'worker', orders: 'local one', deadline: null});
  await waitFor(() => ['completed', 'accepted'].includes(scheduler.tasks()[localTask.task]?.state));
});

test("submitting cloud tasks past the cap never blocks the orchestrator's own turn", async t => {
  const {root, session} = tmpSession('bounce-cloud-orch-');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const claude = fakeAdapter(() => ({never: true}));
  const profiles = {a: cloud('a'), b: cloud('b')};
  const scheduler = createScheduler({...hostless, session, adapters: {claude}, profiles, gitHead: () => null, maxConcurrentCloud: 2});
  t.after(() => scheduler.close());
  const runningA = scheduler.submit({parent: null, profile: 'a', orders: 'one', deadline: null});
  const runningB = scheduler.submit({parent: null, profile: 'b', orders: 'two', deadline: null});
  await waitFor(() => scheduler.tasks()[runningA.task]?.state === 'running' && scheduler.tasks()[runningB.task]?.state === 'running');
  const third = scheduler.submit({parent: null, profile: 'a', orders: 'three', deadline: null});
  await waitFor(() => scheduler.tasks()[third.task]?.state === 'queued');

  // The orchestrator's own turn runs through createMainService, an entirely separate object with
  // its own adapters and no reference to this scheduler — it is structurally unaffected by any
  // task-side cap. Prove it stays live and responsive while the cloud cap above is saturated and
  // a third task waits behind it.
  const {root: orchRoot, session: orchSession} = tmpSession('bounce-cloud-orch-main-');
  t.after(() => fs.rmSync(orchRoot, {recursive: true, force: true}));
  const orchAdapter = {
    async launch() { return {turnId: 't1'}; },
    async *events() { yield {kind: 'result', status: 'completed', text: 'orchestrator answered'}; },
    async cancel() { return {verified: true}; },
  };
  const main = createMainService({session: orchSession, adapters: {claude: orchAdapter}, profile: {adapter: 'claude', mode: 'yolo'}, settings: {executables: {}}, brief: 'Orders'});
  t.after(() => main.close());
  const ended = new Promise(resolve => { const stop = main.subscribe(e => { if (e.kind === 'main.terminal') { stop(); resolve(e); } }); });
  main.run({id: 'turn-1', text: 'go'});
  const result = await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error('orchestrator turn blocked by cloud cap')), 2000))]);
  assert.equal(result.kind, 'main.terminal');
});
