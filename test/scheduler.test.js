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

test('T7: worker raw and model events reach the journal with provider and task; task.started records the requested model', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [
    {kind: 'raw', raw: {type: 'rate_limit_event', rate_limit_info: {status: 'allowed', unifiedWindows: {five_hour: {utilization: 0.4, resetsAt: 1000}}}}},
    {kind: 'model', model: 'claude-sonnet-5'},
    {kind: 'result', status: 'completed', text: 'ok'},
  ]);
  const scheduler = createScheduler({session, adapters: {a: adapter}, profiles: {p: {adapter: 'a', model: 'sonnet', mode: 'yolo', fallback: []}}});
  const row = scheduler.submit({parent: null, profile: 'p', orders: 'x'});
  await waitFor(() => scheduler.tasks()[row.task].state === 'completed');
  const raw = session.events.find(e => e.kind === 'raw' && e.task === row.task);
  assert.equal(raw.provider, 'a');
  assert.equal(raw.from, `worker:${row.task}`);
  assert.equal(raw.raw.rate_limit_info.unifiedWindows.five_hour.utilization, 0.4);
  const model = session.events.find(e => e.kind === 'model' && e.task === row.task);
  assert.equal(model.model, 'claude-sonnet-5');
  assert.equal(model.provider, 'a');
  assert.equal(session.events.find(e => e.kind === 'task.started' && e.task === row.task).requested, 'sonnet');
  assert.equal(fs.readFileSync(session.file, 'utf8').split('\n').filter(l => l.includes('"kind":"raw"')).length, 1);
});

test('T7 critic minors: a raw event without raw journals raw: null; a non-string model is coerced', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'raw'}, {kind: 'model', model: 12345}, {kind: 'result', status: 'completed', text: 'ok'}]);
  const scheduler = createScheduler({session, adapters: {a: adapter}, profiles: {p: {adapter: 'a', mode: 'yolo', fallback: []}}});
  const row = scheduler.submit({parent: null, profile: 'p', orders: 'x'});
  await waitFor(() => scheduler.tasks()[row.task].state === 'completed');
  assert.equal(session.events.find(e => e.kind === 'raw' && e.task === row.task).raw, null);
  assert.equal(session.events.find(e => e.kind === 'model' && e.task === row.task).model, '12345');
});

test('Z1 sized submission under limits: risk and size are stored and dispatch proceeds', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, risk: 'boundary', size: {lines: 120, probes: 5, minutes: 12}});

  assert.equal(row.risk, 'boundary');
  assert.deepEqual(row.size, {lines: 120, probes: 5, minutes: 12});
  await waitFor(() => session.events.some(e => e.kind === 'task.started' && e.task === row.task));
});

test('Z2 unsized submission defaults risk to logic and size to zeroed, never refused; without configured limits a large size dispatches too', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});

  assert.equal(row.risk, 'logic');
  assert.deepEqual(row.size, {lines: 0, probes: 0, minutes: 0});
  await waitFor(() => session.events.some(e => e.kind === 'task.started' && e.task === row.task));
  const big = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, size: {lines: 400, probes: 9, minutes: 40}});
  await waitFor(() => session.events.some(e => e.kind === 'task.started' && e.task === big.task));
  assert.equal(session.events.some(e => e.kind === 'task.failed' && e.task === big.task), false);
});

test('Z3 with configured limits, an oversized submission refuses at dispatch before launch, naming the first exceeding field', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, limits: {lines: 150, probes: 6}});

  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, size: {lines: 151, probes: 1, minutes: 1}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[row.task].reason, 'size');
  const failedRow = session.events.find(e => e.kind === 'task.failed' && e.task === row.task);
  assert.equal(failedRow.text, 'lines 151 exceeds limit 150');
  assert.equal(session.events.some(e => e.kind === 'budget.reserved' && e.task === row.task), false);
  assert.equal(adapter.calls.launch, 0);

  const row2 = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, size: {lines: 1, probes: 7, minutes: 1}});
  await waitFor(() => scheduler.tasks()[row2.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[row2.task].reason, 'size');
  const failedRow2 = session.events.find(e => e.kind === 'task.failed' && e.task === row2.task);
  assert.equal(failedRow2.text, 'probes 7 exceeds limit 6');
  assert.equal(session.events.some(e => e.kind === 'budget.reserved' && e.task === row2.task), false);
  assert.equal(adapter.calls.launch, 0);
});

test('Z4 malformed risk/size/limits throw and publish nothing', async t => {
  const {session} = setup(t);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}])}, profiles});
  const before = session.events.length;

  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, risk: 'huge'}), {message: 'malformed: risk'});
  assert.equal(session.events.length, before);
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, size: {lines: -1, probes: 0, minutes: 0}}), {message: 'malformed: size'});
  assert.equal(session.events.length, before);
  assert.throws(() => createScheduler({session, adapters: {}, profiles: {}, limits: {lines: 0, probes: 6, minutes: 15}}), {message: 'malformed: limits'});
  assert.equal(session.events.length, before);
});

// A fake adapter that also implements the delivery contract: `deliver` records its calls and
// returns (or throws) whatever `respond` decides. Kept here rather than in the shared fake so
// the existing helper's script contract stays exactly as every other test uses it.
const deliveringAdapter = (script, respond) => {
  const adapter = fakeAdapter(script);
  adapter.calls.deliver = 0;
  adapter.deliveries = [];
  adapter.deliver = async (handle, event) => {
    adapter.calls.deliver++;
    adapter.deliveries.push({handle, event});
    return respond(event);
  };
  return adapter;
};

test('V1 message to a live worker goes through the adapter and journals the reported tier', async t => {
  const {session} = setup(t);
  const adapter = deliveringAdapter(() => ({never: true}), () => 'live');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  const message = session.append({kind: 'message', to: `worker:${row.task}`, text: 'hi', from: 'user'});
  const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));

  assert.equal(delivered.tier, 'live');
  assert.equal(delivered.task, row.task);
  assert.equal(delivered.message, message.id);
  assert.equal(delivered.from, 'bounce');
  assert.equal(delivered.text, null);
  assert.equal(adapter.calls.deliver, 1);
  assert.deepEqual(adapter.deliveries[0].event, {text: 'hi'});
  await scheduler.cancel(row.task);
});

test('V2 an unknown tier from the adapter is recorded as queued, naming the value', async t => {
  const {session} = setup(t);
  const adapter = deliveringAdapter(() => ({never: true}), () => 'bogus');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  session.append({kind: 'message', to: `worker:${row.task}`, text: 'hi', from: 'user'});
  const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));

  assert.equal(delivered.tier, 'queued');
  assert.equal(delivered.text, 'adapter reported an unknown tier: bogus');
  assert.equal(adapter.calls.deliver, 1);
  await scheduler.cancel(row.task);
});

test('V3 message to a task with no live handle is queued, and the pending launch never delivers it retroactively', async t => {
  const {session} = setup(t);
  const deferred = {};
  deferred.promise = new Promise(resolve => { deferred.resolve = resolve; });
  const adapter = deliveringAdapter(() => deferred.promise.then(() => ({never: true})), () => 'live');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => adapter.calls.launch === 1);

  const message = session.append({kind: 'message', to: `worker:${row.task}`, text: 'hi', from: 'user'});
  const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));
  assert.equal(delivered.tier, 'queued');
  assert.equal(delivered.text, 'no live worker');
  assert.equal(delivered.message, message.id);

  deferred.resolve();
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.calls.deliver, 0);
  assert.equal(session.events.filter(e => e.kind === 'task.delivered').length, 1);
  await scheduler.cancel(row.task);
});

test('V4 a rejecting deliver is recorded as queued with the error text, with no unhandled rejection', async t => {
  const {session} = setup(t);
  let rejections = 0;
  const onRejection = () => rejections++;
  process.on('unhandledRejection', onRejection);
  try {
    const adapter = deliveringAdapter(() => ({never: true}), () => { throw new Error('socket gone'); });
    const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

    session.append({kind: 'message', to: `worker:${row.task}`, text: 'hi', from: 'user'});
    const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(delivered.tier, 'queued');
    assert.equal(delivered.text, 'socket gone');
    assert.equal(scheduler.tasks()[row.task].state, 'running');
    assert.equal(rejections, 0);
    await scheduler.cancel(row.task);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('V5 a message not addressed to a worker is ignored by the delivery subscriber', async t => {
  const {session} = setup(t);
  const adapter = deliveringAdapter(() => ({never: true}), () => 'live');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  session.append({kind: 'message', to: 'orchestrator', text: 'hi', from: 'user'});
  session.append({kind: 'message', to: 'user', text: 'hi', from: 'bounce'});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(session.events.filter(e => e.kind === 'task.delivered').length, 0);
  assert.equal(adapter.calls.deliver, 0);
  await scheduler.cancel(row.task);
});

// A worker whose stream stays open after it has already reported a result: the handle is
// still live while the task's derived state is terminal. release() ends the stream.
const streamingAdapter = (events, respond) => {
  const calls = {launch: 0, deliver: 0, cancel: 0};
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return {
    calls,
    release: () => release(),
    async launch() { calls.launch++; return {}; },
    async *events() { for (const event of events) yield event; await gate; },
    async deliver(handle, event) { calls.deliver++; return respond(event); },
    async cancel() { calls.cancel++; release(); return {verified: true}; },
  };
};

test('V6 a worker whose task has gone terminal is not live, even while its stream is still open', async t => {
  const {session} = setup(t);
  const adapter = streamingAdapter([{kind: 'result', status: 'completed', text: 'done'}], () => 'live');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');

  session.append({kind: 'message', to: `worker:${row.task}`, text: 'hi', from: 'user'});
  const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));

  assert.equal(delivered.tier, 'queued');
  assert.equal(delivered.text, 'no live worker');
  assert.equal(adapter.calls.deliver, 0);
  adapter.release();
});

test('V7 a journal write that fails while recording a delivery never escapes as an unhandled rejection', async t => {
  const {session} = setup(t);
  let rejections = 0;
  const onRejection = () => rejections++;
  process.on('unhandledRejection', onRejection);
  try {
    const adapter = deliveringAdapter(() => ({never: true}), () => 'live');
    const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

    const realAppend = session.append.bind(session);
    let broken = true;
    session.append = event => {
      if (event.kind === 'task.delivered' && broken) { broken = false; throw new Error('journal broke'); }
      return realAppend(event);
    };
    session.append({kind: 'message', to: `worker:${row.task}`, text: 'hi', from: 'user'});
    const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(delivered.tier, 'queued');
    assert.equal(delivered.text, 'journal broke');
    assert.equal(rejections, 0);

    // And when every attempt to record the delivery fails, there is nowhere left to report
    // it: the failure is swallowed rather than escaping the subscriber.
    session.append = event => { if (event.kind === 'task.delivered') throw new Error('journal down'); return realAppend(event); };
    realAppend({kind: 'message', to: `worker:${row.task}`, text: 'again', from: 'user'});
    await waitFor(() => adapter.calls.deliver === 2);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(session.events.filter(e => e.kind === 'task.delivered').length, 1);
    assert.equal(rejections, 0);

    session.append = realAppend;
    await scheduler.cancel(row.task);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

test('V8 deliveries to one worker are serialized: a slow first delivery still journals before the second', async t => {
  const {session} = setup(t);
  const gate = {};
  gate.promise = new Promise(resolve => { gate.resolve = resolve; });
  const adapter = deliveringAdapter(() => ({never: true}), event => event.text === 'one' ? gate.promise.then(() => 'live') : 'live');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  const first = session.append({kind: 'message', to: `worker:${row.task}`, text: 'one', from: 'user'});
  const second = session.append({kind: 'message', to: `worker:${row.task}`, text: 'two', from: 'user'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.calls.deliver, 1); // the second delivery waits for the first to settle
  gate.resolve();

  await waitFor(() => session.events.filter(e => e.kind === 'task.delivered').length === 2);
  const delivered = session.events.filter(e => e.kind === 'task.delivered');
  assert.deepEqual(delivered.map(e => e.message), [first.id, second.id]);
  assert.deepEqual(delivered.map(e => e.tier), ['live', 'live']);
  assert.deepEqual(adapter.deliveries.map(d => d.event.text), ['one', 'two']);
  await scheduler.cancel(row.task);
});

test('V9 a malformed worker address with an empty task id is ignored like any non-worker address', async t => {
  const {session} = setup(t);
  const adapter = deliveringAdapter(() => ({never: true}), () => 'live');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  session.append({kind: 'message', to: 'worker:', text: 'hi', from: 'user'});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(session.events.filter(e => e.kind === 'task.delivered').length, 0);
  assert.equal(adapter.calls.deliver, 0);
  await scheduler.cancel(row.task);
});

test('V10 a message with no text is queued as malformed and never reaches the adapter', async t => {
  const {session} = setup(t);
  const adapter = deliveringAdapter(() => ({never: true}), () => 'live');
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  const message = session.append({kind: 'message', to: `worker:${row.task}`, from: 'user'});
  const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));

  assert.equal(delivered.tier, 'queued');
  assert.equal(delivered.text, 'no text');
  assert.equal(delivered.message, message.id);
  assert.equal(adapter.calls.deliver, 0);
  await scheduler.cancel(row.task);
});

test('V4b a deliver that throws synchronously is recorded as queued with its message', async t => {
  const {session} = setup(t);
  const adapter = deliveringAdapter(() => ({never: true}), () => 'live');
  adapter.deliver = () => { adapter.calls.deliver++; throw new Error('no socket'); };
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  session.append({kind: 'message', to: `worker:${row.task}`, text: 'hi', from: 'user'});
  const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered'));

  assert.equal(delivered.tier, 'queued');
  assert.equal(delivered.text, 'no socket');
  assert.equal(adapter.calls.deliver, 1);
  await scheduler.cancel(row.task);
});

test('adapter transcript events (assistant, tool, progress, error) become live task.activity rows, never journaled, never dropped', async t => {
  const {session} = setup(t);
  const live = [];
  session.subscribe(e => { if (e.kind === 'task.activity') live.push(e.text); });
  const adapter = fakeAdapter(() => [
    {kind: 'assistant', text: 'thinking aloud'}, {kind: 'tool', text: 'ls -la'}, {kind: 'progress', text: 'Bash · 3s'}, {kind: 'error', text: 'ECONN reset'},
    {kind: 'result', status: 'completed', text: 'ok'},
  ]);
  const scheduler = createScheduler({session, adapters: {a: adapter}, profiles: {p: {adapter: 'a', mode: 'yolo', fallback: []}}});
  const row = scheduler.submit({parent: null, profile: 'p', orders: 'x'});
  await waitFor(() => scheduler.tasks()[row.task].state === 'completed');
  assert.deepEqual(live, ['thinking aloud', 'ls -la', 'Bash · 3s', 'error: ECONN reset']);
  const journal = fs.readFileSync(session.file, 'utf8');
  assert.equal(journal.includes('thinking aloud'), false);
  assert.equal(session.events.some(e => e.kind === 'assistant' && e.task === row.task), false);
});
