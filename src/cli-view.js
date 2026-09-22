// What the header names as the running agent. In orchestrator mode that is the orchestrator
// profile's adapter and model; the classic routing order is not what runs there. Found live: the
// header said `codex` (first in the routing order) while the orchestrator ran on Claude.
export function headerProvider({settings, orchestration, active = null}) {
  if (orchestration?.operation === 'orchestrator') {
    const main = orchestration.profiles?.[orchestration.orchestrator ?? 'main'] ?? {};
    return {provider: main.adapter ?? settings.order?.[0] ?? 'agent', model: main.model ?? ''};
  }
  const provider = active || settings.order?.[0];
  return {provider, model: settings.models?.[provider] || ''};
}
