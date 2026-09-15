import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createLocalLive} from '../src/adapters/local-live.js';
import {createLocalAdmission} from '../src/local-admission.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-local-lifecycle-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

test('client HTTP abort never proves server inference released', async t => {
  const root = await fixture(t);
  let entered;
  const started = new Promise(resolve => {entered = resolve;});
  const fetchImpl = async url => url.endsWith('/v1/models') ? Response.json({data: []}) : new Response(new ReadableStream({
    start() {entered();}, cancel() { /* simulated server continues despite client abort */ },
  }));
  const adapter = createLocalLive({fetchImpl, runtimeFactory: () => ({prepare: async () => ({cancel: async () => ({verified: true})})})});
  const handle = await adapter.launch({cwd: root, dir: root, orders: 'work', profile: {backend: 'lmstudio', model: 'm', localResolved: {url: 'http://127.0.0.1:1234', model: 'm'}}});
  await started;
  assert.deepEqual(await adapter.cancel(handle), {verified: false});
  assert.equal(handle.inferenceSettled, false);
});

test('explicit cancellation during local launch cannot start fallback', async t => {
  const root = await fixture(t);
  const session = new Session(root, {root});
  let entered, fallbacks = 0;
  const started = new Promise(resolve => {entered = resolve;});
  const adapter = {capabilities: () => ({executionPolicies: ['read-only']}),
    launch: ({signal}) => new Promise((resolve, reject) => {
      entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('backend_unavailable'), {code: 'backend_unavailable'})), {once: true});
    }), async *events() {}, cancel: async () => ({verified: true})};
  const cloud = {...adapter, launch: async () => {fallbacks++; return {};}};
  const scheduler = createScheduler({session, adapters: {local: adapter, cloud}, watchdog: {interval: null},
    localAdmission: {acquire: async ({profile}) => ({profile, release() {}})}, profiles: {
      worker: {adapter: 'local', backend: 'lmstudio', policy: 'read-only', mode: 'plan', localOnly: false, fallback: ['cloud']},
      cloud: {adapter: 'cloud', policy: 'read-only', mode: 'plan', fallback: []},
    }});
  t.after(() => scheduler.close());
  const task = scheduler.submit({profile: 'worker', orders: 'work'});
  await started;
  const cancelled = new Promise(resolve => session.subscribe(row => {if (row.kind === 'task.cancelled') resolve(row);}));
  await scheduler.cancel(task.task);
  await cancelled;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fallbacks, 0);
  assert.equal(scheduler.tasks()[task.task].state, 'cancelled');
  assert.ok(session.events.some(row => row.kind === 'policy.fallback.skipped' && row.reason === 'explicit_cancellation'));
});

test('missing or corrupt continuation fails before any model request', async t => {
  const root = await fixture(t);
  let requests = 0;
  const adapter = createLocalLive({fetchImpl: async () => {requests++; throw new Error('must not infer');}});
  const args = {cwd: root, dir: root, native: {sessionId: path.join(root, 'local-live-history.json')}, profile: {backend: 'lmstudio', model: 'm'}, message: 'continue'};
  await assert.rejects(adapter.resume(args), {code: 'LOCAL_RESUME_UNAVAILABLE'});
  await fs.writeFile(args.native.sessionId, '{broken');
  await assert.rejects(adapter.resume(args), {code: 'LOCAL_RESUME_UNAVAILABLE'});
  assert.equal(requests, 0);
});

test('restart reconciles local containers but quarantines unacknowledged inference', async t => {
  const root = await fixture(t);
  const session = new Session(root, {root});
  session.append({kind: 'task.submitted', task: 'old', parent: null, profile: 'worker', orders: 'work', context: session.id});
  session.append({kind: 'task.local_selected', task: 'old', selection: {endpoint: 'lmstudio'}, policy: 'write'});
  session.append({kind: 'task.started', task: 'old', attempt: 1, profile: 'worker'});
  let reconciled = 0, quarantined = 0;
  const scheduler = createScheduler({session, adapters: {}, profiles: {worker: {adapter: 'local', backend: 'lmstudio', policy: 'write'}},
    localAdmission: {quarantine: () => {quarantined++;}},
    localRuntimeReconcile: async ({dir}) => {reconciled++; assert.ok(dir.endsWith('/tasks/old')); return {found: true, verified: true, artifact: '/retained/partial.json'};},
    watchdog: {interval: null}});
  t.after(() => scheduler.close());
  await scheduler.reconcile();
  assert.equal(reconciled, 1);
  assert.ok(quarantined >= 1);
  assert.equal(scheduler.tasks().old.state, 'cancelled');
  assert.ok(session.events.some(row => row.kind === 'task.artifact' && row.path === '/retained/partial.json'));
  assert.ok(session.events.some(row => row.kind === 'task.local_release' && row.verified === false));
});

test('real pre-inference snapshot rejection releases admission for the next worker', async t => {
  const root = await fixture(t), cwd = path.join(root, 'repo');
  await fs.mkdir(cwd);
  await fs.symlink('/etc/passwd', path.join(cwd, 'unsafe'));
  const session = new Session(cwd, {root: path.join(root, 'sessions')});
  let inferences = 0;
  const fetchImpl = async url => {
    if (url.endsWith('/v1/models')) return Response.json({data: []});
    inferences++;
    return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  };
  const catalogs = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [{id: 'model', ref: 'lmstudio/model', type: 'llm', ready: true, tools: true, instances: [{id: 'loaded', context: 8192}]}]}];
  const scheduler = createScheduler({session, adapters: {local: createLocalLive({fetchImpl})},
    profiles: {worker: {adapter: 'local', backend: 'lmstudio', model: 'auto', policy: 'read-only', mode: 'plan'}},
    localAdmission: createLocalAdmission({discover: async () => catalogs}), watchdog: {interval: null}});
  t.after(async () => {await scheduler.stop(); scheduler.close();});
  const terminal = () => new Promise(resolve => {
    const unsubscribe = session.subscribe(row => {if (['task.failed', 'task.completed', 'task.blocked'].includes(row.kind)) {unsubscribe(); resolve(row);}});
  });
  let ended = terminal(); scheduler.submit({profile: 'worker', orders: 'first'});
  assert.equal((await ended).kind, 'task.failed');
  assert.equal(inferences, 0);
  await fs.unlink(path.join(cwd, 'unsafe'));
  ended = terminal(); scheduler.submit({profile: 'worker', orders: 'second'});
  assert.equal((await ended).kind, 'task.completed');
  assert.equal(inferences, 1);
});

test('explicit cancellation during pending local review ends the task without review recovery', async t => {
  const root = await fixture(t), session = new Session(root, {root});
  let entered, launches = 0;
  const started = new Promise(resolve => {entered = resolve;});
  const local = {capabilities: () => ({executionPolicies: ['read-only']}), launch: ({signal}) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('backend_unavailable'), {code: 'backend_unavailable'})), {once: true});
  }), async *events() {}, cancel: async () => ({verified: true})};
  const worker = {...local, launch: async () => {launches++; return {};}};
  const scheduler = createScheduler({session, adapters: {local, worker}, profiles: {
    worker: {adapter: 'worker', policy: 'read-only', mode: 'plan'}, critic: {adapter: 'local', backend: 'lmstudio', policy: 'read-only', mode: 'plan', role: 'critic'},
  }, localAdmission: {acquire: async ({profile}) => ({profile, release() {}})}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({profile: 'worker', orders: 'work', review: {prelaunch: 'critic'}});
  await started;
  await scheduler.cancel(row.task);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.tasks()[row.task].state, 'cancelled');
  assert.equal(launches, 0);
});
