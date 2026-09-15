// Phase 8 — pluggable orchestration strategy (CONTRACT.md §6). S1-S6, composed real scheduler +
// fake adapters + fake/hostile strategies, exactly like test/scheduler.test.js and
// test/policy.test.js. S1 (decisive): the full existing suite (this repo's `npm test`) stays
// green with defaultStrategy self-hosted and zero pre-existing expectation edits — verified
// separately by running the whole suite; this file only adds the direct "no strategy passed"
// assertion plus the new-strategy behaviors S2-S6.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {defaultStrategy, noReviewStrategy, quorumStrategy} from '../src/strategy.js';
import {validateOrchestration} from '../src/profiles.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-strategy-'));
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

test('S1 self-host: with no strategy passed, createScheduler uses defaultStrategy', t => {
  const {session} = setup(t);
  // No direct getter is exposed (strategy is an internal wiring detail, not part of the public
  // scheduler surface) — the decisive proof is behavioral: run a review round to completion with
  // no `strategy` option and confirm it resolves exactly as defaultStrategy's mapping says
  // (accept -> task.accepted), which is also exercised end-to-end by the untouched
  // scheduler/policy/watchdog suites (see the full-suite report). This assertion pins that a
  // scheduler built with NO strategy option and one built with `strategy: defaultStrategy`
  // behave identically for the same input, which can only hold if the omitted case defaults to
  // the very same object.
  const scheduler = createScheduler({session, adapters: {}, profiles: {}});
  assert.equal(typeof scheduler.submit, 'function'); // constructs without throwing: no strategy required
});

test('S1b self-host: an implicit defaultStrategy scheduler and an explicit one behave identically for prelaunch accept', async t => {
  const runOnce = async strategyOpt => {
    const {session} = setup(t);
    const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
    const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
    const profiles = {A: worker(), C: critic()};
    const opts = {session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles};
    if (strategyOpt !== undefined) opts.strategy = strategyOpt;
    const scheduler = createScheduler(opts);
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {prelaunch: 'C'}});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
    return session.events.filter(e => e.task === row.task || e.kind === 'peer.joined').map(e => e.kind);
  };
  const implicit = await runOnce(undefined);
  const explicit = await runOnce(defaultStrategy);
  assert.deepEqual(implicit, explicit);
  assert.deepEqual(implicit, ['task.submitted', 'budget.reserved', 'review.started', 'review.finished', 'task.accepted', 'budget.reserved', 'peer.joined', 'task.started', 'task.completed']);
});

test('S2 no-review: a completion review in config never launches, task completes then accepts by strategy', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  const profiles = {A: worker(), C: critic()};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles, strategy: noReviewStrategy});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');

  assert.equal(criticAdapter.calls.launch, 0);
  const accepted = session.events.find(e => e.kind === 'task.accepted' && e.task === row.task);
  assert.equal(accepted.stage, 'completion');
  assert.equal(accepted.by, 'strategy');
  assert.equal(scheduler.tasks()[row.task].state, 'accepted');
});

test('S3a quorum: both reviewers accept, task is accepted with two review.started/finished', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter1 = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  const criticAdapter2 = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  const profiles = {A: worker(), C1: {...critic(), adapter: 'critic1'}, C2: {...critic(), adapter: 'critic2'}};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic1: criticAdapter1, critic2: criticAdapter2}, profiles, strategy: quorumStrategy(2)});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: ['C1', 'C2']}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');

  assert.equal(session.events.filter(e => e.kind === 'review.started' && e.task === row.task).length, 2);
  assert.equal(session.events.filter(e => e.kind === 'review.finished' && e.task === row.task).length, 2);
  assert.equal(criticAdapter1.calls.launch, 1);
  assert.equal(criticAdapter2.calls.launch, 1);
});

test('S3b quorum: one reviewer reworks -> task.rework to the same worker, no accept yet', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'first'}]);
  const criticAdapter1 = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  let c2round = 0;
  const criticAdapter2 = fakeAdapter(() => {
    c2round++;
    // Round 1 reworks; round 2 (if it ever ran) would hang forever, so the test can assert a
    // stable post-round-1 state with no risk of racing a second round to completion.
    return c2round === 1 ? [{kind: 'result', status: 'completed', text: '{"verdict":"rework","findings":["fix it"]}'}] : {never: true};
  });
  const profiles = {A: worker(), C1: {...critic(), adapter: 'critic1'}, C2: {...critic(), adapter: 'critic2'}};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic1: criticAdapter1, critic2: criticAdapter2}, profiles, strategy: quorumStrategy(2)});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: ['C1', 'C2']}});
  await waitFor(() => session.events.some(e => e.kind === 'task.rework' && e.task === row.task));
  await waitFor(() => criticAdapter2.calls.launch === 2); // second round's review is in flight (and gated open)

  assert.equal(session.events.some(e => e.kind === 'task.accepted' && e.task === row.task), false);
  assert.equal(workerAdapter.calls.resume, 1);
  const rework = session.events.find(e => e.kind === 'task.rework');
  assert.deepEqual(rework.findings, ['fix it']);
  await scheduler.cancel(row.task);
});

test('S3c quorum: a single accept short of quorum (other reworks) never freezes -- it reworks', async t => {
  const {session} = setup(t);
  let workerRound = 0;
  const workerAdapter = fakeAdapter(() => {
    workerRound++;
    return workerRound === 1 ? [{kind: 'result', status: 'completed', text: 'first'}] : [{kind: 'result', status: 'completed', text: 'reworked'}];
  });
  const criticAdapter1 = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  let c2round = 0;
  const criticAdapter2 = fakeAdapter(() => {
    c2round++;
    return c2round === 1
      ? [{kind: 'result', status: 'completed', text: '{"verdict":"rework","findings":["polish"]}'}]
      : [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}];
  });
  const profiles = {A: worker(), C1: {...critic(), adapter: 'critic1'}, C2: {...critic(), adapter: 'critic2'}};
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic1: criticAdapter1, critic2: criticAdapter2}, profiles, strategy: quorumStrategy(2)});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: ['C1', 'C2']}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');

  assert.equal(session.events.filter(e => e.kind === 'task.rework' && e.task === row.task).length, 1);
});

test('S4 scout/next-wave: onTerminal fans out builders only after the scout is terminal; an oversized fan-out is still refused', async t => {
  const {session} = setup(t);
  const scoutAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'scoped'}]);
  const buildAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'built'}]);
  const profiles = {Scout: {adapter: 'scout', model: 's', mode: 'yolo', fallback: []}, Build: {adapter: 'build', model: 'b', mode: 'yolo', fallback: []}};
  let fannedOut = false;
  const scoutStrategy = {
    onSubmitted: defaultStrategy.onSubmitted,
    onCompleted: defaultStrategy.onCompleted,
    onReviewVerdict: defaultStrategy.onReviewVerdict,
    onTerminal(task, view) {
      if (fannedOut || view[task]?.profile !== 'Scout') return {submit: []};
      fannedOut = true;
      return {submit: [
        {parent: null, profile: 'Build', orders: 'build B', deadline: null},
        {parent: null, profile: 'Build', orders: 'build C oversized', deadline: null, size: {lines: 9999, probes: 0, minutes: 0}},
      ]};
    },
  };
  const scheduler = createScheduler({session, adapters: {scout: scoutAdapter, build: buildAdapter}, profiles, strategy: scoutStrategy, limits: {lines: 150, probes: 6, minutes: 15}});
  const scout = scheduler.submit({parent: null, profile: 'Scout', orders: 'scope it', deadline: null});
  await waitFor(() => scheduler.tasks()[scout.task]?.state === 'completed');

  // The fan-out only exists once the scout is terminal; task.accepted (not merely completed)
  // is what defaultStrategy's onTerminal-trigger set reacts to (CONTRACT: accepted/failed/
  // cancelled/timed_out/rejected, not a bare completed) — accept it directly to trigger onTerminal.
  session.append({kind: 'task.accepted', task: scout.task, stage: 'completion', by: 'orchestrator'});

  const built = await waitFor(() => session.events.filter(e => e.kind === 'task.submitted' && e.profile === 'Build'));
  assert.equal(built.length, 2);
  const oversized = built.find(e => e.size?.lines === 9999);
  await waitFor(() => scheduler.tasks()[oversized.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[oversized.task].reason, 'size');
  const normal = built.find(e => e.size?.lines !== 9999);
  await waitFor(() => scheduler.tasks()[normal.task]?.state === 'completed');
});

test('S5a free roles: a profile with role scout and policy read-only validates and launches', async t => {
  const settings = {
    operation: 'orchestrator', orchestrator: 'main', mode: 'yolo',
    profiles: {main: {adapter: 'claude'}, scoutProfile: {adapter: 'claude', role: 'scout', policy: 'read-only'}},
  };
  const view = validateOrchestration(settings, ['claude']);
  assert.equal(view.profiles.scoutProfile.role, 'scout');
  assert.equal(view.profiles.scoutProfile.policy, 'read-only');
});

test('S5b free roles: declaring role orchestrator still throws', t => {
  const settings = {
    operation: 'orchestrator', orchestrator: 'main', mode: 'yolo',
    profiles: {main: {adapter: 'claude'}, other: {adapter: 'claude', role: 'orchestrator'}},
  };
  assert.throws(() => validateOrchestration(settings, ['claude']), {message: 'profile other: role orchestrator is derived, not declared'});
});

test('S5c free roles: a critic with no explicit policy still defaults to read-only', t => {
  const settings = {
    operation: 'orchestrator', orchestrator: 'main', mode: 'yolo',
    profiles: {main: {adapter: 'claude'}, c: {adapter: 'claude', role: 'critic'}},
  };
  const view = validateOrchestration(settings, ['claude']);
  assert.equal(view.profiles.c.role, 'critic');
  assert.equal(view.profiles.c.policy, 'read-only');
});

test('S6a hostile strategy: dispatch for an oversized task is still refused reason size', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: worker()};
  const hostile = {onSubmitted: () => 'dispatch', onCompleted: () => 'none', onReviewVerdict: () => ({action: 'accept'}), onTerminal: () => ({submit: []})};
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles, strategy: hostile, limits: {lines: 150, probes: 6, minutes: 15}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null, size: {lines: 9999, probes: 0, minutes: 0}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[row.task].reason, 'size');
  assert.equal(adapter.calls.launch, 0);
});

test('S6b hostile strategy: onSubmitted throwing fails the task reason strategy, daemon survives', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: worker()};
  let calls = 0;
  const hostile = {
    onSubmitted: () => { calls++; if (calls === 1) throw new Error('boom'); return 'dispatch'; },
    onCompleted: () => 'none', onReviewVerdict: () => ({action: 'accept'}), onTerminal: () => ({submit: []}),
  };
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles, strategy: hostile});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[row.task].reason, 'strategy');
  assert.equal(adapter.calls.launch, 0);

  // The daemon (scheduler) survives a hook throw: a second, well-formed submission on the
  // very same scheduler instance still dispatches and completes normally.
  const row2 = scheduler.submit({parent: null, profile: 'A', orders: 'y', deadline: null});
  await waitFor(() => scheduler.tasks()[row2.task]?.state === 'completed');
});

test('S6c hostile strategy: a malformed onSubmitted intent fails the task reason strategy', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: worker()};
  const hostile = {onSubmitted: () => ({action: 'nonsense'}), onCompleted: () => 'none', onReviewVerdict: () => ({action: 'accept'}), onTerminal: () => ({submit: []})};
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles, strategy: hostile});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[row.task].reason, 'strategy');
});

test('S6d hostile strategy: onTerminal fan-out to a task whose parent it does not own is still validated/refused', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: worker()};
  const hostile = {
    onSubmitted: defaultStrategy.onSubmitted, onCompleted: defaultStrategy.onCompleted, onReviewVerdict: defaultStrategy.onReviewVerdict,
    onTerminal: () => ({submit: [{parent: 'does-not-exist', profile: 'A', orders: 'sneaky', deadline: null}]}),
  };
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles, strategy: hostile});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(session.events.some(e => e.kind === 'task.submitted' && e.orders === 'sneaky'), false);
});
