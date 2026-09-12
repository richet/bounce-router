import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-scheduler-'));
  t?.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, session: new Session(root, {root})};
};

// Dispatch runs async (after adapter.launch), so tests poll the log for a condition
// instead of depending on wall-clock delays.
const waitFor = async (fn, {timeout = 2000, interval = 5} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};

test('S1 happy path: dispatch, milestone, usage, completion, budget debit, worker attribution', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [
    {kind: 'milestone', text: 'm1', evidence: null},
    {kind: 'usage', usage: {tokens: 10}},
    {kind: 'result', status: 'completed', text: 'done'},
  ]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, budget: {starts: 3}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');

  const kinds = session.events.filter(e => e.task === row.task || e.kind === 'peer.joined').map(e => e.kind);
  assert.deepEqual(kinds, ['task.submitted', 'budget.reserved', 'peer.joined', 'task.started', 'task.milestone', 'task.usage', 'task.completed']);
  assert.equal(scheduler.tasks()[row.task].state, 'completed');
  assert.equal(scheduler.tasks()[row.task].summary, 'done');
  assert.equal(scheduler.budgets().roots[row.task].remaining.starts, 2);
  const workerKinds = new Set(['peer.joined', 'task.started', 'task.milestone', 'task.usage', 'task.completed']);
  for (const e of session.events) if (workerKinds.has(e.kind) && e.task === row.task) assert.equal(e.from, `worker:${row.task}`);
});

test('S2 fallback: limited result retries under next profile, replaces original, root budget shared', async t => {
  const {session} = setup(t);
  const adapterA = fakeAdapter(() => [{kind: 'result', status: 'limited', text: 'quota'}]);
  const adapterB = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done via B'}]);
  const profiles = {
    A: {adapter: 'fakeA', model: 'x', mode: 'yolo', fallback: ['B']},
    B: {adapter: 'fakeB', model: 'x', mode: 'yolo', fallback: []},
  };
  const scheduler = createScheduler({session, adapters: {fakeA: adapterA, fakeB: adapterB}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, budget: {starts: 3}});

  const fallbackRow = await waitFor(() => session.events.find(e => e.kind === 'policy.fallback'));
  assert.equal(fallbackRow.from_profile, 'A');
  assert.equal(fallbackRow.to_profile, 'B');

  const retry = await waitFor(() => session.events.find(e => e.kind === 'task.submitted' && e.profile === 'B'));
  assert.equal(retry.parent, row.parent ?? null);
  assert.equal(retry.replaces, row.task);

  await waitFor(() => scheduler.tasks()[retry.task]?.state === 'completed');
  const roots = scheduler.budgets().roots;
  assert.deepEqual(Object.keys(roots), [row.task]);
  assert.equal(roots[row.task].remaining.starts, 1);
});

test('S3 no fallback on error/tests reason: adapter failure text "tests" yields reason error, no retry', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'failed', text: 'tests'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: ['B']}, B: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');

  assert.equal(scheduler.tasks()[row.task].reason, 'error');
  assert.equal(session.events.some(e => e.kind === 'policy.fallback'), false);
  assert.equal(session.events.filter(e => e.kind === 'task.submitted').length, 1);
});

test('S4 ratchet: worker mode yolo under session mode plan fails before launch', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, sessionMode: 'plan'});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');

  assert.equal(scheduler.tasks()[row.task].reason, 'policy');
  assert.equal(session.events.some(e => e.kind === 'budget.reserved'), false);
  assert.equal(adapter.calls.launch, 0);
});

test('S5 budget exhausted: a child cannot draw past the root allowance', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const root = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null, budget: {starts: 1}});
  const child = scheduler.submit({parent: root.task, profile: 'A', orders: 'child', deadline: null});
  await waitFor(() => scheduler.tasks()[child.task]?.state === 'failed');

  assert.equal(scheduler.tasks()[child.task].reason, 'budget');
  assert.equal(adapter.calls.launch, 1);
});

test('S6 depth: grandchild exceeds depth cap of 1', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, depthCap: 1});
  const root = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null});
  await waitFor(() => scheduler.tasks()[root.task]?.state === 'completed');
  const child = scheduler.submit({parent: root.task, profile: 'A', orders: 'child', deadline: null});
  await waitFor(() => scheduler.tasks()[child.task]?.state === 'completed');
  const grandchild = scheduler.submit({parent: child.task, profile: 'A', orders: 'grandchild', deadline: null});
  await waitFor(() => scheduler.tasks()[grandchild.task]?.state === 'failed');

  assert.equal(scheduler.tasks()[grandchild.task].reason, 'depth');
});

test('S7 malformed submissions throw and publish nothing', async t => {
  const {session} = setup(t);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}])}, profiles});
  const before = session.events.length;

  assert.throws(() => scheduler.submit({parent: null, profile: 'nope', orders: 'x', deadline: null}), {message: 'malformed: profile'});
  assert.equal(session.events.length, before);
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: '', deadline: null}), {message: 'malformed: orders'});
  assert.equal(session.events.length, before);
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: 'soon'}), {message: 'malformed: deadline'});
  assert.equal(session.events.length, before);
  assert.throws(() => scheduler.submit({parent: 'does-not-exist', profile: 'A', orders: 'x', deadline: null}), {message: 'malformed: parent'});
  assert.equal(session.events.length, before);

  // Settle the root's own (legitimate) dispatch before the test ends, so no async
  // continuation from it runs after cleanup has removed the tmp session directory.
  const root = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null});
  await waitFor(() => scheduler.tasks()[root.task]?.state === 'completed');
  const settled = session.events.length;
  assert.throws(() => scheduler.submit({parent: root.task, profile: 'A', orders: 'x', deadline: null, budget: {starts: 1}}), {message: 'malformed: budget'});
  assert.equal(session.events.length, settled);
});

test('S8 cancel tree: children cancel deepest-first, then the root, all verified', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const root = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null});
  await waitFor(() => scheduler.tasks()[root.task]?.state === 'running');
  const child1 = scheduler.submit({parent: root.task, profile: 'A', orders: 'c1', deadline: null});
  const child2 = scheduler.submit({parent: root.task, profile: 'A', orders: 'c2', deadline: null});
  await waitFor(() => scheduler.tasks()[child1.task]?.state === 'running' && scheduler.tasks()[child2.task]?.state === 'running');

  const result = await scheduler.cancel(root.task);
  assert.deepEqual(result, {verified: true});
  const cancelledOrder = session.events.filter(e => e.kind === 'task.cancelled').map(e => e.task);
  assert.deepEqual(cancelledOrder, [child1.task, child2.task, root.task]);
  assert.equal(adapter.calls.cancel, 3);
});

test('S9 unverifiable termination: an unverified child is blocked, not cancelled, and cancel() reports unverified', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => ({never: true, cancel: {verified: false}}));
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const root = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null});
  await waitFor(() => scheduler.tasks()[root.task]?.state === 'running');
  const child = scheduler.submit({parent: root.task, profile: 'A', orders: 'c1', deadline: null});
  await waitFor(() => scheduler.tasks()[child.task]?.state === 'running');

  const result = await scheduler.cancel(root.task);
  assert.deepEqual(result, {verified: false});
  assert.equal(session.events.some(e => e.kind === 'task.cancelled' && e.task === child.task), false);
  const blockedRow = session.events.find(e => e.kind === 'task.blocked' && e.task === child.task);
  assert.equal(blockedRow.text, 'termination unverified');
});

test('S10 reconcile: a running task with no live handle is marked blocked at construction', t => {
  const {session} = setup(t);
  session.append({kind: 'task.submitted', task: 'orphan', parent: null, profile: 'A', orders: 'x', deadline: null});
  session.append({kind: 'task.started', task: 'orphan', attempt: 1});
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => [])}, profiles});

  const blockedRow = session.events.find(e => e.kind === 'task.blocked' && e.task === 'orphan');
  assert.equal(blockedRow.text.startsWith('interrupted'), true);
  assert.equal(scheduler.tasks().orphan.state, 'blocked');
});

test('S11 missing adapter fails then falls back to the next profile', async t => {
  const {session} = setup(t);
  const adapterA = fakeAdapter(() => ({launchError: 'missing'}));
  const adapterB = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done via B'}]);
  const profiles = {
    A: {adapter: 'fakeA', model: 'x', mode: 'yolo', fallback: ['B']},
    B: {adapter: 'fakeB', model: 'x', mode: 'yolo', fallback: []},
  };
  const scheduler = createScheduler({session, adapters: {fakeA: adapterA, fakeB: adapterB}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[row.task].reason, 'missing');

  const retry = await waitFor(() => session.events.find(e => e.kind === 'task.submitted' && e.profile === 'B'));
  assert.equal(retry.replaces, row.task);
  await waitFor(() => scheduler.tasks()[retry.task]?.state === 'completed');
});

test('S12 live activity is delivered live and never journaled', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'activity', text: 'tick'}, {kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const seen = [];
  session.subscribe(e => seen.push(e.kind));
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');

  assert.equal(seen.includes('task.activity'), true);
  const journalText = fs.readFileSync(session.file, 'utf8');
  assert.equal(journalText.includes('task.activity'), false);
});

test('G1 events() throwing mid-stream fails the task cleanly, with no unhandled rejection', async t => {
  const {session} = setup(t);
  let rejections = 0;
  const onRejection = () => rejections++;
  process.on('unhandledRejection', onRejection);
  try {
    const adapter = fakeAdapter(() => [{kind: 'milestone', text: 'm1', evidence: null}, {kind: '__throw', message: 'stream broke'}]);
    const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
    // Give any stray unhandled rejection a turn to surface before asserting on it.
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(scheduler.tasks()[row.task].state, 'failed');
    assert.equal(scheduler.tasks()[row.task].reason, 'error');
    assert.equal(scheduler.tasks()[row.task].error, 'stream broke');
    assert.equal(rejections, 0);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('G2 cancelling a task while its launch is still pending prevents the late launch from running unmonitored', async t => {
  const {session} = setup(t);
  const deferred = {};
  deferred.promise = new Promise(resolve => { deferred.resolve = resolve; });
  const adapter = fakeAdapter(() => deferred.promise.then(() => [{kind: 'result', status: 'completed', text: 'done'}]));
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'queued');

  const result = await scheduler.cancel(row.task);
  assert.deepEqual(result, {verified: true});
  assert.equal(session.events.some(e => e.kind === 'task.cancelled' && e.task === row.task), true);

  deferred.resolve();
  await waitFor(() => adapter.calls.cancel === 1);
  // Let any wrongly-scheduled continuation (peer.joined/task.started/events()) get a turn.
  await new Promise(resolve => setTimeout(resolve, 20));

  assert.equal(adapter.calls.cancel, 1);
  assert.equal(adapter.calls.events, 0);
  assert.equal(session.events.some(e => e.kind === 'task.started' && e.task === row.task), false);
  assert.equal(session.events.some(e => e.kind === 'task.completed' && e.task === row.task), false);
});

test('finding 2: an unknown fallback profile does not throw and is not attempted', t => {
  const {session} = setup(t);
  createScheduler({session, adapters: {}, profiles: {}});
  session.append({kind: 'task.submitted', task: 'x1', parent: null, profile: 'GONE', orders: 'y', deadline: null});
  session.append({kind: 'task.failed', task: 'x1', reason: 'limited', text: 'q'});

  assert.equal(session.events.some(e => e.kind === 'policy.fallback'), false);
  assert.equal(session.subscriberErrors.length, 0);
});

test('finding 4: a cancelled task does not spawn a fallback worker on a late/racy result', t => {
  const {session} = setup(t);
  const adapterA = fakeAdapter(() => ({never: true}));
  const adapterB = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {
    A: {adapter: 'fakeA', model: 'x', mode: 'yolo', fallback: ['B']},
    B: {adapter: 'fakeB', model: 'x', mode: 'yolo', fallback: []},
  };
  createScheduler({session, adapters: {fakeA: adapterA, fakeB: adapterB}, profiles});
  session.append({kind: 'task.submitted', task: 'r', parent: null, profile: 'A', orders: 'x', deadline: null});
  session.append({kind: 'task.started', task: 'r', attempt: 1});
  session.append({kind: 'task.cancelled', task: 'r'});
  session.append({kind: 'task.failed', task: 'r', reason: 'limited', text: 'late'}); // arrives after cancellation

  assert.equal(session.events.some(e => e.kind === 'policy.fallback'), false);
  assert.equal(adapterB.calls.launch, 0);
});

test('finding 7: an unknown profile fails the task at dispatch instead of leaving it queued forever', async t => {
  const {session} = setup(t);
  const scheduler = createScheduler({session, adapters: {}, profiles: {}});
  session.append({kind: 'task.submitted', task: 'z1', parent: null, profile: 'GONE', orders: 'x', deadline: null});
  await waitFor(() => scheduler.tasks().z1?.state === 'failed');

  assert.equal(scheduler.tasks().z1.state, 'failed');
  assert.equal(scheduler.tasks().z1.reason, 'error');
});

test('finding 8: cancel() of an id with no task row returns verified true instead of throwing', async t => {
  const {session} = setup(t);
  const scheduler = createScheduler({session, adapters: {}, profiles: {}});
  const result = await scheduler.cancel('does-not-exist');
  assert.deepEqual(result, {verified: true});
});

test('cycle guard: a self-parent task.submitted fails with reason depth instead of hanging or crashing', async t => {
  const {session} = setup(t);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}])}, profiles, depthCap: 1});
  session.append({kind: 'task.submitted', task: 't1', parent: 't1', profile: 'A', orders: 'x', deadline: null});
  await waitFor(() => scheduler.tasks().t1?.state === 'failed');

  assert.equal(scheduler.tasks().t1.state, 'failed');
  assert.equal(scheduler.tasks().t1.reason, 'depth');
});

test('cycle guard: a self-replacing task.submitted resolves its own budget root instead of hanging or crashing', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  session.append({kind: 'task.submitted', task: 'r', parent: null, replaces: 'r', profile: 'A', orders: 'x', deadline: null, budget: {starts: 3}});
  await waitFor(() => scheduler.tasks().r?.state === 'completed');

  assert.equal(scheduler.tasks().r.state, 'completed');
  assert.deepEqual(Object.keys(scheduler.budgets().roots), ['r']);
  assert.equal(scheduler.budgets().roots.r.remaining.starts, 2);
});

test('cycle guard: a self-replacing failed task still resolves a lineage root and can fall back', async t => {
  const {session} = setup(t);
  const adapterA = fakeAdapter(() => ({never: true}));
  const adapterB = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done via B'}]);
  const profiles = {
    A: {adapter: 'fakeA', model: 'x', mode: 'yolo', fallback: ['B']},
    B: {adapter: 'fakeB', model: 'x', mode: 'yolo', fallback: []},
  };
  createScheduler({session, adapters: {fakeA: adapterA, fakeB: adapterB}, profiles});
  session.append({kind: 'task.submitted', task: 'r', parent: null, replaces: 'r', profile: 'A', orders: 'x', deadline: null});
  session.append({kind: 'task.failed', task: 'r', reason: 'limited', text: 'q'});
  await waitFor(() => session.events.find(e => e.kind === 'policy.fallback'));

  const fb = session.events.find(e => e.kind === 'policy.fallback');
  assert.equal(fb.from_profile, 'A');
  assert.equal(fb.to_profile, 'B');
  assert.equal(session.subscriberErrors.length, 0);
});

test('cycle guard: mutually-parented tasks cancel each member exactly once instead of crashing', async t => {
  const {session} = setup(t);
  // Constructed directly (not via submit()/dispatch) and BEFORE the scheduler exists, so
  // reconcile is what makes them non-terminal ('blocked', no live handle) — deterministic,
  // with no real launch racing against the log construction.
  session.append({kind: 'task.submitted', task: 'a', parent: null, profile: 'A', orders: 'x', deadline: null});
  session.append({kind: 'task.started', task: 'a', attempt: 1});
  session.append({kind: 'task.submitted', task: 'b', parent: 'a', profile: 'A', orders: 'x', deadline: null});
  session.append({kind: 'task.started', task: 'b', attempt: 1});
  session.append({kind: 'task.submitted', task: 'a', parent: 'b', profile: 'A', orders: 'x', deadline: null}); // a and b now each other's child
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => ({never: true}))}, profiles});

  const result = await scheduler.cancel('a');
  assert.deepEqual(result, {verified: true});
  const cancelledOrder = session.events.filter(e => e.kind === 'task.cancelled').map(e => e.task);
  assert.deepEqual(cancelledOrder, ['b', 'a']);
});

test('close() unsubscribes: a task.submitted after close() dispatches nothing', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  scheduler.close();
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null});
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.equal(session.events.filter(e => e.task === row.task).length, 1); // only the task.submitted row itself
  assert.equal(adapter.calls.launch, 0);
});

test('stop() cancels every non-terminal task across all roots, children first', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const root1 = scheduler.submit({parent: null, profile: 'A', orders: 'r1', deadline: null});
  await waitFor(() => scheduler.tasks()[root1.task]?.state === 'running');
  const child1 = scheduler.submit({parent: root1.task, profile: 'A', orders: 'c1', deadline: null});
  const root2 = scheduler.submit({parent: null, profile: 'A', orders: 'r2', deadline: null});
  await waitFor(() => scheduler.tasks()[root2.task]?.state === 'running');
  const child2 = scheduler.submit({parent: root2.task, profile: 'A', orders: 'c2', deadline: null});
  await waitFor(() => scheduler.tasks()[child1.task]?.state === 'running' && scheduler.tasks()[child2.task]?.state === 'running');

  const result = await scheduler.stop();
  assert.deepEqual(result.cancelled, [child1.task, root1.task, child2.task, root2.task]);
  assert.deepEqual(result.unverified, []);
});

test('legacy: constructing a scheduler on a session with no task rows appends nothing', t => {
  const {session} = setup(t);
  const before = session.events.length;
  createScheduler({session, adapters: {}, profiles: {}});
  assert.equal(session.events.length, before);
});

