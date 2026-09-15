import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverLocalModels, normalizeLocalSettings, resolveLocalModel} from '../src/local-models.js';

const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json', ...headers}});
const v1 = models => ({models});
const llm = (key, extra = {}) => ({type: 'llm', key, display_name: key, max_context_length: 8192, loaded_instances: [], ...extra});
const embedding = key => ({type: 'embedding', key, display_name: key, max_context_length: 2048, loaded_instances: []});
const local = endpoints => ({endpoints});

test('normalizes the loopback catalog defaults and rejects unsafe endpoint configuration', () => {
  assert.deepEqual(normalizeLocalSettings(), {
    enabled: true,
    endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', loadPolicy: 'loaded-only', maxConcurrent: 3}},
    preferences: {}, exclude: [], overrides: {},
  });
  assert.deepEqual(normalizeLocalSettings({endpoints: {}}).endpoints, {});
  const endpoint = {backend: 'lmstudio', url: 'http://127.0.0.1:1234'};
  assert.equal(normalizeLocalSettings({endpoints: {office: endpoint}}).endpoints.office.maxConcurrent, 3);
  assert.equal(normalizeLocalSettings({endpoints: {office: {...endpoint, maxConcurrent: 1}}}).endpoints.office.maxConcurrent, 1);
  assert.throws(() => normalizeLocalSettings({endpoints: {bad: {backend: 'lmstudio', url: 'https://key@example.test'}}}), {code: 'INVALID_LOCAL_SETTINGS'});
  assert.throws(() => normalizeLocalSettings({endpoints: {bad: {backend: 'lmstudio', url: 'http://host/?x=1'}}}), {code: 'INVALID_LOCAL_SETTINGS'});
  assert.throws(() => normalizeLocalSettings({endpoints: {'not ok': {backend: 'lmstudio', url: 'http://localhost'}}}), {code: 'INVALID_LOCAL_SETTINGS'});
  assert.throws(() => normalizeLocalSettings({endpoints: {bad: {backend: 'lmstudio', url: 'http://localhost', apiKey: 'secret'}}}), {code: 'INVALID_LOCAL_SETTINGS'});
});

test('discovers v1 metadata, keeps embeddings, and sends env auth without cataloguing it', async () => {
  const calls = [];
  const result = await discoverLocalModels(local({office: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', trusted: true, apiKeyEnv: 'LM_TOKEN'}}), {
    env: {LM_TOKEN: 'secret'},
    fetchImpl: async (url, init) => { calls.push([url, init.headers]); return response(v1([
      llm('org/model', {capabilities: {trained_for_tool_use: true}, loaded_instances: [{id: 'one', config: {context_length: 4096, parallel: 2}}]}), embedding('embed'),
    ])); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'http://127.0.0.1:1234/api/v1/models');
  assert.equal(calls[0][1].Authorization, 'Bearer secret');
  assert.deepEqual(result[0].models, [
    {id: 'org/model', ref: 'office/org/model', label: 'org/model', type: 'llm', instances: [{id: 'one', context: 4096, parallel: 2}], context: 8192, tools: true, capabilitySource: 'server', ready: true},
    {id: 'embed', ref: 'office/embed', label: 'embed', type: 'embedding', instances: [], context: 2048, tools: null, capabilitySource: 'unknown', ready: false},
  ]);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('falls back only for unsupported native versions and represents old metadata as unknown', async () => {
  const paths = [];
  const result = await discoverLocalModels(local({a: {backend: 'lmstudio', url: 'http://127.0.0.1:1235'}}), {maxAge: 0, fetchImpl: async url => {
    paths.push(new URL(url).pathname);
    return paths.length === 1 ? response({}, 404) : response({data: [{id: 'old', type: 'llm', state: 'loaded', max_context_length: 1000}]});
  }});
  assert.deepEqual(paths, ['/api/v1/models', '/api/v0/models']);
  assert.deepEqual(result[0].models[0], {id: 'old', ref: 'a/old', label: 'old', type: 'llm', instances: [], context: 1000, tools: null, capabilitySource: 'unknown', ready: null});
  let count = 0;
  const auth = await discoverLocalModels(local({b: {backend: 'lmstudio', url: 'http://127.0.0.1:1236'}}), {maxAge: 0, fetchImpl: async () => { count++; return response({}, 401); }});
  assert.equal(count, 1); assert.match(auth[0].error, /authentication/i);
});

test('does not discover disabled settings or untrusted remote endpoints', async () => {
  let calls = 0;
  assert.deepEqual(await discoverLocalModels({enabled: false}, {fetchImpl: async () => { calls++; return response({}); }}), []);
  const remote = await discoverLocalModels(local({remote: {backend: 'lmstudio', url: 'https://models.example.test'}}), {fetchImpl: async () => { calls++; return response({}); }});
  assert.equal(calls, 0);
  assert.match(remote[0].error, /trusted/i);
  await discoverLocalModels(local({ipv6: {backend: 'lmstudio', url: 'http://[::1]:1234'}}), {fetchImpl: async () => { calls++; return response(v1([])); }});
  assert.equal(calls, 1);
});

test('uses last good results as stale only after transient failures and aborts requests', async () => {
  let healthy = true;
  const settings = local({a: {backend: 'lmstudio', url: 'http://127.0.0.1:1240'}});
  const fetchImpl = async () => healthy ? response(v1([llm('good')])) : Promise.reject(new TypeError('offline'));
  await discoverLocalModels(settings, {fetchImpl, maxAge: 0}); healthy = false;
  const stale = await discoverLocalModels(settings, {fetchImpl, maxAge: 0});
  assert.equal(stale[0].stale, true); assert.equal(stale[0].models[0].id, 'good'); assert.match(stale[0].error, /unavailable/i);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(discoverLocalModels(local({z: {backend: 'lmstudio', url: 'http://127.0.0.1:1241'}}), {fetchImpl, signal: controller.signal}), {name: 'AbortError'});
});

test('caches per relevant endpoint auth revision and coalesces equal discovery requests', async () => {
  let calls = 0;
  const settings = local({a: {backend: 'lmstudio', url: 'http://127.0.0.1:1242', apiKeyEnv: 'TOKEN'}});
  const fetchImpl = async () => { calls++; return response(v1([llm('m')])); };
  await Promise.all([discoverLocalModels(settings, {fetchImpl, env: {TOKEN: 'a'}}), discoverLocalModels(settings, {fetchImpl, env: {TOKEN: 'a'}})]);
  await discoverLocalModels(settings, {fetchImpl, env: {TOKEN: 'a'}});
  await discoverLocalModels(settings, {fetchImpl, env: {TOKEN: 'b'}});
  assert.equal(calls, 2);
});

test('resolves exact pins before preferences, honors exclusions and uses loaded instance context', () => {
  const settings = normalizeLocalSettings(local({a: {backend: 'lmstudio', url: 'http://127.0.0.1:1243'}, b: {backend: 'lmstudio', url: 'http://127.0.0.1:1244', loadPolicy: 'on-demand'}}));
  const catalogs = [{provider: 'local', endpoint: 'a', backend: 'lmstudio', stale: false, models: [
    {id: 'same', ref: 'a/same', label: 'same', type: 'llm', tools: true, context: 16000, ready: true, instances: [{id: 'small', context: 2000}, {id: 'large', context: 8000}]},
    {id: 'embed', ref: 'a/embed', label: 'embed', type: 'embedding', tools: null, context: 2000, ready: true, instances: []},
  ]}, {provider: 'local', endpoint: 'b', backend: 'lmstudio', stale: false, models: [
    {id: 'same', ref: 'b/same', label: 'same', type: 'llm', tools: false, context: 16000, ready: false, instances: []},
  ]}];
  const selected = resolveLocalModel({local: settings, catalogs, profile: {backend: 'lmstudio', endpoint: 'a', model: 'same', prefer: ['b/same']}, requirements: {tools: true, context: 6000}, override: 'a/same'});
  assert.deepEqual(selected, {endpoint: 'a', backend: 'lmstudio', url: 'http://127.0.0.1:1243', model: 'same', instance: 'large', context: 8000, tools: true, loadPolicy: 'loaded-only', reason: 'override', ref: 'a/same'});
  assert.throws(() => resolveLocalModel({local: {...settings, exclude: ['a/same']}, catalogs, profile: {backend: 'lmstudio', endpoint: 'a', model: 'same'}}), {code: 'LOCAL_MODEL_EXCLUDED'});
  assert.throws(() => resolveLocalModel({local: settings, catalogs, profile: {backend: 'lmstudio', endpoint: 'a', model: 'missing'}}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
});

test('selects preference order and rejects unknown/embedding/unloaded models for loaded-only profiles', () => {
  const settings = normalizeLocalSettings({preferences: {builder: {prefer: ['a/tool', 'a/loaded']}}});
  const catalogs = [{provider: 'local', endpoint: 'lmstudio', backend: 'lmstudio', stale: false, models: []}, {provider: 'local', endpoint: 'a', backend: 'lmstudio', stale: false, models: [
    {id: 'tool', ref: 'a/tool', type: 'llm', tools: true, context: 4000, ready: true, instances: [{id: 'i', context: 4000}]},
    {id: 'loaded', ref: 'a/loaded', type: 'llm', tools: null, context: 4000, ready: true, instances: [{id: 'j', context: 4000}]},
    {id: 'unknown', ref: 'a/unknown', type: 'unknown', tools: null, context: null, ready: null, instances: []},
  ]}];
  const changed = normalizeLocalSettings({endpoints: {a: {backend: 'lmstudio', url: 'http://127.0.0.1:1250'}} , preferences: settings.preferences});
  assert.equal(resolveLocalModel({local: changed, catalogs, profile: {backend: 'lmstudio', role: 'builder'}, requirements: {tools: true}}).ref, 'a/tool');
  assert.throws(() => resolveLocalModel({local: changed, catalogs, profile: {backend: 'lmstudio', model: 'unknown'}}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
});

test('an automatic endpoint profile cannot escape to another endpoint', () => {
  const settings = normalizeLocalSettings({endpoints: {
    a: {backend: 'lmstudio', url: 'http://127.0.0.1:1260'}, b: {backend: 'lmstudio', url: 'http://127.0.0.1:1261'},
  }});
  const catalogs = ['a', 'b'].map(endpoint => ({provider: 'local', endpoint, backend: 'lmstudio', stale: false, models: [{
    id: 'm', ref: `${endpoint}/m`, label: 'm', type: 'llm', tools: endpoint === 'b', context: 4096, ready: true, instances: [{id: endpoint, context: 4096}],
  }]}));
  assert.equal(resolveLocalModel({local: settings, catalogs, profile: {backend: 'lmstudio', endpoint: 'a'}}).ref, 'a/m');
});

test('reapplies changed user capability overrides to a cached raw catalog', async () => {
  const settings = local({probe: {backend: 'lmstudio', url: 'http://127.0.0.1:1270'}});
  let calls = 0;
  const fetchImpl = async () => { calls++; return response(v1([llm('m', {capabilities: {trained_for_tool_use: true}})])); };
  assert.equal((await discoverLocalModels(settings, {fetchImpl}))[0].models[0].tools, true);
  const changed = {...settings, overrides: {'probe/m': {tools: false}}};
  const model = (await discoverLocalModels(changed, {fetchImpl}))[0].models[0];
  assert.deepEqual([calls, model.tools, model.capabilitySource], [1, false, 'user']);
});

test('a non-cooperative fetch and an oversized streamed body are independently bounded', async () => {
  const settings = local({slow: {backend: 'lmstudio', url: 'http://127.0.0.1:1271'}});
  const started = Date.now();
  const timedOut = await discoverLocalModels(settings, {timeout: 1, fetchImpl: () => new Promise(() => {})});
  assert.ok(Date.now() - started < 50); assert.match(timedOut[0].error, /timed out/i);
  const bytes = new Uint8Array(1024 * 1024 + 1); bytes.fill(32); bytes[0] = 123; bytes[bytes.length - 1] = 125;
  const tooLarge = await discoverLocalModels(local({large: {backend: 'lmstudio', url: 'http://127.0.0.1:1272'}}), {maxAge: 0, fetchImpl: async () => new Response(bytes)});
  assert.match(tooLarge[0].error, /too large/i);
});

test('coalesced callers have independent cancellation and the remaining caller completes', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const settings = local({shared: {backend: 'lmstudio', url: 'http://127.0.0.1:1273'}});
  const controller = new AbortController();
  const first = discoverLocalModels(settings, {fetchImpl: () => delayed, signal: controller.signal});
  const second = discoverLocalModels(settings, {fetchImpl: () => delayed});
  controller.abort();
  await assert.rejects(first, {name: 'AbortError'});
  release(response(v1([llm('m')])));
  assert.equal((await second)[0].models[0].id, 'm');
});

test('aborting a later coalesced caller does not interrupt the original caller', async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const settings = local({sharedlater: {backend: 'lmstudio', url: 'http://127.0.0.1:1276'}});
  const first = discoverLocalModels(settings, {fetchImpl: () => delayed});
  const controller = new AbortController();
  const second = discoverLocalModels(settings, {fetchImpl: () => delayed, signal: controller.signal});
  controller.abort();
  await assert.rejects(second, {name: 'AbortError'});
  release(response(v1([llm('m')])));
  assert.equal((await first)[0].models[0].id, 'm');
});

test('missing configured auth is reported and on-demand permits known downloaded state only', async () => {
  const auth = await discoverLocalModels(local({auth: {backend: 'lmstudio', url: 'http://127.0.0.1:1274', apiKeyEnv: 'NEEDED'}}), {fetchImpl: async () => { throw new Error('must not fetch'); }, env: {}});
  assert.match(auth[0].error, /authentication.*NEEDED/i);
  const settings = normalizeLocalSettings(local({a: {backend: 'lmstudio', url: 'http://127.0.0.1:1275', loadPolicy: 'on-demand'}}));
  const catalogs = [{provider: 'local', endpoint: 'a', backend: 'lmstudio', stale: false, models: [{id: 'org/m', ref: 'a/org/m', type: 'llm', tools: null, context: 4096, ready: null, instances: []}]}];
  assert.equal(resolveLocalModel({local: settings, catalogs, profile: {backend: 'lmstudio', endpoint: 'a', model: 'org/m'}, requirements: {context: 4000}}).ref, 'a/org/m');
  assert.throws(() => resolveLocalModel({local: normalizeLocalSettings(local({a: {backend: 'lmstudio', url: 'http://127.0.0.1:1275'}})), catalogs, profile: {backend: 'lmstudio', endpoint: 'a', model: 'org/m'}}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
});

test('v1 metadata without loaded_instances remains unknown instead of being called downloaded', async () => {
  const row = llm('m'); delete row.loaded_instances;
  const models = await discoverLocalModels(local({unknown: {backend: 'lmstudio', url: 'http://127.0.0.1:1277'}}), {fetchImpl: async () => response(v1([row]))});
  assert.equal(models[0].models[0].ready, null);
});

test('each coalesced caller applies its own timeout without aborting the longer caller', async () => {
  const settings = local({percaller: {backend: 'lmstudio', url: 'http://127.0.0.1:1278'}});
  const never = () => new Promise(() => {});
  const first = discoverLocalModels(settings, {fetchImpl: never, timeout: 80});
  const started = Date.now();
  const second = await discoverLocalModels(settings, {fetchImpl: never, timeout: 1});
  assert.ok(Date.now() - started < 20);
  assert.match(second[0].error, /timed out/i);
  await first;
});

test('cached and stale rows preserve the server observation time', async () => {
  let healthy = true;
  const settings = local({observed: {backend: 'lmstudio', url: 'http://127.0.0.1:1279'}});
  const fetchImpl = async () => healthy ? response(v1([llm('m')])) : Promise.reject(new TypeError('offline'));
  const fresh = await discoverLocalModels(settings, {fetchImpl});
  await new Promise(resolve => setTimeout(resolve, 2));
  const cached = await discoverLocalModels(settings, {fetchImpl});
  healthy = false;
  const stale = await discoverLocalModels(settings, {fetchImpl, maxAge: 0});
  assert.equal(cached[0].observedAt, fresh[0].observedAt);
  assert.equal(stale[0].observedAt, fresh[0].observedAt);
});

test('rejects non-finite discovery timing options', async () => {
  await assert.rejects(discoverLocalModels({}, {timeout: Infinity}), {code: 'INVALID_LOCAL_DISCOVERY_OPTIONS'});
  await assert.rejects(discoverLocalModels({}, {maxAge: Number.NaN}), {code: 'INVALID_LOCAL_DISCOVERY_OPTIONS'});
});
