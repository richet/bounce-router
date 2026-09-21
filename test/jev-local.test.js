// Jev completion verdicts over a LOCAL worker (docs/plans/jev-agents-routing.md, Phase 0): the two
// were connected only by construction — a local worker's answer is synthesized into
// task.completed.summary, and Jev judges `review.summary` when there is no structured report — and
// had never been run together. Real scheduler, real OpenCode adapter on the one-shot fake, the
// typesafe adapter on a stubbed fetch (never the network).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createOpencodeLive} from '../src/adapters/opencode-live.js';
import {createTypesafeLive} from '../src/adapters/typesafe-live.js';
import {createJevDecisions, jevReviewerProfile, VERDICT_CHECKS} from '../src/jev.js';
import {validateOrchestration} from '../src/profiles.js';

const helper = fileURLToPath(new URL('./helpers/fake-opencode.js', import.meta.url));
const waitFor = async (fn, timeout = 8000) => { const start = Date.now(); for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > timeout) throw new Error('timed out waiting for condition'); await new Promise(r => setTimeout(r, 10)); } };
const okResponse = body => ({ok: true, status: 200, headers: {get: () => null}, json: async () => body, text: async () => JSON.stringify(body)});
const verdict = (choice, confidence, nouls = {}) => ({answers: {decision: {type: 'choice', choice, probabilities: {accept: choice === 'accept' ? confidence : 1 - confidence, rework: choice === 'rework' ? confidence : 1 - confidence}, confidence},
  ...Object.fromEntries(Object.keys(VERDICT_CHECKS).map(name => [name, {type: 'noul', noul: nouls[name] ?? 0.05}]))}});

test('a local agent\'s answer is what Jev judges; a confident rework resumes the SAME opencode session, and the second answer is accepted', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-jev-local-')));
  const log = path.join(root, 'fake-oc.log');
  const saved = {...process.env}; Object.assign(process.env, {FAKE_OC_LOG: log});
  t.after(() => { delete process.env.FAKE_OC_LOG; Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true}); });
  const session = new Session(root, {root});

  // The profile table the daemon would build: the shipped roster plus an agent with a local backend.
  const roles = new Map([['analyst', {name: 'analyst', description: 'Scouts.', policy: 'read-only', prompt: 'You scout.', maxSteps: 8, source: 'user', models: ['lmstudio/loaded']}]]);
  const view = validateOrchestration({operation: 'orchestrator', mode: 'yolo', order: ['claude'], models: {}, executables: {opencode: helper}}, undefined, {roles});
  // No LM Studio here: hand the scheduler a resolver that answers as the real one would.
  const localResolver = {resolve: async ({profile}) => ({...profile, model: 'loaded', providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const profiles = {...view.profiles, jev: jevReviewerProfile({})};
  assert.equal(profiles.analyst.derived, true);

  const settings = {enabled: true, model: 'jev-1.13.0', review: true, routing: {enabled: false, default: null}, confidence: 0.8};
  const calls = []; let round = 0;
  const typesafe = createTypesafeLive({readKey: () => ({key: 'ts-test-key', source: 'file'}), readSettings: () => settings, git: async () => '',
    fetchImpl: async (url, options) => { calls.push(JSON.parse(options.body)); return okResponse(++round === 1 ? verdict('rework', 0.93, {remaining_work: 0.9}) : verdict('accept', 0.96)); }});
  const jev = createJevDecisions({adapter: typesafe, readSettings: () => settings});
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({}), typesafe}, profiles, jev, localResolver, requireFinalReport: true, gitHead: () => null});
  t.after(() => scheduler.close());

  const row = scheduler.submit({parent: null, profile: 'analyst', orders: 'scout the repo', deadline: null});
  assert.equal(row.review.completion, 'jev', 'a task submitted to an agent is Jev-reviewed like any other root task');
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');

  // 1. The local worker's answer was synthesized into the completion, and THAT is what Jev judged.
  const completions = session.events.filter(e => e.kind === 'task.completed' && e.task === row.task);
  assert.equal(completions.length, 2);
  assert.deepEqual(completions.map(e => e.synthesized), [true, true]);
  assert.equal(completions[0].summary, 'echo: scout the repo');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].state.orders, 'scout the repo');
  assert.equal(calls[0].state.report.summary, 'echo: scout the repo', 'with no structured report, the synthesized answer is the report Jev reads');
  assert.equal(session.events.some(e => e.kind === 'task.report_requested'), false, 'no report-chasing continuation for a local worker');

  // 2. A confident rework resumed the same worker in the same opencode session, with the findings.
  assert.deepEqual(session.events.filter(e => e.kind === 'jev.verdict').map(e => [e.verdict, e.confidence]), [['rework', 0.93], ['accept', 0.96]]);
  assert.deepEqual(session.events.find(e => e.kind === 'task.rework').findings, [VERDICT_CHECKS.remaining_work.fix]);
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  const argvs = lines.filter(line => line.startsWith('ARGV ')).map(line => JSON.parse(line.slice(5)));
  const prompts = lines.filter(line => line.startsWith('PROMPT ')).map(line => JSON.parse(line.slice(7)));
  const native = session.events.find(e => e.kind === 'peer.native' && e.from === `worker:${row.task}`);
  assert.equal(argvs.length, 2);
  assert.equal(argvs[0].includes('-s'), false);
  assert.deepEqual(argvs[1].slice(-2), ['-s', native.sessionId], 'the rework is `opencode run -s <the first turn\'s session>`');
  assert.deepEqual([argvs[0][argvs[0].indexOf('--agent') + 1], argvs[1][argvs[1].indexOf('--agent') + 1]], ['analyst', 'analyst'], 'both turns ran AS the agent');
  assert.match(prompts[1], /Rework round 1:\n- /);
  assert.equal(completions[1].summary.startsWith('echo: '), true);

  // 3. Accepted by the Jev review; the key never reached the journal.
  assert.equal(session.events.at(-1).kind, 'task.accepted');
  assert.equal(session.events.at(-1).by, `review:${row.task}`);
  assert.equal(fs.readFileSync(session.file, 'utf8').includes('ts-test-key'), false);
});

// ---------------------------------------------------------------- Phase 1: Jev picks the JOB for `auto`
import {routingQuestions, decideRoute, agentHeads} from '../src/jev.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

// A roster the way the daemon builds it: plain profiles (one AI each) plus two agents' derived chains.
const agent = (name, policy, description) => ({name, description, policy, prompt: `You are the ${name}.`});
const composed = {
  main: {adapter: 'claude', model: 'opus', role: 'orchestrator', policy: 'write'},
  build: {adapter: 'codex', model: 'gpt-6-astra', role: 'builder', policy: 'write', tier: 'mid'},
  // an explicit profile that merely WEARS an agent's role is an AI, not a job
  build_claude: {adapter: 'claude', model: 'opus', role: 'builder', policy: 'write', agent: agent('builder', 'write', 'Implements.')},
  reviewer: {derived: true, adapter: 'opencode', model: 'big', role: 'reviewer', policy: 'read-only', fallback: ['reviewer~2'], agent: agent('reviewer', 'read-only', 'Reads and probes the tree for defects; never edits.')},
  'reviewer~2': {derived: true, adapter: 'claude', model: 'sonnet', role: 'reviewer', policy: 'read-only', fallback: [], agent: agent('reviewer', 'read-only', 'Reads and probes the tree for defects; never edits.')},
  builder: {derived: true, adapter: 'claude', model: 'sonnet', role: 'builder', policy: 'write', fallback: [], agent: agent('builder', 'write', 'Implements an owned module.')},
  jev: {adapter: 'typesafe', model: '', role: 'critic', policy: 'read-only'},
};

test('routing asks which JOB the orders describe — agent heads plus none — beside which AI; with no agent files there is no job question', () => {
  assert.deepEqual(agentHeads(composed).map(([name]) => name), ['reviewer', 'builder'], 'a hidden backend is an AI that may play the job, not a job');
  const questions = routingQuestions(composed);
  assert.deepEqual(Object.keys(questions), ['agent', 'tier', 'profile', 'needs_write', 'needs_shell']);
  assert.deepEqual(questions.agent.criteria, {
    reviewer: 'Reads and probes the tree for defects; never edits. · policy read-only (cannot edit files or run commands)',
    builder: 'Implements an owned module. · policy write',
    none: 'No listed job fits; a general worker should carry out the orders.'});
  assert.deepEqual(Object.keys(questions.profile.criteria), ['build', 'build_claude'], 'the AI choice is over plain profiles only');
  const {main, build, jev} = composed;
  assert.deepEqual(Object.keys(routingQuestions({main, build, jev})), ['tier', 'profile', 'needs_write', 'needs_shell']);
});

test('a confident job whose policy fits wins, and the agent\'s own models decide the AI; none, doubt or a policy misfit fall to the profile choice', () => {
  const options = {profiles: composed, confidence: 0.8, fallback: 'build'};
  const profile = {choice: 'build_claude', confidence: 0.9, probabilities: {build_claude: 0.9, build: 0.1}};
  const job = decideRoute({agent: {choice: 'reviewer', confidence: 0.92, probabilities: {reviewer: 0.92, none: 0.08}}, profile, needs_write: {noul: 0.1}, needs_shell: {noul: 0.1}}, options);
  assert.deepEqual(job, {chosen: 'reviewer', agent: 'reviewer', fallback: false, reason: null, probabilities: {reviewer: 0.92, none: 0.08}, confidence: 0.92, needs: {write: false, shell: false}});

  const none = decideRoute({agent: {choice: 'none', confidence: 0.95}, profile, needs_write: {noul: 0.9}}, options);
  assert.deepEqual([none.chosen, none.agent, none.agentReason, none.fallback], ['build_claude', null, 'no job fits', false]);
  const doubt = decideRoute({agent: {choice: 'builder', confidence: 0.55}, profile}, options);
  assert.deepEqual([doubt.chosen, doubt.agent, doubt.agentReason], ['build_claude', null, 'job confidence 0.55 below 0.8']);
  const misfit = decideRoute({agent: {choice: 'reviewer', confidence: 0.97}, profile, needs_write: {noul: 0.8}}, options);
  assert.deepEqual([misfit.chosen, misfit.agent, misfit.agentReason], ['build_claude', null, 'reviewer is read-only but the orders need write access']);
  // wanting a shell does not veto a read-only job: searching and reviewing score 0.6–0.8 on that Noul live
  const shell = decideRoute({agent: {choice: 'reviewer', confidence: 0.99}, profile, needs_write: {noul: 0.09}, needs_shell: {noul: 0.77}}, options);
  assert.deepEqual([shell.chosen, shell.agent, shell.needs], ['reviewer', 'reviewer', {write: false, shell: true}]);
  const hidden = decideRoute({agent: {choice: 'reviewer~2', confidence: 0.99}, profile}, options);
  assert.deepEqual([hidden.chosen, hidden.agentReason], ['build_claude', 'no such job']);
  // no job AND no confident profile: today's fallback, with both reasons on record
  const lost = decideRoute({agent: {choice: 'none', confidence: 0.9}, profile: {choice: 'build', confidence: 0.3}}, options);
  assert.deepEqual([lost.chosen, lost.fallback, lost.reason, lost.agentReason], ['build', true, 'confidence 0.30 below 0.8', 'no job fits']);
  // asked without the job question (no agent files): the result carries no agent field at all
  assert.equal(Object.hasOwn(decideRoute({profile}, options), 'agent'), false);
});

test('scheduler: `auto` routed to a job runs on that agent\'s chain and the journal says a job was chosen', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-jev-job-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const launched = [];
  const worker = name => ({...fakeAdapter(() => [{kind: 'result', status: 'completed', text: `done by ${name}`}]), launch: async args => { launched.push([name, args.profile.role, args.profile.agent?.name ?? null]); return fakeAdapter(() => [{kind: 'result', status: 'completed', text: `done by ${name}`}]).launch(args); }});
  const asked = [];
  const settings = {enabled: true, model: 'jev-1.13.0', review: false, routing: {enabled: true, default: null}, confidence: 0.8};
  const jev = createJevDecisions({readSettings: () => settings, adapter: {ask: async request => { asked.push(request);
    return {answers: {agent: {choice: 'reviewer', confidence: 0.91, probabilities: {reviewer: 0.91, builder: 0.04, none: 0.05}}, profile: {choice: 'build', confidence: 0.6}, needs_write: {noul: 0.05}, needs_shell: {noul: 0.1}}, model: 'jev-1.13.0', latencyMs: 12}; }}});
  const profiles = {...composed, reviewer: {...composed.reviewer, adapter: 'claude'}};
  const claude = worker('claude'), codex = worker('codex');
  const scheduler = createScheduler({session, adapters: {claude, codex}, profiles, jev, gitHead: () => null});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'auto', orders: 'Review the diff on this branch for defects. Do not change anything.', deadline: null});
  await waitFor(() => ['completed', 'accepted', 'failed'].includes(scheduler.tasks()[row.task]?.state));
  const routed = session.events.find(e => e.kind === 'jev.routed');
  assert.deepEqual([routed.chosen, routed.agent, routed.fallback, routed.confidence], ['reviewer', 'reviewer', false, 0.91]);
  assert.equal(routed.text, 'Routed auto → reviewer (job chosen by Jev, confidence 0.91)');
  assert.deepEqual(Object.keys(asked[0].questions), ['agent', 'tier', 'profile', 'needs_write', 'needs_shell'], 'one ask carries both choices');
  assert.deepEqual(launched, [['claude', 'reviewer', 'reviewer']], 'the task ran as the reviewer agent, on the first AI of ITS list');
});
