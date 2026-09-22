import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createLocalResolver} from '../src/local-resolve.js';

function event(session, predicate) {
  const current = session.events.find(predicate);
  if (current) return Promise.resolve(current);
  return new Promise(resolve => {
    const unsubscribe = session.subscribe(row => {
      if (predicate(row)) {unsubscribe(); resolve(row);}
    });
  });
}

test('a local dispatch resolves its model visibly, is cancellable while resolving, runs as many at once as the endpoint has slots, and binds reports', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-local-scheduler-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  let launches = 0;
  const adapter = {
    capabilities: () => ({executionPolicies: ['read-only']}),
    async launch(options) {
      launches++;
      assert.equal(options.profile.localResolved.instance, 'loaded');
      assert.equal(options.profile.model, 'loaded');
      await options.report({report: {op: 'milestone', phase: 'reading', text: 'Read source', next: 'report'}});
      let end; const pending = new Promise(resolve => {end = resolve;});
      return {end, pending};
    },
    async *events(handle) {await handle.pending;},
    async cancel(handle) {handle.end(); return {verified: true};},
  };
  let hold = null;
  const localResolver = createLocalResolver({local: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234'}}},
    discover: async (settings, {signal}) => {
      if (hold) await new Promise((resolve, reject) => { hold.release = resolve; signal.addEventListener('abort', () => reject(signal.reason), {once: true}); hold.entered(); });
      return [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [
        {id: 'model', ref: 'lmstudio/model', type: 'llm', tools: true, ready: true, instances: [{id: 'loaded', context: 8192}]}]}];
    }});
  const profiles = {worker: {adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model: 'auto', mode: 'yolo', policy: 'read-only', fallback: []}};
  const scheduler = createScheduler({session, adapters: {opencode: adapter}, profiles, localResolver, requireFinalReport: true,
    localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 2}}}});
  t.after(async () => {await scheduler.stop(); scheduler.close();});
  const first = scheduler.submit({profile: 'worker', orders: 'read'});
  const second = scheduler.submit({profile: 'worker', orders: 'read more'});
  await event(session, row => row.kind === 'task.started' && row.task === second.task);
  assert.equal(launches, 2, 'two local workers run at once: the endpoint has two slots (test/local-concurrency.test.js covers the third waiting)');
  assert.equal(session.events.some(row => row.kind === 'task.milestone' && row.task === first.task && row.text === 'Selected lmstudio/model · automatic selection'), true);
  assert.equal(session.events.some(row => row.kind === 'task.milestone' && row.task === first.task && row.text === 'Read source'), true);
  assert.equal(session.events.some(row => row.kind === 'task.local_release'), false, 'no lease, so nothing to release');
  // A third task with both slots taken waits for one, and is cancellable while it waits: nothing is launched.
  const held = scheduler.submit({profile: 'worker', orders: 'waits for a slot'});
  await event(session, row => row.kind === 'task.milestone' && row.task === held.task && /local slot/.test(row.text));
  assert.deepEqual(await scheduler.cancel(held.task), {verified: true});
  assert.equal(scheduler.tasks()[held.task].state, 'cancelled');
  assert.equal(launches, 2);
  // Cancelled while still resolving its model (a slot is free by then): nothing is launched.
  assert.deepEqual(await scheduler.cancel(first.task), {verified: true});
  let entered; hold = {entered: () => entered()}; const waiting = new Promise(resolve => { entered = resolve; });
  const third = scheduler.submit({profile: 'worker', orders: 'never starts'});
  await waiting;
  assert.deepEqual(await scheduler.cancel(third.task), {verified: true});
  assert.equal(scheduler.tasks()[third.task].state, 'cancelled');
  assert.equal(launches, 2);
  hold = null;
  assert.deepEqual(await scheduler.cancel(second.task), {verified: true});
});
