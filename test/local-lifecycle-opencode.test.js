import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {hostless} from './helpers/local-fakes.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-oc-lifecycle-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}

// Adapter-agnostic lifecycle properties ported from test/local-lifecycle.test.js onto the
// `opencode` adapter name, before the legacy `local` adapter is deleted. These exercise the
// SCHEDULER's admission/cancellation orchestration (admission leases, cancellation during launch,
// fallback suppression), which does not depend on which local adapter is behind the `opencode`
// profile name — exactly as the legacy tests themselves used minimal adapter doubles rather than
// a real worker process, to isolate the scheduler behaviour from adapter internals.
//
// See the handback report for the three legacy cases NOT ported here (one container-specific pair
// dropped, one genuine capability gap discovered and left unpatched since src/ is off-limits).

test('explicit cancellation during opencode launch cannot start fallback', async t => {
  const root = await fixture(t);
  const session = new Session(root, {root});
  let entered, fallbacks = 0;
  const started = new Promise(resolve => {entered = resolve;});
  const adapter = {capabilities: () => ({executionPolicies: ['read-only']}),
    launch: ({signal}) => new Promise((resolve, reject) => {
      entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('backend_unavailable'), {code: 'backend_unavailable'})), {once: true});
    }), async *events() {}, cancel: async () => ({verified: true})};
  const cloud = {...adapter, launch: async () => {fallbacks++; return {};}};
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter, cloud}, watchdog: {interval: null},
    localResolver: {resolve: async ({profile}) => profile}, profiles: {
      worker: {adapter: 'opencode', backend: 'lmstudio', policy: 'read-only', mode: 'plan', localOnly: false, fallback: ['cloud']},
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

test('explicit cancellation during pending opencode review ends the task without review recovery', async t => {
  const root = await fixture(t);
  const session = new Session(root, {root});
  let entered, launches = 0;
  const started = new Promise(resolve => {entered = resolve;});
  const opencode = {capabilities: () => ({executionPolicies: ['read-only']}), launch: ({signal}) => new Promise((resolve, reject) => {
    entered(); signal.addEventListener('abort', () => reject(Object.assign(new Error('backend_unavailable'), {code: 'backend_unavailable'})), {once: true});
  }), async *events() {}, cancel: async () => ({verified: true})};
  const worker = {...opencode, launch: async () => {launches++; return {};}};
  const scheduler = createScheduler({...hostless, session, adapters: {opencode, worker}, profiles: {
    worker: {adapter: 'worker', policy: 'read-only', mode: 'plan'}, critic: {adapter: 'opencode', backend: 'lmstudio', policy: 'read-only', mode: 'plan', role: 'critic'},
  }, localResolver: {resolve: async ({profile}) => profile}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({profile: 'worker', orders: 'work', review: {prelaunch: 'critic'}});
  await started;
  await scheduler.cancel(row.task);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.tasks()[row.task].state, 'cancelled');
  assert.equal(launches, 0);
});
