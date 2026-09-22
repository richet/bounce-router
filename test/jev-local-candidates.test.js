// Local models as candidates for an `auto` agent's AI (docs/plans/jev-agents-routing.md, Phase 3).
// A local model only ever exists as an agent's backend, so it is a candidate for the AI of a JOB —
// never for a plain `auto` task. Loaded models are preferred; downloaded ones are offered only when
// nothing is loaded (D3). They are only supplied while `/local` is on, and then a local model of the
// needed tier runs first: it costs nothing. Tiers do the mixing — cheap work local, the rest cloud.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createJevDecisions, aiQuestions, decideAI, decideRoute, routingQuestions, normalizeJevSettings, persistedJevSettings, TIER_HINT} from '../src/jev.js';
import {localCandidates} from '../src/local-models.js';
import {validateOrchestration, playedBy} from '../src/profiles.js';
import {agentMetadata} from '../src/agents.js';
import {undescribedModels} from '../src/roster-notes.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const model = (id, extra = {}) => ({id, ref: `lmstudio/${id}`, type: 'llm', tools: true, ready: true, instances: [{id: `${id}@live`, context: 65536}], context: 65536, ...extra});
const catalogs = models => [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models}];
const onDisk = {ready: false, instances: [], context: 131072};
const cache = {'lmstudio/dense-27b': {tier: 'strongest', capabilities: 'Careful reviewer; slow.'}};

test('candidates: loaded tool-capable models, described by their note or conservatively; downloaded ones only when nothing is loaded', () => {
  const mixed = catalogs([model('coder-30b'), model('dense-27b', {instances: [{id: 'dense', context: 32768}]}), model('big-disk', onDisk), model('no-tools', {tools: false}), {id: 'embed', type: 'embedding', ready: true, instances: []}]);
  assert.deepEqual(localCandidates(mixed, cache), [
    {name: 'lmstudio/coder-30b', endpoint: 'lmstudio', model: 'coder-30b', loaded: true, context: 65536, tier: 'cheapest', capabilities: 'unknown local model: single-file reading only'},
    {name: 'lmstudio/dense-27b', endpoint: 'lmstudio', model: 'dense-27b', loaded: true, context: 32768, tier: 'strongest', capabilities: 'Careful reviewer; slow.'}]);
  assert.deepEqual(localCandidates(catalogs([model('big-disk', onDisk), model('no-tools', {tools: false})]), cache).map(item => [item.name, item.loaded]), [['lmstudio/big-disk', false]]);
  assert.deepEqual(localCandidates([], cache), []);
});

const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude'], models: {}, local: {enabled: true},
  profiles: {main: {adapter: 'claude', model: 'opus'}, sonnet: {adapter: 'claude', model: 'sonnet', tier: 'strongest'}, haiku: {adapter: 'claude', model: 'haiku', tier: 'cheapest'}}};
const roles = new Map([['reviewer', {...agentMetadata('---\nname: reviewer\ndescription: Reads for defects.\npolicy: read-only\nmodels: [auto, claude/sonnet]\n---\nYou are the reviewer.\n'), source: 'user', file: '/x/reviewer.md'}]]);
const table = () => validateOrchestration(settings, undefined, {roles}).profiles;
const locals = localCandidates(catalogs([model('coder-30b'), model('dense-27b')]), cache);
const tier = (choice, confidence) => ({tier: {choice, confidence, probabilities: {[choice]: confidence}}});

test('the AI question offers the local models beside the profiles; a plain `auto` task never sees them', () => {
  const profiles = table();
  const questions = aiQuestions(profiles, {}, profiles.reviewer, locals);
  assert.equal(questions.profile.criteria['lmstudio/dense-27b'], 'local model lmstudio/dense-27b · runs on this machine at no cost · context 64k · tier strongest: independent review, ambiguous or cross-cutting debugging, security-sensitive work · capabilities: Careful reviewer; slow.');
  const cold = localCandidates(catalogs([model('big-disk', onDisk)]), {});
  assert.match(aiQuestions(profiles, {}, profiles.reviewer, cold).profile.criteria['lmstudio/big-disk'], /· not loaded: choosing it costs a model load first · /);
  const {main, haiku} = profiles;
  assert.deepEqual(aiQuestions({main, haiku}, {}, null, locals).tier.criteria, {cheapest: TIER_HINT.cheapest, strongest: TIER_HINT.strongest}, 'a tier only a local model has is offered too');
  assert.equal(Object.keys(routingQuestions(profiles).profile.criteria).some(name => name.startsWith('lmstudio/')), false);
});

test('decideAI: a local model of the needed tier runs first, a tier no local model has goes cloud, loaded before downloaded, and a named local answer counts', () => {
  const options = {profiles: table(), order: ['claude'], locals, confidence: 0.8};
  assert.equal(decideAI(tier('cheapest', 0.9), {...options, locals: []}).ai, 'haiku', 'with /local off no local model is supplied');
  assert.equal(decideAI(tier('mid', 0.9), {...options, profiles: {...options.profiles, terra: {adapter: 'codex', model: 't', role: 'builder', policy: 'write', tier: 'mid'}}}).ai, 'terra', 'no local model is rated mid: cloud');
  assert.deepEqual(decideAI(tier('strongest', 0.9), options), {ai: 'lmstudio/dense-27b', local: {endpoint: 'lmstudio', model: 'dense-27b'}, tier: 'strongest', reason: null, confidence: 0.9, probabilities: {strongest: 0.9}});
  const mixed = [{...locals[0], name: 'lmstudio/cold', model: 'cold', loaded: false}, locals[0]];
  assert.equal(decideAI(tier('cheapest', 0.9), {...options, locals: mixed}).ai, 'lmstudio/coder-30b');
  const named = decideAI({...tier('mid', 0.3), profile: {choice: 'lmstudio/dense-27b', confidence: 0.85}}, options);
  assert.deepEqual([named.ai, named.local], ['lmstudio/dense-27b', {endpoint: 'lmstudio', model: 'dense-27b'}]);
});

test('there is no separate local-first setting: a stale one in config.json is dropped', () => {
  assert.deepEqual(normalizeJevSettings({enabled: true, routing: {enabled: true, preferLocal: true}}).routing, {enabled: true, default: null});
  assert.deepEqual(persistedJevSettings({enabled: true, routing: {enabled: true, preferLocal: true}}).routing, true);
});

test('a job played by a local model is an ordinary local backend of that job', () => {
  const profiles = table();
  const played = playedBy(profiles.reviewer, 'lmstudio/dense-27b', null, {endpoint: 'lmstudio', model: 'dense-27b'});
  const {agent, role, policy, mode, executables} = profiles.reviewer;
  assert.deepEqual(played, {derived: true, ai: 'lmstudio/dense-27b', adapter: 'opencode', model: 'dense-27b', mode, policy, fallback: ['reviewer'], role, executables, agent,
    backend: 'lmstudio', endpoint: 'lmstudio', localOptions: {maxOutputTokens: 2048}});
});

test('the roster setup is asked to describe a local candidate nobody has described', () => {
  const extra = [{key: 'lmstudio/coder-30b', adapter: 'opencode', model: 'coder-30b', endpoint: 'lmstudio'}, {key: 'lmstudio/dense-27b', adapter: 'opencode', model: 'dense-27b', endpoint: 'lmstudio'}];
  assert.deepEqual(undescribedModels({}, cache, extra), [extra[0]]);
});

test('scheduler: Jev\'s local pick runs the job through opencode on that model, and falls to the job\'s chain on failure', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-jev-localai-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const launched = [];
  const worker = (name, script) => { const inner = fakeAdapter(script); return {...inner, launch: async args => { launched.push([name, args.profile.model, args.profile.role, args.profile.policy]); return inner.launch(args); }}; };
  const jev = createJevDecisions({readSettings: () => ({enabled: true, routing: true}), order: () => ['claude'], locals: async () => locals,
    adapter: {ask: async () => ({answers: tier('strongest', 0.9), model: 'jev-1.13.0', latencyMs: 4})}});
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const scheduler = createScheduler({session, profiles: table(), jev, localResolver, gitHead: () => null, adapters: {
    opencode: worker('opencode', () => [{kind: 'result', status: 'failed', recoverable: true, text: 'endpoint down'}]),
    claude: worker('claude', () => [{kind: 'result', status: 'completed', text: 'done'}])}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'reviewer', orders: 'Review src/x.js. Change nothing.', deadline: null});
  const wait = async fn => { const start = Date.now(); for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };
  const fallback = await wait(() => session.events.find(e => e.kind === 'policy.fallback'));
  assert.deepEqual([fallback.from_profile, fallback.to_profile], ['reviewer@lmstudio/dense-27b', 'reviewer']);
  await wait(() => launched.length === 2);
  assert.deepEqual(launched, [['opencode', 'dense-27b', 'reviewer', 'read-only'], ['claude', 'sonnet', 'reviewer', 'read-only']]);
  const routed = session.events.find(e => e.kind === 'jev.routed');
  assert.deepEqual([routed.chosen, routed.ai, routed.local, routed.tier], ['reviewer@lmstudio/dense-27b', 'lmstudio/dense-27b', {endpoint: 'lmstudio', model: 'dense-27b'}, 'strongest']);
  assert.equal(routed.text, 'Routed reviewer → lmstudio/dense-27b (AI chosen by Jev: tier strongest, confidence 0.90)');
});

test('between local models of one tier, the one the agent\'s own list names plays it — a reviewer keeps its reviewer model', () => {
  const two = [{...locals[0], tier: 'mid'}, {...locals[1], tier: 'mid'}]; // coder-30b, dense-27b: both mid
  const pinned = new Map([['reviewer', {...agentMetadata('---\nname: reviewer\ndescription: Reads for defects.\npolicy: read-only\nmodels: [auto, lmstudio/dense-27b, claude/sonnet]\n---\nYou are the reviewer.\n'), source: 'user', file: '/x/reviewer.md'}]]);
  const profiles = validateOrchestration(settings, undefined, {roles: pinned}).profiles;
  const options = {profiles, order: ['claude'], locals: two, confidence: 0.8};
  assert.equal(decideAI(tier('mid', 0.9), options).ai, 'lmstudio/coder-30b', 'with no job in hand, the order LM Studio lists them');
  assert.equal(decideAI(tier('mid', 0.9), {...options, head: profiles.reviewer}).ai, 'lmstudio/dense-27b');
  // the same through a plain `auto` task that lands on the job
  const routed = decideRoute({agent: {choice: 'reviewer', confidence: 0.95}, ...tier('mid', 0.9), needs_write: {noul: 0.02}}, {...options, fallback: null});
  assert.deepEqual([routed.agent, routed.ai], ['reviewer', 'lmstudio/dense-27b']);
});
