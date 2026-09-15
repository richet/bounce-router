import {queryLines} from './query.js';
import {resolveExecutable} from './executable.js';
import {providers} from './providers.js';
import {adapters} from './adapters/index.js';

// Every catalog comes from the vendor CLI's own protocol. Nothing here hard-codes
// a model name, so a CLI update changes the picker without changing bounce.
export const catalogQueries = Object.fromEntries(Object.entries(adapters).map(([name, a]) => [name, a.catalog]));

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
