import {normalizeLocalSettings, discoverLocalModels, resolveLocalModel} from './local-models.js';
import {opencodeProviderConfig} from './local-opencode-config.js';
import {isDeepStrictEqual} from 'node:util';

const failure = (code, message) => Object.assign(new Error(message), {code});

// The whole of what is local-specific at dispatch: decide WHICH model plays this worker and tell
// OpenCode how to reach it. Everything after that is an ordinary worker (src/adapters/opencode-live.js).
// There are no capacity leases: LM Studio queues concurrent requests itself, exactly as a vendor
// API does for a cloud worker.
export function createLocalResolver({local, discover = discoverLocalModels} = {}) {
  let settings = normalizeLocalSettings(local);

  async function resolve({profile, signal, onStatus = () => {}}) {
    signal?.throwIfAborted();
    if (!settings.enabled) throw failure('LOCAL_DISABLED', 'Local models are disabled');
    const endpoint = profile.endpoint ?? 'lmstudio';
    if (!settings.endpoints[endpoint]) throw failure('LOCAL_MODEL_UNAVAILABLE', `Unknown endpoint ${endpoint}`);
    onStatus(`Refreshing local model availability · ${endpoint}`);
    const catalogs = await discover(settings, {signal, maxAge: 0});
    signal?.throwIfAborted();
    const localResolved = resolveLocalModel({local: settings, profile, catalogs,
      requirements: {tools: true, context: (profile.localOptions?.maxOutputTokens ?? 2048) + 1024}});
    onStatus(`Selected ${localResolved.ref} · ${localResolved.reason}`);
    // Address the LOADED INSTANCE identifier when there is one: LM Studio serves aliases and raw refs
    // from one catalog, so asking for the raw ref of a model already loaded under an alias makes it
    // load a second copy of the weights (observed live as a worker that hung on a zero-token row).
    const model = localResolved.instance ?? localResolved.model;
    const opencode = opencodeProviderConfig({settings, endpoint: localResolved.endpoint, model});
    return {...profile, model, localResolved, apiKeyEnv: settings.endpoints[localResolved.endpoint].apiKeyEnv,
      opencodeConfig: opencode.config, providerID: opencode.providerID};
  }

  // Live activation may add agents; it may not silently repoint an endpoint under running workers.
  function configure(next) {
    const normalized = normalizeLocalSettings(next);
    for (const [name, endpoint] of Object.entries(settings.endpoints)) {
      if (!isDeepStrictEqual(endpoint, normalized.endpoints[name])) throw failure('LOCAL_ENDPOINT_CHANGED', `Endpoint ${name} changed; start a new session to apply endpoint changes safely`);
    }
    settings = normalized;
  }

  return {resolve, configure};
}
