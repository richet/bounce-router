// Task leases (docs/plans/task-leases.md). Found live: every reviewer on the
// local 27B was killed by its deadline while still working — its last step 11 to 84 s before the
// kill — and the orchestrator answered each kill by shrinking the next deadline. A deadline is now a
// lease: renewed while the worker makes progress, up to a ceiling; a worker that stops making
// progress, repeats itself or reaches the ceiling is asked for its conclusion before it is killed.
// Jev may judge a lease, but nothing here depends on it: every rule holds with Jev absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler as createSchedulerImpl} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {workerThread} from '../src/format.js';
import {attemptLease} from '../src/reducers.js';

const schedulers = new WeakMap();
const createScheduler = options => {
  const scheduler = createSchedulerImpl(options);
  schedulers.get(options.session)?.add(scheduler);
  return scheduler;
};
const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-lease-'));
  const session = new Session(root, {root});
  const owned = new Set(); schedulers.set(session, owned);
  t.after(async () => {
    for (const scheduler of owned) scheduler.close();
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  });
  return session;
};
const waitFor = async (fn, {timeout = 2000} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const MIN = 60000;
const watchdog = {interval: null, silence: 120000, stall: 600000, grace: 120000, concludeGrace: 30000};
const profiles = {A: {adapter: 'A', model: 'w', mode: 'yolo', fallback: []}};

test('a replacement review keeps its renewable lease but cannot outlive the logical job ceiling', () => {
  const at = minutes => new Date(minutes * MIN).toISOString();
  const events = [
    {kind: 'task.submitted', task: 'original', jobId: 'job:1', deadline: MIN, time: at(0), seq: 1},
    {kind: 'task.started', task: 'original', jobId: 'job:1', time: at(0), seq: 2},
    {kind: 'task.submitted', task: 'retry', jobId: 'job:1', replaces: 'original', deadline: MIN, time: at(1), seq: 3},
    {kind: 'task.started', task: 'retry', jobId: 'job:1', time: at(1), seq: 4},
    {kind: 'review.started', task: 'retry', time: at(2), seq: 5},
    {kind: 'task.lease.renewed', task: 'retry', stage: 'review', time: at(3), seq: 6},
  ];
  const lease = attemptLease(events, 'retry', {defaultDeadlineMs: MIN, ceilingMs: 3 * MIN, stage: 'review'});
  assert.deepEqual(lease, {
    stage: 'review', startedAt: 0, leaseFrom: 2 * MIN, leaseMs: MIN, renewals: 1,
    ceilingAt: 3 * MIN, leaseStartAt: 3 * MIN, deadlineAt: 3 * MIN,
  });
});

// A clock the test drives, a never-ending worker, and a helper that advances time while the worker
// shows activity (optionally naming the tool call it made, as the OpenCode adapter does).
function harness(t, {limits = {minutes: 1, ceiling: 5}, jev = null, adapter = fakeAdapter(() => ({never: true}))} = {}) {
  const session = setup(t);
  let now = 0;
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock: () => now, limits, watchdog, jev});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'review the P2 tree', deadline: null});
  const rows = kind => session.events.filter(e => e.kind === kind && e.task === row.task);
  const act = (at, extra = {}) => session.publish({kind: 'task.activity', task: row.task, text: 'working', from: `worker:${row.task}`, context: row.context, time: new Date(at).toISOString(), ...extra});
  const run = async (from, to, {every = 10000, call = null} = {}) => {
    for (let at = from; at <= to; at += every) { now = at; act(at, call ? {call: call(at), change: false} : {}); await scheduler.tick(); }
  };
  const at = async ms => { now = ms; await scheduler.tick(); };
  return {session, scheduler, row, rows, run, at, adapter, act, setNow: ms => { now = ms; }};
}

test('L1 a worker still making progress when its lease runs out is renewed, not cancelled — the reviewer that was killed at 15 min', async t => {
  const h = harness(t);
  await waitFor(() => h.scheduler.tasks()[h.row.task]?.state === 'running');
  await h.run(10000, 150000);
  assert.deepEqual(h.rows('task.lease.renewed').map(e => [e.lease, e.until]), [[1, 2 * MIN], [2, 3 * MIN]]);
  assert.equal(h.rows('task.lease.renewed')[0].evidence.sinceProgress, 0);
  assert.equal(h.rows('task.lease.renewed')[0].jev, null);
  assert.deepEqual([h.rows('task.deadline').length, h.rows('task.concluding').length, h.adapter.calls.cancel], [0, 0, 0]);
  assert.equal(h.scheduler.tasks()[h.row.task].state, 'running');
});

test('L2 a lease with no progress in it is not renewed: the worker is asked for its conclusion, then killed after the grace with an escalation that does not say "smaller"', async t => {
  const h = harness(t);
  await waitFor(() => h.scheduler.tasks()[h.row.task]?.state === 'running');
  await h.at(59000);
  assert.equal(h.rows('task.concluding').length, 0);
  await h.at(MIN);
  assert.deepEqual(h.rows('task.concluding').map(e => e.reason), ['no_progress']);
  assert.equal(h.rows('task.lease.renewed').length, 0);
  // an adapter with no conclude() gets the request as a message on its ordinary delivery path
  const asked = await waitFor(() => h.session.events.find(e => e.kind === 'message' && e.to === `worker:${h.row.task}` && e.from === 'bounce'));
  assert.equal(asked.text, 'Stop using tools and give your final answer now, in full, as the orders asked (no progress in the last lease). Say what is unfinished.');
  await h.at(MIN + 29000);
  assert.equal(h.rows('task.deadline').length, 0, 'the grace is still running');
  await h.at(MIN + 30000);
  const kinds = h.session.events.filter(e => e.task === h.row.task).map(e => e.kind);
  assert.equal(kinds.indexOf('task.deadline') < kinds.indexOf('task.cancelled'), true);
  assert.equal(h.rows('task.cancelled')[0].reason, 'deadline');
  assert.equal(h.scheduler.tasks()[h.row.task].state, 'timed_out');
  const escalated = h.rows('policy.escalated').find(e => e.reason === 'deadline');
  assert.equal(escalated.text, 'A made no progress in its last 1 min lease and gave no final answer within 30 s of being asked. Its partial progress is in the journal: resubmit what is left with that progress in the orders, or drop it.');
  assert.equal(h.adapter.calls.cancel, 1);
});

test('L3 at the ceiling a progressing worker is asked to conclude through the adapter, and its answer completes the task', async t => {
  const adapter = fakeAdapter(() => ({never: true}));
  const prompts = [];
  adapter.conclude = async (handle, {prompt}) => { prompts.push(prompt); handle.after = [{kind: 'result', status: 'completed', text: 'verdict: accept, no blockers'}]; handle.ended = true; handle.waiters.splice(0).forEach(resolve => resolve()); };
  const h = harness(t, {adapter});
  await waitFor(() => h.scheduler.tasks()[h.row.task]?.state === 'running');
  await h.run(10000, 5 * MIN);
  assert.deepEqual(h.rows('task.lease.renewed').map(e => e.lease), [1, 2, 3, 4]);
  assert.deepEqual(h.rows('task.concluding').map(e => e.reason), ['ceiling']);
  assert.deepEqual(prompts, ['Stop using tools and give your final answer now, in full, as the orders asked (the 5 min ceiling). Say what is unfinished.']);
  await waitFor(() => h.scheduler.tasks()[h.row.task]?.state === 'completed');
  assert.equal(h.rows('task.completed')[0].summary, 'verdict: accept, no blockers');
  // one cancel is the scheduler proving the finished process exited, as after every result; no task.cancelled
  assert.deepEqual([h.rows('task.deadline').length, h.rows('task.cancelled').length, adapter.calls.cancel], [0, 0, 1]);
});

test('L4 without Jev, a lease whose every tool call repeats an earlier one is stuck and concludes; one new call renews it', async t => {
  const files = ['a.ts', 'b.ts', 'c.ts'];
  const stuck = harness(t);
  await waitFor(() => stuck.scheduler.tasks()[stuck.row.task]?.state === 'running');
  await stuck.run(10000, MIN, {call: at => `read ${files[(at / 10000) % 2]}`});
  assert.equal(stuck.rows('task.lease.renewed').length, 1, 'the first lease has nothing earlier to repeat');
  await stuck.run(MIN + 10000, 2 * MIN, {call: at => `read ${files[(at / 10000) % 2]}`});
  assert.deepEqual(stuck.rows('task.concluding').map(e => e.reason), ['stuck']);
  assert.equal(stuck.rows('task.lease.renewed').length, 1);

  const fresh = harness(t);
  await waitFor(() => fresh.scheduler.tasks()[fresh.row.task]?.state === 'running');
  await fresh.run(10000, MIN, {call: at => `read ${files[(at / 10000) % 2]}`});
  await fresh.run(MIN + 10000, 2 * MIN, {call: at => at === 90000 ? 'read c.ts' : `read ${files[(at / 10000) % 2]}`});
  assert.equal(fresh.rows('task.lease.renewed').length, 2);
  assert.equal(fresh.rows('task.concluding').length, 0);
});

test('L5 Jev, when present, judges the lease: stuck concludes, drifting renews and tells the submitter, a failure falls back to the progress rule', async t => {
  let answer = {verdict: 'stuck', confidence: 0.9, reason: null, model: 'jev-1.13.0'};
  const asked = [];
  const jev = {lease: async request => { asked.push(request); if (answer instanceof Error) throw answer; return answer; }};

  const stuck = harness(t, {jev});
  await waitFor(() => stuck.scheduler.tasks()[stuck.row.task]?.state === 'running');
  await stuck.run(10000, MIN, {call: at => `read f${at}.ts`});
  assert.deepEqual(stuck.rows('jev.lease').map(e => [e.verdict, e.confidence]), [['stuck', 0.9]]);
  assert.deepEqual(stuck.rows('task.concluding').map(e => e.reason), ['stuck']);
  assert.equal(asked[0].orders, 'review the P2 tree');
  assert.equal(asked[0].calls.at(-1), `read f${MIN}.ts`);
  assert.equal(asked[0].lease, 1);

  answer = {verdict: 'drifting', confidence: 0.85, reason: null, model: 'jev-1.13.0'};
  const drifting = harness(t, {jev});
  await waitFor(() => drifting.scheduler.tasks()[drifting.row.task]?.state === 'running');
  await drifting.run(10000, MIN);
  assert.deepEqual(drifting.rows('task.lease.renewed').map(e => e.jev), [{verdict: 'drifting', confidence: 0.85}]);
  const drift = drifting.rows('policy.escalated').find(e => e.reason === 'drifting');
  assert.deepEqual([drift.to, drift.text], ['user', 'Jev judged A to be drifting from its orders (0.85) at its lease renewal; it keeps running. Steer it with a message, cancel it, or let it run.']);

  answer = Object.assign(new Error('TypeSafe request timed out'), {code: 'timeout'});
  const broken = harness(t, {jev});
  await waitFor(() => broken.scheduler.tasks()[broken.row.task]?.state === 'running');
  await broken.run(10000, MIN);
  assert.deepEqual(broken.rows('jev.lease').map(e => [e.verdict, e.reason]), [[null, 'timeout']]);
  assert.equal(broken.rows('task.lease.renewed').length, 1);
});

test('L6 one Jev call per lease end even when ticks overlap while it is in flight', async t => {
  const gate = Promise.withResolvers();
  let calls = 0;
  const jev = {lease: async () => { calls++; await gate.promise; return {verdict: 'on_track', confidence: 0.9, reason: null, model: 'jev'}; }};
  const h = harness(t, {jev});
  await waitFor(() => h.scheduler.tasks()[h.row.task]?.state === 'running');
  await h.run(10000, 50000);
  h.setNow(MIN); h.act(MIN);
  const first = h.scheduler.tick();
  const second = h.scheduler.tick();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(h.rows('task.lease.renewed').length, 1);
});

test('L7 the ceiling is the only size limit: 45 minutes runs under a 15-minute lease, 61 is refused before launch', async t => {
  const session = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, limits: {minutes: 15, ceiling: 60}, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const long = scheduler.submit({parent: null, profile: 'A', orders: 'long review', deadline: 45 * MIN});
  await waitFor(() => scheduler.tasks()[long.task]?.state === 'completed');
  const tooLong = scheduler.submit({parent: null, profile: 'A', orders: 'too long', deadline: 61 * MIN});
  const refused = await waitFor(() => session.events.find(e => e.kind === 'task.failed' && e.task === tooLong.task));
  assert.deepEqual([refused.reason, refused.text], ['size', 'a 61-minute task exceeds the 60-minute ceiling: give it at most 60 minutes; bounce renews its lease while it makes progress']);
  assert.equal(adapter.calls.launch, 1);
});

test('L8 the worker pane shows a renewal and a conclusion request', () => {
  const events = [
    {kind: 'task.submitted', task: 't', profile: 'reviewer', orders: 'review', time: '2026-09-22T09:00:00.000Z'},
    {kind: 'task.lease.renewed', task: 't', lease: 1, jev: null, time: '2026-09-22T09:15:00.000Z'},
    {kind: 'task.lease.renewed', task: 't', lease: 2, jev: {verdict: 'on_track', confidence: 0.9}, time: '2026-09-22T09:30:00.000Z'},
    {kind: 'task.concluding', task: 't', reason: 'no_progress', time: '2026-09-22T09:45:00.000Z'},
  ];
  assert.deepEqual(workerThread(events, 't').slice(1).map(row => row.text), ['lease 1 renewed', 'lease 2 renewed · Jev: on_track', 'asked for its conclusion · no progress']);
});

// A completion review is a worker turn too (found live: a 24-minute review nothing was
// watching, which then hit OpenCode's step cap and returned its notice instead of a verdict). It gets
// its own lease, measured from `review.started`, on the same rules.
test('L9 a review is leased like a turn: renewed while it works, asked to conclude at the ceiling', async t => {
  const session = setup(t);
  let now = 0;
  const prompts = [];
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'built it'}]);
  const reviewer = fakeAdapter(() => ({never: true}));
  reviewer.conclude = async (handle, {prompt}) => { prompts.push(prompt); handle.after = [{kind: 'result', status: 'completed', text: 'ACCEPT: it holds'}]; handle.ended = true; handle.waiters.splice(0).forEach(r => r()); };
  const scheduler = createScheduler({session, adapters: {W: worker, R: reviewer}, clock: () => now, limits: {minutes: 1, ceiling: 3}, watchdog,
    profiles: {b: {adapter: 'W', model: 'w', mode: 'yolo', fallback: []}, rev: {adapter: 'R', model: 'r', mode: 'yolo', fallback: [], policy: 'read-only', role: 'reviewer'}}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'build', deadline: null, review: {completion: 'rev'}});
  await waitFor(() => session.events.some(e => e.kind === 'review.started' && e.task === row.task));
  const beat = at => session.publish({kind: 'task.activity', task: row.task, text: 'reading the diff', from: `review:${row.task}`, context: row.context, time: new Date(at).toISOString()});
  for (let at = 10000; at <= 2 * MIN; at += 10000) { now = at; beat(at); await scheduler.tick(); }
  const renewed = session.events.filter(e => e.kind === 'task.lease.renewed' && e.task === row.task);
  assert.deepEqual(renewed.map(e => [e.stage, e.lease]), [['review', 1], ['review', 2]], 'the review has its own lease, from review.started');
  for (let at = 2 * MIN + 10000; at <= 3 * MIN; at += 10000) { now = at; beat(at); await scheduler.tick(); }
  assert.deepEqual(session.events.filter(e => e.kind === 'task.concluding' && e.task === row.task).map(e => [e.stage, e.reason]), [['review', 'ceiling']]);
  assert.equal(prompts.length, 1, 'the reviewer itself was asked, not the worker');
});

// L10: a blocked task holds no slot, so it is never killed by its lease/ceiling — it stays blocked
// until answered or cancelled. Found live (session 159f4746, 4 tasks): the previous lease measured
// from the moment a task parked discarded a blocked worker's resumable context after 60 minutes
// nobody was watching, even though the block itself was the reason no slot was being spent.
test('L10 a blocked task is never killed by the watchdog, however long nobody answers it', async t => {
  const session = setup(t);
  let now = 0;
  const adapter = fakeAdapter(() => [{kind: 'blocked', text: 'needs owner authorisation'}, {kind: 'result', status: 'completed', text: 'parked'}]);
  const scheduler = createScheduler({session, adapters: {A: adapter}, clock: () => now, limits: {minutes: 1, ceiling: 3}, watchdog,
    profiles: {b: {adapter: 'A', model: 'w', mode: 'yolo', fallback: []}}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'b', orders: 'ask', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');
  const parkedAt = now;

  now = parkedAt + 2 * MIN; await scheduler.tick();
  assert.equal(scheduler.tasks()[row.task].state, 'blocked', 'inside its lease it is simply waiting');
  assert.equal(session.events.some(e => e.kind === 'task.deadline' && e.task === row.task), false);

  // Well past where the old lease (measured from the moment it parked) would have expired it.
  now = parkedAt + 10 * MIN; await scheduler.tick();
  assert.equal(scheduler.tasks()[row.task].state, 'blocked', 'still simply waiting, no lease to outlive');
  assert.equal(session.events.some(e => e.kind === 'task.deadline' && e.task === row.task), false,
    'a blocked task is never given a task.deadline row by the watchdog');
  assert.equal(session.events.some(e => e.kind === 'task.cancelled' && e.task === row.task), false);
  assert.equal(session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task && e.reason === 'blocked').length, 1,
    'the owner was told once, but the task was never killed for it');
});
