// The persisted shape of `operation` and profile tables (docs/local-orchestration.md,
// "Operation modes", D2): validated once, opt-in, and legacy configs untouched by construction.
// Phase 8 §4: the role vocabulary is free-form (any non-empty label); `orchestrator` stays
// reserved (derived from `settings.orchestrator`, never declared). READ_ONLY_ROLES is now only
// a back-compat DEFAULT for `policy` on these historically-read-only labels — the read-only/
// write ratchet itself keys on `policy`, never on the label (CONTRACT.md §4).
import {defaultStrategy, noReviewStrategy, quorumStrategy} from './strategy.js';
import {normalizeLocalSettings} from './local-models.js';
import {PROFILE_TIERS} from './jev.js';

// The code fallback for a role LABEL that no agent file declares; an agent file's own `policy` wins.
export const READ_ONLY_ROLES = new Set(['critic']);

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
export const POLICY_RANK = {'read-only': 0, probe: 1, plan: 2, write: 3, yolo: 4};
// Who can enforce `probe` (run commands, write nothing): codex's read-only sandbox, and a local worker
// run under sandbox-exec. claude and muse cannot run commands without also being able to write.
export const PROBE_ADAPTERS = new Set(['codex', 'opencode']);

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

// The adapters that run a LOCAL model. A local worker is an agent's backend, never a config profile.
export const LOCAL_ADAPTERS = new Set(['opencode']);

// A profile's effective policy (pure): read-only is absolute; otherwise mode narrows write/unset
// down to plan or yolo. A local write worker is a yolo worker like any other: it edits the real
// tree and runs commands exactly as a cloud one does. It used to rank one tier below (`write`, from
// the sandboxed design that is gone), which made the scheduler refuse the cloud AI of a local write
// agent as "more privileged" — observed live as a failed local task with no fallback.
export function effectivePolicy(profile) {
  if (profile.policy === 'read-only') return 'read-only';
  if (profile.policy === 'probe') return 'probe';
  if (profile.mode === 'plan') return 'plan';
  return 'yolo';
}

export function validateOrchestration(settings, adapterNames = ['claude', 'codex', 'muse', 'opencode', 'typesafe'], {roles = null} = {}) {
  const strategy = resolveStrategy(settings.strategy);
  if (settings.operation === undefined || settings.operation === 'classic') {
    return {operation: 'classic', orchestrator: null, profiles: {}, shape: 'none', strict: false, strategy, skipped: []};
  }
  if (settings.operation !== 'orchestrator') throw new Error('operation must be classic or orchestrator');

  const {input, userWritten} = mergeProfiles(settings);
  const names = Object.keys(input);
  const orchestrator = settings.orchestrator ?? 'main';
  if (typeof orchestrator !== 'string' || !names.includes(orchestrator)) throw new Error('orchestrator must name a profile');

  if (settings.strict !== undefined && typeof settings.strict !== 'boolean') throw new Error('strict must be a boolean');
  const strict = settings.strict === true;

  // Roles are agent files (src/agents.js). A label no file declares keeps the code default; a file's
  // own `policy` decides for the role it names.
  const declared = new Set([...(roles?.values() ?? [])].filter(role => !role.error).map(role => role.name));
  const readOnly = new Set([...READ_ONLY_ROLES].filter(label => !declared.has(label)));
  for (const role of roles?.values() ?? []) if (!role.error && role.policy === 'read-only') readOnly.add(role.name);
  // One roster, two layers: PROFILES are AIs (the shipped cloud roster plus the config's own, routed
  // by tier and capabilities); AGENTS are jobs whose `models:` say which AIs may play them. A name
  // means one or the other, never both.
  for (const name of names) if (name !== orchestrator && roles?.has(name) && !roles.get(name).error) throw new Error(`profile ${name}: an agent file already defines ${name}; remove the profile or rename one of them`);

  const profiles = {};
  for (const name of names) {
    const raw = input[name] ?? {};
    // A local worker is an agent's backend (`models: [lmstudio/<model>]`), never a config profile.
    // Saved configs are migrated on load (src/core.js), so reaching this means hand-built settings.
    if (LOCAL_ADAPTERS.has(raw.adapter) || raw.adapter === 'local') {
      throw new Error(`profile ${name}: local workers are agent files now. Define ~/.bounce/agents/${String(name).toLowerCase()}.md with "models: [lmstudio/<model>]" (see \`bounce agents\`); saved configs are migrated automatically.`);
    }
    if (!adapterNames.includes(raw.adapter)) throw new Error(`profile ${name}: adapter must be one of ${adapterNames.join(', ')}`);
    const mode = raw.mode ?? settings.mode;
    if (!['yolo', 'plan'].includes(mode)) throw new Error(`profile ${name}: mode must be yolo or plan`);
    if (raw.role === 'orchestrator') throw new Error(`profile ${name}: role orchestrator is derived, not declared`);
    let role = raw.role ?? 'builder';
    if (typeof role !== 'string' || !role) throw new Error(`profile ${name}: role must be a non-empty string`);
    if (name === orchestrator) role = 'orchestrator';
    const policy = raw.policy ?? (raw.adapter === 'typesafe' || readOnly.has(role) ? 'read-only' : roles?.get(role)?.policy ?? (['analyst', 'verifier'].includes(role) ? 'probe' : 'write'));
    if (!['write', 'read-only', 'probe'].includes(policy)) throw new Error(`profile ${name}: policy must be write, read-only or probe`);
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
    if (readOnly.has(role) && policy === 'write') throw new Error(`profile ${name}: ${role} must be read-only`);
    const agent = roles?.get(role);
    if (agent?.error) throw new Error(`profile ${name}: role ${role} is defined by ${agent.file}, which is invalid: ${agent.error}`);
    profiles[name] = {adapter: raw.adapter, model: typeof raw.model === 'string' ? raw.model : '', mode, policy, fallback: [...fallback], role, executables: {...(settings.executables ?? {})},
      ...(agent ? {agent: {name: agent.name, description: agent.description, policy: agent.policy, prompt: agent.prompt, ...(agent.maxSteps ? {maxSteps: agent.maxSteps} : {})}} : {})};
    // Optional cost tier and a sentence on what the model is good for, both read by the router
    // (src/jev.js routingQuestions) and shown in the roster; a profile without them is described
    // once by bounce itself (src/roster-notes.js). Any other value is dropped.
    if (PROFILE_TIERS.includes(raw.tier)) profiles[name].tier = raw.tier;
    if (typeof raw.capabilities === 'string' && raw.capabilities.trim()) profiles[name].capabilities = raw.capabilities.trim();
  }

  // Agents become profiles: one hidden backend profile per `models:` entry, chained as fallbacks, all
  // identical except adapter and model — the scheduler walks fallbacks by name exactly as before, so
  // nothing in dispatch changes; only where the table comes from. A model ref names its PROVIDER;
  // a provider that is a configured local endpoint runs through the opencode adapter.
  const skipped = [];
  for (const agent of roles?.values() ?? []) {
    if (agent.error || agent.name === orchestrator) continue;
    const local = normalizeLocalSettings(settings.local);
    const isLocal = provider => Object.hasOwn(local.endpoints, provider);
    // `auto` first in the list: Jev picks the AI at dispatch (the scheduler composes it with playedBy);
    // the rest — or, with nothing after it, the provider order — is the chain the job falls to.
    const auto = agent.models?.[0] === 'auto';
    const listed = (agent.models ?? []).filter(ref => ref !== 'auto');
    const wanted = listed.length ? listed
      : [...(settings.order ?? []).filter(provider => adapterNames.includes(provider)).map(provider => `${provider}/${settings.models?.[provider] ?? ''}`),
        ...(local.enabled && adapterNames.includes('opencode') ? Object.keys(local.endpoints).map(endpoint => `${endpoint}/auto`) : [])];
    // `provider/default` is the provider's own default model — the written form of what an agent with
    // no `models:` gets, so setup can pin a local model first and still keep the cloud fallbacks.
    const backends = wanted.map(ref => { const cut = ref.indexOf('/'); const model = ref.slice(cut + 1); return {provider: ref.slice(0, cut), model: model === 'default' ? '' : model, ref}; })
      .filter(({provider, ref}) => {
        // A plan session is read-only end to end: a write agent is not offered rather than refused,
        // so a fresh install (whose shipped team has write agents) still plans.
        if (settings.mode === 'plan' && (agent.policy ?? 'write') === 'write') { skipped.push({agent: agent.name, ref, reason: 'a plan session runs read-only agents only'}); return false; }
        if (agent.policy === 'probe' && !PROBE_ADAPTERS.has(isLocal(provider) ? 'opencode' : provider)) { skipped.push({agent: agent.name, ref, reason: 'adapter cannot run isolated checks'}); return false; }
        if (isLocal(provider) && !local.enabled) { skipped.push({agent: agent.name, ref, reason: 'local models are off (/local on)'}); return false; }
        if (isLocal(provider) ? !adapterNames.includes('opencode') : !adapterNames.includes(provider)) { skipped.push({agent: agent.name, ref, reason: `no ${provider} adapter on this machine`}); return false; }
        return true;
      });
    if (!backends.length) continue; // an agent nobody on this machine can play is simply not offered
    const chain = backends.map((_, index) => index === 0 ? agent.name : `${agent.name}~${index + 1}`);
    backends.forEach(({provider, model}, index) => {
      const name = chain[index];
      const mode = settings.mode;
      // Unsupported probe adapters were excluded above; never silently remove command tools.
      const policy = agent.policy ?? 'write';
      const base = {derived: true, adapter: isLocal(provider) ? 'opencode' : provider, model, mode, policy,
        fallback: chain.slice(index + 1, index + 2), role: agent.name, executables: {...(settings.executables ?? {})},
        agent: {name: agent.name, description: agent.description, policy, prompt: agent.prompt, ...(agent.maxSteps ? {maxSteps: agent.maxSteps} : {})}};
      if (auto && index === 0) base.auto = true;
      if (isLocal(provider)) {
        // All a local backend adds is where its model lives; src/local-resolve.js does the rest at dispatch.
        Object.assign(base, {backend: 'lmstudio', endpoint: provider, localOptions: {maxOutputTokens: 2048}});
      }
      profiles[name] = base;
    });
  }

  const orchestratorAdapter = profiles[orchestrator].adapter;
  const shape = names.every(name => profiles[name].adapter === orchestratorAdapter) ? 'single-provider' : 'multi-provider';

  return {operation: 'orchestrator', orchestrator, profiles, shape, strict, strategy, skipped};
}

// A job played by an AI that is not on its own list — Jev's pick for an agent whose `models:` opens
// with `auto`. The AI brings only what it runs on; mode, policy, role and prompt stay the job's, and
// a failure falls to the job's own chain.
// `local` ({endpoint, model}) instead of a profile makes it an ordinary local backend of the job.
export function playedBy(head, aiName, ai, local = null) {
  return {derived: true, ai: aiName, adapter: local ? 'opencode' : ai.adapter, model: local ? local.model : ai.model ?? '', mode: head.mode, policy: head.policy,
    fallback: [head.agent.name], role: head.role, executables: head.executables, agent: head.agent,
    ...(local ? {backend: 'lmstudio', endpoint: local.endpoint, localOptions: {maxOutputTokens: 2048}} : {})};
}

export function profileFor(view, name) {
  if (!Object.prototype.hasOwnProperty.call(view.profiles, name)) throw new Error(`unknown profile: ${name}`);
  return view.profiles[name];
}
