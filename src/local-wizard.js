import {stripVTControlCharacters} from 'node:util';
import {discoverLocalModels, normalizeLocalSettings} from './local-models.js';
import {checkOpencodeBridge} from './local-opencode-config.js';
import {writeAgent} from './agents.js';
import {validateOrchestration} from './profiles.js';

const cancelled = Symbol('cancelled');
const safe = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1200);

// The one thing that is different about a local worker is configuration, so this is the whole of
// the setup assist: see which models LM Studio has, and say which one plays each agent. An agent is
// the job; picking a model puts `lmstudio/<model>` first in that agent's `models:` (a user-layer
// override file), with the AIs that could already play it kept behind as fallbacks. Enter accepts a
// suggestion for every agent, so setup can be next-next-next. Nothing is written before consent.
export async function runLocalSetup({settings, ask, write, save, discover = discoverLocalModels,
  bridge = checkOpencodeBridge, roles = null, agentsDir = null, loadedOnly = false, signal}) {
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
    write('Local worker setup. Nothing is saved until final confirmation. Type cancel at any prompt.');
    if (draft.local?.enabled === false) {
      if (!await yes('Enable local models in the saved configuration? [y/N] ')) return {saved: false};
      draft.local.enabled = true;
    }
    if (draft.operation !== 'orchestrator') {
      if (!await yes('Enable orchestrator mode for future sessions? [y/N] ')) return {saved: false};
      draft.operation = 'orchestrator';
      draft.orchestrator ??= 'main';
      // The overlay only: the shipped roster stays underneath it in the validated view, so the switch
      // never copies the roster into config.json.
      draft.profiles ??= {};
    }
    write('Discovering local models; no inference or model loading…');
    const candidates = async () => {
      const catalogs = await discover(draft.local, {maxAge: 0, signal});
      ensureActive();
      return catalogs.flatMap(catalog => (catalog.models ?? []).filter(model => model.type !== 'embedding' && model.tools !== false)
        .flatMap(model => model.ready === true
          ? (model.instances?.length ? model.instances : [{id: model.id, context: model.context}]).map(instance => ({endpoint: catalog.endpoint, id: instance.id, context: instance.context, loaded: true}))
          : loadedOnly || model.ready !== false ? [] : [{endpoint: catalog.endpoint, id: model.id, context: model.context, loaded: false}]));
    };
    const models = await candidates();
    const declared = [...(roles?.values() ?? [])].filter(role => !role.error && role.name !== draft.orchestrator);
    if (!models.length) { write('No tool-capable model is loaded or downloaded in LM Studio. Load one (the LM Studio app, or `lms load <model>`), then run setup again.'); return {saved: false}; }
    if (!declared.length || !agentsDir) { write('There are no agent files to fill. See `bounce agents`.'); return {saved: false}; }

    // The TUI's setup pane shows about ten rows, so nothing here may depend on a long list staying on
    // screen: loaded models lead and are repeated INSIDE every question; the (often many) downloaded
    // ones keep their numbers but are only printed when asked for with `list`.
    models.sort((a, b) => Number(b.loaded) - Number(a.loaded));
    const loaded = models.filter(item => item.loaded), downloaded = models.filter(item => !item.loaded);
    const size = item => item.context ? `${Math.round(item.context / 1024)}k` : '?';
    const entry = item => `[${models.indexOf(item) + 1}] ${safe(item.id)} (${size(item)})`;
    const inline = loaded.length ? loaded : models.slice(0, 4);
    // Inside a question (the pane caps it at three rows) names are trimmed; the line above has them whole.
    const brief = item => `[${models.indexOf(item) + 1}] ${safe(item.id).length > 26 ? `${safe(item.id).slice(0, 25)}…` : safe(item.id)}`;
    write(`${loaded.length ? 'Loaded' : 'Nothing is loaded; downloaded (load on first use)'}: ${inline.map(entry).join(' · ')}`);
    if (loaded.length && downloaded.length) write(`${downloaded.length} more ${downloaded.length === 1 ? 'is' : 'are'} downloaded and would load on first use — answer "list" to see ${downloaded.length === 1 ? 'it' : 'them'}.`);
    write(`Agents (${declared.every(role => role.source === 'skill') ? 'shipped with skill agent-orchestrator' : 'from your agent files'}): Enter takes the suggestion, a number picks another model, skip leaves the agent as is.`);
    // A write agent gets the largest coder model (else the largest), a read-only one the largest;
    // a loaded model always beats one that would have to be loaded.
    const ranked = [...models].sort((a, b) => Number(b.loaded) - Number(a.loaded) || (b.context ?? 0) - (a.context ?? 0));
    const suggest = role => (role.policy === 'write' ? ranked.find(item => item.loaded === ranked[0].loaded && /cod(e|er)/i.test(item.id)) : null) ?? ranked[0];
    const picks = [];
    for (const role of declared) {
      const current = role.models?.find(ref => Object.hasOwn(normalizeLocalSettings(draft.local).endpoints, ref.split('/')[0]));
      const suggestion = suggest(role), suggested = String(models.indexOf(suggestion) + 1);
      let item = null;
      for (;;) {
        const answer = (await prompt(`${safe(role.name)} (${role.policy})${current ? ` · now ${safe(current)}` : ''} → ${inline.map(brief).join(' · ')} · ${downloaded.length && loaded.length ? 'list · ' : ''}skip (Enter = ${suggested}): `, suggested)).trim();
        if (answer === 'list') {
          const rest = loaded.length ? downloaded : models.slice(4);
          for (let at = 0; at < rest.length; at += 3) write(rest.slice(at, at + 3).map(entry).join('   '));
          if (!rest.length) write('There are no other models.');
          continue;
        }
        if (answer && answer !== 'skip') {
          item = models[Number(answer) - 1] ?? models.find(candidate => candidate.id === answer);
          if (!item) { write(`No model ${safe(answer)}; leaving ${safe(role.name)} as is.`); }
        }
        break;
      }
      if (!item) continue;
      if (role.policy === 'write' && draft.mode !== 'yolo') {
        write('A write agent needs yolo session mode. This also relaxes cloud-provider permissions.');
        if (!await yes('Enable yolo for future sessions? [y/N] ')) return {saved: false};
        draft.mode = 'yolo';
      }
      const ref = `${item.endpoint}/${item.id}`;
      // The pick goes first; whoever could already play the agent stays behind it — including the
      // implicit providers an agent with no `models:` had, so pinning never drops the cloud fallback.
      const implicit = (draft.order ?? []).map(provider => `${provider}/${draft.models?.[provider] || 'default'}`);
      // Picking a local model REPLACES the agent's other local models: the user is saying which one
      // plays it. (Stacking them left a weak model as the first fallback — observed live: a 4B that
      // "completed" a scout with a wrong answer.) Cloud AIs stay behind the pick.
      const endpoints = Object.keys(normalizeLocalSettings(draft.local).endpoints);
      const chain = [ref, ...(role.models ?? implicit).filter(other => !endpoints.includes(other.split('/')[0]))];
      for (const fallback of implicit) if (!chain.some(other => other.startsWith(`${fallback.split('/')[0]}/`))) chain.push(fallback);
      const {file, source, error, ...agent} = role;
      picks.push({agent: {...agent, models: chain}, item});
      write(`${safe(role.name)} → ${safe(item.id)}${item.loaded ? '' : ' (loads on first use)'}${chain.length > 1 ? ` · then ${safe(chain.slice(1).join(', '))}` : ''}`);
    }
    if (!picks.length) { write('No agent changed. Nothing saved.'); return {saved: false}; }
    if (picks.some(pick => pick.agent.policy === 'write')) write('A local write agent edits your project directly and may run commands, exactly like a cloud worker in yolo mode.');
    validateOrchestration(draft, undefined, {roles});
    write(`Agent files to write (${safe(agentsDir)}): ${picks.map(pick => `${safe(pick.agent.name)}.md`).join(', ')}.`);
    if (!await yes('Save this configuration? [y/N] ')) return {saved: false};
    const still = await candidates();
    for (const pick of picks) if (!still.some(item => item.endpoint === pick.item.endpoint && item.id === pick.item.id)) throw new Error(`Model ${pick.item.id} is no longer available; rerun setup. Nothing saved.`);
    // Local workers are driven by OpenCode, a second binary bounce does not ship. Prove the bridge with
    // one real turn before writing anything, so a missing or unreachable setup is reported here.
    write('Checking the OpenCode bridge with a one-line test turn...');
    const status = await bridge({settings: normalizeLocalSettings(draft.local), endpoint: picks[0].item.endpoint, model: picks[0].item.id});
    if (!status.worker.ready) throw new Error(`OpenCode bridge not ready: ${status.worker.reason ?? status.config.reason}. Nothing saved.`);
    write(`OpenCode bridge ready · ${safe(status.binary)}`);
    ensureActive();
    // The config first: if it changed under us, save() refuses and no agent file is left behind.
    await save(draft);
    for (const pick of picks) write(`Wrote ${safe(writeAgent(agentsDir, pick.agent, {force: true}).file)}`);
    write('Saved.');
    return {saved: true, profiles: [], agents: picks.map(pick => pick.agent.name)};
  } catch (error) {
    if (error !== cancelled) throw error;
    write('Setup cancelled. No configuration saved.');
    return {saved: false};
  }
}
