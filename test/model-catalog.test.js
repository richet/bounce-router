// src/model-catalog.js: the shipped notes for every model the cloud vendors expose in the
// `/model` picker, and the default roster (src/profiles.js starterProfiles) built on them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MODEL_CATALOG, CATALOG_SOURCE, catalogNote} from '../src/model-catalog.js';
import {starterProfiles, validateOrchestration} from '../src/profiles.js';
import {PROFILE_TIERS, routable, routingFallback} from '../src/jev.js';
import {CAPABILITIES_MAX, effectiveNotes, undescribedModels, modelKey} from '../src/roster-notes.js';

// The ids `bounce models --json` reports on 2026-09-18, per provider (local models are dynamic
// and deliberately not shipped).
const PICKER = {
  claude: ['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku'],
  codex: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
  muse: ['muse-spark-1.3', 'muse-spark-1.3-contributor', 'muse-spark-1.2', 'muse-spark-1.2-contributor'],
};

test('every picker model has a shipped note with a valid tier and a bounded, concrete sentence', () => {
  for (const [adapter, ids] of Object.entries(PICKER)) {
    for (const id of ids) {
      const note = catalogNote(`${adapter}/${id}`);
      assert.ok(note, `${adapter}/${id} is in the catalog`);
      assert.ok(PROFILE_TIERS.includes(note.tier), `${adapter}/${id}: tier ${note.tier}`);
      assert.equal(typeof note.capabilities, 'string');
      assert.ok(note.capabilities.trim().length > 40, `${adapter}/${id}: a real sentence`);
      assert.ok(note.capabilities.length <= CAPABILITIES_MAX, `${adapter}/${id}: ${note.capabilities.length} chars`);
      assert.equal(note.capabilities, note.capabilities.replace(/\s+/g, ' ').trim(), 'single-spaced, no padding');
    }
  }
  assert.equal(catalogNote('claude/default'), catalogNote('claude/opus[1m]'), 'the picker default is Opus 5 1M: one note');
  assert.equal(catalogNote('claude/opus'), catalogNote('claude/opus[1m]'));
  assert.equal(catalogNote('local/auto'), null);
  assert.equal(catalogNote('codex/gpt-7-nova'), null);
  assert.equal(CATALOG_SOURCE, 'catalog');
  assert.ok(Object.isFrozen(MODEL_CATALOG));
});

test('tiers rank each vendor\'s lineup the way the vendor does', () => {
  const tier = key => catalogNote(key).tier;
  assert.equal(tier('claude/claude-fable-5-1[1m]'), 'strongest');
  assert.equal(tier('claude/opus[1m]'), 'strongest');
  assert.equal(tier('claude/sonnet'), 'mid');
  assert.equal(tier('claude/haiku'), 'cheapest');
  assert.equal(tier('codex/gpt-6-astra'), 'strongest');
  assert.equal(tier('codex/gpt-5.6-sol'), 'mid');
  assert.equal(tier('codex/gpt-5.6-terra'), 'mid');
  assert.equal(tier('codex/gpt-5.5'), 'mid');
  assert.equal(tier('codex/gpt-5.6-luna'), 'cheapest');
  for (const id of PICKER.muse) assert.equal(tier(`muse/${id}`), 'mid');
  for (const id of PICKER.muse.filter(id => id.endsWith('-contributor'))) assert.match(catalogNote(`muse/${id}`).capabilities, /shares your prompts and code/);
});

test('the default roster validates, routes every builder from the catalog alone, and falls back across vendors', () => {
  const settings = {order: ['claude'], mode: 'yolo', operation: 'orchestrator', orchestrator: 'main', models: {}};
  settings.profiles = starterProfiles(settings);
  const view = validateOrchestration(settings);
  assert.equal(view.orchestrator, 'main');
  assert.equal(view.profiles.main.role, 'orchestrator');
  assert.equal(view.profiles.main.adapter, 'claude');
  assert.equal(view.shape, 'multi-provider');
  // the historical names still resolve to the frontier builders
  assert.deepEqual([view.profiles.build.adapter, view.profiles.build.model], ['codex', 'gpt-6-astra']);
  assert.deepEqual([view.profiles.build_claude.adapter, view.profiles.build_claude.model], ['claude', 'opus[1m]']);
  assert.equal(routingFallback(view.profiles), 'build');
  // one builder per non-contributor picker model, none for local, none for the -contributor variants
  const workers = Object.entries(view.profiles).filter(routable);
  const shipped = workers.map(([, p]) => modelKey(p)).sort();
  const expected = Object.entries(PICKER).flatMap(([adapter, ids]) => ids.filter(id => id !== 'default' && !id.endsWith('-contributor')).map(id => `${adapter}/${id}`)).sort();
  assert.deepEqual(shipped, expected);
  assert.ok(workers.every(([, p]) => p.role === 'builder' && p.policy === 'write'));
  assert.ok(workers.every(([name]) => name === 'build' || name === 'build_claude' || /^(claude|codex|muse)_[a-z0-9_]+$/.test(name)), 'naming: build, build_claude, then <adapter>_<model>');
  // every routable profile has a tier and a sentence with an empty cache — no agent turn needed
  const notes = effectiveNotes(view.profiles, {});
  for (const [name] of workers) {
    assert.ok(PROFILE_TIERS.includes(notes[name].tier), `${name} has a tier`);
    assert.ok(notes[name].capabilities, `${name} has a sentence`);
    assert.equal(notes[name].source, 'catalog');
  }
  assert.deepEqual(undescribedModels(view.profiles, {}), []);
  // fallbacks: valid names, never self, and each frontier builder can leave its vendor
  for (const [name, p] of workers) {
    assert.ok(p.fallback.length, `${name} has a fallback`);
    assert.ok(p.fallback.every(f => f !== name && view.profiles[f]?.role === 'builder'));
  }
  for (const name of ['build', 'build_claude', 'claude_fable']) {
    assert.ok(view.profiles[name].fallback.some(f => view.profiles[f].adapter !== view.profiles[name].adapter), `${name} falls back across vendors`);
    assert.equal(notes[name].tier, 'strongest');
  }
  // no `order` at all still yields a roster
  assert.equal(starterProfiles().main.adapter, 'claude');
  assert.equal(starterProfiles({order: ['codex']}).main.adapter, 'codex');
});

test('orchestrator mode with no profiles block runs the shipped roster; a present-but-invalid block still throws', () => {
  const view = validateOrchestration({order: ['codex'], mode: 'yolo', operation: 'orchestrator'});
  assert.equal(view.operation, 'orchestrator');
  assert.equal(view.orchestrator, 'main', 'main is the orchestrator unless the config names one');
  assert.equal(view.profiles.main.adapter, 'codex');
  assert.deepEqual(Object.keys(view.profiles), Object.keys(starterProfiles({order: ['codex']})));
  assert.equal(view.profiles.build.role, 'builder');
  const named = validateOrchestration({order: ['claude'], mode: 'plan', operation: 'orchestrator', orchestrator: 'build'});
  assert.equal(named.orchestrator, 'build');
  assert.equal(named.profiles.build.role, 'orchestrator');
  assert.throws(() => validateOrchestration({order: ['claude'], mode: 'yolo', operation: 'orchestrator', orchestrator: 'ghost'}), {message: 'orchestrator must name a profile'});
  for (const profiles of [null, [], 'x']) {
    assert.throws(() => validateOrchestration({order: ['claude'], mode: 'yolo', operation: 'orchestrator', orchestrator: 'main', profiles}), {message: 'profiles must be an object'});
  }
  // a user's table is an overlay: the shipped roster is underneath it (test/profiles.test.js covers the merge)
  const own = validateOrchestration({order: ['claude'], mode: 'yolo', operation: 'orchestrator', orchestrator: 'main', profiles: {main: {adapter: 'claude'}, w: {adapter: 'codex'}}});
  assert.deepEqual(Object.keys(own.profiles), [...Object.keys(starterProfiles({order: ['claude']})), 'w']);
  // the daemon's adapter registry may not include every vendor: the shipped roster is still checked against it
  assert.throws(() => validateOrchestration({order: ['claude'], mode: 'yolo', operation: 'orchestrator'}, ['claude', 'codex']), /profile muse_spark: adapter must be one of claude, codex/);
});
