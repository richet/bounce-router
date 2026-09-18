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

// The shipped worker roster: one builder per model the cloud vendors expose in the `/model`
// picker, each described in src/model-catalog.js so `profile: "auto"` can route between them
// out of the box. It is the baseline of every orchestrator config: validateOrchestration lays
// the config's `profiles` block over it (mergeProfiles), so the saved config only ever holds
// the user's additions and overrides. Naming: the two frontier builders keep their historical
// names `build` (Codex) and `build_claude` (Claude) so existing ORDERS and briefs still
// resolve; every other profile is `<adapter>_<model>`. Roster order matters: `build` is first
// so it stays the routing fallback (src/jev.js routingFallback). Fallbacks cross vendors at
// the same tier, so an exhausted account moves a task sideways, not down. The muse
// -contributor variants share user content with the vendor and are left out.
export function starterProfiles(settings = {}) {
  return {
    main: {adapter: settings.order?.[0] ?? 'claude'},
    // strongest
    build: {adapter: 'codex', model: 'gpt-6-astra', fallback: ['build_claude', 'claude_fable']},
    build_claude: {adapter: 'claude', model: 'opus[1m]', fallback: ['build', 'claude_fable']},
    claude_fable: {adapter: 'claude', model: 'claude-fable-5-1[1m]', fallback: ['build_claude', 'build']},
    // mid
    codex_sol: {adapter: 'codex', model: 'gpt-5.6-sol', fallback: ['claude_sonnet', 'codex_terra']},
    codex_terra: {adapter: 'codex', model: 'gpt-5.6-terra', fallback: ['claude_sonnet', 'codex_sol']},
    claude_sonnet: {adapter: 'claude', model: 'sonnet', fallback: ['codex_terra', 'codex_sol']},
    codex_55: {adapter: 'codex', model: 'gpt-5.5', fallback: ['claude_sonnet', 'codex_terra']},
    muse_spark: {adapter: 'muse', model: 'muse-spark-1.3', fallback: ['muse_spark_12', 'codex_terra', 'claude_sonnet']},
    muse_spark_12: {adapter: 'muse', model: 'muse-spark-1.2', fallback: ['muse_spark', 'codex_terra']},
    // cheapest
    codex_luna: {adapter: 'codex', model: 'gpt-5.6-luna', fallback: ['claude_haiku']},
    claude_haiku: {adapter: 'claude', model: 'haiku', fallback: ['codex_luna']},
  };
}

// The effective profile table: the shipped roster with the config's `profiles` block laid over
// it by name. A user entry replaces the shipped one of the same name outright (no field-level
// merge); `null` drops a shipped profile; names the roster lacks are appended after it, so the
// shipped order — and with it the routing fallback — is kept. A `profiles` block that is absent
// is an empty overlay; one that is present but not an object is still an error. Every entry,
// shipped or not, is then validated the same way; `userWritten` only marks which came from the
// config, so the fallback check never blames the user for a shipped fallback into a profile
// they dropped.
function mergeProfiles(settings) {
  const overlay = settings.profiles === undefined ? {} : settings.profiles;
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) throw new Error('profiles must be an object');
  const shipped = starterProfiles(settings);
  const input = {}, userWritten = new Set();
  for (const name of [...Object.keys(shipped), ...Object.keys(overlay).filter(name => !Object.hasOwn(shipped, name))]) {
    if (!Object.hasOwn(overlay, name)) { input[name] = shipped[name]; continue; }
    if (overlay[name] === null) continue;
    input[name] = overlay[name];
    userWritten.add(name);
  }
  return {input, userWritten};
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

  const {input, userWritten} = mergeProfiles(settings);
  const names = Object.keys(input);
  const orchestrator = settings.orchestrator ?? 'main';
  if (typeof orchestrator !== 'string' || !names.includes(orchestrator)) throw new Error('orchestrator must name a profile');

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
    if (name === orchestrator) role = 'orchestrator';
    const policy = raw.policy ?? (raw.adapter === 'local' || raw.adapter === 'typesafe' || READ_ONLY_ROLES.has(role) ? 'read-only' : 'write');
    if (!['write', 'read-only'].includes(policy)) throw new Error(`profile ${name}: policy must be write or read-only`);
    // A decision model (typesafe) has no tools: it can only ever be a read-only reviewer.
    if (raw.adapter === 'typesafe' && policy === 'write') throw new Error(`profile ${name}: typesafe must be read-only`);
    // A shipped fallback that points at a profile the user dropped is skipped, not an error;
    // a user-written one must name a profile in the merged table.
    let fallback = raw.fallback ?? [];
    if (!Array.isArray(fallback)) throw new Error(`profile ${name}: fallback must list known profiles`);
    if (userWritten.has(name)) { if (fallback.some(f => !names.includes(f))) throw new Error(`profile ${name}: fallback must list known profiles`); }
    else fallback = fallback.filter(f => names.includes(f));
    if (fallback.includes(name)) throw new Error(`profile ${name}: fallback may not include itself`);
    if (mode === 'yolo' && settings.mode === 'plan') throw new Error(`profile ${name}: mode exceeds session mode`);
    if (READ_ONLY_ROLES.has(role) && policy === 'write') throw new Error(`profile ${name}: ${role} must be read-only`);
    profiles[name] = {adapter: raw.adapter, model: typeof raw.model === 'string' ? raw.model : '', mode, policy, fallback: [...fallback], role, executables: {...(settings.executables ?? {})}};
    // Optional cost tier and a sentence on what the model is good for, both read by the router
    // (src/jev.js routingQuestions) and shown in the roster; a profile without them is described
    // once by bounce itself (src/roster-notes.js). Any other value is dropped.
    if (PROFILE_TIERS.includes(raw.tier)) profiles[name].tier = raw.tier;
    if (typeof raw.capabilities === 'string' && raw.capabilities.trim()) profiles[name].capabilities = raw.capabilities.trim();
    if (raw.adapter === 'local') {
      Object.assign(profiles[name], normalizeLocalProfile({raw, policy, role, settings}));
    }
  }

  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.adapter === 'local' && profile.localOnly && profile.fallback.some(target => profiles[target].adapter !== 'local')) {
      throw new Error(`profile ${name}: localOnly forbids cross-provider fallback`);
    }
  }

  const orchestratorAdapter = profiles[orchestrator].adapter;
  const shape = names.every(name => profiles[name].adapter === orchestratorAdapter) ? 'single-provider' : 'multi-provider';

  return {operation: 'orchestrator', orchestrator, profiles, shape, strict, strategy};
}

export function profileFor(view, name) {
  if (!Object.prototype.hasOwnProperty.call(view.profiles, name)) throw new Error(`unknown profile: ${name}`);
  return view.profiles[name];
}
