import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {effectivePolicy} from '../src/profiles.js';
import {createClaudeLive} from '../src/adapters/claude-live.js';
import {createCodexLive} from '../src/adapters/codex-live.js';
import {createMuseLive} from '../src/adapters/muse-live.js';
import {createLocalLive} from '../src/adapters/local-live.js';
import {createFakeBackend} from '../src/adapters/backends/fake.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-policy-exec-'));
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

// E1: effectivePolicy unit — exact strings, per CONTRACT.md §1.
test('E1 effectivePolicy: read-only absolute, otherwise mode narrows write/unset', () => {
  assert.equal(effectivePolicy({policy: 'read-only'}), 'read-only');
  assert.equal(effectivePolicy({policy: 'write', mode: 'plan'}), 'plan');
  assert.equal(effectivePolicy({mode: 'yolo'}), 'yolo');
  assert.equal(effectivePolicy({}), 'yolo');
});

// E2: ratchet — a yolo profile under a plan session fails before launch; plan and read-only
// profiles under a plan session both launch.
test('E2 ratchet: yolo under plan fails before launch; plan and read-only under plan both launch', async t => {
  {
    const {session} = setup(t);
    const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
    const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, sessionMode: 'plan'});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
    assert.equal(scheduler.tasks()[row.task].reason, 'policy');
    assert.equal(adapter.calls.launch, 0);
  }
  {
    const {session} = setup(t);
    const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
    const profiles = {A: {adapter: 'fake', model: 'x', mode: 'plan', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, sessionMode: 'plan'});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
    assert.equal(adapter.calls.launch, 1);
  }
  {
    const {session} = setup(t);
    const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
    const profiles = {A: {adapter: 'fake', model: 'x', policy: 'read-only', mode: 'yolo', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, sessionMode: 'plan'});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
    assert.equal(adapter.calls.launch, 1);
  }
});

// E3: unsupported — the effective policy is not in the adapter's declared executionPolicies.
test('E3 unsupported: adapter declaring read-only refuses an effective-yolo profile, no fallback taken', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
  adapter.capabilities = () => ({executionPolicies: ['read-only']});
  const profiles = {
    A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: ['B']},
    B: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []},
  };
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
  const failedRow = session.events.find(e => e.kind === 'task.failed' && e.task === row.task);
  assert.equal(failedRow.reason, 'unsupported');
  assert.match(failedRow.text, /fake/);
  assert.match(failedRow.text, /yolo/);
  assert.equal(adapter.calls.launch, 0);
  assert.equal(session.events.some(e => e.kind === 'policy.fallback'), false);
  assert.equal(session.events.some(e => e.kind === 'task.submitted' && e.profile === 'B'), false);
});

// E4: no downgrade — the unsupported case never launches at a weaker policy: exactly one
// task.failed, zero task.started, zero budget.reserved consumed (released if reserved).
test('E4 no downgrade: unsupported never launches the worker at a weaker policy', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
  adapter.capabilities = () => ({executionPolicies: ['read-only']});
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
  assert.equal(session.events.filter(e => e.kind === 'task.failed' && e.task === row.task).length, 1);
  assert.equal(session.events.some(e => e.kind === 'task.started' && e.task === row.task), false);
  const reserved = session.events.filter(e => e.kind === 'budget.reserved' && e.task === row.task).length;
  const released = session.events.filter(e => e.kind === 'budget.released' && e.task === row.task).length;
  assert.equal(reserved, released);
});

// E5: a bare fake with no executionPolicies (or no capabilities at all) is unconstrained.
test('E5 backward compat: no executionPolicies key means unconstrained', async t => {
  {
    const {session} = setup(t);
    const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
    // no capabilities() at all
    const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
    assert.equal(adapter.calls.launch, 1);
  }
  {
    const {session} = setup(t);
    const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'x'}]);
    adapter.capabilities = () => ({live: true}); // capabilities present, but no executionPolicies key
    const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
    const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
    assert.equal(adapter.calls.launch, 1);
  }
});

// E6: live-adapter capabilities — exact executionPolicies lists.
test('E6 live-adapter capabilities: executionPolicies deepEqual the declared ladder rungs', () => {
  assert.deepEqual(createClaudeLive().capabilities().executionPolicies, ['read-only', 'plan', 'yolo']);
  assert.deepEqual(createCodexLive().capabilities().executionPolicies, ['read-only', 'plan', 'yolo']);
  assert.deepEqual(createMuseLive().capabilities().executionPolicies, ['read-only', 'plan', 'yolo']);
  assert.deepEqual(createLocalLive().capabilities().executionPolicies, ['read-only', 'plan', 'write']);
});

// E7: real seam — local through the real scheduler with an effective-yolo profile is
// unsupported; with a read-only profile it launches (drives the fake backend).
test('E7 real seam: local refuses effective-yolo, launches effective-read-only', async t => {
  {
    const {session} = setup(t);
    const script = [[{kind: 'done', text: 'hello'}]];
    const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
    const scheduler = createScheduler({session, adapters: {local: adapter}, profiles: {p: {adapter: 'local', backend: 'fake', model: '', mode: 'yolo', fallback: [], script}}});
    const row = scheduler.submit({parent: null, profile: 'p', orders: 'say hello'});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
    assert.equal(scheduler.tasks()[row.task].reason, 'unsupported');
  }
  {
    const {session} = setup(t);
    const script = [[{kind: 'done', text: 'hello'}]];
    const adapter = createLocalLive({backends: {fake: createFakeBackend()}});
    const scheduler = createScheduler({session, adapters: {local: adapter}, profiles: {p: {adapter: 'local', backend: 'fake', model: '', policy: 'read-only', fallback: [], script}}});
    t.after(async () => { await scheduler.cancel(row.task); scheduler.close(); });
    const row = scheduler.submit({parent: null, profile: 'p', orders: 'say hello'});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
    assert.equal(scheduler.tasks()[row.task].state, 'completed');
  }
});

// E8 (Amendment A1): a completion review is a review launch too — gated the same way as the
// prelaunch review, before it reserves a start. A review adapter that cannot enforce the
// reviewer's effective policy escalates and blocks; the review never launches.
test('E8 completion-review gate: unsupported reviewer policy escalates and blocks, no review launch, no reservation', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const reviewAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  reviewAdapter.capabilities = () => ({executionPolicies: ['yolo']});
  const profiles = {
    A: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: []},
    C: {adapter: 'review', model: 'c', mode: 'yolo', policy: 'read-only', fallback: [], role: 'critic'},
  };
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, review: reviewAdapter}, profiles});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  const kinds = session.events.filter(e => e.task === row.task || e.kind === 'peer.joined').map(e => e.kind);
  assert.deepEqual(kinds, ['task.submitted', 'budget.reserved', 'peer.joined', 'task.started', 'task.completed', 'policy.escalated', 'task.blocked']);
  const escalated = session.events.find(e => e.kind === 'policy.escalated' && e.task === row.task);
  assert.equal(escalated.reason, 'unsupported');
  assert.match(escalated.text, /review/);
  assert.match(escalated.text, /read-only/);
  assert.equal(reviewAdapter.calls.launch, 0);
  // Only the worker's own start was ever reserved; the review's own start never was.
  assert.equal(session.events.filter(e => e.kind === 'budget.reserved' && e.task === row.task).length, 1);
});
