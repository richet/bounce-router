// The persisted shape of `operation` and profile tables (docs/local-orchestration.md,
// "Operation modes", D2): validated once, opt-in, and legacy configs untouched by construction.
const ROLES = ['orchestrator', 'builder', 'critic', 'verifier', 'analyst', 'extractor'];
const READ_ONLY_ROLES = new Set(['critic', 'verifier', 'analyst']);

// Phase 7 execution-policy ladder (docs/local-orchestration.md "Permissions", CONTRACT.md §1):
// least to most privileged. `write` exists for adapters to declare and future profiles to
// request; no current bounce profile produces it.
export const POLICY_RANK = {'read-only': 0, plan: 1, write: 2, yolo: 3};

// A profile's effective policy (pure): read-only is absolute; otherwise mode narrows write/unset
// down to plan or yolo.
export function effectivePolicy(profile) {
  if (profile.policy === 'read-only') return 'read-only';
  if (profile.mode === 'plan') return 'plan';
  return 'yolo';
}

export function validateOrchestration(settings, adapterNames = ['claude', 'codex', 'muse']) {
  if (settings.operation === undefined || settings.operation === 'classic') {
    return {operation: 'classic', orchestrator: null, profiles: {}, shape: 'none', strict: false};
  }
  if (settings.operation !== 'orchestrator') throw new Error('operation must be classic or orchestrator');

  const input = settings.profiles;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) throw new Error('profiles must be a nonempty object');
  const names = Object.keys(input);
  if (typeof settings.orchestrator !== 'string' || !names.includes(settings.orchestrator)) throw new Error('orchestrator must name a profile');

  if (settings.strict !== undefined && typeof settings.strict !== 'boolean') throw new Error('strict must be a boolean');
  const strict = settings.strict === true;

  const profiles = {};
  for (const name of names) {
    const raw = input[name] ?? {};
    if (!adapterNames.includes(raw.adapter)) throw new Error(`profile ${name}: adapter must be one of ${adapterNames.join(', ')}`);
    const mode = raw.mode ?? settings.mode;
    if (!['yolo', 'plan'].includes(mode)) throw new Error(`profile ${name}: mode must be yolo or plan`);
    if (raw.role === 'orchestrator') throw new Error(`profile ${name}: role orchestrator is derived, not declared`);
    let role = raw.role ?? 'builder';
    if (!ROLES.includes(role)) throw new Error(`profile ${name}: role must be one of ${ROLES.join(', ')}`);
    if (name === settings.orchestrator) role = 'orchestrator';
    const policy = raw.policy ?? (READ_ONLY_ROLES.has(role) ? 'read-only' : 'write');
    if (!['write', 'read-only'].includes(policy)) throw new Error(`profile ${name}: policy must be write or read-only`);
    const fallback = raw.fallback ?? [];
    if (!Array.isArray(fallback) || fallback.some(f => !names.includes(f))) throw new Error(`profile ${name}: fallback must list known profiles`);
    if (fallback.includes(name)) throw new Error(`profile ${name}: fallback may not include itself`);
    if (mode === 'yolo' && settings.mode === 'plan') throw new Error(`profile ${name}: mode exceeds session mode`);
    if (READ_ONLY_ROLES.has(role) && policy === 'write') throw new Error(`profile ${name}: ${role} must be read-only`);
    profiles[name] = {adapter: raw.adapter, model: typeof raw.model === 'string' ? raw.model : '', mode, policy, fallback: [...fallback], role, executables: {...(settings.executables ?? {})}};
  }

  const orchestratorAdapter = profiles[settings.orchestrator].adapter;
  const shape = names.every(name => profiles[name].adapter === orchestratorAdapter) ? 'single-provider' : 'multi-provider';

  return {operation: 'orchestrator', orchestrator: settings.orchestrator, profiles, shape, strict};
}

export function profileFor(view, name) {
  if (!Object.prototype.hasOwnProperty.call(view.profiles, name)) throw new Error(`unknown profile: ${name}`);
  return view.profiles[name];
}
