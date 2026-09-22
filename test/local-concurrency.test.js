// `local.endpoints.<name>.maxConcurrent` was parsed and never enforced: bounce launched as many local
// workers as it had tasks, LM Studio ran them all at once, and the machine swapped (observed live:
// three models, 102 GB, two running together). Now it is the number of local workers the scheduler
// will run on that endpoint at once; the rest wait in the queue and start as slots free up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async fn => { const start = Date.now(); for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
const local = name => ({adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model: 'm', mode: 'yolo', policy: 'write', fallback: [], role: name, agent: {name, description: 'x', policy: 'write', prompt: 'x'}, derived: true, localOptions: {}});

test('no more local workers run at once than the endpoint allows; the rest wait and start as slots free; cloud workers are never held', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-conc-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const gates = new Map(); let launched = [];
  const opencode = fakeAdapter(({orders}) => { const gate = Promise.withResolvers(); gates.set(orders, gate); launched.push(orders); return gate.promise; });
  const claude = fakeAdapter(({orders}) => { launched.push(orders); return [{kind: 'result', status: 'completed', text: 'cloud done'}]; });
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const profiles = {a: local('a'), b: local('b'), c: local('c'), cloud: {adapter: 'claude', model: 's', mode: 'yolo', policy: 'write', fallback: [], role: 'builder'}};
  const scheduler = createScheduler({session, adapters: {opencode, claude}, profiles, localResolver, gitHead: () => null,
    localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 2}}}});
  t.after(() => scheduler.close());
  const one = scheduler.submit({parent: null, profile: 'a', orders: 'one', deadline: null});
  const two = scheduler.submit({parent: null, profile: 'b', orders: 'two', deadline: null});
  const three = scheduler.submit({parent: null, profile: 'c', orders: 'three', deadline: null});
  const cloud = scheduler.submit({parent: null, profile: 'cloud', orders: 'cloud', deadline: null});
  await waitFor(() => launched.includes('cloud') && launched.filter(o => o !== 'cloud').length === 2);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(launched.filter(o => o !== 'cloud'), ['one', 'two'], 'only two local workers launched');
  assert.equal(scheduler.tasks()[three.task].state, 'queued');
  const waiting = session.events.find(e => e.kind === 'task.milestone' && e.task === three.task);
  assert.equal(waiting.text, 'Waiting for a local slot on lmstudio: 2 of 2 in use');
  await waitFor(() => scheduler.tasks()[cloud.task].state === 'completed');

  gates.get('one').resolve([{kind: 'result', status: 'completed', text: 'done one'}]);
  await waitFor(() => launched.includes('three'));
  assert.deepEqual(launched.filter(o => o !== 'cloud'), ['one', 'two', 'three']);
  gates.get('two').resolve([{kind: 'result', status: 'completed', text: 'done two'}]);
  gates.get('three').resolve([{kind: 'result', status: 'completed', text: 'done three'}]);
  await waitFor(() => ['completed', 'accepted'].includes(scheduler.tasks()[three.task]?.state));
  assert.equal(session.events.filter(e => e.kind === 'task.milestone' && /local slot/.test(e.text)).length, 1, 'said once, not on every reconcile');
});
