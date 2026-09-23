// The probing reviewer (docs/plans/probing-reviewer.md). Found live: a read-only reviewer was
// told to run probes it had no tool for, reasoned through the whole tree for 60 minutes instead, and was
// killed while writing its conclusion, taking every finding with it. A `probe` worker may read and run
// commands but never change anything; a reviewer states each finding as it confirms it, and bounce keeps
// them, so a stopped review still hands its findings on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {agentMetadata, serializeAgent, loadAgents, agentStore} from '../src/agents.js';
import {validateOrchestration, effectivePolicy, POLICY_RANK} from '../src/profiles.js';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {breakdownOrders} from '../src/reload.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const root = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-probe-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; };
const waitFor = async (fn, {timeout = 2000} = {}) => { const start = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - start > timeout) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const MIN = 60000;

test('P1 probe is a policy: an agent file may declare it, it ranks between read-only and plan, and it passes the review gate', async t => {
  assert.equal(agentMetadata('---\nname: rev\ndescription: d\npolicy: probe\n---\nbody').policy, 'probe');
  assert.throws(() => agentMetadata('---\nname: rev\ndescription: d\npolicy: delete\n---\nbody'), {message: 'policy must be read-only, probe or write'});
  assert.equal(effectivePolicy({policy: 'probe', mode: 'yolo'}), 'probe');
  assert.deepEqual(['read-only', 'probe', 'plan', 'write', 'yolo'].map(p => POLICY_RANK[p]), [0, 1, 2, 3, 4]);
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  const scheduler = createScheduler({session, adapters: {A: fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}])},
    profiles: {build: {adapter: 'A', model: 'w', mode: 'yolo', fallback: []}, rev: {adapter: 'A', model: 'w', mode: 'yolo', fallback: [], policy: 'probe'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'build', orders: 'x', deadline: null, review: {completion: 'rev'}});
  await waitFor(() => session.events.find(e => e.task === row.task && (e.kind === 'task.started' || e.kind === 'task.failed')));
  assert.equal(session.events.some(e => e.task === row.task && e.kind === 'task.failed' && e.reason === 'review'), false, 'a probe reviewer is a reviewer');
});

test('P2 a probe agent probes on AIs that can enforce it (codex, local) and plays read-only on the others, never skipped', t => {
  const dir = root(t);
  fs.mkdirSync(agentStore(dir), {recursive: true});
  fs.writeFileSync(path.join(agentStore(dir), 'reviewer.md'), serializeAgent({name: 'reviewer', description: 'Reviews.', policy: 'probe',
    models: ['claude/sonnet', 'codex/gpt-5.6-terra', 'lmstudio/qwen3.8-27b-mlx@4bit'], prompt: 'Review.'}));
  const view = validateOrchestration({operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', order: ['claude', 'codex', 'muse'],
    models: {claude: 'sonnet', codex: 'gpt-5.6-terra'}, profiles: {main: {adapter: 'claude'}}}, undefined, {roles: loadAgents(dir)});
  const chain = Object.values(view.profiles).filter(p => p.role === 'reviewer');
  assert.deepEqual(chain.map(p => [p.adapter, p.policy, p.agent.policy]), [['claude', 'read-only', 'read-only'], ['codex', 'probe', 'probe'], ['opencode', 'probe', 'probe']]);
  assert.deepEqual(view.skipped, []);
});

test('P3 a reviewer\'s FINDING lines are kept as they come, and a stopped review hands them on in its deadline row', async t => {
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  let now = 0;
  const finding = {file: 'src/workspaces/operations/create.ts', line: 88, severity: 'major', title: 'lock released before the journal write'};
  const adapter = fakeAdapter(() => ({never: true, events: [
    {kind: 'assistant', text: `Reading the lock code.\nFINDING: ${JSON.stringify(finding)}\nNow the journal.`},
    {kind: 'assistant', text: `FINDING: ${JSON.stringify(finding)}`},
    {kind: 'assistant', text: 'FINDING: the CLI exits 0 on a failed create (no json)'},
  ]}));
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles: {rev: {adapter: 'A', model: 'w', mode: 'yolo', fallback: [], policy: 'probe'}},
    clock: () => now, limits: {minutes: 1, ceiling: 1}, watchdog: {interval: null, silence: 120000, stall: 600000, grace: 120000, concludeGrace: 30000}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'rev', orders: 'review P2', deadline: null});
  await waitFor(() => session.events.filter(e => e.kind === 'task.finding' && e.task === row.task).length === 2);
  const found = session.events.filter(e => e.kind === 'task.finding' && e.task === row.task);
  assert.deepEqual(found.map(e => [e.finding?.title ?? null, e.text]), [
    ['lock released before the journal write', `FINDING: ${JSON.stringify(finding)}`],
    [null, 'FINDING: the CLI exits 0 on a failed create (no json)'],
  ], 'a repeated finding is kept once; one that is not JSON is kept as text');
  now = MIN; await scheduler.tick();
  now = MIN + 30000; await scheduler.tick();
  const deadline = session.events.find(e => e.kind === 'task.deadline' && e.task === row.task);
  assert.equal(deadline.text, 'no final answer 30 s after being asked to conclude (ceiling) at 90 s. 2 findings recorded before the stop:\n'
    + '- major src/workspaces/operations/create.ts:88 lock released before the journal write\n'
    + '- the CLI exits 0 on a failed create (no json)');
});

test('P4 a conclusion still being written is waited for up to the cap; one that goes quiet is not', async t => {
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  let now = 0;
  const scheduler = createScheduler({session, adapters: {A: fakeAdapter(() => ({never: true}))}, profiles: {rev: {adapter: 'A', model: 'w', mode: 'yolo', fallback: []}},
    clock: () => now, limits: {minutes: 1, ceiling: 1}, watchdog: {interval: null, silence: 120000, stall: 600000, grace: 120000, concludeGrace: 30000, concludeCap: 120000}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'rev', orders: 'review', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');
  const beat = at => session.publish({kind: 'task.activity', task: row.task, text: 'generating · step open 30 s', from: `worker:${row.task}`, context: row.context, time: new Date(at).toISOString()});
  for (let at = 10000; at <= MIN; at += 10000) { now = at; beat(at); await scheduler.tick(); }
  assert.equal(session.events.filter(e => e.kind === 'task.concluding' && e.task === row.task).length, 1);
  for (let at = MIN + 10000; at < MIN + 120000; at += 10000) { now = at; beat(at); await scheduler.tick(); }
  assert.equal(session.events.some(e => e.kind === 'task.deadline' && e.task === row.task), false, 'still generating its answer: waited for');
  now = MIN + 120000; beat(now); await scheduler.tick();
  assert.equal(session.events.find(e => e.kind === 'task.deadline' && e.task === row.task).text, 'no final answer 120 s after being asked to conclude (ceiling) at 180 s');
});

test('P5 the orders split a heavy review by risk area', () => {
  const text = breakdownOrders(15, {ceiling: 60}).join('\n');
  assert.equal(text.includes('A review of a whole phase, or of more than one risk area, is heavy: split it into one reviewer per area (for example locking and journaling, ownership, the CLI), each with the verification commands for its area. Reviewers probe: they run commands but cannot change the tree.'), true);
});

// Found live: the reviewer hit its step cap, its notice did not parse as a verdict, and the
// task sat `blocked` — waiting for a person. An unusable review ends the task with its reason instead, so
// the orchestrator is woken by an outcome and decides what to do.
test('P6 a review with no readable verdict fails the task, it does not block it', async t => {
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'built it'}]);
  const reviewer = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'CRITICAL - MAXIMUM STEPS REACHED\nTools are disabled until next user input.'}]);
  const scheduler = createScheduler({session, adapters: {W: worker, R: reviewer}, watchdog: {interval: null},
    profiles: {b: {adapter: 'W', model: 'w', mode: 'yolo', fallback: []}, rev: {adapter: 'R', model: 'r', mode: 'yolo', fallback: [], policy: 'probe', role: 'reviewer'}}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'build', deadline: null, review: {completion: 'rev'}});
  const failed = await waitFor(() => session.events.find(e => e.kind === 'task.failed' && e.task === row.task));
  assert.deepEqual([failed.reason, failed.text], ['review_unreadable', 'the reviewer returned no readable verdict']);
  assert.equal(session.events.some(e => e.kind === 'task.blocked' && e.task === row.task), false, 'never a dead end that waits for a person');
});

// The seam the answer-contract plan left open: a reviewer that answers in prose instead of the verdict
// line is asked once more, with the note on record, before the review is failed. Never twice.
test('P7 an unreadable verdict is re-asked exactly once, with the note in the reviewer\'s orders', async t => {
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  const seen = [];
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'built it'}]);
  let answers = ['it looks fine to me, no JSON here', '{"verdict": "accept"}'];
  const reviewer = fakeAdapter(({orders}) => { seen.push(orders); return [{kind: 'result', status: 'completed', text: answers.shift() ?? 'still prose'}]; });
  const scheduler = createScheduler({session, adapters: {W: worker, R: reviewer}, watchdog: {interval: null},
    profiles: {b: {adapter: 'W', model: 'w', mode: 'yolo', fallback: []}, rev: {adapter: 'R', model: 'r', mode: 'yolo', fallback: [], policy: 'probe', role: 'reviewer'}}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'build', deadline: null, review: {completion: 'rev'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');
  const asked = session.events.filter(e => e.kind === 'review.reasked' && e.task === row.task);
  assert.deepEqual(asked.map(e => e.text), ['Your last answer carried no readable verdict. Answer again with the verdict line only, as JSON.']);
  assert.equal(seen.length, 2, 'the reviewer ran twice: the first answer, then the re-ask');
  assert.match(seen[1], /Answer again with the verdict line only, as JSON\.$/);
  assert.equal(session.events.some(e => e.kind === 'task.failed' && e.task === row.task), false, 'the second answer was readable: accepted');
});

test('P8 a reviewer that is unreadable twice fails the task, never a third ask', async t => {
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  let runs = 0;
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'built it'}]);
  const reviewer = fakeAdapter(() => { runs++; return [{kind: 'result', status: 'completed', text: 'prose, always prose'}]; });
  const scheduler = createScheduler({session, adapters: {W: worker, R: reviewer}, watchdog: {interval: null},
    profiles: {b: {adapter: 'W', model: 'w', mode: 'yolo', fallback: []}, rev: {adapter: 'R', model: 'r', mode: 'yolo', fallback: [], policy: 'probe', role: 'reviewer'}}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'build', deadline: null, review: {completion: 'rev'}});
  const failed = await waitFor(() => session.events.find(e => e.kind === 'task.failed' && e.task === row.task));
  assert.equal(failed.reason, 'review_unreadable');
  assert.equal(runs, 2, 'asked once more, then done');
  assert.equal(session.events.filter(e => e.kind === 'review.reasked' && e.task === row.task).length, 1);
});
