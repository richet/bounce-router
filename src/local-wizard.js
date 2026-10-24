import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual, stripVTControlCharacters} from 'node:util';
import YAML from 'yaml';
import {discoverLocalModels, normalizeLocalSettings} from './local-models.js';
import {checkOpencodeBridge} from './local-opencode-config.js';
import {writeAgent, agentStore, projectAgentStore, shippedAgents} from './agents.js';
import {BINDINGS_FILE, MODELS_FILE, bindingsFile, readBindings} from './bindings.js';

const cancelled = Symbol('cancelled');
const safe = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1200);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const PROVIDERS = new Set(['claude', 'codex', 'muse']);
const isRef = entry => /^[a-z0-9][a-z0-9_-]*\/\S+$/.test(entry) || PROVIDERS.has(entry);

// What a machine needs to play its team (docs/ARCHITECTURE.md § Agents, bindings and models): `models.yaml` naming this machine's models by
// alias, and a `bindings.yml` saying which alias plays each agent. Setup writes them from what it discovers, and folds
// in the move from the old agent files (a profile's `models:` and sampling). Nothing is written before consent.
export async function runLocalSetup({settings, ask, write, save, discover = discoverLocalModels,
  bridge = checkOpencodeBridge, roles = null, root, cwd, loadedOnly = false, signal, shipped = () => shippedAgents(root)}) {
  const draft = structuredClone(settings);
  const ensureActive = () => {if (signal?.aborted) throw cancelled;};
  const prompt = async (question, fallback = '') => {
    ensureActive();
    const response = await ask(question);
    ensureActive();
    if (response === null || response === undefined || response.trim().toLowerCase() === 'cancel') throw cancelled;
    return response.trim() || fallback;
  };
  const yes = async question => /^(y|yes)$/i.test(await prompt(question));
  try {
    write('Local setup: this machine\'s models (models.yaml) and who plays each agent (bindings.yml). Nothing is saved until you confirm. Type cancel at any prompt.');
    if (draft.local?.enabled === false) {
      if (!await yes('Enable local models in the saved configuration? [y/N] ')) return {saved: false};
      draft.local.enabled = true;
    }
    write('Discovering local models; no inference or model loading…');
    const candidates = async () => {
      const catalogs = await discover(draft.local, {maxAge: 0, signal});
      ensureActive();
      // A loaded model is named by its instances (an instance may carry the name the user gave it in LM Studio, which is
      // what a worker asks the server for); one on disk by its id, and it loads on first use.
      return catalogs.flatMap(catalog => (catalog.models ?? []).filter(model => model.type !== 'embedding' && model.tools !== false)
        .flatMap(model => model.ready === true
          ? (model.instances?.length ? model.instances : [{id: model.id, context: model.context}]).map(instance => ({endpoint: catalog.endpoint, id: instance.id, context: instance.context ?? model.context, loaded: true}))
          : loadedOnly || model.ready !== false ? [] : [{endpoint: catalog.endpoint, id: model.id, context: model.context, loaded: false}]));
    };
    const models = await candidates();
    models.sort((a, b) => Number(b.loaded) - Number(a.loaded) || (b.context ?? 0) - (a.context ?? 0));
    if (!models.length) { write('No tool-capable model is loaded or downloaded in LM Studio. Load one (the LM Studio app, or `lms load <model>`), then run setup again.'); return {saved: false}; }
    const entry = item => `[${models.indexOf(item) + 1}] ${safe(item.id)}${item.loaded ? '' : ' (loads on first use)'}`;
    write(`LM Studio has: ${models.slice(0, 6).map(entry).join(' · ')}${models.length > 6 ? ` · and ${models.length - 6} more` : ''}`);

    // The team in use, and the layer setup writes for: the project's when it has a team, else the user's.
    // An invalid agent is still the team's: it is named, never moved, and never offered a copy over it.
    const members = [...(roles?.values() ?? [])].filter(role => role.name !== draft.orchestrator);
    const team = members.filter(role => !role.error);
    for (const role of members.filter(role => role.error)) write(`${safe(role.name)}: INVALID (${safe(role.error)}); not moved`);
    const layer = members[0]?.source === 'project' ? 'project' : 'user';
    const agentsDir = layer === 'project' ? projectAgentStore(cwd) : agentStore(root);
    const bindingsTarget = layer === 'project' ? path.join(cwd, '.bounce', BINDINGS_FILE) : path.join(root, BINDINGS_FILE);
    const modelsTarget = path.join(root, MODELS_FILE);
    const machine = readYamlObject(modelsTarget);
    const inUse = bindingsFile(root, cwd);
    const bindings = {agents: {...(inUse && inUse.file === bindingsTarget ? readBindings(inUse.file).agents : {})}};
    const added = {};                       // alias → models.yaml entry this run adds
    const aliasFor = ref => Object.entries({...machine, ...added}).find(([, value]) => (isObject(value) ? value.model : value) === ref && !isObject(value))?.[0];
    const nameFrom = id => { const base = String(id).toLowerCase().split('-')[0].replace(/[^a-z0-9_.]/g, '_') || 'local'; let name = base, n = 2; while (machine[name] || added[name]) name = `${base}_${n++}`; return name; };

    // 1. The move from the old agent files: each profile's `models:` becomes its bindings entry, a local model id an
    // alias. Sampling that differs between agents on one model becomes a variant alias per agent; the same sampling
    // everywhere is the model's own, which LM Studio holds, so it is dropped and printed.
    // Only a user's or a project's own files are moved; the shipped team is never written (it is bounce's).
    const legacy = team.filter(role => role.profileModels?.length && ['user', 'project'].includes(role.source) && !bindings.agents[role.name]);
    const local = new Set(Object.keys(normalizeLocalSettings(draft.local).endpoints));
    const rewritten = [], dropped = [];
    const byModel = new Map();
    for (const role of legacy) for (const ref of role.profileModels.filter(ref => local.has(ref.split('/')[0]))) (byModel.get(ref) ?? byModel.set(ref, []).get(ref)).push(role);
    const variant = new Map();              // `${agent} ${ref}` → alias
    const here = ref => models.some(item => `${item.endpoint}/${item.id}` === ref);
    const unplayed = new Set();             // aliases left undefined here on purpose: not asked again in step 2
    for (const [ref, users] of byModel) {
      const settingsOf = role => JSON.stringify(role.sampling ?? {});
      const same = new Set(users.map(settingsOf)).size === 1;
      const existing = aliasFor(ref);
      const base = existing ?? nameFrom(ref.split('/').slice(1).join('/'));
      // A model this machine lacks (another machine's id) keeps its alias, so the bindings stay portable; here it is
      // pointed at one of this machine's models, or left undefined.
      let target = ref;
      if (!existing && !here(ref)) {
        const answer = await prompt(`The old files name ${safe(ref)}, which LM Studio here does not have → which model here plays ${safe(base)}? number, id or skip (Enter = 1): `, '1');
        const item = answer === 'skip' ? null : models[Number(answer) - 1] ?? models.find(candidate => candidate.id === answer);
        if (answer !== 'skip' && !item) write(`No model ${safe(answer)}; ${safe(base)} left undefined.`);
        target = item ? `${item.endpoint}/${item.id}` : null;
      }
      if (!existing && target) added[base] = target;
      if (!target) unplayed.add(base);
      for (const role of users) {
        if (same || !role.sampling) { variant.set(`${role.name} ${ref}`, base); if (role.sampling) dropped.push({agent: role.name, sampling: role.sampling}); continue; }
        // A same-named alias this machine already has is reused only when it is the same model and settings.
        const spec = {model: target, ...role.sampling};
        let name = `${base}_${role.name}`;
        for (let n = 2; machine[name] && !isDeepStrictEqual(machine[name], spec) || added[name]; n++) name = `${base}_${role.name}_${n}`;
        if (!target) unplayed.add(name); else if (!machine[name]) added[name] = spec;
        variant.set(`${role.name} ${ref}`, name);
      }
    }
    let bindingsChanged = legacy.length > 0;
    for (const role of legacy) {
      bindings.agents[role.name] = role.profileModels.map(ref => ref === 'auto' ? ref : local.has(ref.split('/')[0]) ? variant.get(`${role.name} ${ref}`) : ref);
      rewritten.push(role);
    }

    // 2. The aliases the bindings ask for that this machine does not name: each pointed at one of its models.
    const wanted = new Set(Object.values(bindings.agents).flat().filter(entry => entry !== 'auto' && !isRef(entry)));
    for (const alias of [...wanted].filter(alias => !machine[alias] && !added[alias] && !unplayed.has(alias))) {
      const suggestion = (/cod(e|er)/i.test(alias) && models.find(item => /cod(e|er)/i.test(item.id))) || models[0];
      const answer = await prompt(`The bindings ask for ${safe(alias)} → which model here? number, id or skip (Enter = ${models.indexOf(suggestion) + 1}): `, String(models.indexOf(suggestion) + 1));
      if (answer === 'skip') continue;
      const item = models[Number(answer) - 1] ?? models.find(candidate => candidate.id === answer);
      if (!item) { write(`No model ${safe(answer)}; ${safe(alias)} left undefined.`); continue; }
      added[alias] = `${item.endpoint}/${item.id}`;
    }

    // 3. A first setup with nothing to bind: the shipped starting point, every agent on Jev, then this machine.
    if (!Object.keys(bindings.agents).length && !inUse) {
      const item = models[0];
      const name = aliasFor(`${item.endpoint}/${item.id}`) ?? nameFrom(item.id);
      if (!machine[name]) added[name] = `${item.endpoint}/${item.id}`;
      bindings.agents['*'] = ['auto', name, 'claude/sonnet', 'codex'];
      bindingsChanged = true;
    }

    // 4. Agents bounce ships that this team lacks: offered one by one, copied in only when asked (option A).
    const copies = [];
    if (team.length && team[0].source !== 'skill' && team[0].source !== 'installed-skill') {
      for (const agent of shipped().values()) {
        if (agent.error || members.some(role => role.name === agent.name)) continue;
        if (!await yes(`Your team has no ${safe(agent.name)} (${safe(agent.description)}). Copy bounce's into ${safe(agentsDir)}? [y/N] `)) continue;
        copies.push(agent);
        // Its chain moves with it: bounce's own, unless the bindings say who plays every other agent.
        if (!bindings.agents[agent.name] && !bindings.agents['*'] && agent.models?.length) { bindings.agents[agent.name] = [...agent.models]; bindingsChanged = true; }
      }
    }

    const nextModels = {...machine, ...added};
    const writeBindings = bindingsChanged;
    if (!Object.keys(added).length && !writeBindings && !copies.length) { write('Nothing to change: this machine\'s models and the bindings in use already agree.'); return {saved: false}; }
    if (Object.keys(added).length) write(`${modelsTarget} gets:\n${yamlText(added).trimEnd()}`);
    if (writeBindings) write(`${bindingsTarget} will read:\n${yamlText(bindings).trimEnd()}`);
    for (const role of rewritten) write(`${role.file ?? role.name}: models: and sampling move out of the profile`);
    for (const {agent, sampling} of dropped) write(`Dropped from ${agent}, the model's own settings (set them on the model in LM Studio if they matter): ${Object.entries(sampling).map(([key, value]) => `${key} ${value}`).join(', ')}`);
    for (const agent of copies) write(`${path.join(agentsDir, `${agent.name}.md`)}: copied from bounce`);
    if (!await yes('Save this? [y/N] ')) return {saved: false};

    // LM Studio unloads and deletes models on its own: what the new aliases name must still be there after consent.
    const still = await candidates();
    for (const ref of Object.values(added).map(value => isObject(value) ? value.model : value).filter(ref => local.has(ref.split('/')[0]))) {
      if (!still.some(item => `${item.endpoint}/${item.id}` === ref)) throw new Error(`Model ${ref} is no longer available; rerun setup. Nothing saved.`);
    }
    const localAlias = Object.values(added).map(value => isObject(value) ? value.model : value).find(ref => local.has(ref.split('/')[0]));
    if (localAlias) {
      write('Checking the OpenCode bridge with a one-line test turn...');
      const [endpoint, ...id] = localAlias.split('/');
      const status = await bridge({settings: normalizeLocalSettings(draft.local), endpoint, model: id.join('/')});
      if (!status.worker.ready) throw new Error(`OpenCode bridge not ready: ${status.worker.reason ?? status.config.reason}. Nothing saved.`);
      write(`OpenCode bridge ready · ${safe(status.binary)}`);
    }
    ensureActive();
    await save(draft);
    if (Object.keys(added).length) { writeYaml(modelsTarget, nextModels, '# This machine\'s models, by alias: what bindings.yml names. bounce local setup wrote it; edit freely.'); write(`Wrote ${modelsTarget}`); }
    if (writeBindings) { writeYaml(bindingsTarget, bindings, '# Which alias plays each agent, first choice first. auto lets Jev pick; "*" is every other agent.'); write(`Wrote ${bindingsTarget}`); }
    for (const role of rewritten) {
      const {file, source, error, binding, chainSettings, models: _m, sampling: _s, ...agent} = role;
      write(`Wrote ${safe(writeAgent(path.dirname(file), agent, {force: true}).file)}`);
    }
    for (const agent of copies) { const {file, source, error, binding, chainSettings, models: _models, sampling: _sampling, ...profile} = agent; write(`Wrote ${safe(writeAgent(agentsDir, profile, {force: true}).file)}`); }
    write('Saved.');
    return {saved: true, models: Object.keys(added), bindings: writeBindings ? bindingsTarget : null, rewritten: rewritten.map(role => role.name), copied: copies.map(agent => agent.name)};
  } catch (error) {
    if (error !== cancelled) throw error;
    write('Setup cancelled. Nothing saved.');
    return {saved: false};
  }
}

function readYamlObject(file) {
  try { const value = YAML.parse(fs.readFileSync(file, 'utf8')); return isObject(value) ? value : {}; } catch { return {}; }
}
// Chains read best on one line, as the plan writes them: `builder: [auto, sonnet, qwen_coder]`.
function yamlText(value) {
  const doc = new YAML.Document(value);
  YAML.visit(doc, {Seq(_, node) { node.flow = true; }});
  return doc.toString({flowCollectionPadding: false});
}
function writeYaml(file, value, header) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, `${header}\n${yamlText(value)}`, {mode: 0o600});
}
