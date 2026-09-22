// What the header names as the running agent. In orchestrator mode that is the orchestrator
// profile's adapter and model; the classic routing order is not what runs there. Found live: the
// header said `codex` (first in the routing order) while the orchestrator ran on Claude.
export function headerProvider({settings, orchestration, active = null}) {
  if (orchestration?.operation === 'orchestrator') {
    const main = orchestration.profiles?.[orchestration.orchestrator ?? 'main'] ?? {};
    const provider = main.adapter ?? settings.order?.[0] ?? 'agent';
    // The daemon runs the profile's model, else the per-agent one (main-service.js selection).
    return {provider, model: main.model || settings.models?.[provider] || ''};
  }
  const provider = active || settings.order?.[0];
  return {provider, model: settings.models?.[provider] || ''};
}

const lead = (order, provider) => [provider, ...(order ?? []).filter(p => p !== provider)];
const orchestratorName = orchestration => orchestration?.orchestrator ?? 'main';

// A choice made with /model or the picker lands where the next turn runs from: in orchestrator
// mode on the orchestrator profile's adapter and model (the daemon's main-service runs that
// profile), in classic mode on the routing order and the per-agent model. Found live: both were
// written to the classic settings in orchestrator mode, which nothing there reads, so
// `/model gpt-6-astra` left the orchestrator on Claude. Mutates `settings`; returns what now runs.
export function chooseModel(settings, orchestration, {provider, model}) {
  settings.models ??= {};
  settings.models[provider] = model;
  settings.order = lead(settings.order, provider);
  if (orchestration?.operation === 'orchestrator') {
    const name = orchestratorName(orchestration);
    settings.profiles ??= {};
    settings.profiles[name] = {...settings.profiles[name], adapter: provider, model};
  }
  return {provider, model};
}

// /order: the first agent of the order is the one that runs; in orchestrator mode that moves the
// orchestrator there, with the model already chosen for that agent.
export function chooseOrder(settings, orchestration, order) {
  settings.order = [...order];
  const provider = order[0];
  const model = settings.models?.[provider] || '';
  if (orchestration?.operation === 'orchestrator') {
    const name = orchestratorName(orchestration);
    settings.profiles ??= {};
    settings.profiles[name] = {...settings.profiles[name], adapter: provider, model};
  }
  return {provider, model};
}
