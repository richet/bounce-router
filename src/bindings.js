// Which models play the team's agents. A project's profiles say who an agent is; its
// bindings.yml says which alias plays each one; each machine's models.yaml says what an alias is here. One bindings
// file is in use — the project's, else the user's, else none (today's default chains) — taken whole, never merged.
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const BINDINGS_FILE = 'bindings.yml';
export const MODELS_FILE = 'models.yaml';
const AUTO = 'auto';
const PROVIDERS = new Set(['claude', 'codex', 'muse']);
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MODEL_REF = /^[a-z0-9][a-z0-9_-]*\/\S+$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (file, message) => { throw new Error(`${path.basename(file)}: ${message}`); };

function readYaml(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try { return YAML.parse(text) ?? {}; } catch (error) { return fail(file, `not valid YAML (${error.message.split('\n')[0]})`); }
}

// The bindings file in use and where it came from: the project's, else the user's, else null (the default).
export function bindingsFile(root, cwd) {
  const project = cwd && path.resolve(cwd, '.bounce') !== path.resolve(root) ? path.join(cwd, '.bounce', BINDINGS_FILE) : null;
  if (project && fs.existsSync(project)) return {file: project, source: 'project'};
  const user = path.join(root, BINDINGS_FILE);
  return fs.existsSync(user) ? {file: user, source: 'user'} : null;
}

export function readBindings(file) {
  const value = readYaml(file);
  if (value === null) return {agents: {}};
  if (!isObject(value)) fail(file, 'must be a mapping with an agents: section');
  for (const key of Object.keys(value)) if (key !== 'agents') fail(file, `unknown key ${key}`);
  const agents = value.agents ?? {};
  if (!isObject(agents)) fail(file, 'agents: must map each agent name to its chain');
  for (const [name, chain] of Object.entries(agents)) {
    if (!Array.isArray(chain) || !chain.length || chain.some(entry => typeof entry !== 'string' || !entry.trim())) fail(file, `${name}: a chain is a list of names, like [auto, qwen, claude/sonnet]`);
    if (chain.indexOf(AUTO) > 0) fail(file, `${name}: auto goes first; the entries after it are what the agent falls back to`);
  }
  return {agents};
}

// `sampling` is src/agents.js SAMPLING: the same settings an agent file accepted, now an alias's.
export function readModels(file, sampling) {
  const value = readYaml(file);
  if (value === null) return {};
  if (!isObject(value)) fail(file, 'must map each alias to a model, like qwen: lmstudio/qwen3.8-27b');
  const models = {};
  for (const [alias, entry] of Object.entries(value)) {
    if (alias === AUTO) fail(file, 'auto is reserved: it hands the choice to Jev');
    if (!ALIAS.test(alias)) fail(file, `${alias}: an alias is letters, digits, _ . or -, with no /`);
    const spec = isObject(entry) ? entry : {model: entry};
    if (typeof spec.model !== 'string' || !MODEL_REF.test(spec.model)) fail(file, `${alias}: the model is a provider/model ref, like lmstudio/qwen3.8-27b or claude/sonnet`);
    const settings = {};
    for (const [key, raw] of Object.entries(spec)) {
      if (key === 'model') continue;
      if (!sampling[key]) fail(file, `${alias}: unknown setting ${key}`);
      settings[key] = sampling[key].parse(String(raw));
      if (settings[key] === undefined) fail(file, `${alias}: ${key} must be ${sampling[key].rule}`);
    }
    models[alias] = {model: spec.model, settings: Object.keys(settings).length ? settings : null};
  }
  return models;
}

function resolveEntry(entry, models) {
  if (models[entry]) return {ref: models[entry].model, settings: models[entry].settings, alias: entry};
  if (MODEL_REF.test(entry)) return {ref: entry, settings: null};
  if (PROVIDERS.has(entry)) return {ref: `${entry}/default`, settings: null};
  return {skipped: {entry, reason: `bindings ask for ${entry}; ${MODELS_FILE} does not define it`}};
}

// Gives each agent of the team the chain it plays on: its entry in the bindings in use, else its profile's own
// `models:` (legacy), else that file's "*", else nothing (profiles.js derives today's default). `models` becomes the
// resolved refs and `chainSettings` their aliases' settings, one per ref; `binding` says where the chain came from.
export function applyBindings(roles, {root, cwd, sampling}) {
  let inUse, bindings, models;
  try {
    inUse = bindingsFile(root, cwd);
    bindings = inUse ? readBindings(inUse.file) : {agents: {}};
    models = readModels(path.join(root, MODELS_FILE), sampling);
  } catch (error) {
    for (const role of roles.values()) if (!role.error) role.error = error.message;
    return roles;
  }
  for (const role of roles.values()) {
    if (role.error) continue;
    const own = bindings.agents[role.name];
    // The shipped team's `models: [auto]` is its default chain, not a user's old file to move.
    const shipped = role.source === 'skill' || role.source === 'installed-skill';
    // Kept even when another file's chain wins, so setup can still move it into the profile's own layer.
    if (role.models?.length && !shipped) role.profileModels = [...role.models];
    if (!own && role.models?.length && !shipped) { role.binding = {source: 'profile', file: role.file ?? null, from: role.name, skipped: []}; continue; }
    const chain = own ?? bindings.agents['*'];
    if (!chain) continue;
    const resolved = chain.filter(entry => entry !== AUTO).map(entry => resolveEntry(entry, models));
    role.models = [...(chain[0] === AUTO ? [AUTO] : []), ...resolved.filter(item => item.ref).map(item => item.ref)];
    role.chainSettings = resolved.filter(item => item.ref).map(item => item.settings);
    role.chainAliases = resolved.filter(item => item.ref).map(item => item.alias ?? null);
    role.binding = {source: inUse.source, file: inUse.file, from: own ? role.name : '*', skipped: resolved.filter(item => item.skipped).map(item => item.skipped)};
  }
  return roles;
}

// A model id read as a family and a version, so a newer release of the same model is found by name: gpt-5.6-terra
// and gpt-6.1-terra are both gpt-terra, claude-opus-4-8 and claude-opus-5 both claude-opus. An id with no version
// (claude/sonnet, an alias that already follows the newest) has none to upgrade.
export function modelVersion(id) {
  const [, base, variant = ''] = String(id).match(/^(.*?)(\[[^\]]*\])?$/);
  const parts = base.split('-');
  const version = parts.filter(part => /^\d+(\.\d+)*$/.test(part)).flatMap(part => part.split('.').map(Number));
  return version.length ? {family: parts.filter(part => !/^\d+(\.\d+)*$/.test(part)).join('-') + variant, version} : null;
}
const newer = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); return false; };

// Each chain entry that names a versioned model, with the newest release of its family a signed-in CLI reports.
// `catalogs` is src/models.js modelCatalog: what each vendor offers today, so a new model is seen the day it ships.
export function bindingUpdates(chains, catalogs) {
  const offered = new Map(catalogs.map(catalog => [catalog.provider, catalog.models.map(model => model.id)]));
  const updates = [];
  for (const [agent, chain] of Object.entries(chains)) for (const entry of chain) {
    const slash = entry.indexOf('/');
    if (slash < 0) continue;
    const provider = entry.slice(0, slash), current = modelVersion(entry.slice(slash + 1));
    if (!current) continue;
    let best = null;
    for (const id of offered.get(provider) ?? []) {
      const release = modelVersion(id);
      if (release?.family === current.family && newer(release.version, (best ?? current).version)) best = {id, version: release.version};
    }
    if (best) updates.push({agent, from: entry, to: `${provider}/${best.id}`});
  }
  return updates;
}

// The upgrades in one line for the TUI, or null when every chain is on its family's newest model.
export function bindingUpdatesNotice(updates) {
  if (!updates.length) return null;
  const pairs = [...new Set(updates.map(update => `${update.from} → ${update.to}`))];
  return `Newer models: ${pairs.join(', ')} · bounce bindings update shows where, --save applies it`;
}

// `bounce bindings update [--save]`: lists the upgrades, and with save rewrites those entries in the bindings file in
// use, keeping its comments and order. When an agent already lists the newer model, the older entry is dropped.
export function bindingsCommand(words, {root, cwd, catalogs = [], save = false}) {
  const [action = 'list'] = words.filter(Boolean);
  const inUse = bindingsFile(root, cwd);
  if (!['list', 'update'].includes(action)) throw new Error('Use bindings [list] or bindings update [--save]');
  if (!inUse) return {text: `No ${BINDINGS_FILE} in use: agents play their default chains. bounce local setup writes one.`, report: null};
  const {agents: chains} = readBindings(inUse.file);
  if (action === 'list') {
    const width = Math.max(0, ...Object.keys(chains).map(name => name.length)) + 2;
    return {text: [`${inUse.file} (${inUse.source})`, ...Object.entries(chains).map(([name, chain]) => `  ${name.padEnd(width)}${chain.join(', ')}`)].join('\n'), report: {...inUse, agents: chains}};
  }
  const updates = bindingUpdates(chains, catalogs);
  const unread = catalogs.filter(catalog => !catalog.models.length).map(catalog => `  ${catalog.provider} not checked: ${catalog.error}`);
  if (!updates.length) return {text: [`Every model in ${inUse.file} is its family's newest.`, ...unread].join('\n'), report: {file: inUse.file, updates, saved: false}};
  const rows = updates.map(update => `  ${update.agent}: ${update.from} → ${update.to}`);
  if (!save) return {text: [`Newer models for ${inUse.file}:`, ...rows, ...unread, 'bounce bindings update --save applies them.'].join('\n'), report: {file: inUse.file, updates, saved: false}};
  const doc = YAML.parseDocument(fs.readFileSync(inUse.file, 'utf8'));
  for (const {agent, from, to} of updates) {
    const seq = doc.getIn(['agents', agent], true);
    const values = seq.items.map(item => String(YAML.isScalar(item) ? item.value : item));
    const at = values.indexOf(from);
    if (values.includes(to)) seq.items.splice(at, 1); else seq.items[at] = doc.createNode(to);
  }
  fs.writeFileSync(inUse.file, doc.toString({lineWidth: 0}));
  return {text: [`Updated ${inUse.file}:`, ...rows, ...unread, 'Used by newly started sessions; a running one keeps its roster.'].join('\n'), report: {file: inUse.file, updates, saved: true}};
}
