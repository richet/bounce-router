// The resource gate (docs/plans/resource-aware.md). Slots count turns, not memory: bounce would happily
// ask LM Studio to load a 73 GB model beside a resident one, or keep working while the machine pages.
// Decided 2026-09-22: greedy on what is actually free, unload an IDLE model to make room (with a
// warning), wait with a warning when nothing fits, and never run local while the machine is swapping —
// that one goes to the cloud instead. A machine bounce cannot read has no opinion at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const GB = 1024 ** 3;
const waitFor = async fn => { const start = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const setup = t => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-res-'))); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return new Session(root, {root}); };
const localProfile = (model, fallback = []) => ({adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model, mode: 'yolo', policy: 'write', fallback, role: 'builder',
  agent: {name: 'builder', description: 'x', policy: 'write', prompt: 'p'}});
const catalogs = models => [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models}];
const model = (id, {size, ready = false, ttl = null} = {}) => ({id, ref: `lmstudio/${id}`, type: 'llm', tools: true, ready, size, ttl, instances: ready ? [{id, context: 65536}] : [], context: 65536});
const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
const machine = over => ({known: true, ramTotal: 128 * GB, available: 30 * GB, wiredLimit: 92 * GB, swapouts: 1, swapUsed: 8 * GB, at: 0, ...over});

test('G1 a machine that is swapping does not run a local worker: it warns and the next AI takes the task', async t => {
  const session = setup(t);
  const launched = [];
  const opencode = fakeAdapter(({orders}) => { launched.push(['local', orders]); return [{kind: 'result', status: 'completed', text: 'local'}]; });
  const claude = fakeAdapter(({orders}) => { launched.push(['cloud', orders]); return [{kind: 'result', status: 'completed', text: 'cloud did it'}]; });
  const scheduler = createScheduler({session, adapters: {opencode, claude}, localResolver, gitHead: () => null,
    profiles: {b: localProfile('m', ['b~2']), 'b~2': {adapter: 'claude', model: 's', mode: 'yolo', policy: 'write', fallback: [], role: 'builder'}},
    resources: {read: () => machine(), swapping: () => true},
    localFleet: async () => catalogs([model('m', {size: 16 * GB})])});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'build it', deadline: null});
  await waitFor(() => session.events.some(e => e.kind === 'task.failed' && e.task === row.task));
  const failed = session.events.find(e => e.kind === 'task.failed' && e.task === row.task);
  assert.equal(failed.reason, 'local_unavailable');
  assert.equal(failed.text, 'the machine is swapping: a local worker would make it worse');
  await waitFor(() => launched.some(([where]) => where === 'cloud'));
  assert.deepEqual(launched.map(([where]) => where), ['cloud'], 'never launched locally');
});

test('G2 an idle resident model is unloaded to make room, with a warning naming what it freed', async t => {
  const session = setup(t);
  const unloaded = [];
  const opencode = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const scheduler = createScheduler({session, adapters: {opencode}, localResolver, gitHead: () => null,
    profiles: {b: localProfile('big')},
    resources: {read: () => machine({available: 20 * GB}), swapping: () => false},
    localFleet: async () => catalogs([model('big', {size: 24 * GB}), model('idle-one', {size: 16 * GB, ready: true, ttl: 300})]),
    unloadLocal: async name => { unloaded.push(name); }});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'build it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  assert.deepEqual(unloaded, ['lmstudio/idle-one']);
  const freed = session.events.find(e => e.kind === 'local.unloaded' && e.task === row.task);
  assert.equal(freed.text, 'Unloaded idle lmstudio/idle-one (16.0 GB) to make room for big (24.0 GB, 20.0 GB free)');
});

test('G3 when nothing fits the task waits with a warning, is escalated if it waits too long, and runs when memory frees', async t => {
  const session = setup(t);
  let available = 10 * GB, now = 0;
  const opencode = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const scheduler = createScheduler({session, adapters: {opencode}, localResolver, gitHead: () => null, clock: () => now,
    profiles: {b: localProfile('big')},
    resources: {read: () => machine({available}), swapping: () => false},
    localFleet: async () => catalogs([model('big', {size: 45 * GB})]), // nothing resident to reclaim: it simply does not fit
    localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 2, waitMinutes: 10, pollMs: 5}}}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'build it', deadline: null});
  const waiting = await waitFor(() => session.events.find(e => e.kind === 'task.milestone' && e.task === row.task && /memory/.test(e.text)));
  assert.equal(waiting.text, 'Waiting for memory on lmstudio for big: needs 45.0 GB plus a reserve of 8.0 GB, and only 10.0 GB is free');
  assert.equal(scheduler.tasks()[row.task].state, 'queued');
  now = 11 * 60000;
  const escalated = await waitFor(() => session.events.find(e => e.kind === 'policy.escalated' && e.task === row.task && e.reason === 'resources'));
  assert.equal(escalated.to, 'user');
  assert.match(escalated.text, /^big has waited 11 min for memory on lmstudio: needs 45\.0 GB/);
  available = 60 * GB;
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
});
