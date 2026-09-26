import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {campaignCommand, campaigns, createActionRunner, requestAction, actionState} from '../src/orchestration.js';
import {sameJob} from '../src/loop-guard.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {judgePlan} from '../src/jev.js';

test('an enabled plan review failure never synthesizes plan acceptance', async () => {
  const plan = {chunks: [{id: 'one', orders: 'Edit one owned file; verify with its focused test', owns: ['src/a']}]};
  const verdict = await judgePlan({plan, settings: {enabled: true}, ask: async () => { throw new Error('unavailable'); }});
  assert.equal(verdict.verdict, 'unavailable');
  assert.equal((await judgePlan({plan, settings: {enabled: false}})).verdict, 'accept');
});

test('a pending worker launch reaches a bounded startup blocker', async t => {
  const {session} = fixture(t);
  let now = 0, release;
  const adapter = {launch: () => new Promise(resolve => { release = resolve; }), async *events() {}, async cancel() { return {verified: true}; }};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, clock: () => now, watchdog: {interval: null, startupMs: 1000}});
  t.after(() => scheduler.close());
  scheduler.submit({task: 'starting', profile: 'reader', orders: 'Inspect'});
  now = 1001; await scheduler.tick();
  assert.equal(scheduler.tasks().starting.state, 'blocked');
  assert.ok(session.events.some(e => e.kind === 'policy.escalated' && e.reason === 'startup_timeout'));
  release({}); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduler.tasks().starting.state, 'cancelled');
});

test('campaign pause holds a dependent until an explicit user resume', async t => {
  const {session} = fixture(t);
  let finish, launches = 0;
  const adapter = {async launch() { return {number: ++launches}; }, async *events(handle) { if (handle.number === 1) yield await new Promise(resolve => { finish = resolve; }); else yield {kind: 'result', status: 'completed', text: 'done'}; }, async cancel() { return {verified: true}; }};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  campaignCommand(session, {kind: 'campaign.start', from: 'user', campaignId: 'scope', objective: 'Two steps', required: ['A', 'B']});
  scheduler.submit({task: 'a', profile: 'reader', orders: 'A', gate: 'A'});
  scheduler.submit({task: 'b', profile: 'reader', orders: 'B', gate: 'B', depends_on: ['a']});
  await new Promise(resolve => setImmediate(resolve));
  campaignCommand(session, {kind: 'campaign.pause', from: 'user', campaignId: 'scope'});
  finish({kind: 'result', status: 'completed', text: 'done'});
  await new Promise(resolve => setImmediate(resolve));
  session.append({kind: 'task.accepted', task: 'a'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 1, 'paused campaigns must not admit the dependent');
  campaignCommand(session, {kind: 'campaign.resume', from: 'user', campaignId: 'scope'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(launches, 2);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-control-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const session = new Session(cwd, {root});
  t.after(async () => { await new Promise(resolve => setImmediate(resolve)); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, cwd, session};
}
function next(session, predicate) {
  return new Promise(resolve => {
    const off = session.subscribe(row => { if (predicate(row)) { off(); resolve(row); } });
  });
}

test('submission commits its dispatch obligation before returning to the caller', async t => {
  const {session} = fixture(t);
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}])}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const settled = next(session, e => e.kind === 'orchestration.action.settled' && e.task === 't');
  scheduler.submit({task: 't', profile: 'reader', orders: 'Inspect'});
  const requested = [...actionState(session.events).values()].filter(action => action.task === 't' && action.type === 'dispatch');
  assert.equal(requested.length, 1);
  const physical = fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(physical.some(row => row.kind === 'journal.commit' && row.events.some(e => e.kind === 'task.submitted') && row.events.some(e => e.kind === 'orchestration.action.requested')), true);
  await settled;
});

test('replay starts a requested action once and blocks an uncertain started action', async t => {
  const {session} = fixture(t);
  requestAction(session, {actionId: 'safe', type: 'launch'});
  requestAction(session, {actionId: 'uncertain', type: 'launch'});
  session.append({kind: 'orchestration.action.started', actionId: 'uncertain', type: 'launch'});
  const called = [];
  const runner = createActionRunner({session, handlers: {launch: async action => { called.push(action.actionId); }}});
  t.after(() => runner.close());
  const settled = next(session, e => e.kind === 'orchestration.action.settled' && e.actionId === 'safe');
  runner.reconcile(); runner.reconcile();
  await settled;
  assert.deepEqual(called, ['safe']);
  assert.equal(actionState(session.events).get('uncertain').reason, 'execution_uncertain');
  assert.equal(session.events.filter(e => e.kind === 'orchestration.action.blocked' && e.actionId === 'uncertain').length, 1);
});

test('replay recovers a terminal failure whose fallback subscriber never ran', async t => {
  const {session} = fixture(t);
  session.append({kind: 'task.submitted', task: 'lost', jobId: 'logical', profile: 'first', orders: 'inspect', owns: ['src/a'], budget: {starts: 2}});
  session.append({kind: 'task.failed', task: 'lost', reason: 'limited'});
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'recovered'}]);
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {first: {adapter: 'fake', policy: 'read-only', fallback: ['second']}, second: {adapter: 'fake', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  await scheduler.reconcile();
  const replacement = session.events.find(e => e.kind === 'task.submitted' && e.replaces === 'lost');
  assert.ok(replacement, 'durable reconciliation must recover the omitted fallback');
  assert.equal(replacement.jobId, 'logical');
  assert.deepEqual(replacement.owns, ['src/a']);
  await scheduler.reconcile();
  assert.equal(session.events.filter(e => e.kind === 'task.submitted' && e.replaces === 'lost').length, 1);
});

test('campaign cannot close remaining scope and only user may remove a required gate', t => {
  const {session} = fixture(t);
  campaignCommand(session, {kind: 'campaign.start', from: 'orchestrator', campaignId: 'ace', objective: 'Implement all phases', required: ['lock', 'P3']});
  session.append({kind: 'task.submitted', task: 'lock', campaignId: 'ace', gate: 'lock', profile: 'builder'});
  session.append({kind: 'task.completed', task: 'lock'});
  assert.deepEqual(campaigns(session.events).ace.remaining, ['P3']);
  assert.throws(() => campaignCommand(session, {kind: 'campaign.complete', from: 'orchestrator', campaignId: 'ace'}), /gates unmet: P3/);
  assert.throws(() => campaignCommand(session, {kind: 'campaign.scope', from: 'orchestrator', campaignId: 'ace', required: ['lock']}), /only the user/);
  session.append({kind: 'task.submitted', task: 'p3', campaignId: 'ace', gate: 'P3', profile: 'builder', review: {completion: 'critic'}});
  session.append({kind: 'task.completed', task: 'p3'});
  assert.deepEqual(campaigns(session.events).ace.remaining, ['P3']);
  session.append({kind: 'task.accepted', task: 'p3'});
  campaignCommand(session, {kind: 'campaign.complete', from: 'orchestrator', campaignId: 'ace'});
  assert.equal(campaigns(session.events).ace.state, 'completed');
});

test('logical retry preserves job budget identity across changed instructions, inherits owns by default but a retry may widen it', async t => {
  const {session} = fixture(t);
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => [{kind: 'result', status: 'failed', text: 'needs repair'}])}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const ended = next(session, e => e.kind === 'task.failed' && e.task === 'first');
  const first = scheduler.submit({task: 'first', profile: 'reader', orders: 'Review', owns: ['src/a.js'], budget: {starts: 2}});
  await ended;
  const retryEnded = next(session, e => e.kind === 'orchestration.action.settled' && e.task === 'retry');
  // Found live (ACE session 159f4746, task d59ce7f5): a green fix stayed blocked on a two-line
  // change outside `owns`, and a retryOf could not widen `owns` to recover — prepare() always
  // forced the original's. A retry's own declared `owns` now replaces the inherited list;
  // omitting it (as most retries do) still inherits, same as before.
  const retried = scheduler.submit({task: 'retry', profile: 'reader', retryOf: 'first', orders: 'Review the remaining work', owns: ['**']});
  assert.equal(retried.jobId, first.jobId);
  assert.equal(retried.replaces, 'first');
  assert.equal(retried.parent, null);
  assert.deepEqual(retried.owns, ['**'], 'the retry\'s own owns replaces the original, narrower list');
  assert.equal(sameJob(first, retried), true);
  await retryEnded;
  const implicit = scheduler.submit({task: 'retry2', profile: 'reader', retryOf: 'retry', orders: 'Review once more'});
  assert.deepEqual(implicit.owns, ['**'], 'no owns declared on the retry: the predecessor\'s still applies');
});

test('two writing attempts work in isolated copies and integrate both owned outputs', async t => {
  const {session, cwd} = fixture(t);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'old A'); fs.writeFileSync(path.join(cwd, 'b.txt'), 'old B');
  const launched = new Map();
  let ready;
  const bothReady = new Promise(resolve => { ready = resolve; });
  const adapter = {
    async launch(args) { const handle = {task: args.task, cwd: args.cwd}; launched.set(args.task, handle); return handle; },
    async *events(handle) { yield await new Promise(resolve => { handle.finish = resolve; if ([...launched.values()].filter(h => h.finish).length === 2) ready(); }); },
    async cancel() { return {verified: true}; },
  };
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {builder: {adapter: 'fake', policy: 'write'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const endedA = next(session, e => e.kind === 'task.completed' && e.task === 'a');
  const endedB = next(session, e => e.kind === 'task.completed' && e.task === 'b');
  const drainedB = next(session, e => e.kind === 'orchestration.action.settled' && e.actionId === 'completion:b:1');
  scheduler.submit({task: 'a', profile: 'builder', orders: 'Edit a', owns: ['a.txt']});
  scheduler.submit({task: 'b', profile: 'builder', orders: 'Edit b', owns: ['b.txt']});
  await bothReady;
  assert.notEqual(launched.get('a').cwd, cwd); assert.notEqual(launched.get('b').cwd, launched.get('a').cwd);
  fs.writeFileSync(path.join(launched.get('a').cwd, 'a.txt'), 'new A');
  fs.writeFileSync(path.join(launched.get('b').cwd, 'b.txt'), 'new B');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'old A');
  launched.get('a').finish({kind: 'result', status: 'completed', text: 'done a'});
  await endedA;
  launched.get('b').finish({kind: 'result', status: 'completed', text: 'done b'});
  await endedB;
  assert.deepEqual(['a.txt', 'b.txt'].map(file => fs.readFileSync(path.join(cwd, file), 'utf8')), ['new A', 'new B']);
  assert.equal(session.events.filter(e => e.kind === 'task.integrated').length, 2);
  await drainedB;
});

test('required review unavailable retains the isolated artifact and leaves source unchanged', async t => {
  const {session, cwd} = fixture(t);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'old');
  const worker = {async launch(args) { fs.writeFileSync(path.join(args.cwd, 'a.txt'), 'new'); return {}; }, async *events() { yield {kind: 'result', status: 'completed', text: 'Changed a'}; }, async cancel() { return {verified: true}; }};
  const reviewer = fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify({verdict: 'unavailable', reason: 'network'})}]);
  const scheduler = createScheduler({session, adapters: {worker, reviewer}, profiles: {builder: {adapter: 'worker', policy: 'write'}, critic: {adapter: 'reviewer', policy: 'read-only', role: 'critic'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const blocked = next(session, e => e.kind === 'task.blocked');
  scheduler.submit({task: 'reviewed', profile: 'builder', orders: 'Change a', owns: ['a.txt'], review: {completion: 'critic'}});
  assert.equal((await blocked).text, 'Required review unavailable: network');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'old');
  assert.equal(session.events.filter(e => e.kind === 'task.accepted').length, 0);
  assert.equal(session.events.filter(e => e.kind === 'task.artifact').length, 1);
});

test('a reviewer with an accepting result cannot release work before verified termination', async t => {
  const {session} = fixture(t);
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const reviewer = fakeAdapter(() => ({events: [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}], cancel: {verified: false}}));
  const scheduler = createScheduler({session, adapters: {worker, reviewer}, profiles: {builder: {adapter: 'worker', policy: 'read-only'}, critic: {adapter: 'reviewer', policy: 'read-only', role: 'critic'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const outcome = next(session, e => ['task.accepted', 'task.blocked'].includes(e.kind));
  scheduler.submit({task: 'reviewed', profile: 'builder', orders: 'Inspect', review: {completion: 'critic'}});
  assert.equal((await outcome).kind, 'task.blocked');
  assert.equal(session.events.some(e => e.kind === 'task.accepted'), false);
  assert.equal((await scheduler.cancel('reviewed')).verified, false);
});

test('a paused campaign holds completion review until resumed', async t => {
  const {session} = fixture(t);
  let finish, reviews = 0;
  const worker = {async launch() { return {}; }, async *events() { yield await new Promise(resolve => { finish = resolve; }); }, async cancel() { return {verified: true}; }};
  const reviewer = {async launch() { reviews++; return {}; }, async *events() { yield {kind: 'result', status: 'completed', text: JSON.stringify({verdict: 'accept', findings: []})}; }, async cancel() { return {verified: true}; }};
  const scheduler = createScheduler({session, adapters: {worker, reviewer}, profiles: {worker: {adapter: 'worker', policy: 'read-only'}, critic: {adapter: 'reviewer', policy: 'read-only', role: 'critic'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  campaignCommand(session, {kind: 'campaign.start', from: 'user', campaignId: 'scope', objective: 'Reviewed result', required: ['A']});
  scheduler.submit({task: 'a', profile: 'worker', orders: 'A', gate: 'A', review: {completion: 'critic'}});
  await new Promise(resolve => setImmediate(resolve));
  campaignCommand(session, {kind: 'campaign.pause', from: 'user', campaignId: 'scope'});
  finish({kind: 'result', status: 'completed', text: 'done'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reviews, 0);
  campaignCommand(session, {kind: 'campaign.resume', from: 'user', campaignId: 'scope'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reviews, 1);
});

test('a hung plan classifier becomes unavailable and ignores its late acceptance', {timeout: 1000}, async t => {
  const {session} = fixture(t);
  let finish;
  const scheduler = createScheduler({session, adapters: {}, profiles: {}, jev: {plan: () => new Promise(resolve => { finish = resolve; })}, watchdog: {interval: null, startupMs: 10}});
  t.after(() => scheduler.close());
  session.append({kind: 'plan.submitted', plan: 'hung', phase: 'phase', chunks: []});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(session.events.findLast(e => e.plan === 'hung' && e.kind === 'plan.unavailable')?.reason, 'startup_timeout');
  finish({verdict: 'accept'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.events.some(e => e.kind === 'plan.accepted'), false);
});

test('planned task admission rejects invented chunks and widened ownership', async t => {
  const {session} = fixture(t);
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => [])}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, jev: {plan: async () => ({verdict: 'accept'})}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  session.append({kind: 'plan.submitted', plan: 'accepted', chunks: [{id: 'inspect', profile: 'reader', orders: 'Inspect', owns: ['src/a.js']}]});
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => scheduler.submit({profile: 'reader', orders: 'Inspect', planId: 'accepted', chunkId: 'invented'}), /unknown plan chunk/);
  assert.throws(() => scheduler.submit({profile: 'reader', orders: 'Inspect', planId: 'accepted', chunkId: 'inspect', owns: ['**']}), /owns mismatch/);
  const task = scheduler.submit({profile: 'reader', orders: 'Inspect', planId: 'accepted', chunkId: 'inspect', owns: ['src/a.js']});
  assert.equal(task.jobId, 'plan:accepted:inspect');
});
