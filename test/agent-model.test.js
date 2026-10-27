// A profile is an agent's (the job: its prompt, rules and policy); a model is an AI (sol, terra, opus, qwen). Naming an
// AI never swaps the agent out. Found live (2026-10-26): the user asked for Sol, the orchestrator sent
// `profile: codex_61_sol, userAsked: true` and `review: {completion: "codex_61_sol"}`, and both ran as the bare Sol
// profile with no agent at all — the "reviews" implemented the step again, edited the copy under review and gave
// no verdict, then fell down the builder's chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {waitFor} from './helpers/wait.js';

const builder = {name: 'builder', description: 'builds', policy: 'write', prompt: 'build it'};
const reviewer = {name: 'reviewer', description: 'reviews', policy: 'write', prompt: 'review it; end with PASS or FAIL'};
const profiles = () => ({
  builder: {derived: true, adapter: 'claude', model: 'sonnet', policy: 'write', role: 'builder', agent: builder, fallback: ['builder~2']},
  'builder~2': {derived: true, adapter: 'codex', model: 'gpt-5.6-sol', policy: 'write', role: 'builder', agent: builder, fallback: ['builder~3']},
  'builder~3': {derived: true, adapter: 'codex', model: 'gpt-6.1-sol', policy: 'write', role: 'builder', agent: builder, fallback: []},
  reviewer: {derived: true, adapter: 'claude', model: 'sonnet', policy: 'write', role: 'reviewer', agent: reviewer, fallback: ['reviewer~2']},
  'reviewer~2': {derived: true, adapter: 'codex', model: 'gpt-6.1-terra', policy: 'write', role: 'reviewer', agent: reviewer, fallback: []},
  codex_61_sol: {adapter: 'codex', model: 'gpt-6.1-sol', policy: 'write', role: 'builder', fallback: ['claude_sonnet']},
  claude_sonnet: {adapter: 'claude', model: 'sonnet', policy: 'write', role: 'builder', fallback: []},
});
const adapter = {launch: async () => ({}), async *events() {}, cancel: async () => ({verified: true})};
function rig(t, table = profiles()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agent-model-'));
  const session = new Session(root, {root});
  const scheduler = createScheduler({session, adapters: {claude: adapter, codex: adapter}, profiles: table, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, session, scheduler, profiles: table};
}
const base = {from: 'orchestrator', orders: 'implement step 10', requires: ['read', 'write']};

test('the session case: an AI the user asked for plays the agent, for the work and for its review', t => {
  const {scheduler, profiles: table} = rig(t);
  const row = scheduler.submit({...base, profile: 'codex_61_sol', userAsked: true, review: {completion: 'codex_61_sol'}});
  assert.equal(row.profile, 'builder@codex:gpt-6.1-sol');
  assert.equal(row.review.completion, 'reviewer@codex:gpt-6.1-sol');
  const work = table['builder@codex:gpt-6.1-sol'], review = table['reviewer@codex:gpt-6.1-sol'];
  assert.deepEqual([work.agent.prompt, work.role, work.adapter, work.model], ['build it', 'builder', 'codex', 'gpt-6.1-sol']);
  assert.deepEqual([review.agent.prompt, review.role, review.adapter, review.model], ['review it; end with PASS or FAIL', 'reviewer', 'codex', 'gpt-6.1-sol']);
  assert.deepEqual([work.fallback, review.fallback], [[], []], 'the AI the user asked for has no chain under it');
  assert.deepEqual(row.corrections, [
    'profile: codex_61_sol is an AI, not an agent: it runs as the builder agent on codex/gpt-6.1-sol (profile names the agent, model the AI)',
    'review.completion: codex_61_sol is an AI, not an agent: the reviewer agent reviews on codex/gpt-6.1-sol',
  ]);
});

test('model names the AI by family, the newest the agent lists first; one off the list still plays the agent, said so', t => {
  const {scheduler} = rig(t);
  assert.equal(scheduler.submit({...base, profile: 'builder', model: 'sol'}).profile, 'builder@codex:gpt-6.1-sol');
  assert.equal(scheduler.submit({...base, profile: 'builder', model: 'codex/gpt-5.6-sol'}).profile, 'builder@codex:gpt-5.6-sol');
  const off = scheduler.submit({...base, profile: 'builder', model: 'terra'});
  assert.equal(off.profile, 'builder@codex:gpt-6.1-terra');
  assert.deepEqual(off.corrections, ["model: codex/gpt-6.1-terra is not on the builder's list; it plays the builder because it was named"]);
  assert.throws(() => scheduler.submit({...base, profile: 'builder', model: 'nova'}), /malformed: model: no AI named "nova" here/);
});

test('only a review agent reviews: a builder named as reviewer becomes the reviewer, on the AI given', t => {
  const {scheduler} = rig(t);
  const row = scheduler.submit({...base, profile: 'builder', review: {completion: 'builder'}});
  assert.equal(row.review.completion, 'reviewer');
  assert.deepEqual(row.corrections, ['review.completion: builder is not a review agent: the reviewer agent reviews']);
  assert.equal(scheduler.submit({...base, profile: 'builder', review: {completion: {profile: 'reviewer', model: 'sol'}}}).review.completion, 'reviewer@codex:gpt-6.1-sol');
  const none = rig(t, {builder: profiles().builder, 'builder~2': profiles()['builder~2'], 'builder~3': profiles()['builder~3']});
  assert.throws(() => none.scheduler.submit({...base, profile: 'builder', review: {completion: 'builder'}}), /malformed: review/);
});

test('a retry naming an AI keeps the job of the task it retries', t => {
  const {scheduler} = rig(t);
  const first = scheduler.submit({...base, profile: 'reviewer', orders: 'review step 10', requires: ['read']});
  assert.equal(scheduler.prepare({...base, profile: 'codex_61_sol', retryOf: first.task}).profile, 'reviewer@codex:gpt-6.1-sol');
});

test('an agent on a named AI is rebuilt from its name after a restart', t => {
  const {root, session, scheduler} = rig(t);
  const row = scheduler.submit({...base, profile: 'builder', model: 'sol', review: {completion: {profile: 'reviewer', model: 'sol'}}});
  scheduler.close();
  const fresh = profiles();
  const again = createScheduler({session: new Session(root, {root, id: session.id}), adapters: {claude: adapter, codex: adapter}, profiles: fresh, watchdog: {interval: null}});
  t.after(() => again.close());
  assert.equal(fresh[row.profile]?.agent?.name, 'builder');
  assert.equal(fresh[row.review.completion]?.agent?.name, 'reviewer');
});

// Found live (a session): the user asked for a Codex review. The codex reviewer got only the builder's orders and its
// report, with nothing saying it was reviewing, so it did the work again and ended with a build report; bounce read no
// verdict and handed the review to the reviewer agent's own chain, whose first AI was the local qwen ("profile pin").
test('a review agent on a cloud AI gets its own instructions, and one the user named does not fall to the agent chain', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agent-model-'));
  const session = new Session(root, {root});
  const seen = [];
  const answer = text => fakeAdapter(args => { seen.push({adapter: args.profile.adapter, model: args.profile.model, orders: args.orders, review: Boolean(args.review)}); return [{kind: 'result', status: 'completed', text: args.review ? text : 'built it'}]; });
  const scheduler = createScheduler({session, adapters: {claude: answer('PASS'), codex: answer('Fixed and verified.')}, profiles: profiles(), watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const row = scheduler.submit({...base, profile: 'builder', model: 'sol', userAsked: true, requires: ['read'], review: {completion: {profile: 'reviewer', model: 'sol'}}});
  await waitFor(() => ['accepted', 'failed', 'blocked', 'completed'].includes(scheduler.tasks()[row.task]?.state) && !session.events.some(e => e.kind === 'review.started' && e.task === row.task && !session.events.some(f => f.kind === 'review.finished' && f.seq > e.seq)), {timeout: 6000});
  const reviews = seen.filter(s => s.review);
  assert.ok(reviews.length >= 1, JSON.stringify(seen));
  assert.equal(reviews[0].orders.startsWith('review it; end with PASS or FAIL\n\n---\n\nimplement step 10'), true, reviews[0].orders);
  assert.deepEqual([...new Set(reviews.map(s => `${s.adapter}/${s.model}`))], ['codex/gpt-6.1-sol'], 'every review ran on the AI the user named');
  assert.equal(session.events.some(e => e.kind === 'review.escalated' && e.task === row.task), false);
});

// Found live (a session): the user moved the builders to `qwen3.8_builder_2`, a name from models.yaml that bindings.yml
// lists for the builder. The orchestrator sent it as the profile; bounce answered "is not a profile here; it runs as
// the builder agent" and the AI the user named was dropped. A binding's name is an AI: it plays the agent, with the
// settings that name carries.
test('a name from the bindings is an AI: as the profile or as the model it plays the agent, with its own settings', t => {
  const table = profiles();
  table['builder~2'] = {...table['builder~2'], alias: 'qwen_builder', adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model: 'qwen3.8-27b', localOptions: {thinking: false, temperature: 0.6}};
  table['reviewer~2'] = {...table['reviewer~2'], alias: 'qwen_reviewer', adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model: 'qwen3.8-27b', localOptions: {thinking: false, temperature: 0.2}};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agent-model-'));
  const scheduler = createScheduler({session: new Session(root, {root}), adapters: {claude: adapter, codex: adapter, opencode: adapter}, profiles: table, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const asProfile = scheduler.prepare({...base, profile: 'qwen_builder', userAsked: true});
  assert.equal(asProfile.profile, 'builder@lmstudio:qwen3.8-27b');
  assert.deepEqual(asProfile.corrections, ['profile: qwen_builder is an AI (a name in the bindings), not an agent: it runs as the builder agent on lmstudio/qwen3.8-27b (profile names the agent, model the AI)']);
  assert.deepEqual(table['builder@lmstudio:qwen3.8-27b'].localOptions, {thinking: false, temperature: 0.6}, "the builder's own settings for that AI");
  assert.equal(scheduler.prepare({...base, profile: 'builder', model: 'qwen_builder'}).profile, 'builder@lmstudio:qwen3.8-27b');
  assert.equal(scheduler.prepare({...base, profile: 'builder', review: {completion: {profile: 'reviewer', model: 'qwen_reviewer'}}}).review.completion, 'reviewer@lmstudio:qwen3.8-27b');
  assert.deepEqual(table['reviewer@lmstudio:qwen3.8-27b'].localOptions, {thinking: false, temperature: 0.2});
});
