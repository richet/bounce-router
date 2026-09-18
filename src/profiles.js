// The persisted shape of `operation` and profile tables (docs/local-orchestration.md,
// "Operation modes", D2): validated once, opt-in, and legacy configs untouched by construction.
// Phase 8 §4: the role vocabulary is free-form (any non-empty label); `orchestrator` stays
// reserved (derived from `settings.orchestrator`, never declared). READ_ONLY_ROLES is now only
// a back-compat DEFAULT for `policy` on these historically-read-only labels — the read-only/
// write ratchet itself keys on `policy`, never on the label (CONTRACT.md §4).
import {defaultStrategy, noReviewStrategy, quorumStrategy} from './strategy.js';
import {normalizeLocalProfile} from './local-profiles.js';
import {PROFILE_TIERS} from './jev.js';

const READ_ONLY_ROLES = new Set(['critic', 'verifier', 'analyst']);

// Phase 8 §3: `strategy` is a declarative Tier-1 setting — a string preset resolved to the
// actual strategy object here, so callers (reload.js) never parse the string themselves.
function resolveStrategy(spec) {
  if (spec === undefined || spec === 'default') return defaultStrategy;
  if (spec === 'no-review') return noReviewStrategy;
  if (typeof spec === 'string' && spec.startsWith('quorum:')) {
    const n = Number(spec.slice('quorum:'.length));
    if (!Number.isInteger(n) || n < 1) throw new Error('strategy must be default, no-review, or quorum:<n>');
    return quorumStrategy(n);
  }
  throw new Error('strategy must be default, no-review, or quorum:<n>');
}

// Phase 7 execution-policy ladder (docs/local-orchestration.md "Permissions", CONTRACT.md §1):
// least to most privileged. `write` exists for adapters to declare and future profiles to
// request; no current bounce profile produces it.
export const POLICY_RANK = {'read-only': 0, plan: 1, write: 2, yolo: 3};

// Used only when the user enables orchestration without an existing profile table.
export function starterProfiles(settings) {
  return {
    main: {adapter: settings.order[0]},
    build: {adapter: 'codex', model: settings.models?.codex || 'gpt-5.6-terra', fallback: ['build_claude']},
    build_claude: {adapter: 'claude', model: settings.models?.claude || 'sonnet'},
  };
}

// A profile's effective policy (pure): read-only is absolute; otherwise mode narrows write/unset
// down to plan or yolo.
export function effectivePolicy(profile) {
  if (profile.policy === 'read-only') return 'read-only';
  if (profile.mode === 'plan') return 'plan';
  if (profile.adapter === 'local' && profile.policy === 'write') return 'write';
  return 'yolo';
}

export function validateOrchestration(settings, adapterNames = ['claude', 'codex', 'muse', 'local', 'typesafe']) {
  const strategy = resolveStrategy(settings.strategy);
  if (settings.operation === undefined || settings.operation === 'classic') {
    return {operation: 'classic', orchestrator: null, profiles: {}, shape: 'none', strict: false, strategy};
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
    if (typeof role !== 'string' || !role) throw new Error(`profile ${name}: role must be a non-empty string`);
    if (name === settings.orchestrator) role = 'orchestrator';
    const policy = raw.policy ?? (raw.adapter === 'local' || raw.adapter === 'typesafe' || READ_ONLY_ROLES.has(role) ? 'read-only' : 'write');
    if (!['write', 'read-only'].includes(policy)) throw new Error(`profile ${name}: policy must be write or read-only`);
    // A decision model (typesafe) has no tools: it can only ever be a read-only reviewer.
    if (raw.adapter === 'typesafe' && policy === 'write') throw new Error(`profile ${name}: typesafe must be read-only`);
    const fallback = raw.fallback ?? [];
    if (!Array.isArray(fallback) || fallback.some(f => !names.includes(f))) throw new Error(`profile ${name}: fallback must list known profiles`);
    if (fallback.includes(name)) throw new Error(`profile ${name}: fallback may not include itself`);
    if (mode === 'yolo' && settings.mode === 'plan') throw new Error(`profile ${name}: mode exceeds session mode`);
    if (READ_ONLY_ROLES.has(role) && policy === 'write') throw new Error(`profile ${name}: ${role} must be read-only`);
    profiles[name] = {adapter: raw.adapter, model: typeof raw.model === 'string' ? raw.model : '', mode, policy, fallback: [...fallback], role, executables: {...(settings.executables ?? {})}};
    // Optional cost tier a router (src/jev.js routingQuestions) may read; any other value is dropped.
    if (PROFILE_TIERS.includes(raw.tier)) profiles[name].tier = raw.tier;
    if (raw.adapter === 'local') {
      Object.assign(profiles[name], normalizeLocalProfile({raw, policy, role, settings}));
    }
  }

  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.adapter === 'local' && profile.localOnly && profile.fallback.some(target => profiles[target].adapter !== 'local')) {
      throw new Error(`profile ${name}: localOnly forbids cross-provider fallback`);
    }
  }

  const orchestratorAdapter = profiles[settings.orchestrator].adapter;
  const shape = names.every(name => profiles[name].adapter === orchestratorAdapter) ? 'single-provider' : 'multi-provider';

  return {operation: 'orchestrator', orchestrator: settings.orchestrator, profiles, shape, strict, strategy};
}

export function profileFor(view, name) {
  if (!Object.prototype.hasOwnProperty.call(view.profiles, name)) throw new Error(`unknown profile: ${name}`);
  return view.profiles[name];
}
