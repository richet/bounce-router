import {createHash} from 'node:crypto';

const cache = new Map();
// Phase 2 (docs/plans/opencode-adapter.md): local workers now run a full `opencode serve` per
// worker instead of a single in-process loop, so the concurrency that was safe before has not been
// measured for the new shape. Default to one until it is.
// on-demand by default: LM Studio unloads idle models on its own, and its server loads a requested
// model just in time (measured live: nothing loaded → a completed turn through OpenCode in 9.2s).
// A loaded model is still preferred when one exists (see the ranking in resolveLocalModel); this only
// stops "nothing is loaded right now" from being a dead end. `loaded-only` remains available for
// setups that must never trigger a load.
// maxConcurrent: how many local workers the scheduler runs on the endpoint at once — set it to the
// number of parallel slots the model is loaded with. The rest wait in the queue (src/scheduler.js).
const DEFAULT_ENDPOINT = {backend: 'lmstudio', url: 'http://127.0.0.1:1234', loadPolicy: 'on-demand', maxConcurrent: 1};
const endpointIdPattern = /^[A-Za-z0-9_-]+$/;
const maxBodyBytes = 1024 * 1024;

const error = (message, code = 'INVALID_LOCAL_SETTINGS') => Object.assign(new Error(message), {code});
const copy = value => structuredClone(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLoopback = url => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname.toLowerCase());

function endpointConfig(id, input) {
  if (!endpointIdPattern.test(id) || !isObject(input)) throw error(`Invalid local endpoint ${id}`);
  const fields = new Set(['backend', 'url', 'apiKeyEnv', 'trusted', 'loadPolicy', 'maxConcurrent', 'contextTokens', 'slotsPerModel', 'reserveGb', 'waitMinutes', 'pollMs']);
  if (Object.keys(input).some(field => !fields.has(field))) throw error(`Endpoint ${id} has unsupported settings`);
  if (input.backend !== 'lmstudio') throw error(`Endpoint ${id} must use backend lmstudio`);
  if (Object.hasOwn(input, 'apiKey')) throw error(`Endpoint ${id} must use apiKeyEnv, not apiKey`);
  let parsed;
  try { parsed = new URL(input.url); } catch { throw error(`Endpoint ${id} has an invalid URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw error(`Endpoint ${id} URL must be http(s) without credentials, query, or hash`);
  if (input.apiKeyEnv !== undefined && (typeof input.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.apiKeyEnv))) throw error(`Endpoint ${id} apiKeyEnv must be an environment-variable name`);
  if (input.trusted !== undefined && typeof input.trusted !== 'boolean') throw error(`Endpoint ${id} trusted must be boolean`);
  if (input.loadPolicy !== undefined && !['loaded-only', 'on-demand'].includes(input.loadPolicy)) throw error(`Endpoint ${id} has an invalid loadPolicy`);
  if (input.maxConcurrent !== undefined && (!Number.isInteger(input.maxConcurrent) || input.maxConcurrent < 1)) throw error(`Endpoint ${id} maxConcurrent must be a positive integer`);
  // The context OpenCode is told a model has: it compacts the conversation at that size instead of
  // growing to whatever LM Studio loaded (262k on these MLX builds, whatever the CLI asked for).
  // Slots per loaded model: how many turns one model runs at once (LM Studio's `--parallel`). The
  // endpoint's maxConcurrent stays the ceiling over all models. Found live: a reviewer waited seven
  // minutes for an endpoint slot while its own model sat idle.
  if (input.slotsPerModel !== undefined && (!Number.isInteger(input.slotsPerModel) || input.slotsPerModel < 1)) throw error(`Endpoint ${id} slotsPerModel must be a positive integer`);
  if (input.contextTokens !== undefined && (!Number.isInteger(input.contextTokens) || input.contextTokens < 4096)) throw error(`Endpoint ${id} contextTokens must be a whole number of tokens, at least 4096`);
  // The memory gate (src/resources.js): the reserve kept free beside a model's weights, how long a task
  // may wait for memory before its submitter is told, and how often the gate looks again.
  if (input.reserveGb !== undefined && (!Number.isFinite(input.reserveGb) || input.reserveGb < 0)) throw error(`Endpoint ${id} reserveGb must be a non-negative number of gigabytes`);
  if (input.waitMinutes !== undefined && (!Number.isInteger(input.waitMinutes) || input.waitMinutes < 1)) throw error(`Endpoint ${id} waitMinutes must be a positive whole number of minutes`);
  if (input.pollMs !== undefined && (!Number.isInteger(input.pollMs) || input.pollMs < 1)) throw error(`Endpoint ${id} pollMs must be a positive integer`);
  const normalized = {backend: 'lmstudio', url: parsed.href.replace(/\/$/, ''), loadPolicy: input.loadPolicy ?? DEFAULT_ENDPOINT.loadPolicy, maxConcurrent: input.maxConcurrent ?? DEFAULT_ENDPOINT.maxConcurrent};
  if (input.apiKeyEnv) normalized.apiKeyEnv = input.apiKeyEnv;
  if (input.trusted) normalized.trusted = true;
  if (input.contextTokens !== undefined) normalized.contextTokens = input.contextTokens;
  if (input.slotsPerModel !== undefined) normalized.slotsPerModel = input.slotsPerModel;
  for (const key of ['reserveGb', 'waitMinutes', 'pollMs']) if (input[key] !== undefined) normalized[key] = input[key];
  return normalized;
}

export function normalizeLocalSettings(local = {}) {
  if (!isObject(local)) throw error('local settings must be an object');
  if (local.enabled !== undefined && typeof local.enabled !== 'boolean') throw error('local.enabled must be boolean');
  if (local.endpoints !== undefined && !isObject(local.endpoints)) throw error('local.endpoints must be an object');
  const endpoints = local.endpoints === undefined
    ? {lmstudio: copy(DEFAULT_ENDPOINT)}
    : Object.fromEntries(Object.entries(local.endpoints).map(([id, endpoint]) => [id, endpointConfig(id, endpoint)]));
  const preferences = normalizePreferences(local.preferences);
  if (local.exclude !== undefined && (!Array.isArray(local.exclude) || !local.exclude.every(value => typeof value === 'string'))) throw error('local.exclude must be an array of model refs');
  const overrides = normalizeOverrides(local.overrides);
  return {enabled: local.enabled ?? true, endpoints, preferences, exclude: [...(local.exclude ?? [])], overrides};
}

function normalizePreferences(input) {
  if (input === undefined) return {};
  if (!isObject(input)) throw error('local.preferences must be an object');
  const result = {};
  for (const [role, preference] of Object.entries(input)) {
    if (!isObject(preference)) throw error(`Preference ${role} must be an object`);
    for (const field of ['prefer', 'exclude']) if (preference[field] !== undefined && (!Array.isArray(preference[field]) || !preference[field].every(value => typeof value === 'string'))) throw error(`Preference ${role}.${field} must be a string array`);
    result[role] = {...(preference.prefer ? {prefer: [...preference.prefer]} : {}), ...(preference.exclude ? {exclude: [...preference.exclude]} : {})};
  }
  return result;
}

function normalizeOverrides(input) {
  if (input === undefined) return {};
  if (!isObject(input)) throw error('local.overrides must be an object');
  const result = {};
  for (const [ref, override] of Object.entries(input)) {
    if (!isObject(override) || (override.tools !== undefined && typeof override.tools !== 'boolean') || (override.context !== undefined && (!Number.isInteger(override.context) || override.context < 1))) throw error(`Override ${ref} is invalid`);
    result[ref] = {...(override.tools !== undefined ? {tools: override.tools} : {}), ...(override.context !== undefined ? {context: override.context} : {})};
  }
  return result;
}

function authHeaders(endpoint, env) {
  if (endpoint.apiKeyEnv && !env?.[endpoint.apiKeyEnv]) throw error(`Local model endpoint requires authentication: ${endpoint.apiKeyEnv} is not set`, 'LOCAL_AUTH_REQUIRED');
  const value = endpoint.apiKeyEnv && env[endpoint.apiKeyEnv];
  return value ? {Authorization: `Bearer ${value}`} : {};
}

function configRevision(endpoint, env) {
  const auth = endpoint.apiKeyEnv ? String(env?.[endpoint.apiKeyEnv] ?? '') : '';
  // The token never becomes a cache key or catalog field; SHA-256 only separates in-memory revisions.
  const digest = createHash('sha256').update(auth).digest('base64url');
  return JSON.stringify([endpoint.url, endpoint.backend, endpoint.trusted === true, endpoint.loadPolicy, endpoint.maxConcurrent, endpoint.apiKeyEnv ?? '', digest]);
}

function awaitSignal(promise, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', aborted);
    const aborted = () => { cleanup(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', aborted, {once: true});
    promise.then(resolve, reject).finally(cleanup).catch(() => {});
  });
}

async function readJson(response, signal) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBodyBytes) throw error('Model catalog response is too large', 'LOCAL_DISCOVERY_FAILED');
  if (!response.body) throw error('Model catalog returned an empty response', 'LOCAL_DISCOVERY_FAILED');
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      const {done, value} = await awaitSignal(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) throw error('Model catalog response is too large', 'LOCAL_DISCOVERY_FAILED');
      chunks.push(value);
    }
  } finally { reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder().decode(bytes);
  try { return JSON.parse(body); } catch { throw error('Model catalog returned invalid JSON', 'LOCAL_DISCOVERY_FAILED'); }
}

async function fetchCatalog(endpoint, options) {
  const {fetchImpl, env, signal} = options;
  try {
    for (const path of ['/api/v1/models', '/api/v0/models', '/v1/models']) {
      const response = await awaitSignal(fetchImpl(endpoint.url + path, {method: 'GET', headers: authHeaders(endpoint, env), redirect: 'manual', signal}), signal);
      if ((response.status === 404 || response.status === 405) && path !== '/v1/models') continue;
      if (response.status === 401 || response.status === 403) throw error('Local model endpoint requires authentication', 'LOCAL_AUTH_REQUIRED');
      if (!response.ok) throw error(`Local model endpoint returned HTTP ${response.status}`, 'LOCAL_DISCOVERY_FAILED');
      return {data: await readJson(response, signal), version: path, observedAt: new Date().toISOString()};
    }
  } catch (cause) {
    if (signal?.aborted) throw signal.reason ?? cause;
    if (cause?.code) throw cause;
    throw error(`Local model endpoint unavailable: ${cause?.message ?? 'request failed'}`, 'LOCAL_UNAVAILABLE');
  } finally { /* The shared entry owns cancellation; individual callers own their timers. */ }
}

function modelType(value) {
  if (value === 'llm') return 'llm';
  if (value === 'embedding' || value === 'embeddings') return 'embedding';
  return 'unknown';
}

function parseModels(payload, version, endpoint, overrides) {
  const rows = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter(isObject).map(row => {
    const id = typeof row.key === 'string' ? row.key : typeof row.id === 'string' ? row.id : null;
    if (!id) return null;
    const override = overrides[`${endpoint}/${id}`] ?? {};
    const modern = version === '/api/v1/models';
    const hasInstances = modern && Array.isArray(row.loaded_instances);
    const instances = hasInstances ? row.loaded_instances.filter(isObject).map(instance => ({
      id: typeof instance.id === 'string' ? instance.id : null,
      context: positive(instance.config?.context_length ?? instance.context_length),
      parallel: positive(instance.config?.parallel ?? instance.parallel),
    })).filter(instance => instance.id) : [];
    const serverTools = typeof row.capabilities?.trained_for_tool_use === 'boolean' ? row.capabilities.trained_for_tool_use : null;
    const tools = override.tools ?? serverTools;
    const context = override.context ?? positive(row.max_context_length ?? row.context_length);
    // size and ttl: what src/resources.js needs to know whether a model can be loaded beside the rest.
    const size = positive(Number(row.size_bytes));
    const ttl = hasInstances ? positive(Number(row.loaded_instances[0]?.remaining_ttl_seconds)) : null;
    return {id, ref: `${endpoint}/${id}`, label: typeof row.display_name === 'string' ? row.display_name : id, type: modelType(row.type), instances, context: context ?? null, tools, capabilitySource: override.tools !== undefined ? 'user' : serverTools !== null ? 'server' : 'unknown', ready: hasInstances ? instances.length > 0 : null, size: size ?? null, ttl};
  }).filter(Boolean);
}

const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const catalog = (endpoint, models = [], errorMessage = null, stale = false, observedAt = new Date().toISOString()) => ({provider: 'local', endpoint, backend: 'lmstudio', models: copy(models), error: errorMessage, stale, observedAt});

async function waitForEntry(entry, signal, timeout) {
  entry.waiters++;
  const controller = new AbortController();
  const timeoutError = error('Local model discovery timed out', 'LOCAL_DISCOVERY_TIMEOUT');
  const timer = setTimeout(() => controller.abort(timeoutError), timeout);
  const relayAbort = () => controller.abort(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  signal?.addEventListener('abort', relayAbort, {once: true});
  try {
    return await awaitSignal(entry.pending, controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
    entry.waiters--;
    if (entry.waiters === 0 && !entry.controller.signal.aborted) entry.controller.abort(error('No discovery callers remain', 'LOCAL_DISCOVERY_CANCELLED'));
  }
}

async function discoverEndpoint(id, endpoint, normalized, options) {
  if (!isLoopback(new URL(endpoint.url)) && !endpoint.trusted) return catalog(id, [], 'Remote local-model endpoint is not trusted');
  const key = `${id}:${configRevision(endpoint, options.env)}`;
  const now = Date.now();
  const existing = cache.get(key);
  if (existing?.raw && options.maxAge > 0 && now - existing.at <= options.maxAge) return catalog(id, parseModels(existing.raw.data, existing.raw.version, id, normalized.overrides), null, false, existing.raw.observedAt);
  const created = !existing?.pending;
  const entry = existing?.pending ? existing.entry : {controller: new AbortController(), waiters: 0};
  const pending = existing?.pending ?? fetchCatalog(endpoint, {...options, signal: entry.controller.signal}).then(raw => {
    const current = cache.get(key) ?? {};
    cache.set(key, {...current, raw, at: Date.now()});
    return raw;
  });
  if (created) {
    entry.pending = pending;
    cache.set(key, {...(existing?.raw ? {raw: existing.raw, at: existing.at} : {}), entry, pending});
    pending.finally(() => { const current = cache.get(key); if (current?.pending === pending) delete current.pending; }).catch(() => {});
  }
  try {
    const raw = await waitForEntry(entry, options.signal, options.timeout);
    return catalog(id, parseModels(raw.data, raw.version, id, normalized.overrides), null, false, raw.observedAt);
  } catch (cause) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const last = cache.get(key)?.raw;
    if (last && !['LOCAL_AUTH_REQUIRED'].includes(cause.code)) return catalog(id, parseModels(last.data, last.version, id, normalized.overrides), cause.message, true, last.observedAt);
    return catalog(id, [], cause.message ?? 'Local model discovery failed');
  } finally { /* The request owner cleans pending after every coalesced caller settles. */ }
}

export async function discoverLocalModels(local, {fetchImpl = globalThis.fetch, signal, onUpdate, env = process.env, maxAge = 30_000, timeout = 3_000} = {}) {
  const normalized = normalizeLocalSettings(local);
  if (!normalized.enabled || Object.keys(normalized.endpoints).length === 0) return [];
  if (typeof fetchImpl !== 'function') throw error('fetch is unavailable', 'LOCAL_DISCOVERY_FAILED');
  if (!Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(timeout) || timeout <= 0) throw error('maxAge must be finite and non-negative; timeout must be finite and positive', 'INVALID_LOCAL_DISCOVERY_OPTIONS');
  const options = {fetchImpl, signal, env, maxAge, timeout};
  return Promise.all(Object.entries(normalized.endpoints).map(async ([id, endpoint]) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const value = await discoverEndpoint(id, endpoint, normalized, options);
    onUpdate?.(copy(value));
    return copy(value);
  }));
}

function splitRef(ref) {
  // Model keys may contain slashes, so only the first slash separates endpoint from key.
  if (typeof ref !== 'string') return null;
  const slash = ref.indexOf('/');
  return slash > 0 && slash < ref.length - 1 ? {endpoint: ref.slice(0, slash), key: ref.slice(slash + 1)} : null;
}

function endpointAllowed(id, endpoint) { return endpoint && (isLoopback(new URL(endpoint.url)) || endpoint.trusted); }

// `local on|off`, the same switch `jev on|off` is. On is the default, so it is saved as the absence
// of the flag; the text is what both the CLI and the TUI answer with.
export function switchLocal(settings, on) {
  settings.local = {...(isObject(settings.local) ? settings.local : {})};
  if (on) delete settings.local.enabled; else settings.local.enabled = false;
  return on ? 'Local models: on · agents may run on the models LM Studio serves' : 'Local models: off · agents skip their local AIs and run on the rest of their list';
}

// Every tool-capable local model, loaded ones first. Which of them an agent is offered is decided in
// src/jev.js (`offerable`: loaded, or named by the agent's own list). Each is described
// by its roster note (`<endpoint>/<model>` in roster-notes.json) or, with none, conservatively.
export function localCandidates(catalogs = [], notes = {}) {
  const usable = catalogs.flatMap(catalog => (catalog.models ?? []).filter(model => model.type !== 'embedding' && model.tools !== false && (model.ready === true || model.ready === false))
    .map(model => { const name = `${catalog.endpoint}/${model.id}`; const note = notes[name] ?? {};
      return {name, endpoint: catalog.endpoint, model: model.id, loaded: model.ready === true, size: model.size ?? null, context: model.instances?.[0]?.context ?? model.context ?? null,
        tier: ['cheapest', 'mid', 'strongest'].includes(note.tier) ? note.tier : 'cheapest', capabilities: note.capabilities || 'unknown local model: single-file reading only'}; }));
  // Loaded first, then the rest: which of these Jev is actually offered is decided per agent in
  // src/jev.js (loaded, or named by the agent's own `models:`), so a big downloaded model nobody
  // asked for never enters the running.
  return [...usable.filter(item => item.loaded), ...usable.filter(item => !item.loaded)];
}

export function resolveLocalModel({local, profile, catalogs, requirements = {}, override} = {}) {
  const settings = normalizeLocalSettings(local);
  const fail = (message, code) => { throw error(message, code); };
  if (!settings.enabled) fail('Local models are disabled', 'LOCAL_DISABLED');
  if (!isObject(profile) || profile.backend !== 'lmstudio') fail('Profile must select backend lmstudio', 'INVALID_LOCAL_PROFILE');
  if (!Array.isArray(catalogs)) fail('Local model catalogs are required', 'INVALID_LOCAL_CATALOGS');
  const rolePreference = profile.role && settings.preferences[profile.role] || {};
  const exclusions = new Set([...settings.exclude, ...(rolePreference.exclude ?? []), ...(profile.exclude ?? [])]);
  const all = catalogs.filter(row => row?.provider === 'local' && row.backend === 'lmstudio' && !row.stale).flatMap(row => (row.models ?? []).map(model => ({endpoint: row.endpoint, model})));
  const exact = override ? {ref: override, reason: 'override'} : profile.model && profile.model !== 'auto' ? {ref: `${profile.endpoint ?? 'lmstudio'}/${profile.model}`, reason: 'profile pin'} : null;
  if (exact) {
    const parsed = splitRef(exact.ref);
    if (!parsed) fail(`Invalid local model ref ${exact.ref}`, 'INVALID_LOCAL_MODEL_REF');
    if (exclusions.has(exact.ref)) fail(`Pinned model ${exact.ref} is excluded`, 'LOCAL_MODEL_EXCLUDED');
    const endpoint = settings.endpoints[parsed.endpoint];
    if (!endpointAllowed(parsed.endpoint, endpoint)) fail(`Pinned endpoint ${parsed.endpoint} is unavailable or untrusted`, 'LOCAL_MODEL_UNAVAILABLE');
    let candidate = all.find(item => item.endpoint === parsed.endpoint && item.model.id === parsed.key);
    // A pin may also be the identifier of a LOADED INSTANCE — the name the user gave it in LM Studio
    // (e.g. `bounce-coder` for a loaded qwen3-coder-next). That is the natural way to say "this
    // role uses that loaded model", and it is exactly the id the worker must ask the server for.
    let instanceId = null;
    if (!candidate) {
      candidate = all.find(item => item.endpoint === parsed.endpoint && (item.model.instances ?? []).some(instance => instance.id === parsed.key));
      if (candidate) instanceId = parsed.key;
    }
    if (!candidate) fail(`Pinned model ${exact.ref} is unavailable; refresh its endpoint or choose another pin`, 'LOCAL_MODEL_UNAVAILABLE');
    return selected(candidate, endpoint, requirements, exact.reason, true, instanceId);
  }
  const preference = [...(profile.prefer ?? []), ...(rolePreference.prefer ?? [])];
  const allowed = all.filter(candidate => (!profile.endpoint || candidate.endpoint === profile.endpoint) && endpointAllowed(candidate.endpoint, settings.endpoints[candidate.endpoint]) && !exclusions.has(candidate.model.ref));
  const eligible = allowed.filter(candidate => eligibleModel(candidate.model, settings.endpoints[candidate.endpoint], requirements));
  if (!eligible.length) fail('No eligible local LLM is available; refresh catalogs, relax requirements, or configure an eligible model', 'LOCAL_MODEL_UNAVAILABLE');
  const rank = candidate => { const index = preference.indexOf(candidate.model.ref); return index === -1 ? Number.MAX_SAFE_INTEGER : index; };
  // Tiebreak among otherwise-equal candidates by capacity, not by name: with several models loaded,
  // alphabetical order was picking the smallest one.
  const capacity = candidate => bestInstance(candidate.model)?.context ?? candidate.model.context ?? 0;
  eligible.sort((a, b) => rank(a) - rank(b) || Number(b.model.tools === true) - Number(a.model.tools === true) || Number(b.model.ready === true) - Number(a.model.ready === true) || capacity(b) - capacity(a) || a.model.ref.localeCompare(b.model.ref));
  const winner = eligible[0];
  return selected(winner, settings.endpoints[winner.endpoint], requirements, rank(winner) === Number.MAX_SAFE_INTEGER ? 'automatic selection' : 'preference', false);
}

function eligibleModel(model, endpoint, requirements) {
  return ineligibleReason(model, endpoint, requirements) === null;
}

// Why a model cannot be used — the message a pinned profile fails with. "Does not meet the
// requirements" sent a user looking at OpenCode's configuration when the model was simply not loaded.
function ineligibleReason(model, endpoint, requirements) {
  if (model.type !== 'llm') return 'it is not an LLM';
  if (requirements.tools === true && model.tools !== true) return 'it does not support tool calls';
  if (endpoint.loadPolicy === 'loaded-only' && model.ready !== true) return `downloaded but not loaded, and ${endpoint.id ?? 'the endpoint'}'s loadPolicy is loaded-only (load it in LM Studio, or set loadPolicy on-demand)`;
  if (requirements.context && !bestInstance(model, requirements.context) && !(endpoint.loadPolicy === 'on-demand' && model.ready !== true && model.context >= requirements.context)) {
    const have = bestInstance(model)?.context ?? model.context;
    return `context ${have ?? 'unknown'} is below the ${requirements.context} the profile needs`;
  }
  return null;
}

function bestInstance(model, minimum = 0) {
  return (model.instances ?? []).filter(instance => positive(instance.context) >= minimum).sort((a, b) => b.context - a.context)[0] ?? null;
}

function selected(candidate, endpoint, requirements, reason, pinned, instanceId = null) {
  const {model} = candidate;
  const why = ineligibleReason(model, {...endpoint, id: candidate.endpoint}, requirements);
  if (why) throw error(`${pinned ? 'Pinned' : 'Selected'} model ${model.ref} cannot be used: ${why}`, 'LOCAL_MODEL_UNAVAILABLE');
  const instance = instanceId
    ? (model.instances ?? []).find(item => item.id === instanceId && positive(item.context) >= (requirements.context ?? 0)) ?? null
    : bestInstance(model, requirements.context ?? 0);
  if (instanceId && !instance) throw error(`Pinned instance ${instanceId} does not meet the local profile context requirement`, 'LOCAL_MODEL_UNAVAILABLE');
  const context = instance?.context ?? model.context ?? null;
  return Object.freeze({endpoint: candidate.endpoint, backend: 'lmstudio', url: endpoint.url, model: model.id, instance: instance?.id ?? null, context, tools: model.tools, loadPolicy: endpoint.loadPolicy, reason, ref: model.ref});
}
