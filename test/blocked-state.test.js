// A task shows blocked only when it waits for an answer. A worker that reports blocked while its turn goes on is
// still working on its own; a check that runs out of time is a failed check, not a question.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const setup = (t, script, {adapter, ...options} = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-blocked-state-')));
  const session = new Session(root, {root: path.join(root, 'home')});
  const scheduler = createScheduler({session, adapters: {worker: adapter ?? fakeAdapter(script)}, requireFinalReport: true, gitHead: () => null,
    profiles: {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}, ...options});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {session, scheduler};
};
const waitFor = async (fn, timeout = 3000) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const final = (outcome, summary) => JSON.stringify({op: 'final', phase: 'test', text: summary, next: 'none', evidence: [], outcome, summary, remaining: ''});
const waiting = {op: 'blocked', phase: 'test', text: 'the test run ended with operation_timeout; waiting one minute before the single retry', next: 'retry once'};

// The worker reports from inside its turn: once the attempt has started, it sends `report`, then its turn yields
// `after` (or holds, when `after` is null).
const reporting = (box, report, after) => {
  const adapter = fakeAdapter(() => ({never: true}));
  adapter.events = async function* () {
    await new Promise(resolve => setTimeout(resolve, 20));
    box.scheduler.report({task: box.task(), attempt: 1, report});
    if (!after) return void await new Promise(() => {});
    yield* after;
  };
  return adapter;
};

test('a blocked report mid-turn is a milestone while the worker keeps going', async t => {
  const box = {};
  const {session, scheduler} = setup(t, null, {adapter: reporting(box, waiting, null)});
  box.scheduler = scheduler; box.task = () => task;
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'run the tests', deadline: null});
  const milestone = await waitFor(() => session.events.findLast(e => e.kind === 'task.milestone' && e.task === task && e.waiting));
  assert.match(milestone.text, /operation_timeout/);
  await waitFor(() => scheduler.tasks()[task]?.state === 'running');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(scheduler.tasks()[task].state, 'running');
  assert.equal(session.events.some(e => e.task === task && (e.kind === 'task.blocked' || e.kind === 'policy.escalated')), false);
});

test('a worker that reported blocked, then finished, completes with no blocked row', async t => {
  const box = {};
  const {session, scheduler} = setup(t, null, {adapter: reporting(box, waiting, [{kind: 'result', status: 'completed', text: final('completed', 'retried; the tests pass')}])});
  box.scheduler = scheduler; box.task = () => task;
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'run the tests', deadline: null});
  await waitFor(() => ['completed', 'accepted'].includes(scheduler.tasks()[task]?.state));
  assert.equal(session.events.some(e => e.task === task && (e.kind === 'task.blocked' || e.kind === 'policy.escalated')), false);
});

test('a turn that ends on its blocked report leaves the task blocked, waiting for an answer', async t => {
  const box = {};
  const {session, scheduler} = setup(t, null, {adapter: reporting(box, {...waiting, text: 'need the staging password', next: 'wait for it'}, [{kind: 'result', status: 'completed', text: ''}])});
  box.scheduler = scheduler; box.task = () => task;
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'run the tests', deadline: null});
  await waitFor(() => scheduler.tasks()[task]?.state === 'blocked');
  const blocked = session.events.findLast(e => e.kind === 'task.blocked' && e.task === task);
  assert.equal(blocked.reason, 'worker_blocked');
  assert.equal(blocked.text, 'need the staging password');
});

test('a check that times out fails the task with check_timeout, no rework', async t => {
  const runs = [];
  const checkRunner = async ({command, timeoutMs}) => { runs.push(timeoutMs); return {command, exit: null, passed: false, output: 'building', ms: timeoutMs + 13, timedOut: true, minutes: Math.round(timeoutMs / 60_000)}; };
  const {session, scheduler} = setup(t, () => [{kind: 'result', status: 'completed', text: final('completed', 'ready for the gate')}], {checkRunner});
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'run the gate', deadline: null, check: 'make e2e'});
  await waitFor(() => scheduler.tasks()[task]?.state === 'failed');
  const failed = session.events.findLast(e => e.kind === 'task.failed' && e.task === task);
  assert.equal(failed.reason, 'check_timeout');
  assert.match(failed.text, /did not finish in 10 minutes.*make e2e.*checkTimeoutMinutes/);
  assert.deepEqual(runs, [600_000]);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(session.events.some(e => e.task === task && ['task.rework', 'task.blocked', 'policy.escalated'].includes(e.kind)), false);
});

test('a task sets its own check limit at submit, within bounds and only with a check', async t => {
  const runs = [];
  const checkRunner = async ({command, timeoutMs}) => { runs.push(timeoutMs); return {command, exit: 0, passed: true, output: 'ok', ms: 5}; };
  const {scheduler} = setup(t, () => [{kind: 'result', status: 'completed', text: final('completed', 'ready')}], {checkRunner});
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'run the gate', deadline: null, check: 'make e2e', checkTimeoutMinutes: 45});
  await waitFor(() => runs.length);
  assert.deepEqual(runs, [45 * 60_000]);
  assert.throws(() => scheduler.submit({parent: null, profile: 'builder', orders: 'x', deadline: null, check: 'true', checkTimeoutMinutes: 500}), /checkTimeoutMinutes/);
  assert.throws(() => scheduler.submit({parent: null, profile: 'builder', orders: 'x', deadline: null, checkTimeoutMinutes: 5}), /checkTimeoutMinutes/);
  assert.ok(task);
});
