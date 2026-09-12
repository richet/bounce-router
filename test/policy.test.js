// CONTRACT.md §5: contract tests for Phase 4 review-as-policy — prelaunch/completion review,
// rework via resume bounded by rounds, depends_on holds and the verdict protocol. Composed
// real scheduler + reducers + fake adapters, exactly like test/scheduler.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-policy-'));
  t?.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, session: new Session(root, {root})};
};

const waitFor = async (fn, {timeout = 2000, interval = 5} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};

const worker = () => ({adapter: 'worker', model: 'w', mode: 'yolo', fallback: []});
const critic = () => ({adapter: 'critic', model: 'c', mode: 'yolo', fallback: [], role: 'critic'});
const verifier = () => ({adapter: 'verifier', model: 'v', mode: 'yolo', fallback: [], role: 'verifier'});

test('P1 prelaunch reject: worker never launches, task ends rejected with the questions', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"reject","questions":["probe 3 has no expected output"]}'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'rejected');

  const kinds = session.events.filter(e => e.task === row.task).map(e => e.kind);
  assert.deepEqual(kinds, ['task.submitted', 'budget.reserved', 'review.started', 'review.finished', 'task.rejected']);
  const rejected = session.events.find(e => e.kind === 'task.rejected');
  assert.deepEqual(rejected.questions, ['probe 3 has no expected output']);
  assert.equal(workerAdapter.calls.launch, 0);
  assert.equal(scheduler.tasks()[row.task].state, 'rejected');
});

test('P2 prelaunch accept precedes task.started; a later direct completion accept freezes the task', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');

  const kinds = session.events.filter(e => e.task === row.task || e.kind === 'peer.joined').map(e => e.kind);
  assert.deepEqual(kinds, ['task.submitted', 'budget.reserved', 'review.started', 'review.finished', 'task.accepted', 'budget.reserved', 'peer.joined', 'task.started', 'task.completed']);
  const acceptedRow = session.events.find(e => e.kind === 'task.accepted');
  assert.equal(acceptedRow.stage, 'prelaunch');
  assert.equal(acceptedRow.by, `review:${row.task}`);

  session.append({kind: 'task.accepted', task: row.task, stage: 'completion', by: 'orchestrator'});
  assert.equal(scheduler.tasks()[row.task].state, 'accepted');
});

test('P3 completion rework on the same worker, then accept', async t => {
  const {session} = setup(t);
  let workerRound = 0;
  const workerAdapter = fakeAdapter(() => {
    workerRound++;
    if (workerRound === 1) return [{kind: 'native', provider: 'worker', sessionId: 'sess-1'}, {kind: 'result', status: 'completed', text: 'first pass'}];
    return [{kind: 'result', status: 'completed', text: 'reworked'}];
  });
  let criticRound = 0;
  const criticAdapter = fakeAdapter(() => {
    criticRound++;
    if (criticRound === 1) return [{kind: 'result', status: 'completed', text: '{"verdict":"rework","findings":["fix the probe"]}'}];
    return [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}];
  });
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');

  const reworkRow = session.events.find(e => e.kind === 'task.rework');
  assert.equal(reworkRow.round, 1);
  assert.deepEqual(reworkRow.findings, ['fix the probe']);

  assert.equal(workerAdapter.calls.launch, 1);
  assert.equal(workerAdapter.calls.resume, 1);
  const resumeArgs = workerAdapter.resumeCalls[0];
  assert.equal(resumeArgs.message.startsWith('Rework round 1:'), true);
  assert.equal(resumeArgs.message.includes('fix the probe'), true);
  const nativeRow = session.events.find(e => e.kind === 'peer.native');
  assert.equal(resumeArgs.native.sessionId, nativeRow.sessionId);

  const startedRows = session.events.filter(e => e.kind === 'task.started' && e.task === row.task);
  assert.equal(startedRows.length, 2);
  assert.equal(startedRows[1].attempt, 2);
  assert.equal(startedRows[1].resumed, true);

  const finalAccept = session.events.filter(e => e.kind === 'task.accepted').at(-1);
  assert.equal(finalAccept.stage, 'completion');
  assert.equal(scheduler.tasks()[row.task].state, 'accepted');
  assert.equal(scheduler.budgets().roots[row.task].reserved.rounds, 1);
});

test('P4 rounds cap: two reworks in a row blocks instead of a silent third round', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'pass'}]);
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"rework","findings":["still broken"]}'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}, budget: {rounds: 1}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  const escalated = session.events.filter(e => e.kind === 'policy.escalated');
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].reason, 'rounds');
  const blockedRow = session.events.filter(e => e.kind === 'task.blocked').at(-1);
  assert.equal(blockedRow.text, 'rounds exhausted');
  assert.equal(workerAdapter.calls.resume, 1);
  assert.equal(scheduler.tasks()[row.task].state, 'blocked');
});

test('P5 depends_on: B holds while A is running or merely completed, launches once A is accepted', async t => {
  const {session} = setup(t);
  const deferredA = {};
  deferredA.promise = new Promise(resolve => { deferredA.resolve = resolve; });
  const adapterA = fakeAdapter(() => deferredA.promise.then(() => [{kind: 'result', status: 'completed', text: 'a done'}]));
  const adapterB = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'b done'}]);
  const scheduler = createScheduler({session, adapters: {a: adapterA, b: adapterB}, profiles: {A: {...worker(), adapter: 'a'}, B: {...worker(), adapter: 'b'}}});
  const rowA = scheduler.submit({parent: null, profile: 'A', orders: 'a', deadline: null});
  const rowB = scheduler.submit({parent: null, profile: 'B', orders: 'b', deadline: null, depends_on: [rowA.task]});

  await waitFor(() => adapterA.calls.launch === 1);
  assert.equal(adapterB.calls.launch, 0);

  deferredA.resolve();
  await waitFor(() => scheduler.tasks()[rowA.task]?.state === 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapterB.calls.launch, 0);

  session.append({kind: 'task.accepted', task: rowA.task, stage: 'completion', by: 'orchestrator'});
  await waitFor(() => adapterB.calls.launch === 1);
});

test('P5b depends_on: a failed dependency fails the dependent task', async t => {
  const {session} = setup(t);
  const adapterA = fakeAdapter(() => [{kind: 'result', status: 'failed', text: 'boom'}]);
  const adapterB = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'b'}]);
  const scheduler = createScheduler({session, adapters: {a: adapterA, b: adapterB}, profiles: {A: {...worker(), adapter: 'a'}, B: {...worker(), adapter: 'b'}}});
  const rowA = scheduler.submit({parent: null, profile: 'A', orders: 'a', deadline: null});
  const rowB = scheduler.submit({parent: null, profile: 'B', orders: 'b', deadline: null, depends_on: [rowA.task]});

  await waitFor(() => scheduler.tasks()[rowB.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[rowB.task].reason, 'dependency');
  const failedB = session.events.find(e => e.kind === 'task.failed' && e.task === rowB.task);
  assert.equal(failedB.text, rowA.task);
  assert.equal(adapterB.calls.launch, 0);
});

test('P5c depends_on: a self reference and an unknown id are malformed', t => {
  const {session} = setup(t);
  const scheduler = createScheduler({session, adapters: {a: fakeAdapter(() => [])}, profiles: {A: {...worker(), adapter: 'a'}}});
  assert.throws(() => scheduler.submit({task: 'self-1', parent: null, profile: 'A', orders: 'x', deadline: null, depends_on: ['self-1']}), {message: 'malformed: depends_on'});
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, depends_on: ['does-not-exist']}), {message: 'malformed: depends_on'});
});

test('P5d depends_on (A1): a dependent submitted after its dependency merely completed still holds, launching only once the dependency is accepted', async t => {
  const {session} = setup(t);
  const adapterA = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'a done'}]);
  const adapterB = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'b done'}]);
  const scheduler = createScheduler({session, adapters: {a: adapterA, b: adapterB}, profiles: {A: {...worker(), adapter: 'a'}, B: {...worker(), adapter: 'b'}}});
  const rowA = scheduler.submit({parent: null, profile: 'A', orders: 'a', deadline: null});
  await waitFor(() => scheduler.tasks()[rowA.task]?.state === 'completed');

  const before = session.events.length;
  const rowB = scheduler.submit({parent: null, profile: 'B', orders: 'b', deadline: null, depends_on: [rowA.task]});
  await new Promise(resolve => setImmediate(resolve));
  const rowsForB = session.events.slice(before).filter(e => e.task === rowB.task);
  assert.deepEqual(rowsForB.map(e => e.kind), ['task.submitted']);
  assert.equal(adapterB.calls.launch, 0);

  session.append({kind: 'task.accepted', task: rowA.task, stage: 'completion', by: 'orchestrator'});
  await waitFor(() => adapterB.calls.launch === 1);
  assert.equal(adapterB.calls.launch, 1);
});

test('P6a prelaunch reviewer receives orders verbatim', async t => {
  const {session} = setup(t);
  let seenOrders;
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(args => { seenOrders = args.orders; return [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]; });
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do exactly this', deadline: null, review: {prelaunch: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  assert.equal(seenOrders, 'do exactly this');
});

test('P6b completion critic receives the brief plus the worker report', async t => {
  const {session} = setup(t);
  let seenOrders;
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'summary text here'}]);
  const criticAdapter = fakeAdapter(args => { seenOrders = args.orders; return [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]; });
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'the brief', deadline: null, review: {completion: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');
  assert.equal(seenOrders, 'the brief\n\n--- worker report ---\nsummary text here');
});

test('P6c completion verifier receives steps verbatim, dir ends review-completion-1', async t => {
  const {session} = setup(t);
  let seenOrders, seenDir;
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const verifierAdapter = fakeAdapter(args => { seenOrders = args.orders; seenDir = args.dir; return [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]; });
  const profiles = {A: worker(), V: verifier()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, verifier: verifierAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'the brief', deadline: null, review: {completion: 'V'}, steps: '1. do a\n2. do b'});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');
  assert.equal(seenOrders, '1. do a\n2. do b');
  assert.equal(seenDir.endsWith('review-completion-1'), true);
});

test('P7a an unreadable verdict text escalates and blocks before any worker launch', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'looks fine'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  const finished = session.events.find(e => e.kind === 'review.finished');
  assert.equal(finished.verdict, 'unreadable');
  const escalated = session.events.find(e => e.kind === 'policy.escalated');
  assert.equal(escalated.reason, 'review');
  assert.equal(session.events.some(e => e.kind === 'task.blocked'), true);
  assert.equal(workerAdapter.calls.launch, 0);
});

test('P7b a failed review result reads as unreadable the same way', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'failed', text: 'crashed'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');
  const finished = session.events.find(e => e.kind === 'review.finished');
  assert.equal(finished.verdict, 'unreadable');
});

test('P8 pending messages fold into the resume message once (A2): round 1 only, then marked next-turn', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'pass'}]);
  // The critic's first launch is held open (deferred), so the task stays in `reviewing` with no
  // live worker handle for a controlled window in which to inject the two pending messages —
  // without this, a fake adapter resolves fast enough that round 1 could already be resuming
  // before the test gets a chance to append them. The critic reworks twice (the default
  // limits.rounds cap is 2), so a second resume happens naturally with no manual pacing needed;
  // a third review attempt then finds the cap spent and blocks.
  const deferredCritic = {};
  deferredCritic.promise = new Promise(resolve => { deferredCritic.resolve = resolve; });
  let firstCriticLaunch = true;
  const criticAdapter = fakeAdapter(() => {
    if (firstCriticLaunch) { firstCriticLaunch = false; return deferredCritic.promise.then(() => [{kind: 'result', status: 'completed', text: '{"verdict":"rework","findings":["fix x"]}'}]); }
    return [{kind: 'result', status: 'completed', text: '{"verdict":"rework","findings":["fix y"]}'}];
  });
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'reviewing');
  await waitFor(() => criticAdapter.calls.launch === 1);

  const m1 = session.append({kind: 'message', to: `worker:${row.task}`, text: 'note one', from: 'user'});
  await waitFor(() => session.events.some(e => e.kind === 'task.delivered' && e.message === m1.id));
  assert.equal(session.events.find(e => e.message === m1.id).tier, 'queued');

  deferredCritic.resolve();
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  assert.equal(workerAdapter.calls.resume, 2);
  assert.equal(workerAdapter.resumeCalls[0].message, 'Rework round 1:\n- fix x\nnote one');
  assert.equal(workerAdapter.resumeCalls[1].message, 'Rework round 2:\n- fix y');
  const deliveredForM1 = session.events.filter(e => e.kind === 'task.delivered' && e.message === m1.id).map(e => e.tier);
  assert.deepEqual(deliveredForM1, ['queued', 'next-turn']);
});

test('P9 malformed review/steps/budget submissions throw and publish nothing', t => {
  const {session} = setup(t);
  const profiles = {A: worker(), builderProfile: worker(), V: verifier(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(() => []), verifier: fakeAdapter(() => []), critic: fakeAdapter(() => [])}, profiles});
  const before = session.events.length;

  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, review: {completion: 'builderProfile'}}), {message: 'malformed: review'});
  assert.equal(session.events.length, before);

  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, review: {completion: 'V'}}), {message: 'malformed: steps'});
  assert.equal(session.events.length, before);

  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, budget: {rounds: -1}}), {message: 'malformed: budget'});
  assert.equal(session.events.length, before);
});

test('P9b strict requires both prelaunch and completion review on every submit', t => {
  const {session} = setup(t);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(() => []), critic: fakeAdapter(() => [])}, profiles, strict: true});
  const before = session.events.length;

  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null}), {message: 'malformed: review'});
  assert.equal(session.events.length, before);
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, review: {prelaunch: 'C'}}), {message: 'malformed: review'});
  assert.equal(session.events.length, before);
});

test('P10 review budget: the review consumes the only start; the worker never launches', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}, budget: {starts: 1}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  const escalated = session.events.find(e => e.kind === 'policy.escalated');
  assert.equal(escalated.reason, 'budget');
  assert.equal(session.events.some(e => e.kind === 'task.blocked'), true);
  assert.equal(workerAdapter.calls.launch, 0);
  assert.equal(criticAdapter.calls.launch, 1);
});

test('P11 cancel() during a never-ending prelaunch review cancels the review handle (A3)', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}});
  await waitFor(() => criticAdapter.calls.launch === 1);
  await waitFor(() => criticAdapter.calls.events === 1);

  const result = await scheduler.cancel(row.task);
  assert.equal(result.verified, true);
  assert.equal(criticAdapter.calls.cancel, 1);
  assert.equal(workerAdapter.calls.launch, 0);
});

test('P12 stop() during a never-ending completion review cancels the review handle, drives no resume (A3)', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'reviewing');
  await waitFor(() => criticAdapter.calls.events === 1);

  const result = await scheduler.stop();
  assert.deepEqual(result.cancelled, [row.task]);
  assert.equal(criticAdapter.calls.cancel, 1);
  assert.equal(workerAdapter.calls.resume, 0);
});

test('P13 a throwing review stream ends unreadable, escalates, and cancels the handle (A4)', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => [{kind: '__throw', message: 'critic crashed'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  const finished = session.events.find(e => e.kind === 'review.finished');
  assert.equal(finished.verdict, 'unreadable');
  assert.equal(finished.text, 'critic crashed');
  const escalated = session.events.find(e => e.kind === 'policy.escalated');
  assert.equal(escalated.reason, 'review');
  assert.equal(criticAdapter.calls.cancel, 1);
  assert.equal(workerAdapter.calls.launch, 0);
});

test('P14 limits merge over defaults (A5): an override changes only that field, others keep their default', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const scheduler = createScheduler({session, adapters: {a: adapter}, profiles: {A: {...worker(), adapter: 'a'}}, limits: {lines: 1}});

  const oversized = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, size: {lines: 2, probes: 1, minutes: 1}});
  await waitFor(() => scheduler.tasks()[oversized.task]?.state === 'failed');
  assert.equal(session.events.find(e => e.kind === 'task.failed' && e.task === oversized.task).text, 'lines 2 exceeds limit 1');

  const withinDefaults = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, size: {lines: 1, probes: 6, minutes: 15}});
  await waitFor(() => scheduler.tasks()[withinDefaults.task]?.state === 'completed');
});

test('P15 non-positive limits.rounds throws malformed: limits (A5)', t => {
  const {session} = setup(t);
  assert.throws(() => createScheduler({session, adapters: {}, profiles: {}, limits: {rounds: 0}}), {message: 'malformed: limits'});
});
