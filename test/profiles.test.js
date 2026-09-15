import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateOrchestration, profileFor, starterProfiles} from '../src/profiles.js';
import {defaults} from '../src/core.js';
import {defaultStrategy} from '../src/strategy.js';

test('new orchestration profiles validate with a distinct cross-provider worker fallback', () => {
  const settings = {order: ['claude'], mode: 'plan', operation: 'orchestrator', orchestrator: 'main', models: {}};
  settings.profiles = starterProfiles(settings);
  const view = validateOrchestration(settings);
  assert.deepEqual(view.profiles.build.fallback, ['build_claude']);
  assert.equal(view.profiles.build.adapter, 'codex');
  assert.equal(view.profiles.build_claude.adapter, 'claude');
  assert.equal(view.profiles.build_claude.role, 'builder');
  assert.equal(view.profiles.main.role, 'orchestrator');
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

test('P2 single-provider profiles get role, policy and mode defaults', () => {
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
  assert.equal(view.shape, 'single-provider');
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
  assert.throws(() => validateOrchestration({...base, profiles: {}}), {message: 'profiles must be a nonempty object'});
  assert.throws(() => validateOrchestration({...base, profiles: {main: {adapter: 'gpt5'}}}),
    {message: 'profile main: adapter must be one of claude, codex, muse, local'});
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
  assert.deepEqual(Object.keys(defaults()), ['order', 'mode', 'models', 'cooldownMinutes', 'contextChars', 'executables', 'skills']);
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
