import fs from 'node:fs';
import path from 'node:path';
import {stripVTControlCharacters} from 'node:util';
import {runLocalSetup} from './local-wizard.js';
import {formatAgentTable} from './agents.js';

// Owns only setup input and output; never starts/cancels a conversation turn.
export function createLocalSetupView({onChange = () => {}, run = runLocalSetup, save, ...options}) {
  const controller = new AbortController();
  const state = {active: true, question: null, lines: [], result: null, error: null};
  let answer;
  const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, 16000);
  const view = {
    state,
    answer(value) {
      if (!state.active || !answer) return false;
      const resolve = answer; answer = null; state.question = null;
      resolve(value); onChange(); return true;
    },
    cancel() {
      state.active = false; state.question = null;
      controller.abort(new Error('Setup cancelled'));
      const resolve = answer; answer = null; resolve?.(null); onChange();
    },
  };
  view.done = (async () => {
    try {
      const result = await run({...options, signal: controller.signal,
        ask: question => {
          if (!state.active) return Promise.resolve(null);
          state.question = clean(question);
          const pending = new Promise(resolve => {answer = resolve;});
          onChange(); return pending;
        },
        write: text => {
          if (!state.active) return;
          state.lines.push(clean(text)); state.lines = state.lines.slice(-12); onChange();
        },
        save: settings => {controller.signal.throwIfAborted(); return save(settings);},
      });
      if (state.active) state.result = result;
    } catch (error) {
      if (state.active) state.error = clean(error.message);
    } finally {state.active = false; state.question = null; answer = null; onChange();}
    return state.result;
  })();
  return view;
}

// The local status view, shared by `bounce local` and the TUI's `/local`. Both surfaces answer the
// same three questions — what the endpoint has, whether the OpenCode bridge works, and which local
// workers are configured — so they gather and render through one implementation rather than drifting.
export async function gatherLocalStatus({settings, verify = false, model: requested, executables = {},
  discover, resolve, bridge, roles = null} = {}) {
  const {discoverLocalModels, normalizeLocalSettings, resolveLocalModel} = await import('./local-models.js');
  const {resolveExecutable} = await import('./executable.js');

  const local = normalizeLocalSettings(settings.local);
  const catalogs = await (discover ?? discoverLocalModels)(settings.local, {maxAge: 0});
  // resolveExecutable falls back to the bare name when it finds nothing executable, so an absolute
  // path is the signal that OpenCode is actually installed.
  const binary = resolveExecutable('opencode', executables.opencode);
  const installed = path.isAbsolute(binary) && (() => { try { fs.accessSync(binary, fs.constants.X_OK); return true; } catch { return false; } })();
  // The chain a local worker depends on, checked in the order it fails in practice, and reduced to
  // ONE blocker with ONE next action. Every part has independent state — LM Studio unloads idle
  // models on its own, the binary can vanish from a stripped PATH, a profile can name a model that
  // is no longer there — and a user asking "will my worker run?" needs the first broken link named,
  // not a model-selection error from three layers down.
  const endpoint = catalogs.find(catalog => catalog.endpoint === 'lmstudio') ?? catalogs[0];
  const loaded = (endpoint?.models ?? []).filter(item => item.ready === true && item.tools !== false);
  const downloaded = (endpoint?.models ?? []).filter(item => item.ready === false && item.tools !== false);
  let problem = null;
  if (!endpoint || endpoint.error) {
    problem = {stage: 'lmstudio', text: `LM Studio is not reachable at ${local.endpoints.lmstudio?.url ?? 'the configured endpoint'}${endpoint?.error ? ` (${endpoint.error})` : ''}.`,
      next: 'Start LM Studio and its local server (or run `lms server start`), then try again.'};
  } else if (!loaded.length && !(local.endpoints[endpoint.endpoint]?.loadPolicy === 'on-demand' && downloaded.length)) {
    // Only a dead end when nothing can be loaded on demand either: no tool-capable model on disk, or
    // an endpoint explicitly pinned to loaded-only.
    problem = {stage: 'model', text: 'No tool-capable model is loaded in LM Studio right now — it unloads idle models on its own.',
      next: downloaded.length
        ? `This endpoint is loaded-only. Load one: \`lms load <model>\` or the LM Studio app. Downloaded and tool-capable: ${downloaded.slice(0, 4).map(item => item.ref.replace(/^lmstudio\//, '')).join(', ')}${downloaded.length > 4 ? ', …' : ''}.`
        : 'Download a tool-capable model in LM Studio first.'};
  } else if (!installed) {
    problem = {stage: 'opencode', text: 'OpenCode is not installed, or not on PATH.',
      next: 'Install the `opencode` CLI (https://opencode.ai) and make sure it is on your PATH, then try again.'};
  }

  let verified;
  if (verify && !problem) {
    const pick = resolve ?? resolveLocalModel;
    let model = requested;
    if (!model) {
      try {
        model = pick({local, catalogs, profile: {backend: 'lmstudio', endpoint: 'lmstudio'}, requirements: {tools: true, context: 3072}}).instance;
      } catch (error) {
        problem = {stage: 'model', text: `No loaded model satisfies a worker's requirements (${error.message}).`,
          next: 'Load a tool-capable model with at least 3k context in LM Studio, then try again.'};
      }
    }
    if (model) {
      const check = bridge ?? (await import('./local-opencode-config.js')).checkOpencodeBridge;
      verified = await check({settings: local, model});
      if (!verified.worker.ready) {
        problem = {stage: 'bridge', text: `OpenCode could not complete a turn with ${model}: ${verified.worker.reason ?? verified.config.reason}`,
          next: 'Fix the reason above, then run verify again.'};
      }
    }
  }
  // Nothing loaded but loadable: not a blocker, but worth a line — the first turn pays the load.
  const note = !problem && !loaded.length && downloaded.length
    ? `No model is loaded right now; the first turn loads one on demand (about 10s).` : null;
  // Agents and who may play them. Derived the way the daemon derives it, so this view and the roster
  // cannot disagree; a backend that was skipped says why, which is what makes "why isn't builder using
  // my local model?" answerable.
  const roleTable = roles?.size && settings.operation === 'orchestrator' ? (await import('./agents.js')).agentTable(roles, settings) : [];
  // A "local worker" is an agent with a local AI in its chain — read off the same table.
  const workers = roleTable.filter(row => !row.error).flatMap(row => row.backends.filter(ref => ref.endsWith('(via opencode)')).slice(0, 1).map(ref => ({name: row.name, model: ref.replace(' (via opencode)', ''), policy: row.policy})));
  return {catalogs, binary, installed, workers, loaded: loaded.length, bridge: verified, problem, note, roles: roleTable};
}

export function formatLocalStatus({catalogs, binary, installed = true, workers, bridge, problem, note, roles = []}, {verifyHint, setupHint} = {}) {
  const lines = [];
  if (problem) lines.push(`NOT READY (${problem.stage}): ${problem.text}`, `  → ${problem.next}`, '');
  else if (note) lines.push(note, '');
  for (const catalog of catalogs) {
    lines.push(`${catalog.endpoint}: ${catalog.error ?? `${catalog.models.length} models`}${catalog.stale ? ' (stale)' : ''}`);
    // Loaded models first, named by the identifier LM Studio serves them under — that identifier
    // is what a profile pins (`model: <identifier>`), and it differs from the catalog ref when the
    // user aliased the load (e.g. `bounce-coder`). Downloaded-only models follow, in one line each.
    const loaded = catalog.models.filter(model => model.ready === true);
    const rest = catalog.models.filter(model => model.ready !== true);
    for (const model of loaded) {
      const modelId = model.id ?? model.ref;
      for (const instance of (model.instances?.length ? model.instances : [{id: modelId, context: model.context}])) {
        lines.push(`  ${instance.id} · loaded${instance.id !== modelId ? ` (${modelId})` : ''} · context ${instance.context ?? '?'} · tools: ${model.tools ?? 'unknown'}`);
      }
    }
    for (const model of rest) {
      lines.push(`  ${model.ref} · ${model.ready === false ? 'downloaded' : 'unknown readiness'} · tools: ${model.tools ?? 'unknown'} (${model.capabilitySource})`);
    }
  }
  lines.push('', installed
    ? `OpenCode: ${binary}`
    : 'OpenCode: NOT INSTALLED — local workers need the `opencode` CLI on your PATH (https://opencode.ai)');
  if (bridge?.worker.ready) lines.push(`  bridge verified · ${bridge.model} replied`);
  else if (!problem && verifyHint) lines.push(`  ${verifyHint}`);
  if (roles.length) {
    lines.push('', 'Agents (skill agent-orchestrator, then ~/.bounce/agents, then .bounce/agents):');
    lines.push(...formatAgentTable(roles));
  }
  lines.push('', workers.length
    ? `Agents a local model may play: ${workers.map(worker => `${worker.name} (${worker.model}, ${worker.policy})`).join(', ')}`
    : `No agent has a local model yet${setupHint ? ` — ${setupHint}` : ''}`);
  return lines;
}
