import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalResolver} from '../src/local-resolve.js';

// The only local-specific step of a dispatch: which model, and how OpenCode reaches it. No leases,
// no queue: LM Studio serialises concurrent requests itself, as a vendor API does for cloud workers.
const local = {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234'}}};
const catalog = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [
  {id: 'model', ref: 'lmstudio/model', type: 'llm', tools: true, ready: true, instances: [{id: 'loaded', context: 8192}], context: 8192}]}];
const profile = {adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model: 'auto', localOptions: {maxOutputTokens: 1024}};

test('resolve addresses the loaded instance identifier and builds the provider config OpenCode is started with', async () => {
  const statuses = [];
  const resolved = await createLocalResolver({local, discover: async () => catalog}).resolve({profile, onStatus: text => statuses.push(text)});
  assert.equal(resolved.providerID, 'lmstudio');
  assert.equal(resolved.model, 'loaded', 'the instance id is what the worker must ask for');
  assert.equal(resolved.localResolved.model, 'model', 'the resolved model ref is still recorded');
  assert.deepEqual(resolved.opencodeConfig.provider.lmstudio.options, {baseURL: 'http://127.0.0.1:1234/v1'});
  assert.deepEqual(Object.keys(resolved.opencodeConfig.provider.lmstudio.models), ['loaded']);
  assert.deepEqual(statuses, ['Refreshing local model availability · lmstudio', 'Selected lmstudio/model · automatic selection']);
  assert.equal(profile.model, 'auto', 'the input profile is not mutated');
});

test('a model with no loaded instance is addressed by its ref and loaded on demand', async () => {
  const unloaded = [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [
    {id: 'model', ref: 'lmstudio/model', type: 'llm', tools: true, ready: null, instances: [], context: 8192}]}];
  const resolved = await createLocalResolver({local, discover: async () => unloaded}).resolve({profile});
  assert.equal(resolved.model, 'model');
  assert.deepEqual(Object.keys(resolved.opencodeConfig.provider.lmstudio.models), ['model']);
});

test('any number of workers resolve at once: there is no capacity queue to wait in', async () => {
  const resolver = createLocalResolver({local, discover: async () => catalog});
  const all = await Promise.all([1, 2, 3, 4].map(() => resolver.resolve({profile})));
  assert.deepEqual(all.map(item => item.model), ['loaded', 'loaded', 'loaded', 'loaded']);
});

test('failures are named: disabled, unknown endpoint, an unusable pin, a cancelled wait', async () => {
  await assert.rejects(createLocalResolver({local: {enabled: false}}).resolve({profile}), {code: 'LOCAL_DISABLED'});
  await assert.rejects(createLocalResolver({local, discover: async () => catalog}).resolve({profile: {...profile, endpoint: 'elsewhere'}}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
  await assert.rejects(createLocalResolver({local, discover: async () => catalog}).resolve({profile: {...profile, model: 'missing'}}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(createLocalResolver({local, discover: async () => catalog}).resolve({profile, signal: controller.signal}), /cancelled/);
});

test('live configuration refuses to repoint an endpoint under running workers', () => {
  const resolver = createLocalResolver({local});
  resolver.configure(local);
  assert.throws(() => resolver.configure({endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:9999'}}}), {code: 'LOCAL_ENDPOINT_CHANGED'});
});
