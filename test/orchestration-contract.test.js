import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createActionRunner, requestAction, actionState} from '../src/orchestration.js';
import {sameJob} from '../src/loop-guard.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

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

// Campaigns were removed (user, 2026-09-27: "following a plan should be enough"). An old journal's
// campaign rows still replay, and an orchestrator's old campaignId/gate habit is accepted, never refused.
test('an old journal with campaign rows replays, and a task carrying campaignId and gate is accepted with the fields dropped', async t => {
  const {session} = fixture(t);
  session.append({kind: 'campaign.started', campaignId: 'old', objective: 'Two steps', required: ['A'], from: 'orchestrator'});
  session.append({kind: 'campaign.paused', campaignId: 'old', from: 'user'});
  session.append({kind: 'task.submitted', task: 'legacy', campaignId: 'old', gate: 'A', profile: 'reader', orders: 'A'});
  session.append({kind: 'task.completed', task: 'legacy', summary: 'A done'});
  session.append({kind: 'task.accepted', task: 'legacy'});
  session.append({kind: 'campaign.blocked', campaignId: 'old', reason: 'exhausted', from: 'orchestrator'});
  let launches = 0;
  const adapter = {async launch() { launches++; return {}; }, async *events() { yield {kind: 'result', status: 'completed', text: 'done'}; }, async cancel() { return {verified: true}; }};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  await scheduler.reconcile();
  const done = next(session, e => e.kind === 'task.completed' && e.task === 'fresh');
  const row = scheduler.submit({task: 'fresh', profile: 'reader', orders: 'B', campaignId: 'old', gate: 'not-a-gate'});
  assert.deepEqual([row.campaignId, row.gate], [undefined, undefined]);
  await done;
  assert.equal(launches, 1, 'a paused old campaign holds nothing');
  assert.equal(scheduler.tasks().legacy.state, 'accepted');
});

// Plans were removed (decided 2026-09-29: 16 plans submitted in the last real session, all 16 accepted,
// 2 with any finding, 13 plan.drift notes nobody acted on). An old journal's plan rows still replay, and
// an orchestrator's old planId/chunkId habit on a task is accepted, never refused, with the fields dropped.
test('an old journal with plan rows replays, and a task carrying planId and chunkId is accepted with the fields dropped', async t => {
  const {session} = fixture(t);
  session.append({kind: 'plan.submitted', plan: 'old', phase: 'build', from: 'orchestrator', chunks: [{id: 'a', profile: 'reader', orders: 'A'}]});
  session.append({kind: 'plan.accepted', plan: 'old', phase: 'build', chunks: 1});
  session.append({kind: 'plan.rejected', plan: 'old', phase: 'build', chunks: 1});
  session.append({kind: 'plan.unavailable', plan: 'old', phase: 'build', chunks: 1});
  session.append({kind: 'plan.drift', task: 'legacy', planId: 'old', chunkId: 'a', reason: 'unknown plan chunk'});
  session.append({kind: 'task.submitted', task: 'legacy', planId: 'old', chunkId: 'a', profile: 'reader', orders: 'A'});
  session.append({kind: 'task.completed', task: 'legacy', summary: 'A done'});
  session.append({kind: 'task.accepted', task: 'legacy'});
  let launches = 0;
  const adapter = {async launch() { launches++; return {}; }, async *events() { yield {kind: 'result', status: 'completed', text: 'done'}; }, async cancel() { return {verified: true}; }};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  await scheduler.reconcile();
  const done = next(session, e => e.kind === 'task.completed' && e.task === 'fresh');
  const row = scheduler.submit({task: 'fresh', profile: 'reader', orders: 'B', planId: 'old', chunkId: 'not-a-chunk'});
  assert.equal(Object.hasOwn(row, 'planId'), false);
  assert.equal(Object.hasOwn(row, 'chunkId'), false);
  await done;
  assert.equal(launches, 1);
  assert.equal(scheduler.tasks().legacy.state, 'accepted');
});

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

// b (owns is a hint, not a fence, 2026-09-29): two tasks whose owns overlap on the same file, started
// from the same checkout state, are never held back from running together — only integrateArtifact's
// conflict check, unchanged, decides which one's change actually lands.
test('b: two tasks whose owns overlap on the same file: the first to finish integrates, the second gets a conflict and the checkout keeps the first\'s content', async t => {
  const {session, cwd} = fixture(t);
  fs.writeFileSync(path.join(cwd, 'x.txt'), 'old');
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
  const endedFirst = next(session, e => e.kind === 'task.completed' && e.task === 'first');
  const blockedSecond = next(session, e => e.kind === 'task.blocked' && e.task === 'second');
  scheduler.submit({task: 'first', profile: 'builder', orders: 'Edit x first', owns: ['x.txt']});
  scheduler.submit({task: 'second', profile: 'builder', orders: 'Edit x second', owns: ['x.txt']});
  await bothReady;
  fs.writeFileSync(path.join(launched.get('first').cwd, 'x.txt'), 'from first');
  fs.writeFileSync(path.join(launched.get('second').cwd, 'x.txt'), 'from second');
  launched.get('first').finish({kind: 'result', status: 'completed', text: 'done first'});
  await endedFirst;
  assert.equal(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8'), 'from first');
  launched.get('second').finish({kind: 'result', status: 'completed', text: 'done second'});
  const blocked = await blockedSecond;
  assert.equal(blocked.reason, 'integration_conflict');
  assert.equal(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8'), 'from first', 'the first task\'s content survives the refused second integration');
});

// Rewritten 2026-09-27: a review that gives no verdict no longer holds finished work. The task is accepted
// with advice saying the review gave none, and its isolated work integrates into the checkout.
// 2026-09-29: that is so for work its check verified; without one the work waits for the orchestrator.
const aIsNew = `node -e "process.exit(require('fs').readFileSync('a.txt','utf8')==='new'?0:1)"`;
test('a completion review that gives no verdict accepts work its check verified, with advice, and integrates it', async t => {
  const {session, cwd} = fixture(t);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'old');
  const worker = {async launch(args) { fs.writeFileSync(path.join(args.cwd, 'a.txt'), args.task === 'unchecked' ? 'newer' : 'new'); return {}; }, async *events() { yield {kind: 'result', status: 'completed', text: 'Changed a'}; }, async cancel() { return {verified: true}; }};
  const reviewer = fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify({verdict: 'unavailable', reason: 'network'})}]);
  const scheduler = createScheduler({session, adapters: {worker, reviewer}, profiles: {builder: {adapter: 'worker', policy: 'write'}, critic: {adapter: 'reviewer', policy: 'read-only', role: 'critic'}}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const accepted = next(session, e => e.kind === 'task.accepted');
  scheduler.submit({task: 'reviewed', profile: 'builder', orders: 'Change a', owns: ['a.txt'], check: aIsNew, review: {completion: 'critic'}});
  assert.equal((await accepted).advice, 'The review gave no verdict (network); check the work yourself before building on it.');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'new');
  assert.equal(session.events.some(e => e.kind === 'task.blocked'), false);

  const held = next(session, e => e.kind === 'task.blocked' && e.task === 'unchecked');
  scheduler.submit({task: 'unchecked', profile: 'builder', orders: 'Change a again', owns: ['a.txt'], review: {completion: 'critic'}});
  const blocked = await held;
  assert.equal(blocked.reason, 'unverified');
  assert.equal(blocked.text.includes(': the task names no check. The review gave no verdict (network); check the work yourself before building on it. The work is in '), true, blocked.text);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'new');
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

