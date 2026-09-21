// `auto` inside an agent's `models:` (docs/plans/jev-agents-routing.md, Phase 2): the agent is still
// the job, but WHICH AI plays it is Jev's pick at dispatch; the entries after `auto` are the chain
// the job runs on when Jev is off, unavailable or unconfident. Real scheduler, fake adapters, a
// scripted Jev answer (never the network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createJevDecisions, aiQuestions, decideAI, decideRoute} from '../src/jev.js';
import {validateOrchestration, playedBy} from '../src/profiles.js';
import {agentMetadata, agentTable} from '../src/agents.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (fn, timeout = 8000) => { const start = Date.now(); for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > timeout) throw new Error('timed out waiting for condition'); await new Promise(r => setTimeout(r, 10)); } };
const file = models => `---\nname: reviewer\ndescription: Reads for defects; never edits.\npolicy: read-only\nmodels: [${models}]\n---\nYou are the reviewer.\n`;
const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude', 'codex'], models: {},
  profiles: {main: {adapter: 'claude', model: 'opus'}, build: {adapter: 'codex', model: 'gpt-6-astra', tier: 'mid', capabilities: 'routine implementation'}}};
const rolesOf = models => new Map([['reviewer', {...agentMetadata(file(models)), source: 'user', file: '/x/reviewer.md'}]]);

test('an agent file may put `auto` first in models; the rest is the chain it falls to, and `auto` alone falls to the provider order', () => {
  assert.deepEqual(agentMetadata(file('auto, claude/sonnet')).models, ['auto', 'claude/sonnet']);
  assert.throws(() => agentMetadata(file('claude/sonnet, auto')), /auto goes first in models: the entries after it are what the agent falls back to/);

  const view = validateOrchestration(settings, undefined, {roles: rolesOf('auto, claude/sonnet')});
  assert.deepEqual([view.profiles.reviewer.auto, view.profiles.reviewer.adapter, view.profiles.reviewer.model, view.profiles.reviewer.fallback], [true, 'claude', 'sonnet', []]);
  assert.equal(Object.keys(view.profiles).some(name => name.includes('@')), false, 'nothing is composed until a task is dispatched');

  const alone = validateOrchestration(settings, undefined, {roles: rolesOf('auto')});
  assert.deepEqual([alone.profiles.reviewer.auto, alone.profiles.reviewer.adapter, alone.profiles['reviewer~2'].adapter, alone.profiles['reviewer~2'].auto], [true, 'claude', 'codex', undefined]);
  const explicit = validateOrchestration(settings, undefined, {roles: rolesOf('claude/sonnet')});
  assert.equal(Object.hasOwn(explicit.profiles.reviewer, 'auto'), false, 'a list a person wrote is never overridden');

  assert.deepEqual(agentTable(rolesOf('auto, claude/sonnet'), settings)[0].backends, ['auto (Jev)', 'claude/sonnet']);
});

test('the job played by an AI: the AI\'s adapter and model, everything else the job\'s, falling back to the job\'s own chain', () => {
  const view = validateOrchestration(settings, undefined, {roles: rolesOf('auto, claude/sonnet')});
  const composed = playedBy(view.profiles.reviewer, 'build', view.profiles.build);
  const {agent, role, policy, mode, executables} = view.profiles.reviewer;
  assert.deepEqual(composed, {derived: true, ai: 'build', adapter: 'codex', model: 'gpt-6-astra', mode, policy, fallback: ['reviewer'], role, executables, agent});
  assert.equal(policy, 'read-only');
});

test('the AI question leaves the job out of it: what each AI runs on and is good at, no role, no policy, no access questions', () => {
  const view = validateOrchestration(settings, undefined, {roles: rolesOf('auto, claude/sonnet')});
  const questions = aiQuestions(view.profiles, {build: {tier: 'strongest'}}, view.profiles.reviewer);
  assert.deepEqual(Object.keys(questions), ['tier', 'profile']);
  assert.equal(questions.profile.criteria.build, 'codex/gpt-6-astra · tier mid: research, routine implementation, test triage · capabilities: routine implementation');
  // the shipped roster is in the table too; whatever is offered is an AI, never a job or the orchestrator
  assert.deepEqual(Object.keys(questions.profile.criteria).filter(name => ['main', 'reviewer'].includes(name)), []);
  assert.deepEqual(Object.values(questions.profile.criteria).filter(text => /role |policy /.test(text)), []);
  assert.match(questions.profile.instructions.question, /^Which AI should do this job\? The job: Reads for defects; never edits\. \(policy read-only\)$/);

  const options = {profiles: view.profiles, confidence: 0.8};
  assert.deepEqual(decideAI({profile: {choice: 'build', confidence: 0.86, probabilities: {build: 0.86}}}, options), {ai: 'build', reason: null, confidence: 0.86, probabilities: {build: 0.86}});
  assert.deepEqual(decideAI({profile: {choice: 'build', confidence: 0.5}}, options), {ai: null, reason: 'confidence 0.50 below 0.8', confidence: 0.5, probabilities: {}});
  assert.deepEqual(decideAI({profile: {choice: 'reviewer', confidence: 0.99}}, options), {ai: null, reason: 'no routable choice', confidence: 0.99, probabilities: {}});

  // `auto` as the task's profile: one ask answers both, and only an `auto` agent takes the AI answer
  const both = {agent: {choice: 'reviewer', confidence: 0.95}, profile: {choice: 'build', confidence: 0.9}, needs_write: {noul: 0.05}};
  assert.deepEqual([decideRoute(both, {...options, fallback: 'build'}).chosen, decideRoute(both, {...options, fallback: 'build'}).ai], ['reviewer', 'build']);
  const pinned = validateOrchestration(settings, undefined, {roles: rolesOf('claude/sonnet')}).profiles;
  assert.equal(Object.hasOwn(decideRoute(both, {profiles: pinned, confidence: 0.8, fallback: 'build'}), 'ai'), false);
  assert.equal(Object.hasOwn(decideRoute({...both, profile: {choice: 'build', confidence: 0.4}}, {...options, fallback: 'build'}), 'ai'), false, 'an unconfident AI answer leaves the job on its own chain');
});

function rig(t, {answer, enabled = true, codexScript = null}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-agent-auto-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const launched = [], asked = [], prompts = [];
  const done = name => [{kind: 'result', status: 'completed', text: `done by ${name}`}];
  const worker = (name, script = () => done(name)) => { const inner = fakeAdapter(script); return {...inner, launch: async args => { launched.push([name, args.profile.model, args.profile.role, args.profile.policy, args.profile.agent?.name ?? null]); prompts.push(args.profile.agent?.prompt ?? null); return inner.launch(args); }}; };
  const jevSettings = {enabled, model: 'jev-1.13.0', review: false, routing: {enabled: true, default: null}, confidence: 0.8};
  const jev = createJevDecisions({readSettings: () => jevSettings, adapter: {ask: async request => { asked.push(request); return {answers: answer, model: 'jev-1.13.0', latencyMs: 9}; }}});
  const profiles = validateOrchestration(settings, undefined, {roles: rolesOf('auto, claude/sonnet')}).profiles;
  const scheduler = createScheduler({session, adapters: {claude: worker('claude'), codex: worker('codex', codexScript ?? undefined)}, profiles, jev, gitHead: () => null});
  t.after(() => scheduler.close());
  const settled = async task => waitFor(() => ['completed', 'accepted', 'failed'].includes(scheduler.tasks()[task]?.state));
  return {session, scheduler, launched, asked, settled, prompts, profiles, root};
}
const ORDERS = 'Review src/x.js for defects. Change nothing.';

test('scheduler: a task for an `auto` agent runs the job on the AI Jev picks, and the journal says so', async t => {
  const {session, scheduler, launched, asked, settled} = rig(t, {answer: {profile: {choice: 'build', confidence: 0.9, probabilities: {build: 0.9}}}});
  const row = scheduler.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null});
  await settled(row.task);
  assert.deepEqual(launched, [['codex', 'gpt-6-astra', 'reviewer', 'read-only', 'reviewer']], 'the reviewer job, on the AI of profile build');
  assert.deepEqual(Object.keys(asked[0].questions), ['tier', 'profile']);
  const routed = session.events.filter(e => e.kind === 'jev.routed');
  assert.equal(routed.length, 1);
  assert.deepEqual([routed[0].chosen, routed[0].agent, routed[0].ai, routed[0].via, routed[0].fallback, routed[0].confidence], ['reviewer@build', 'reviewer', 'build', 'agent-auto', false, 0.9]);
  assert.equal(routed[0].text, 'Routed reviewer → build (AI chosen by Jev, confidence 0.90)');
  assert.equal(scheduler.tasks()[row.task].profile, 'reviewer@build');
});

test('scheduler: with Jev off the job runs on the chain after `auto` and nothing is journaled; in doubt it does too, with the reason', async t => {
  const off = rig(t, {enabled: false, answer: {}});
  const first = off.scheduler.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null});
  await off.settled(first.task);
  assert.deepEqual(off.launched, [['claude', 'sonnet', 'reviewer', 'read-only', 'reviewer']]);
  assert.equal(off.asked.length, 0);
  assert.equal(off.session.events.some(e => e.kind === 'jev.routed'), false, 'Jev off: the journal is what it was before');

  const doubt = rig(t, {answer: {profile: {choice: 'build', confidence: 0.41}}});
  const second = doubt.scheduler.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null});
  await doubt.settled(second.task);
  assert.deepEqual(doubt.launched, [['claude', 'sonnet', 'reviewer', 'read-only', 'reviewer']]);
  const routed = doubt.session.events.find(e => e.kind === 'jev.routed');
  assert.deepEqual([routed.chosen, routed.ai, routed.via, routed.fallback, routed.reason], ['reviewer', null, 'agent-auto', true, 'confidence 0.41 below 0.8']);
  assert.equal(routed.text, 'Routed reviewer → its own models (fallback: confidence 0.41 below 0.8)');
});

test('scheduler: when Jev\'s AI fails recoverably the job falls to its own chain, and Jev is not asked a second time', async t => {
  const {session, scheduler, launched, asked} = rig(t, {answer: {profile: {choice: 'build', confidence: 0.9}}, codexScript: () => [{kind: 'result', status: 'failed', recoverable: true, text: 'endpoint down'}]});
  const row = scheduler.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null});
  const fallback = await waitFor(() => session.events.find(e => e.kind === 'policy.fallback'));
  assert.deepEqual([fallback.task, fallback.from_profile, fallback.to_profile, fallback.reason], [row.task, 'reviewer@build', 'reviewer', 'worker_runtime']);
  await waitFor(() => Object.values(scheduler.tasks()).some(task => task.replaces === row.task && ['completed', 'accepted'].includes(task.state)));
  assert.deepEqual(launched.map(([name]) => name), ['codex', 'claude']);
  assert.equal(asked.length, 1);
});

test('scheduler: `auto` as the profile picks the job AND, for an `auto` agent, the AI — from the one ask', async t => {
  const {session, scheduler, launched, asked, settled} = rig(t, {answer: {agent: {choice: 'reviewer', confidence: 0.93}, profile: {choice: 'build', confidence: 0.88}, needs_write: {noul: 0.02}, needs_shell: {noul: 0.3}}});
  const row = scheduler.submit({parent: null, profile: 'auto', orders: ORDERS, deadline: null});
  await settled(row.task);
  assert.equal(asked.length, 1);
  assert.deepEqual(launched, [['codex', 'gpt-6-astra', 'reviewer', 'read-only', 'reviewer']]);
  const routed = session.events.find(e => e.kind === 'jev.routed');
  assert.deepEqual([routed.chosen, routed.agent, routed.ai, routed.via], ['reviewer@build', 'reviewer', 'build', 'auto']);
  assert.equal(routed.text, 'Routed auto → reviewer on build (job and AI chosen by Jev, confidence 0.93)');
});

test('scheduler: a job on Jev\'s AI survives a daemon restart and follows the agent file when it is re-activated', async t => {
  // Restart: the first daemon journaled the route and died before launching. The next one has a
  // freshly validated table — which never holds `reviewer@build` — and must still run the task there.
  const first = rig(t, {answer: {}});
  first.scheduler.close();
  const hung = createScheduler({session: first.session, adapters: {}, profiles: first.profiles, gitHead: () => null,
    jev: {reviewer: 'jev', settings: () => ({}), route: async () => new Promise(() => {}), routeAI: async () => new Promise(() => {})}});
  const row = hung.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null});
  hung.close();
  first.session.append({kind: 'jev.routed', task: row.task, chosen: 'reviewer@build', agent: 'reviewer', ai: 'build', via: 'agent-auto', fallback: false});
  const launched = [];
  const worker = name => { const inner = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]); return {...inner, launch: async args => { launched.push([name, args.profile.role]); return inner.launch(args); }}; };
  const next = createScheduler({session: first.session, adapters: {claude: worker('claude'), codex: worker('codex')}, gitHead: () => null,
    profiles: validateOrchestration(settings, undefined, {roles: rolesOf('auto, claude/sonnet')}).profiles, jev: {reviewer: 'jev', settings: () => ({}), route: async () => { throw new Error('asked again'); }, routeAI: async () => { throw new Error('asked again'); }}});
  t.after(() => next.close());
  await next.reconcile();
  await waitFor(() => ['completed', 'accepted', 'failed'].includes(next.tasks()[row.task]?.state));
  assert.deepEqual([next.tasks()[row.task].state === 'failed', launched], [false, [['codex', 'reviewer']]]);

  // Re-activation while a task runs on Jev's AI (setup edited the agent file): the running task keeps
  // its way back to the job's own chain, and the next task is composed from the new file.
  const gate = Promise.withResolvers();
  let turn = 0;
  const live = rig(t, {answer: {profile: {choice: 'build', confidence: 0.9}}, codexScript: async () => (turn++ === 0 ? (await gate.promise, [{kind: 'result', status: 'failed', recoverable: true, text: 'endpoint down'}]) : [{kind: 'result', status: 'completed', text: 'done'}])});
  const running = live.scheduler.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null});
  await waitFor(() => live.launched.length === 1);
  const head = live.profiles.reviewer;
  live.scheduler.replaceAgent('reviewer', {reviewer: {...head, agent: {...head.agent, prompt: 'You are the STRICT reviewer.'}}}, undefined);
  gate.resolve();
  const fallback = await waitFor(() => live.session.events.find(e => e.kind === 'policy.fallback'));
  assert.deepEqual([fallback.task, fallback.from_profile, fallback.to_profile], [running.task, 'reviewer@build', 'reviewer']);
  await waitFor(() => live.launched.length === 2);
  await live.settled(live.scheduler.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null}).task);
  assert.deepEqual(live.launched.map(([name]) => name), ['codex', 'claude', 'codex']);
  assert.deepEqual(live.prompts, ['You are the reviewer.', 'You are the STRICT reviewer.', 'You are the STRICT reviewer.']);
});
