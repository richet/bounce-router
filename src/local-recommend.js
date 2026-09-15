import {normalizeLocalSettings, resolveLocalModel} from './local-models.js';
import {createLmStudioBackend} from './adapters/backends/lmstudio.js';

function validateIntent(intent) {
  if (!['research', 'coding'].includes(intent)) throw new Error('Choose research or coding');
}

function loadedSettings(local) {
  const settings = normalizeLocalSettings(local);
  for (const endpoint of Object.values(settings.endpoints)) endpoint.loadPolicy = 'loaded-only';
  return settings;
}

export function recommendLocalModels({catalogs, settings = {}, intent = 'research', priority = 'balanced', probes = []}) {
  validateIntent(intent);
  if (!['balanced', 'speed', 'context'].includes(priority)) throw new Error('Choose balanced, speed or context');
  const local = loadedSettings(settings.local);
  const role = intent === 'coding' ? 'builder' : 'analyst';
  const preferences = local.preferences[role]?.prefer ?? [];
  const candidates = catalogs.flatMap(catalog => (catalog.models ?? []).map(model => {
    const reasons = [model.ready === true ? 'Loaded' : model.ready === false ? 'Not loaded: load it in LM Studio to evaluate it' : 'Loaded state unknown: check LM Studio server metadata',
      `Tools: ${model.tools === true ? 'yes' : model.tools === false ? 'no' : 'unknown'} (${model.capabilitySource ?? 'unknown'})`];
    let selection;
    try {
      if (catalog.error || catalog.stale) throw new Error(catalog.error || 'Catalog is stale');
      selection = resolveLocalModel({local, catalogs, profile: {backend: 'lmstudio', role},
        override: model.ref, requirements: {tools: true, context: 3072}});
    } catch (error) {
      reasons.push(error.message);
    }
    const probe = probes.findLast(result => result.ref === model.ref && result.intent === intent);
    if (probe) reasons.push(`Synthetic ${intent} test: ${probe.status}; not a general quality benchmark`);
    if (selection) reasons.push(`Loaded; tool capability ${model.capabilitySource ?? 'unknown'}; ${selection.context} context tokens`);
    if (preferences.includes(model.ref)) reasons.push(`Your ${role} preference`);
    return {ref: model.ref, label: model.label ?? model.id, eligible: Boolean(selection) && (!probe || probe.status === 'passed'),
      reasons, context: selection?.context ?? model.context ?? null, ready: model.ready,
      capabilitySource: model.capabilitySource ?? 'unknown', probe};
  }));
  const preference = candidate => {
    const index = preferences.indexOf(candidate.ref);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const measured = candidate => Number.isFinite(candidate.probe?.durationMs) ? candidate.probe.durationMs : Infinity;
  const eligible = candidates.filter(candidate => candidate.eligible).sort((left, right) => {
    return preference(left) - preference(right) || Number(Boolean(right.probe)) - Number(Boolean(left.probe)) ||
      (priority === 'speed' ? measured(left) - measured(right) : 0) ||
      (priority === 'context' ? (right.context ?? 0) - (left.context ?? 0) : 0) || left.ref.localeCompare(right.ref);
  });
  const notes = [
    'Model names are identifiers, never quality rankings. General coding quality is unknown.',
    'Bounce defaults to three local workers per endpoint. Loaded does not prove spare RAM/GPU capacity; lower maxConcurrent if your hardware needs it.',
    'Preferences take precedence. Otherwise passed synthetic tests, then your chosen priority are used; equal evidence uses a stable identifier tie-break, not a quality claim.',
    ...catalogs.filter(catalog => catalog.error).map(catalog => `${catalog.endpoint}: ${catalog.error}`),
  ];
  return {candidates, recommended: eligible[0]?.ref ?? null, notes};
}

export async function probeLocalModel({local, catalogs, ref, intent = 'research', signal, fetchImpl, timeoutMs = 30000}) {
  validateIntent(intent);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Probe timeout must be 1–60000 ms');
  const settings = loadedSettings(local);
  const selected = resolveLocalModel({local: settings, catalogs, profile: {backend: 'lmstudio', role: intent === 'coding' ? 'builder' : 'analyst'},
    override: ref, requirements: {tools: true, context: 3072}});
  const endpoint = settings.endpoints[selected.endpoint];
  if (endpoint.apiKeyEnv && !process.env[endpoint.apiKeyEnv]) throw new Error(`Missing endpoint authentication: ${endpoint.apiKeyEnv}`);
  const backend = createLmStudioBackend({base: selected.url, apiKey: endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : undefined, fetchImpl, timeoutMs});
  const started = performance.now();
  const calls = [];
  let status = 'failed';
  const evidence = [];
  try {
    const prompt = intent === 'coding'
      ? 'Synthetic coding fixture: function add(a,b) { return a-b; } is buggy. Submit the corrected return statement (not the whole function) in the replacement field of submit_answer exactly once. It must add both arguments correctly for any numbers. Do not call other tools.'
      : 'Synthetic extraction fixture: record A has value 17; record B has value 42. Extract the value for record B. Submit the integer using submit_answer exactly once.';
    for await (const event of backend.generate({model: selected.instance ?? selected.model,
      messages: [{role: 'user', content: prompt}], maxTokens: 512, signal,
      tools: [{name: 'submit_answer', description: 'Submit the synthetic fixture answer; this tool has no side effects.',
        parameters: intent === 'coding'
          ? {type: 'object', properties: {replacement: {type: 'string'}}, required: ['replacement'], additionalProperties: false}
          : {type: 'object', properties: {answer: {type: 'integer'}}, required: ['answer'], additionalProperties: false}}]})) {
      if (event.kind === 'tool_call') calls.push(event);
    }
    const correct = calls.length === 1 && calls[0].name === 'submit_answer' &&
      Object.keys(calls[0].arguments).length === 1 && (intent === 'coding'
        ? /^return(?:a\+b|b\+a);?$/.test(String(calls[0].arguments.replacement ?? '').replace(/\s/g, ''))
        : calls[0].arguments.answer === 42);
    status = correct ? 'passed' : 'failed';
    evidence.push(correct ? 'Observed one correctly structured tool call with the exact fixture answer' : 'Completed response did not provide the exact required tool call/answer');
  } catch (error) {
    status = error.inferenceVerified === true ? 'failed' : 'uncertain';
    evidence.push(error.message);
  }
  return {ref, intent, status, durationMs: Math.round(performance.now() - started), evidence,
    limitations: ['One synthetic fixture is not a general coding-quality benchmark or a filesystem/test execution check.',
      'Latency is one observation, not sustained throughput. No workspace content was sent and no tool was executed.'],
    observedAt: new Date().toISOString()};
}
