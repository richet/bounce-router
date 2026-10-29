// The OpenCode provider block for a local endpoint: how OpenCode reaches LM Studio and which model.
// Its own file so the classic adapter (opencode.js) can build it without loading the live adapter that
// local-opencode-config.js's preflight needs.
const error = (message, code) => Object.assign(new Error(message), {code});

function normalizeBaseURL(url) {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

// An agent's sampling (src/agents.js SAMPLING) as the model's `options`. OpenCode hands those to
// @ai-sdk/openai-compatible as providerOptions[<provider id>], which copies every key it does not
// own verbatim to the top level of the chat/completions body, after its standard fields. Read from
// the source of opencode 1.18.31 and @ai-sdk/openai-compatible 2.0.41, everything rides that copy:
//   - temperature/top_p as OpenCode's own fields are dropped for a model it has no catalog entry
//     for (its `temperature` capability defaults to false);
//   - the SDK's topK is dropped as unsupported;
//   - a literal `reasoning_effort` is overwritten by the SDK's own, so thinking goes as its
//     `reasoningEffort`. Only "none" switches LM Studio's thinking off; "on" sends nothing.
// LM Studio honours `repeat_penalty`, never `repetition_penalty`, so that is the name sent.
const WIRE = {temperature: 'temperature', topP: 'top_p', topK: 'top_k', minP: 'min_p', presencePenalty: 'presence_penalty',
  frequencyPenalty: 'frequency_penalty', repeatPenalty: 'repeat_penalty', maxTokens: 'max_tokens', seed: 'seed'};

export function samplingOptions(sampling = {}) {
  const options = {};
  for (const [key, wire] of Object.entries(WIRE)) if (sampling[key] !== undefined) options[wire] = sampling[key];
  if (sampling.thinking === 'off') options.reasoningEffort = 'none';
  return options;
}

export function opencodeProviderConfig({settings, endpoint = 'lmstudio', model, sampling, env = process.env}) {
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

  const request = samplingOptions(sampling);
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [providerID]: {
        npm: '@ai-sdk/openai-compatible',
        name: providerID,
        options,
        // OpenCode budgets compaction on `limit.output`, so a declared maxTokens is the limit it plans with too.
        models: {[model]: {name: model, ...(Object.keys(request).length ? {options: request} : {}),
          ...(entry.contextTokens ? {limit: {context: entry.contextTokens, output: sampling?.maxTokens ?? Math.min(32768, Math.floor(entry.contextTokens / 4))}} : {})}},
      },
    },
  };

  return {config, providerID, modelID: model};
}

