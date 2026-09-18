import fs from 'node:fs/promises';
import path from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {discoverLocalModels, resolveLocalModel} from './local-models.js';
import {recommendLocalModels, probeLocalModel} from './local-recommend.js';
import {previewLocalProfile} from './local-setup.js';
import {validateOrchestration} from './profiles.js';
import {inspectLocalToolchain, prepareLocalToolchain} from './local-toolchain.js';

const cancelled = Symbol('cancelled');
const safe = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 1200);

export async function runLocalSetup({settings, cwd, ask, write, save, discover = discoverLocalModels,
  probe = probeLocalModel, inspect = inspectLocalToolchain, prepare = prepareLocalToolchain, loadedOnly = false, liveActivation = false, signal}) {
  let draft = structuredClone(settings);
  const ensureActive = () => {if (signal?.aborted) throw cancelled;};
  const prompt = async (question, fallback = '') => {
    ensureActive();
    const response = await ask(question);
    ensureActive();
    if (response === null || response === undefined || response.trim().toLowerCase() === 'cancel') throw cancelled;
    return response.trim() || fallback;
  };
  const yes = async question => /^(y|yes)$/i.test(await prompt(question));
  const choose = async (question, options, fallback) => {
    for (;;) {
      const answer = (await prompt(question, fallback)).toLowerCase();
      if (options.includes(answer)) return answer;
      write(`Choose ${options.join(', ')}; or type cancel.`);
    }
  };
  try {
    write('Local worker setup. Nothing is saved until final confirmation. Type cancel at any prompt.');
    if (draft.local?.enabled === false) {
      if (!await yes('Enable local models in the saved configuration? [y/N] ')) return {saved: false};
      draft.local.enabled = true;
    }
    if (draft.operation !== 'orchestrator') {
      if (!await yes('Enable orchestrator mode for future sessions? [y/N] ')) return {saved: false};
      draft.operation = 'orchestrator';
      // The overlay only: the shipped roster stays underneath it in the validated view, so
      // the switch never copies the roster into config.json (cli.js materialiseRoster does the same).
      draft.orchestrator ??= 'main';
      draft.profiles ??= {};
    }
    const purpose = await choose('Workers for research/review, coding, or both? [research/coding/both] ', ['research', 'coding', 'both'], 'research');
    if (purpose !== 'research' && draft.mode !== 'yolo') {
      write('Write workers require yolo session mode. This also relaxes cloud-provider permissions.');
      if (!await yes('Enable yolo for future sessions? [y/N] ')) return {saved: false};
      draft.mode = 'yolo';
    }
    const priority = await choose('Priority: balanced, speed, or context? [balanced] ', ['balanced', 'speed', 'context'], 'balanced');
    write('Discovering local models; no inference or model loading…');
    const refresh = async () => {
      const catalogs = await discover(draft.local, {maxAge: 0, signal});
      ensureActive();
      return loadedOnly ? catalogs.map(catalog => ({...catalog, models: catalog.models.filter(model => model.ready === true)})) : catalogs;
    };
    let catalogs = await refresh();
    if (loadedOnly) write('Using currently loaded models only. No model will be loaded or downloaded.');
    const intents = purpose === 'both' ? ['research', 'coding'] : [purpose];
    const selections = [];
    for (const intent of intents) {
      let recommendation = recommendLocalModels({catalogs, settings: draft, intent, priority});
      for (const note of recommendation.notes) write(safe(note));
      for (const candidate of recommendation.candidates) write(`${safe(candidate.ref)} · ${candidate.eligible ? 'eligible' : 'unavailable'} · ${safe(candidate.reasons.join('; '))}`);
      if (!recommendation.recommended) {
        write('No eligible loaded model. Load a tool-capable LLM in LM Studio, check its server, then rerun setup. Manual capability overrides remain available.');
        return {saved: false};
      }
      const eligible = recommendation.candidates.filter(candidate => candidate.eligible);
      const probes = [];
      if (await yes(`Compare ${Math.min(eligible.length, 8)} loaded models with small synthetic ${intent} tests? Uses local inference only; ensure other local workers are idle. [y/N] `)) {
        for (const candidate of eligible.slice(0, 8)) {
          write(`Testing ${safe(candidate.ref)} (one request, up to 30 seconds)…`);
          const result = await probe({local: draft.local, catalogs, ref: candidate.ref, intent, signal});
          ensureActive();
          probes.push(result);
          write(`${safe(candidate.ref)}: ${result.status} · ${result.durationMs ?? '?'} ms · ${safe(result.evidence.join('; '))}`);
          for (const limitation of result.limitations ?? []) write(safe(limitation));
          if (result.status === 'uncertain') {
            write('Inference termination is uncertain. Setup stopped without saving; check LM Studio before trying another model.');
            return {saved: false};
          }
        }
        recommendation = recommendLocalModels({catalogs, settings: draft, intent, priority, probes});
      }
      if (!recommendation.recommended) {
        write('No candidate passed the selected checks. Nothing saved.');
        return {saved: false};
      }
      write(`Recommendation for ${intent}: ${safe(recommendation.recommended)}. You can accept or choose any eligible model listed above.`);
      let ref;
      for (;;) {
        ref = await prompt('Model endpoint/key [Enter accepts recommendation]: ', recommendation.recommended);
        if (recommendation.candidates.some(candidate => candidate.ref === ref && candidate.eligible)) break;
        write('Choose an eligible exact endpoint/model key from the list.');
      }
      let name;
      for (;;) {
        name = await prompt('Worker profile name: ', intent === 'coding' ? 'local_build' : 'local_read');
        // Shipped names count as existing: the validated table, not the overlay alone.
        if (/^[A-Za-z0-9_-]+$/.test(name) && !Object.hasOwn(validateOrchestration(draft).profiles, name)) break;
        write('Use a new name containing letters, numbers, underscores or hyphens. Existing profiles are not overwritten.');
      }
      const slash = ref.indexOf('/');
      const options = {model: ref.slice(slash + 1), endpoint: ref.slice(0, slash), role: intent === 'coding' ? 'builder' : 'analyst', policy: intent === 'coding' ? 'write' : 'read-only'};
      if (intent === 'coding') {
        const suggestedPaths = [];
        for (const entry of ['src', 'test', 'tests']) {
          if ((await fs.lstat(path.join(cwd, entry)).catch(() => null))?.isDirectory()) suggestedPaths.push(entry);
        }
        let manifest = {};
        try { manifest = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')); } catch {}
        options.writePaths = (await prompt(`Writable paths, comma-separated [${suggestedPaths.join(',')}]: `, suggestedPaths.join(','))).split(',').map(value => value.trim()).filter(Boolean);
        const defaultCommand = manifest.scripts?.test ? 'npm test' : '';
        const commands = await prompt(`Exact permitted commands, separated by ;; [${defaultCommand || 'none'}]; type none to grant none: `, defaultCommand);
        options.commands = commands === 'none' ? [] : commands.split(';;').map(value => value.trim()).filter(Boolean);
        write('Command permissions are exact strings. Commands run without network access in Docker/OrbStack.');
        let image = await prompt('Container image [node:22-alpine]: ', 'node:22-alpine');
        if (await yes('Prepare a cached npm dependency image now? Copies only package/lock metadata; install scripts disabled. [y/N] ')) {
          const allowNetwork = await yes('Allow npm package downloads during this image build? Worker networking remains disabled. [y/N] ');
          const prepared = await prepare({cwd, image, allowNetwork, onActivity: event => write(safe(event.text))});
          image = prepared.profileImageID;
        }
        const check = await inspect({cwd, image});
        if (!check.docker.ready || !check.image.ready) throw new Error(`Container is not ready: ${check.docker.reason ?? check.image.reason}`);
        options.container = {image: check.image.id};
        write('Image exists. Dependency compatibility and command success still require a worker test; image metadata alone does not prove them.');
      }
      if (await yes('Adjust worker token/time/container limits? [y/N] ')) {
        const number = async (question, fallback) => {
          const value = Number(await prompt(question, String(fallback)));
          if (!Number.isInteger(value)) throw new Error('Limits must be whole numbers; nothing saved');
          return value;
        };
        options.localOptions = {
          maxOutputTokens: await number('Maximum output tokens [2048]: ', 2048),
          timeoutMs: await number('Model request timeout in milliseconds [120000]: ', 120000),
        };
        if (intent === 'coding') {
          options.container.memoryMiB = await number('Container memory MiB [512]: ', 512);
          options.container.cpus = await number('Container CPUs [1]: ', 1);
          options.container.pids = await number('Container process limit [64]: ', 64);
          options.container.workspaceMiB = await number('Private workspace MiB [128]: ', 128);
        }
      }
      const preview = previewLocalProfile({settings: draft, name, options});
      resolveLocalModel({local: draft.local, catalogs, profile: preview.profile,
        requirements: {tools: true, context: preview.profile.localOptions.maxOutputTokens + 1024}});
      draft = preview.settings;
      selections.push({name, ref, intent, probes});
      write(`Profile preview ${safe(name)}:\n${JSON.stringify(preview.profile, null, 2)}`);
      write(`Review ${safe(name)}: ${safe(ref)} · ${options.policy}`);
      write(`Writable: ${safe((options.writePaths ?? []).join(', ') || 'none')} · Commands: ${safe((options.commands ?? []).join(' ;; ') || 'none')}`);
      write(`Limits: ${preview.profile.localOptions.maxOutputTokens} output tokens · ${preview.profile.localOptions.timeoutMs} ms per request`);
      if (options.container) write(`Image: ${safe(options.container.image)} · ${preview.profile.container.memoryMiB} MiB · ${preview.profile.container.cpus} CPU · ${preview.profile.container.pids} processes · ${preview.profile.container.workspaceMiB} MiB workspace`);
    }
    validateOrchestration(draft);
    write(liveActivation
      ? 'After saving, Bounce will activate these workers in this session if its permission ceiling allows them. Existing agents and their permissions will not change.'
      : 'These profiles apply to newly started sessions only. Existing sessions and workers will not change.');
    if (!await yes('Save this configuration? [y/N] ')) return {saved: false};
    catalogs = await refresh();
    for (const selection of selections) {
      const current = recommendLocalModels({catalogs, settings: draft, intent: selection.intent, priority, probes: selection.probes});
      if (!current.candidates.some(candidate => candidate.ref === selection.ref && candidate.eligible)) throw new Error('Model availability changed; rerun setup. Nothing saved.');
      const profile = validateOrchestration(draft).profiles[selection.name];
      resolveLocalModel({local: draft.local, catalogs, profile,
        requirements: {tools: true, context: profile.localOptions.maxOutputTokens + 1024}});
    }
    ensureActive();
    await save(draft);
    write(liveActivation ? 'Saved and activated in this session; existing agents unchanged.' : 'Saved. Start a new Bounce session to use these workers; running sessions were not changed.');
    return {saved: true, profiles: selections.map(selection => selection.name)};
  } catch (error) {
    if (error !== cancelled) throw error;
    write('Setup cancelled. No configuration saved.');
    return {saved: false};
  }
}
