import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLocalSettings} from '../src/local-models.js';
import {opencodeProviderConfig, checkOpencodeBridge} from '../src/local-opencode-config.js';

test('builds provider config for the default lmstudio endpoint', () => {
  const settings = normalizeLocalSettings();
  const result = opencodeProviderConfig({settings, model: 'org/model'});
  assert.deepEqual(result, {
    config: {
      $schema: 'https://opencode.ai/config.json',
      provider: {
        lmstudio: {
          npm: '@ai-sdk/openai-compatible',
          name: 'lmstudio',
          options: {baseURL: 'http://127.0.0.1:1234/v1'},
          models: {'org/model': {name: 'org/model'}},
        },
      },
    },
    providerID: 'lmstudio',
    modelID: 'org/model',
  });
});

test('does not duplicate /v1 when the endpoint url already carries it', () => {
  const settings = normalizeLocalSettings({endpoints: {office: {backend: 'lmstudio', url: 'http://127.0.0.1:1234/v1'}}});
  const result = opencodeProviderConfig({settings, endpoint: 'office', model: 'm'});
  assert.equal(result.config.provider.office.options.baseURL, 'http://127.0.0.1:1234/v1');
});

test('normalizes a trailing slash before appending /v1', () => {
  const settings = normalizeLocalSettings({endpoints: {office: {backend: 'lmstudio', url: 'http://127.0.0.1:1234/'}}});
  const result = opencodeProviderConfig({settings, endpoint: 'office', model: 'm'});
  assert.equal(result.config.provider.office.options.baseURL, 'http://127.0.0.1:1234/v1');
});

test('includes apiKey from env when apiKeyEnv is declared and present', () => {
  const settings = normalizeLocalSettings({endpoints: {office: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', apiKeyEnv: 'LM_TOKEN', trusted: true}}});
  const result = opencodeProviderConfig({settings, endpoint: 'office', model: 'm', env: {LM_TOKEN: 'secret'}});
  assert.deepEqual(result.config.provider.office.options, {baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'secret'});
});

test('omits apiKey entirely when apiKeyEnv is not declared', () => {
  const settings = normalizeLocalSettings();
  const result = opencodeProviderConfig({settings, model: 'm'});
  assert.equal(Object.hasOwn(result.config.provider.lmstudio.options, 'apiKey'), false);
});

test('throws LOCAL_AUTH_REQUIRED when apiKeyEnv is declared but unset', () => {
  const settings = normalizeLocalSettings({endpoints: {office: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', apiKeyEnv: 'LM_TOKEN', trusted: true}}});
  assert.throws(() => opencodeProviderConfig({settings, endpoint: 'office', model: 'm', env: {}}), {code: 'LOCAL_AUTH_REQUIRED'});
});

test('throws LOCAL_AUTH_REQUIRED when apiKeyEnv is declared but empty', () => {
  const settings = normalizeLocalSettings({endpoints: {office: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', apiKeyEnv: 'LM_TOKEN', trusted: true}}});
  assert.throws(() => opencodeProviderConfig({settings, endpoint: 'office', model: 'm', env: {LM_TOKEN: ''}}), {code: 'LOCAL_AUTH_REQUIRED'});
});

test('throws LOCAL_MODEL_UNAVAILABLE for an unknown endpoint', () => {
  const settings = normalizeLocalSettings();
  assert.throws(() => opencodeProviderConfig({settings, endpoint: 'nope', model: 'm'}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
});

test('throws LOCAL_MODEL_UNAVAILABLE for a missing, empty, or non-string model', () => {
  const settings = normalizeLocalSettings();
  assert.throws(() => opencodeProviderConfig({settings}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
  assert.throws(() => opencodeProviderConfig({settings, model: ''}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
  assert.throws(() => opencodeProviderConfig({settings, model: 42}), {code: 'LOCAL_MODEL_UNAVAILABLE'});
});

test('never mutates or aliases the settings object', () => {
  const settings = normalizeLocalSettings();
  const before = JSON.parse(JSON.stringify(settings));
  const result = opencodeProviderConfig({settings, model: 'm'});
  assert.deepEqual(settings, before);
  assert.notEqual(result.config.provider.lmstudio, settings.endpoints.lmstudio);
});

// The bridge preflight. bounce configures OpenCode but does not ship it, so a local worker depends
// on a second binary; without this check a missing or unreachable setup only appears at the first
// dispatch as `spawn ... ENOENT`. It deliberately runs a REAL turn through the real adapter rather
// than inspecting config, because opencode reports whatever model the generated block declares —
// config inspection alone cannot tell a servable model from an unservable one.
test('the bridge check reports a working bridge, and reports the reply it actually got', async () => {
  const calls = [];
  const adapter = {
    launch: async args => { calls.push(args); return {pid: 1}; },
    events: async function* () { yield {kind: 'result', status: 'completed', text: 'OK'}; },
    cancel: async () => ({verified: true}),
  };
  const status = await checkOpencodeBridge({settings: normalizeLocalSettings({}), model: 'bounce-scout',
    executable: '/bin/echo', adapter});
  assert.equal(status.config.ready, true);
  assert.equal(status.worker.ready, true);
  assert.equal(status.worker.reply, 'OK');
  // The check must exercise the same shape a real worker gets: the generated provider block, the
  // chosen model pinned, and read-only.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].profile.model, 'bounce-scout');
  assert.equal(calls[0].profile.policy, 'read-only');
  assert.deepEqual(calls[0].profile.opencodeConfig.provider.lmstudio.options, {baseURL: 'http://127.0.0.1:1234/v1'});
});

test('the bridge check reports a worker that fails, without claiming readiness', async () => {
  const adapter = {
    launch: async () => ({pid: 1}),
    events: async function* () { yield {kind: 'result', status: 'failed', text: 'Invalid model identifier "nope"', code: 'X'}; },
    cancel: async () => ({verified: true}),
  };
  const status = await checkOpencodeBridge({settings: normalizeLocalSettings({}), model: 'nope',
    executable: '/bin/echo', adapter});
  assert.equal(status.worker.ready, false);
  assert.match(status.worker.reason, /Invalid model identifier/);
});

test('a missing opencode binary is reported as exactly that, not as an opaque spawn error', async () => {
  const adapter = {
    launch: async () => { throw Object.assign(new Error('spawn /nonexistent/opencode ENOENT'), {code: 'ENOENT'}); },
    events: async function* () {},
    cancel: async () => ({verified: true}),
  };
  const status = await checkOpencodeBridge({settings: normalizeLocalSettings({}), model: 'bounce-scout',
    executable: '/nonexistent/opencode', adapter});
  assert.equal(status.worker.ready, false);
  assert.equal(status.worker.reason, 'opencode is not installed or not on PATH (/nonexistent/opencode)');
});

test('a config that cannot be generated fails before any process is started', async () => {
  let launched = 0;
  const adapter = {launch: async () => { launched++; return {pid: 1}; }, events: async function* () {}, cancel: async () => ({verified: true})};
  const status = await checkOpencodeBridge({settings: normalizeLocalSettings({}), model: '', executable: '/bin/echo', adapter});
  assert.equal(status.config.ready, false);
  assert.match(status.config.reason, /model id is required/);
  assert.equal(launched, 0, 'nothing is spawned when the config itself is invalid');
});

// LM Studio loads these MLX models at their full 262k context whatever the CLI asks for, and a worker
// that fills that in one turn is the memory that swapped the machine. `contextTokens` on the endpoint
// is the limit OpenCode is told: it compacts the conversation at that size instead of growing past it.
test('contextTokens on the endpoint becomes the model\'s context limit for OpenCode; absent, no limit is written', () => {
  const capped = normalizeLocalSettings({endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', contextTokens: 131072}}});
  assert.equal(capped.endpoints.lmstudio.contextTokens, 131072);
  const result = opencodeProviderConfig({settings: capped, model: 'm'});
  assert.deepEqual(result.config.provider.lmstudio.models.m, {name: 'm', limit: {context: 131072, output: 32768}});
  assert.deepEqual(opencodeProviderConfig({settings: normalizeLocalSettings(), model: 'm'}).config.provider.lmstudio.models.m, {name: 'm'});
  for (const bad of [0, -1, 1.5, '131072', 500]) assert.throws(() => normalizeLocalSettings({endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', contextTokens: bad}}}), /contextTokens must be a whole number of tokens, at least 4096/);
});
