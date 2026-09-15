import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalAdmission} from '../src/local-admission.js';

const local = {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 1}}};
const catalog = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [
  {id: 'model', ref: 'lmstudio/model', type: 'llm', tools: true, ready: true,
    instances: [{id: 'loaded', context: 8192}], context: 8192},
]}];
const profile = {adapter: 'local', backend: 'lmstudio', endpoint: 'lmstudio', model: 'auto',
  localOptions: {maxOutputTokens: 1024}};

test('defaults admit three workers and queue the fourth until a slot is released', async () => {
  let discoveries = 0;
  const manager = createLocalAdmission({discover: async () => {discoveries++; return catalog;}});
  const first = await manager.acquire({profile});
  const second = await manager.acquire({profile});
  const third = await manager.acquire({profile});
  assert.equal(discoveries, 3);
  let status;
  const waiting = manager.acquire({profile, onStatus: text => {status = text;}});
  assert.equal(discoveries, 3);
  assert.equal(status, 'Waiting for LM Studio capacity · lmstudio');
  first.release({verified: true});
  const fourth = await waiting;
  assert.equal(discoveries, 4);
  for (const lease of [second, third, fourth]) lease.release({verified: true});
});

test('live configuration preserves outstanding leases, queued work, and quarantine', async () => {
  let discoveries = 0;
  const manager = createLocalAdmission({local, discover: async () => {discoveries++; return catalog;}});
  const first = await manager.acquire({profile});
  let waitingStatus;
  const waiting = manager.acquire({profile, onStatus: text => {waitingStatus = text;}});
  manager.configure(local);
  assert.equal(discoveries, 1);
  assert.equal(waitingStatus, 'Waiting for LM Studio capacity · lmstudio');
  first.release({verified: true});
  const second = await waiting;
  assert.equal(discoveries, 2);
  second.release({verified: false});
  manager.configure(local);
  await assert.rejects(manager.acquire({profile}), {code: 'LOCAL_CAPACITY_UNCERTAIN'});
  assert.throws(() => manager.configure({endpoints: {lmstudio: {...local.endpoints.lmstudio, url: 'http://127.0.0.1:5678'}}}), /Endpoint lmstudio changed/);
});

test('admission resolves a model snapshot and exposes cancelable capacity waiting', async () => {
  const manager = createLocalAdmission({local, discover: async () => catalog});
  const first = await manager.acquire({profile});
  assert.equal(first.profile.localResolved.instance, 'loaded');
  assert.equal(first.profile.model, 'model');
  const controller = new AbortController();
  let observed;
  const waiting = manager.acquire({profile, signal: controller.signal, onStatus: value => {observed = value;}});
  assert.equal(observed, 'Waiting for LM Studio capacity · lmstudio');
  controller.abort();
  await assert.rejects(waiting, {name: 'AbortError'});
  first.release({verified: true});
  const second = await manager.acquire({profile});
  second.release({verified: true});
});

test('unverified termination quarantines capacity and fails queued work visibly', async () => {
  const manager = createLocalAdmission({local, discover: async () => catalog});
  const first = await manager.acquire({profile});
  const waiting = manager.acquire({profile});
  first.release({verified: false});
  await assert.rejects(waiting, {code: 'LOCAL_CAPACITY_UNCERTAIN'});
  await assert.rejects(manager.acquire({profile}), {code: 'LOCAL_CAPACITY_UNCERTAIN'});
});

test('refresh failure releases slot without silently replacing an exact pin', async () => {
  let calls = 0;
  const manager = createLocalAdmission({local, discover: async () => {calls++; return catalog;}});
  await assert.rejects(manager.acquire({profile: {...profile, model: 'missing'}}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
  const next = await manager.acquire({profile});
  assert.equal(calls, 2);
  next.release({verified: true});
});

test('different endpoints cannot admit overlapping writers in the same workspace', async () => {
  const multi = {endpoints: {...local.endpoints, second: {...local.endpoints.lmstudio, url: 'http://127.0.0.1:1235'}}};
  const both = [...catalog, {...catalog[0], endpoint: 'second', models: catalog[0].models.map(model => ({...model, ref: 'second/model'}))}];
  const manager = createLocalAdmission({local: multi, discover: async () => both});
  const writer = {...profile, policy: 'write', mode: 'yolo', writePaths: ['src']};
  const first = await manager.acquire({profile: writer, cwd: '/workspace'});
  let state;
  const controller = new AbortController();
  const pending = manager.acquire({profile: {...writer, endpoint: 'second', writePaths: ['src/main.js']}, cwd: '/workspace',
    signal: controller.signal, onStatus: value => {state = value;}});
  assert.match(state, /writer ownership/);
  controller.abort();
  await assert.rejects(pending, {name: 'AbortError'});
  first.release({verified: true});
});

test('uncertain writer termination rejects conflicting waiters on other endpoints', async () => {
  const multi = {endpoints: {...local.endpoints, second: {...local.endpoints.lmstudio, url: 'http://127.0.0.1:1235'}}};
  const both = [...catalog, {...catalog[0], endpoint: 'second', models: catalog[0].models.map(model => ({...model, ref: 'second/model'}))}];
  const manager = createLocalAdmission({local: multi, discover: async () => both});
  const writer = {...profile, policy: 'write', mode: 'yolo', writePaths: ['src']};
  const first = await manager.acquire({profile: writer, cwd: '/workspace'});
  const controller = new AbortController();
  const pending = manager.acquire({profile: {...writer, endpoint: 'second'}, cwd: '/workspace', signal: controller.signal});
  first.release({verified: false});
  const timer = setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, {code: 'LOCAL_CAPACITY_UNCERTAIN'});
  clearTimeout(timer);
});
