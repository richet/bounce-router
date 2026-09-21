// Roster notes: what each worker profile's model is good for, so Jev routing (src/jev.js) picks
// between abilities rather than names. Nothing here needs configuring. A profile may declare
// `tier` and `capabilities` in config.json and those always win; a model bounce ships a note for
// (src/model-catalog.js — every model in the cloud vendors' `/model` pickers) is read from there;
// every other model (local, a new vendor id) is described ONCE by one of the user's own signed-in
// agents — one read-only, tool-free turn that answers with JSON — and the answer is cached under
// the data root keyed by adapter/model, so the setup runs per new model, never per task. A
// failed or refused setup only narrows what the router sees (adapter/model/role/policy); it
// never blocks a dispatch.
import fs from 'node:fs';
import path from 'node:path';
import {dataRoot, saveJSON} from './core.js';
import {PROFILE_TIERS, TIER_HINT, routable} from './jev.js';
import {LOCAL_ADAPTERS} from './profiles.js';
import {invocation, runProcess} from './providers.js';
import {resolveExecutable} from './executable.js';
import {CATALOG_SOURCE, catalogNote} from './model-catalog.js';

export const NOTES_FILE = 'roster-notes.json';
export const SETUP_TIMEOUT_MS = 120_000;
export const SETUP_AGENTS = ['claude', 'codex', 'muse']; // agents that can answer one question in a read-only turn
export const CAPABILITIES_MAX = 400;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The cache key: one note per model, shared by every profile that runs it.
// A local model is named by its provider (`lmstudio/<model>`), like everywhere else — never by the
// runtime it runs through.
export const modelKey = profile => LOCAL_ADAPTERS.has(profile.adapter)
  ? `${profile.endpoint ?? 'lmstudio'}/${profile.model || 'auto'}`
  : `${profile.adapter}/${profile.model || 'default'}`;

// ---- the store ---------------------------------------------------------------------------

export function readRosterNotes(root = dataRoot()) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, NOTES_FILE), 'utf8'));
    return isObject(value) ? Object.fromEntries(Object.entries(value).filter(([, note]) => isObject(note))) : {};
  } catch { return {}; }
}

export function writeRosterNotes(notes, root = dataRoot()) {
  saveJSON(path.join(root, NOTES_FILE), notes);
}

// ---- reading the roster ------------------------------------------------------------------

const rosterEntries = profiles => Object.entries(profiles ?? {}).filter(routable);

// The note for a model in precedence order: the shipped catalog, else the cache. The catalog
// comes first so a cached agent answer never shadows what bounce knows, and so no agent turn
// is spent on a model already described.
const noteFor = (key, cache) => catalogNote(key) ?? cache[key] ?? null;

// Per routable profile: the tier and capabilities the router will see and where each came
// from — `config` (the profile declares it), `catalog` (bounce ships the note), the agent that
// described the model, or null.
export function effectiveNotes(profiles = {}, cache = {}) {
  return Object.fromEntries(rosterEntries(profiles).map(([name, p]) => {
    const key = modelKey(p);
    const note = noteFor(key, cache) ?? {};
    const tier = p.tier ?? (PROFILE_TIERS.includes(note.tier) ? note.tier : null);
    const capabilities = p.capabilities ?? (typeof note.capabilities === 'string' && note.capabilities ? note.capabilities : null);
    const source = p.capabilities ? 'config' : !capabilities ? null : catalogNote(key) ? CATALOG_SOURCE : note.by ?? 'notes';
    return [name, {model: key, tier, capabilities, source}];
  }));
}

// The models the roster runs that nobody has described yet: no `capabilities` on any profile
// running them, not in the shipped catalog, and no cached note. Unique, in roster order.
// `extra` are models outside the roster that routing may still pick — the local candidates of an
// `auto` agent — in the same {key, adapter, model, endpoint} shape.
export function undescribedModels(profiles = {}, cache = {}, extra = []) {
  const seen = new Map();
  for (const [, p] of rosterEntries(profiles)) {
    const key = modelKey(p);
    if (p.capabilities || noteFor(key, cache)?.capabilities || seen.has(key)) continue;
    seen.set(key, {key, adapter: p.adapter, model: p.model || '', ...(LOCAL_ADAPTERS.has(p.adapter) && p.endpoint ? {endpoint: p.endpoint} : {})});
  }
  for (const item of extra) if (!noteFor(item.key, cache)?.capabilities && !seen.has(item.key)) seen.set(item.key, item);
  return [...seen.values()];
}

// Which agent writes the notes: the orchestrator's own model when it is a cloud agent (the one
// the user already trusts to coordinate), else the first cloud profile in the roster, else the
// first cloud provider in the fallback order. Null when no cloud agent is configured at all.
export function setupAgent({profiles = {}, orchestrator = null, order = [], models = {}} = {}) {
  const cloud = ([, p]) => p && SETUP_AGENTS.includes(p.adapter);
  const entries = Object.entries(profiles);
  const pick = entries.find(([name, p]) => name === orchestrator && cloud([name, p])) ?? entries.find(cloud);
  if (pick) return {adapter: pick[1].adapter, model: pick[1].model || ''};
  const provider = order.find(name => SETUP_AGENTS.includes(name));
  return provider ? {adapter: provider, model: models[provider] || ''} : null;
}

// ---- the one-shot description ------------------------------------------------------------

// `reference` ([key, tier] pairs) is what the roster already rates: shown so a new model — a local
// one above all — lands on the same scale instead of being ranked only against its neighbours.
export function setupPrompt(models, catalogs = [], reference = []) {
  const vendorSays = ({adapter, model}) => catalogs.find(c => c?.provider === adapter)?.models?.find(m => m.id === model)?.description || '';
  const line = m => {
    const where = LOCAL_ADAPTERS.has(m.adapter) ? `a local model served through LM Studio${m.endpoint ? ` (endpoint ${m.endpoint})` : ''}${m.model && m.model !== 'auto' ? `, model "${m.model}"` : ', the model loaded at the time'}`
      : `the ${m.adapter} CLI${m.model ? `, model "${m.model}"` : ', its default model'}`;
    const vendor = vendorSays(m);
    return `- ${m.key}: ${where}${vendor ? ` — the vendor describes it as: ${JSON.stringify(vendor)}` : ''}`;
  };
  return [
    'You are configuring a router that assigns coding tasks to worker models. For each model listed below, write one or two',
    'sentences on what it is good and bad at as a coding agent — strengths, weaknesses, relative cost and speed, and how well',
    'it handles tool use and multi-step work — and assign a cost tier relative to the others in this list:',
    ...PROFILE_TIERS.map(tier => `  "${tier}" — ${TIER_HINT[tier].slice(tier.length + 2)}`),
    'Judge from what you know of these models and what the vendor says. Say so when you do not recognise one, and place it at',
    '"mid" unless its name or the vendor\'s description says otherwise — never at "cheapest" just because it is unfamiliar.',
    'Do not use any tools, do not read files, and do not ask questions.',
    'Reply with ONLY a JSON object — no prose, no code fence — keyed by the model key exactly as listed:',
    `{${models.map(m => `${JSON.stringify(m.key)}: {"tier": "cheapest|mid|strongest", "capabilities": "…"}`).join(', ')}}`,
    ...(reference.length ? ['', 'Already rated, for scale — place the models below on this same scale:', ...reference.map(([key, tier]) => `  ${key} → ${tier}`)] : []),
    '', 'Models:', ...models.map(line),
  ].join('\n');
}

// The JSON object in an agent's answer, tolerant of prose or a fence around it.
export function parseSetupAnswer(text, models) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the agent answered with no JSON object');
  let value;
  try { value = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('the agent\'s JSON could not be parsed'); }
  if (!isObject(value)) throw new Error('the agent answered with something other than an object');
  const notes = {};
  for (const {key} of models) {
    const note = value[key];
    if (!isObject(note) || typeof note.capabilities !== 'string' || !note.capabilities.trim()) continue;
    notes[key] = {tier: PROFILE_TIERS.includes(note.tier) ? note.tier : 'mid', capabilities: note.capabilities.trim().replace(/\s+/g, ' ').slice(0, CAPABILITIES_MAX)};
  }
  if (!Object.keys(notes).length) throw new Error('the agent described none of the models');
  return notes;
}

// One read-only, tool-free turn of `agent` answering setupPrompt. Resolves the parsed notes
// (each stamped with who wrote them and when); rejects with the agent's failure. `run` is the
// classic runner (providers.js runProcess): the vendor child sees no bus and no grant.
export async function describeModels({models, agent, catalogs = [], reference = [], root = dataRoot(), executables = {}, run = runProcess, timeoutMs = SETUP_TIMEOUT_MS, clock = () => Date.now(), signal} = {}) {
  if (!models.length) return {};
  if (!agent) throw new Error('no signed-in cloud agent to describe the roster with');
  const prompt = setupPrompt(models, catalogs, reference);
  const dir = path.join(root, 'roster-setup');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const promptFile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, {mode: 0o600});
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once: true});
  // claude repeats its final answer as the result text, codex only speaks in assistant rows:
  // the result is read first, then each assistant row from the last back, then all of them.
  const said = [], results = [];
  try {
    const result = await run({provider: agent.adapter, executable: resolveExecutable(agent.adapter, executables[agent.adapter]),
      args: invocation(agent.adapter, {model: agent.model, mode: 'plan'}, promptFile), prompt, cwd: dir, signal: controller.signal,
      emit: e => { if (e.kind === 'assistant') said.push(e.text); else if (e.kind === 'result' && e.success) results.push(e.text); }});
    if (controller.signal.aborted) throw new Error(signal?.aborted ? 'cancelled' : `${agent.adapter} did not answer within ${Math.round(timeoutMs / 1000)} s`);
    if (result.status !== 'completed') throw new Error(`${agent.adapter} ${result.status === 'missing' ? 'is not installed' : result.status}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
  let parsed = null, failure = null;
  for (const candidate of [...results, ...[...said].reverse(), said.join('\n')]) {
    try { parsed = parseSetupAnswer(candidate, models); break; } catch (error) { failure ??= error; }
  }
  if (!parsed) throw failure ?? new Error('the agent answered with no JSON object');
  const by = `${agent.adapter}${agent.model ? `/${agent.model}` : ''}`;
  const at = new Date(clock()).toISOString();
  return Object.fromEntries(Object.entries(parsed).map(([key, note]) => [key, {...note, by, at}]));
}

// ---- the daemon's setup ------------------------------------------------------------------

// `notes()` is what the router reads; `ensure()` describes whatever the roster runs that has no
// note yet — at most one run at a time, and after a failure not again until forced, so a broken
// agent costs one attempt per daemon, not one per task. Every outcome is journaled: `jev.roster`
// with the notes written, or `jev.skipped` with the reason. `onChange` (ORDERS.md) runs after
// notes are written.
export function createRosterSetup({root = dataRoot(), profiles = {}, agent = null, catalogs = async () => [], extra = async () => [], session = null, executables = {}, run, timeoutMs, clock, onChange = () => {}} = {}) {
  let inflight = null, failed = false;
  const append = row => { try { session?.append(row); } catch {} };
  const notes = () => effectiveNotes(profiles, readRosterNotes(root));
  const ensure = ({force = false} = {}) => {
    if (inflight) return inflight;
    if (failed && !force) return Promise.resolve(null);
    const cache = force ? {} : readRosterNotes(root);
    inflight = (async () => {
      try {
        let others = [];
        try { others = await extra(); } catch {}
        const models = undescribedModels(profiles, cache, Array.isArray(others) ? others : []);
        if (!models.length) return null;
        if (!agent) throw new Error('no cloud agent in the roster or the provider order to describe the models with');
        let known = [];
        try { known = await catalogs(); } catch {}
        const reference = [...new Map(Object.values(effectiveNotes(profiles, cache)).filter(note => note.tier).map(note => [note.model, note.tier]))];
        const written = await describeModels({models, agent, catalogs: Array.isArray(known) ? known : [], reference, root, executables, run, timeoutMs, clock});
        writeRosterNotes({...readRosterNotes(root), ...written}, root);
        failed = false;
        const roster = effectiveNotes(profiles, readRosterNotes(root));
        const by = Object.values(written)[0].by;
        append({kind: 'jev.roster', by, models: written, text: `Jev roster: ${by} described ${Object.keys(written).join(', ')} · ${Object.entries(roster).filter(([, n]) => n.tier).map(([name, n]) => `${name} → ${n.tier}`).join(', ')}`});
        try { onChange(); } catch {}
        return written;
      } catch (error) {
        failed = true;
        append({kind: 'jev.skipped', reason: 'roster', text: `Jev roster notes not written · ${error.message} · routing sees adapter/model/role/policy only; /jev roster refresh retries`});
        return null;
      } finally { inflight = null; }
    })();
    return inflight;
  };
  return {notes, ensure, pending: () => inflight};
}

// The `/jev roster` listing: one line per routable profile.
export function rosterLines(profiles = {}, cache = {}) {
  const roster = effectiveNotes(profiles, cache);
  if (!Object.keys(roster).length) return ['No worker profiles to route between'];
  return Object.entries(roster).map(([name, n]) => `${name} → ${n.model}${n.tier ? ` · tier ${n.tier}` : ''}${n.capabilities ? ` · ${n.capabilities}` : ' · not described yet'}${n.source ? ` (${n.source === 'config' || n.source === CATALOG_SOURCE ? n.source : `by ${n.source}`})` : ''}`);
}
