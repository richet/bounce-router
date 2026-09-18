import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateOrchestration, profileFor, starterProfiles} from '../src/profiles.js';
import {routingFallback} from '../src/jev.js';
import {defaults} from '../src/core.js';
import {defaultStrategy} from '../src/strategy.js';

// The shipped roster itself (one builder per picker model, catalog notes, fallbacks) is covered
// in test/model-catalog.test.js; this checks the starter still validates in plan mode and that
// the frontier builders keep their historical names and cross-provider fallback.
test('new orchestration profiles validate with a distinct cross-provider worker fallback', () => {
  const settings = {order: ['claude'], mode: 'plan', operation: 'orchestrator', orchestrator: 'main', models: {}};
  settings.profiles = starterProfiles(settings);
  const view = validateOrchestration(settings);
  assert.equal(view.profiles.build.fallback[0], 'build_claude');
  assert.equal(view.profiles.build.adapter, 'codex');
  assert.equal(view.profiles.build_claude.adapter, 'claude');
  assert.equal(view.profiles.build_claude.role, 'builder');
  assert.equal(view.profiles.main.role, 'orchestrator');
  assert.ok(Object.keys(view.profiles).length > 3, 'the whole shipped roster, not two builders');
  assert.ok(Object.values(view.profiles).every(p => p.mode === 'plan'));
});

// The shipped roster is the baseline of every orchestrator config: a `profiles` block adds to
// it and overrides it by name (mergeProfiles) rather than replacing it, so a two-profile
// config still routes between all shipped builders.
test('overlay: a two-profile table sits on top of the whole shipped roster, in shipped order', () => {
  const settings = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude', model: 'opus'}, scout: {adapter: 'claude', model: 'haiku', role: 'analyst'}}};
  const view = validateOrchestration(settings);
  const shipped = Object.keys(starterProfiles(settings));
  assert.deepEqual(Object.keys(view.profiles), [...shipped, 'scout'], 'shipped names first, then the user\'s own');
  assert.equal(Object.keys(view.profiles).length, 13);
  assert.equal(view.profiles.main.model, 'opus', 'the user\'s main');
  assert.equal(view.profiles.claude_haiku.adapter, 'claude');
  assert.deepEqual(view.profiles.build.fallback, ['build_claude', 'claude_fable'], 'shipped fallbacks are kept');
  assert.equal(view.profiles.scout.policy, 'read-only');
  // every shipped profile is validated like a user-written one: mode, policy and role defaults
  for (const name of shipped.slice(1)) assert.deepEqual([view.profiles[name].mode, view.profiles[name].policy, view.profiles[name].role], ['yolo', 'write', 'builder'], name);
  assert.equal(routingFallback(view.profiles), 'build');
  // the saved block is never touched
  assert.deepEqual(Object.keys(settings.profiles), ['main', 'scout']);
  // an absent block and an empty one are the same empty overlay; orchestrator defaults to main
  const bare = validateOrchestration({operation: 'orchestrator', order: ['codex'], mode: 'yolo', profiles: {}});
  assert.deepEqual(Object.keys(bare.profiles), Object.keys(starterProfiles({order: ['codex']})));
  assert.equal(bare.orchestrator, 'main');
});

test('overlay: a user entry replaces the shipped profile of the same name outright', () => {
  const settings = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude'}, build: {adapter: 'codex', model: 'gpt-6-astra', fallback: ['build_claude']}, build_claude: {adapter: 'claude', model: 'default'}}};
  const view = validateOrchestration(settings);
  assert.equal(Object.keys(view.profiles).length, 12);
  assert.equal(view.profiles.build_claude.model, 'default');
  assert.deepEqual(view.profiles.build_claude.fallback, [], 'no field-level merge: the shipped fallback is gone with the entry');
  assert.deepEqual(view.profiles.build.fallback, ['build_claude']);
  assert.ok(view.profiles.claude_haiku);
  assert.equal(routingFallback(view.profiles), 'build');
  // a user-written fallback must still name a profile in the merged table — a shipped name counts
  assert.equal(validateOrchestration({...settings, profiles: {...settings.profiles, own: {adapter: 'claude', fallback: ['claude_haiku']}}}).profiles.own.fallback[0], 'claude_haiku');
  assert.throws(() => validateOrchestration({...settings, profiles: {...settings.profiles, own: {adapter: 'claude', fallback: ['ghost']}}}), {message: 'profile own: fallback must list known profiles'});
});

test('overlay: null drops a shipped profile and prunes shipped fallbacks into it; false is malformed', () => {
  const settings = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude'}, codex_luna: null, muse_spark: null, muse_spark_12: null, never_there: null}};
  const view = validateOrchestration(settings);
  assert.equal(Object.hasOwn(view.profiles, 'codex_luna'), false);
  assert.equal(Object.hasOwn(view.profiles, 'muse_spark'), false);
  assert.equal(Object.hasOwn(view.profiles, 'never_there'), false, 'dropping a name the roster lacks is a no-op');
  assert.deepEqual(view.profiles.claude_haiku.fallback, [], 'the shipped fallback into codex_luna is dropped, not an error');
  assert.equal(Object.keys(view.profiles).length, 9);
  // the routing fallback is the first writing builder that is left
  assert.equal(routingFallback(validateOrchestration({...settings, profiles: {main: {adapter: 'claude'}, build: null}}).profiles), 'build_claude');
  // a user-written fallback into a dropped profile is the user's error
  assert.throws(() => validateOrchestration({...settings, profiles: {...settings.profiles, own: {adapter: 'claude', fallback: ['codex_luna']}}}), {message: 'profile own: fallback must list known profiles'});
  // only null removes; false (or any non-object) is a malformed entry
  assert.throws(() => validateOrchestration({...settings, profiles: {main: {adapter: 'claude'}, codex_luna: false}}), /profile codex_luna: adapter must be one of/);
});

test('overlay: a shipped profile is validated exactly like a user-written one, registry included', () => {
  // a registry without a shipped vendor fails the config just as a user entry on that vendor would
  assert.throws(() => validateOrchestration({operation: 'orchestrator', order: ['claude'], mode: 'yolo', profiles: {main: {adapter: 'claude'}}}, ['claude']), /profile build: adapter must be one of claude$/);
  // a shipped profile inherits the session mode and is capped by it like any other
  assert.throws(() => validateOrchestration({operation: 'orchestrator', order: ['claude'], mode: 'plan', profiles: {main: {adapter: 'claude'}, build: {adapter: 'codex', mode: 'yolo'}}}), {message: 'profile build: mode exceeds session mode'});
  const planned = validateOrchestration({operation: 'orchestrator', order: ['claude'], mode: 'plan', profiles: {main: {adapter: 'claude'}}});
  assert.ok(Object.values(planned.profiles).every(p => p.mode === 'plan'));
});

test('P1 legacy config is untouched and classic', () => {
  const input = {order: ['claude'], mode: 'yolo'};
  const before = structuredClone(input);
  const view = validateOrchestration(input);
  // Phase 8 §3: a resolved `strategy` rides along even in classic mode (absent settings.strategy
  // resolves to defaultStrategy) — classic mode never engages review/dispatch reactions, so this
  // is inert for it, but createScheduler always receives a strategy value either way.
  assert.deepEqual(view, {operation: 'classic', orchestrator: null, profiles: {}, shape: 'none', strict: false, strategy: defaultStrategy});
  assert.deepEqual(input, before);
});

test('P2 profiles get role, policy and mode defaults; the shipped roster underneath makes every config multi-provider', () => {
  const settings = {
    operation: 'orchestrator',
    mode: 'yolo',
    orchestrator: 'main',
    profiles: {
      main: {adapter: 'claude'},
      build: {adapter: 'claude', model: 'sonnet'},
      scout: {adapter: 'claude', model: 'haiku', role: 'extractor'},
    },
  };
  const view = validateOrchestration(settings);
  assert.equal(view.shape, 'multi-provider');
  assert.equal(view.profiles.main.role, 'orchestrator');
  assert.equal(view.profiles.build.policy, 'write');
  assert.equal(view.profiles.scout.mode, 'yolo');
});

test('P3 multi-provider when adapters differ from the orchestrator', () => {
  const settings = {
    operation: 'orchestrator',
    mode: 'yolo',
    orchestrator: 'main',
    profiles: {
      main: {adapter: 'claude'},
      build: {adapter: 'codex'},
    },
  };
  const view = validateOrchestration(settings);
  assert.equal(view.shape, 'multi-provider');
});

test('P4 error messages, one case each', () => {
  const base = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {main: {adapter: 'claude'}}};

  assert.throws(() => validateOrchestration({...base, operation: 'weird'}), {message: 'operation must be classic or orchestrator'});
  assert.throws(() => validateOrchestration({...base, orchestrator: 'nope'}), {message: 'orchestrator must name a profile'});
  for (const profiles of [null, [], 'x', 3]) assert.throws(() => validateOrchestration({...base, profiles}), {message: 'profiles must be an object'});
  assert.throws(() => validateOrchestration({...base, profiles: {}, orchestrator: 'nope'}), {message: 'orchestrator must name a profile'});
  assert.throws(() => validateOrchestration({...base, profiles: {main: null}}), {message: 'orchestrator must name a profile'});
  assert.throws(() => validateOrchestration({...base, profiles: {main: {adapter: 'gpt5'}}}),
    {message: 'profile main: adapter must be one of claude, codex, muse, local, typesafe'});
  assert.throws(() => validateOrchestration({...base, profiles: {main: {adapter: 'claude', mode: 'sideways'}}}),
    {message: 'profile main: mode must be yolo or plan'});
  assert.throws(() => validateOrchestration({...base, profiles: {main: {adapter: 'claude', policy: 'delete'}}}),
    {message: 'profile main: policy must be write or read-only'});
  assert.throws(() => validateOrchestration({...base, profiles: {main: {adapter: 'claude'}, build: {adapter: 'claude', fallback: ['ghost']}}}),
    {message: 'profile build: fallback must list known profiles'});
  // Phase 8 §4: the role vocabulary is free-form now (any non-empty label except the reserved
  // `orchestrator`) — 'manager' validates rather than throwing; the remaining role error case
  // is the type/emptiness check.
  assert.throws(() => validateOrchestration({...base, profiles: {main: {adapter: 'claude', role: ''}}}),
    {message: 'profile main: role must be a non-empty string'});
  assert.throws(() => validateOrchestration({...base, profiles: {main: {adapter: 'claude'}, build: {adapter: 'claude', fallback: ['build']}}}),
    {message: 'profile build: fallback may not include itself'});
});

test('Phase 8 §4: a free-form role like "manager" validates and defaults to policy write', () => {
  const settings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {main: {adapter: 'claude'}, other: {adapter: 'claude', role: 'manager'}}};
  const view = validateOrchestration(settings);
  assert.equal(view.profiles.other.role, 'manager');
  assert.equal(view.profiles.other.policy, 'write');
});

test('role orchestrator is derived from settings.orchestrator, never declared', () => {
  const declaredOnWorker = {
    operation: 'orchestrator', mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude'}, build: {adapter: 'claude', role: 'orchestrator'}},
  };
  assert.throws(() => validateOrchestration(declaredOnWorker), {message: 'profile build: role orchestrator is derived, not declared'});

  const declaredOnOrchestratorProfile = {
    operation: 'orchestrator', mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude', role: 'orchestrator'}, build: {adapter: 'claude'}},
  };
  assert.throws(() => validateOrchestration(declaredOnOrchestratorProfile), {message: 'profile main: role orchestrator is derived, not declared'});
});

test('P5 ratchet: session mode caps profile mode, read-only roles cannot be write', () => {
  const settingsMode = {
    operation: 'orchestrator', mode: 'plan', orchestrator: 'main',
    profiles: {main: {adapter: 'claude'}, build: {adapter: 'claude', mode: 'yolo'}},
  };
  assert.throws(() => validateOrchestration(settingsMode), {message: 'profile build: mode exceeds session mode'});

  const settingsPolicy = {
    operation: 'orchestrator', mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude'}, rev: {adapter: 'claude', role: 'critic', policy: 'write'}},
  };
  assert.throws(() => validateOrchestration(settingsPolicy), {message: 'profile rev: critic must be read-only'});
});

test('P6 purity: repeated validation is stable and results are deep copies', () => {
  const settings = {
    operation: 'orchestrator', mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude'}, build: {adapter: 'claude', model: 'sonnet'}},
  };
  const first = validateOrchestration(settings);
  const second = validateOrchestration(settings);
  assert.deepEqual(first, second);
  first.profiles.main.model = 'mutated';
  assert.equal(settings.profiles.main.model, undefined);
});

test('legacy defaults() is unchanged by this task', () => {
  assert.deepEqual(Object.keys(defaults()), ['order', 'mode', 'models', 'cooldownMinutes', 'contextChars', 'executables', 'skills', 'sidebar']);
});

test('profileFor returns a profile from a validated view', () => {
  const settings = {
    operation: 'orchestrator', mode: 'yolo', orchestrator: 'main',
    profiles: {main: {adapter: 'claude'}, build: {adapter: 'claude', model: 'sonnet'}},
  };
  const view = validateOrchestration(settings);
  assert.equal(profileFor(view, 'build').model, 'sonnet');
});

test('profileFor throws on an unknown profile name', () => {
  const view = validateOrchestration({order: ['claude'], mode: 'yolo'});
  assert.throws(() => profileFor(view, 'ghost'), {message: 'unknown profile: ghost'});
});

// Jev (src/jev.js): the typesafe adapter validates, defaults to read-only and refuses write;
// an optional `tier` rides along for the router, any other value is dropped.
test('typesafe profiles default to read-only, refuse write, and tier is kept only when valid', () => {
  const settings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {
    main: {adapter: 'claude'},
    verdict: {adapter: 'typesafe', model: 'jev-1.13.0', role: 'critic'},
    scout: {adapter: 'claude', model: 'haiku', tier: 'cheapest', capabilities: '  Fast lookups; weak at long edits.  '},
    build: {adapter: 'codex', tier: 'huge', capabilities: '   '},
  }};
  const view = validateOrchestration(settings);
  assert.equal(view.profiles.scout.capabilities, 'Fast lookups; weak at long edits.');
  assert.equal(Object.hasOwn(view.profiles.build, 'capabilities'), false, 'a blank sentence is dropped');
  assert.equal(view.profiles.verdict.policy, 'read-only');
  assert.equal(view.profiles.verdict.role, 'critic');
  assert.equal(view.profiles.verdict.model, 'jev-1.13.0');
  assert.equal(view.profiles.scout.tier, 'cheapest');
  assert.equal(Object.hasOwn(view.profiles.build, 'tier'), false);
  assert.equal(Object.hasOwn(view.profiles.main, 'tier'), false);
  assert.throws(() => validateOrchestration({...settings, profiles: {...settings.profiles, verdict: {adapter: 'typesafe', policy: 'write'}}}), {message: 'profile verdict: typesafe must be read-only'});
  // the default adapter list (used by nine callers) accepts typesafe without the daemon's registry
  assert.doesNotThrow(() => validateOrchestration({operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {main: {adapter: 'claude'}, v: {adapter: 'typesafe'}}}));
});
