// Tier first (docs/plans/jev-agents-routing.md, Phase 2b). Measured live: over eleven look-alike
// profiles Jev's choice never reached 0.8 (0.15–0.66), while the three-way tier question was right
// 5/5 at 0.60–1.00. So Jev picks the TIER, and bounce takes the first fitting profile of that tier
// in the provider order — inside a tier the AIs are near-equal, which is not a decision for a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createJevDecisions, routingQuestions, aiQuestions, decideRoute, decideAI, routeTask, TIER_HINT, JEV_TIER_CONFIDENCE} from '../src/jev.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const roster = {
  main: {adapter: 'claude', model: 'opus', role: 'orchestrator', policy: 'write'},
  scout: {adapter: 'claude', model: 'haiku', role: 'scout', policy: 'read-only', tier: 'cheapest'},
  haiku: {adapter: 'claude', model: 'haiku', role: 'builder', policy: 'write', tier: 'cheapest'},
  sonnet: {adapter: 'claude', model: 'sonnet', role: 'builder', policy: 'write', tier: 'mid'},
  terra: {adapter: 'codex', model: 'gpt-5.6-terra', role: 'builder', policy: 'write', tier: 'mid'},
  spark: {adapter: 'muse', model: 'muse-spark', role: 'builder', policy: 'write'}, // its tier comes from the roster notes
  jev: {adapter: 'typesafe', model: '', role: 'critic', policy: 'read-only'},
};
const notes = {spark: {tier: 'strongest', capabilities: 'Deep debugging.'}};
const tier = (choice, confidence) => ({tier: {choice, confidence, probabilities: {[choice]: confidence}}});

test('the threshold for a tier is 0.6, and the tier question offers only the tiers some routable profile has', () => {
  assert.equal(JEV_TIER_CONFIDENCE, 0.6);
  const questions = routingQuestions(roster, notes);
  assert.deepEqual(Object.keys(questions), ['tier', 'profile', 'needs_write', 'needs_shell']);
  assert.deepEqual(questions.tier.criteria, TIER_HINT);
  assert.equal(questions.tier.instructions.question, 'Which tier of AI do these orders need?');
  const {main, scout, haiku, jev} = roster;
  assert.deepEqual(routingQuestions({main, scout, haiku, jev}).tier.criteria, {cheapest: TIER_HINT.cheapest});
  // a roster nobody tiered is asked exactly what it was asked before
  const plain = {main, a: {adapter: 'claude', role: 'builder', policy: 'write'}};
  assert.deepEqual(Object.keys(routingQuestions(plain)), ['profile', 'needs_write', 'needs_shell']);
  assert.deepEqual(Object.keys(aiQuestions(roster, notes)), ['tier', 'profile']);
});

test('decideRoute: a tier at 0.6 or above decides, and the profile is the first fitting one of that tier in the provider order', () => {
  const options = {profiles: roster, notes, confidence: 0.8, fallback: 'haiku'};
  const codexFirst = decideRoute({...tier('mid', 0.62), profile: {choice: 'haiku', confidence: 0.3}}, {...options, order: ['codex', 'claude']});
  assert.deepEqual(codexFirst, {chosen: 'terra', tier: 'mid', fallback: false, reason: null, probabilities: {mid: 0.62}, confidence: 0.62, needs: {write: false, shell: false}});
  assert.equal(decideRoute(tier('mid', 0.98), {...options, order: ['claude', 'codex']}).chosen, 'sonnet');
  assert.equal(decideRoute(tier('mid', 0.98), options).chosen, 'sonnet', 'with no provider order, the order of the roster');
  assert.equal(decideRoute(tier('strongest', 0.7), options).chosen, 'spark', 'a tier known only from the roster notes counts');

  // access: a read-only profile is never picked for orders that need to write or run commands
  assert.equal(decideRoute(tier('cheapest', 1), options).chosen, 'scout');
  assert.equal(decideRoute({...tier('cheapest', 1), needs_write: {noul: 0.9}}, options).chosen, 'haiku');
  assert.equal(decideRoute({...tier('cheapest', 1), needs_shell: {noul: 0.7}}, options).chosen, 'haiku');

  // tier first: it wins even over a confident profile answer; below 0.6 the profile answer is the second chance
  assert.equal(decideRoute({...tier('mid', 0.9), profile: {choice: 'spark', confidence: 0.95}}, options).chosen, 'sonnet');
  const second = decideRoute({...tier('mid', 0.59), profile: {choice: 'spark', confidence: 0.85}}, options);
  assert.deepEqual([second.chosen, second.fallback, Object.hasOwn(second, 'tier')], ['spark', false, false]);
  const lost = decideRoute({...tier('mid', 0.4), profile: {choice: 'spark', confidence: 0.5}}, options);
  assert.deepEqual([lost.chosen, lost.fallback, lost.reason], ['haiku', true, 'tier confidence 0.40 below 0.6; confidence 0.50 below 0.8']);
  const {main, scout, jev} = roster;
  const none = decideRoute({...tier('cheapest', 0.9), needs_write: {noul: 0.9}, profile: {choice: 'scout', confidence: 0.2}}, {profiles: {main, scout, jev}, fallback: null});
  assert.deepEqual([none.chosen, none.reason], [null, 'no cheapest profile can write; confidence 0.20 below 0.8']);
});

test('decideAI: the AI for an `auto` agent is chosen the same way, with no access gate — the policy is the job\'s', () => {
  const options = {profiles: roster, notes, confidence: 0.8, order: ['codex', 'claude']};
  assert.deepEqual(decideAI(tier('mid', 0.7), options), {ai: 'terra', tier: 'mid', reason: null, confidence: 0.7, probabilities: {mid: 0.7}});
  assert.equal(decideAI(tier('cheapest', 0.8), options).ai, 'scout', 'a read-only profile is a fine AI for any job');
  assert.deepEqual(decideAI({...tier('mid', 0.2), profile: {choice: 'spark', confidence: 0.3}}, options), {ai: null, reason: 'tier confidence 0.20 below 0.6; confidence 0.30 below 0.8', confidence: 0.3, probabilities: {}});
});

test('routeTask hands the decision the roster notes and the provider order; the scheduler journals the tier', async t => {
  const ask = async () => ({answers: tier('mid', 0.98), model: 'jev-1.13.0', latencyMs: 5});
  const decision = await routeTask({orders: 'implement x', profiles: roster, settings: {enabled: true}, notes: async () => notes, order: ['codex', 'claude'], ask});
  assert.deepEqual([decision.chosen, decision.tier, decision.fallback], ['terra', 'mid', false]);

  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-jev-tier-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const launched = [];
  const worker = name => { const inner = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]); return {...inner, launch: async args => { launched.push([name, args.profile.model]); return inner.launch(args); }}; };
  const jev = createJevDecisions({readSettings: () => ({enabled: true, routing: true}), order: () => ['codex', 'claude'], notes: async () => notes, adapter: {ask}});
  const scheduler = createScheduler({session, adapters: {claude: worker('claude'), codex: worker('codex'), muse: worker('muse')}, profiles: structuredClone(roster), jev, gitHead: () => null});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'auto', orders: 'Implement the flag and its test.', deadline: null});
  const start = Date.now(); while (!['completed', 'accepted', 'failed'].includes(scheduler.tasks()[row.task]?.state)) { if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); }
  assert.deepEqual(launched, [['codex', 'gpt-5.6-terra']]);
  const routed = session.events.find(e => e.kind === 'jev.routed');
  assert.deepEqual([routed.chosen, routed.tier, routed.confidence, routed.fallback], ['terra', 'mid', 0.98, false]);
  assert.equal(routed.text, 'Routed auto → terra (Jev: tier mid, confidence 0.98)');
});
