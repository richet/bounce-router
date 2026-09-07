import {queryLines} from './query.js';
import {resolveExecutable} from './executable.js';
import {providers} from './providers.js';

// Every catalog comes from the vendor CLI's own protocol. Nothing here hard-codes
// a model name, so a CLI update changes the picker without changing bounce.
export const catalogQueries = {
  claude: {
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    requests: [{type: 'control_request', request_id: 'bounce-models', request: {subtype: 'initialize'}}],
    read(raw, out) {
      if (raw.type !== 'control_response' || raw.response?.request_id !== 'bounce-models') return false;
      const result = raw.response.response ?? {};
      out.account = result.account?.email ?? null;
      out.models = (result.models ?? []).map(m => ({id: m.value, label: m.displayName || m.value, description: m.description || m.resolvedModel || ''}));
      return true;
    },
  },
  codex: {
    args: ['app-server'],
    requests: [
      {id: 1, method: 'initialize', params: {clientInfo: {name: 'bounce', version: '0.1.0'}}},
      {method: 'initialized'},
      {id: 2, method: 'account/read', params: {}},
      {id: 3, method: 'model/list', params: {}},
    ],
    read(raw, out) {
      if (raw.id === 2) out.account = raw.result?.account?.email ?? null;
      if (raw.id === 3) out.models = (raw.result?.data ?? []).filter(m => !m.hidden)
        .map(m => ({id: m.id ?? m.model, label: m.displayName || m.id || m.model, description: m.description || ''}));
      return out.models !== undefined && out.account !== undefined;
    },
  },
  muse: {
    args: ['serve'],
    requests: [
      {jsonrpc: '2.0', id: 1, method: 'initialize', params: {clientInfo: {name: 'bounce', version: '0.1.0'}}},
      {jsonrpc: '2.0', method: 'initialized'},
      {jsonrpc: '2.0', id: 2, method: 'model/list', params: {}},
    ],
    read(raw, out) {
      if (raw.id !== 2) return false;
      const result = raw.result ?? {};
      out.account = result.profileId ? `${result.providerId}/${result.profileId}` : result.providerId ?? null;
      out.models = (result.models ?? []).map(m => ({id: m.modelId, label: m.displayLabel || m.modelId, description: m.description || ''}));
      return true;
    },
  },
};

// A failed or empty catalog is reported, never thrown: one signed-out agent must
// not hide the models of the others.
export async function queryCatalog(provider, executable = provider, {spawn, timeout = 20000, cwd} = {}) {
  const query = catalogQueries[provider];
  if (!query) return {provider, models: [], account: null, error: `Unknown provider: ${provider}`};
  const {out, error} = await queryLines({executable, args: query.args, requests: query.requests, read: query.read,
    spawn, timeout, cwd, messages: {missing: `${provider} CLI not installed`, timeout: `${provider} did not answer in time`,
      closed: `${provider} exited before listing models`}});
  return {provider, models: out.models ?? [], account: out.account ?? null,
    error: out.models?.length ? null : error || `${provider} reported no models`};
}

let cache = {time: 0, value: null};
export async function modelCatalog(settings, {maxAge = 300000, ...options} = {}) {
  if (cache.value && Date.now() - cache.time < maxAge) return cache.value;
  const value = await Promise.all(Object.keys(providers).map(provider =>
    queryCatalog(provider, resolveExecutable(provider, settings.executables?.[provider]), options)));
  cache = {time: Date.now(), value};
  return value;
}

// One flat list, ordered by the fallback order, so a pick chooses agent and model together.
export function modelEntries(catalogs, {order = [], models = {}} = {}) {
  const rank = provider => {const i = order.indexOf(provider); return i < 0 ? order.length : i;};
  const entries = [];
  for (const catalog of [...catalogs].sort((a, b) => rank(a.provider) - rank(b.provider))) {
    if (!catalog.models.length) continue;
    entries.push({provider: catalog.provider, id: '', label: 'Provider default',
      description: catalog.account ? `Signed in as ${catalog.account}` : 'The CLI picks the model',
      current: !models[catalog.provider]});
    for (const model of catalog.models) entries.push({provider: catalog.provider, id: model.id,
      label: model.label, description: model.description || model.id,
      current: models[catalog.provider] === model.id});
  }
  return entries;
}
export const catalogNotes = catalogs => catalogs.filter(c => !c.models.length)
  .map(c => `${c.provider}: ${c.error} · try /login ${c.provider}`);
