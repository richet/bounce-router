import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createLocalAdmission} from '../src/local-admission.js';

function event(session, predicate) {
  const current = session.events.find(predicate);
  if (current) return Promise.resolve(current);
  return new Promise(resolve => {
    const unsubscribe = session.subscribe(row => {
      if (predicate(row)) {unsubscribe(); resolve(row);}
    });
  });
}

test('scheduler local admission queues visibly, cancels without launch, and binds reports', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-local-scheduler-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  let launches = 0;
  const adapter = {
    capabilities: () => ({executionPolicies: ['read-only']}),
    async launch(options) {
      launches++;
      assert.equal(options.profile.localResolved.instance, 'loaded');
      await options.report({report: {op: 'milestone', phase: 'reading', text: 'Read source', next: 'report'}});
      let end;
      const pending = new Promise(resolve => {end = resolve;});
      return {end, pending};
    },
    async *events(handle) {await handle.pending;},
    async cancel(handle) {handle.end(); return {verified: true};},
  };
  const localAdmission = createLocalAdmission({discover: async () => [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [
    {id: 'model', ref: 'lmstudio/model', type: 'llm', tools: true, ready: true, instances: [{id: 'loaded', context: 8192}]},
  ]}]});
  const profiles = {worker: {adapter: 'local', backend: 'lmstudio', endpoint: 'lmstudio', model: 'auto', mode: 'yolo', policy: 'read-only', fallback: []}};
  const scheduler = createScheduler({session, adapters: {local: adapter}, profiles, localAdmission, requireFinalReport: true});
  t.after(async () => {await scheduler.stop(); scheduler.close();});
  const first = scheduler.submit({profile: 'worker', orders: 'read'});
  const started = await event(session, row => ['task.started', 'task.failed'].includes(row.kind) && row.task === first.task);
  assert.equal(started.kind, 'task.started', started.text);
  const waiting = event(session, row => row.kind === 'task.milestone' && row.text?.startsWith('Waiting for LM Studio'));
  const second = scheduler.submit({profile: 'worker', orders: 'read more'});
  await waiting;
  assert.equal(launches, 1);
  assert.equal(scheduler.tasks()[second.task].state, 'queued');
  assert.deepEqual(await scheduler.cancel(second.task), {verified: true});
  assert.equal(scheduler.tasks()[second.task].state, 'cancelled');
  assert.equal(launches, 1);
  assert.equal(session.events.some(row => row.kind === 'task.milestone' && row.task === first.task && row.text === 'Read source'), true);
  assert.deepEqual(await scheduler.cancel(first.task), {verified: true});
});
