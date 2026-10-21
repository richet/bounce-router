// The OpenCode provider block for a local endpoint: how OpenCode reaches LM Studio and which model.
// Its own file so the classic adapter (opencode.js) can build it without loading the live adapter that
// local-opencode-config.js's preflight needs.
const error = (message, code) => Object.assign(new Error(message), {code});

function normalizeBaseURL(url) {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function opencodeProviderConfig({settings, endpoint = 'lmstudio', model, env = process.env}) {
  const providerID = endpoint;
  const entry = settings?.endpoints?.[providerID];
  if (!entry) throw error(`Unknown local endpoint ${providerID}`, 'LOCAL_MODEL_UNAVAILABLE');
  if (typeof model !== 'string' || model === '') throw error('A local model id is required', 'LOCAL_MODEL_UNAVAILABLE');

  const options = {baseURL: normalizeBaseURL(entry.url)};
  if (entry.apiKeyEnv) {
    const value = env?.[entry.apiKeyEnv];
    if (!value) throw error(`Local model endpoint requires authentication: ${entry.apiKeyEnv} is not set`, 'LOCAL_AUTH_REQUIRED');
    options.apiKey = value;
  }

  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [providerID]: {
        npm: '@ai-sdk/openai-compatible',
        name: providerID,
        options,
        models: {[model]: {name: model, ...(entry.contextTokens ? {limit: {context: entry.contextTokens, output: Math.min(32768, Math.floor(entry.contextTokens / 4))}} : {})}},
      },
    },
  };

  return {config, providerID, modelID: model};
}

