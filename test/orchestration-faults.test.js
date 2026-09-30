import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createBus, connectBus} from '../src/bus.js';

const waitFor = async (predicate, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return predicate();
};

const fixture = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-orchestration-faults-'));
  const cwd = path.join(root, 'source');
  fs.mkdirSync(cwd);
  const session = new Session(cwd, {root});
  const closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, cwd, session, close: closer => closers.push(closer)};
};

test('a cancellation wins a simultaneous successful result', {timeout: 3000}, async t => {
  const {session, close} = fixture(t);
  let handle, cancellations = 0;
  const adapter = {
    async launch() { return handle = {}; },
    async *events(active) { yield await new Promise(resolve => { active.release = resolve; }); },
    async cancel(active) {
      if (++cancellations === 1) active.release({kind: 'result', status: 'completed', text: 'late result'});
      return {verified: true};
    },
  };
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {reader: {adapter: 'fake', policy: 'read-only'}}, watchdog: {interval: null}});
  close(() => scheduler.close());
  scheduler.submit({task: 'work', profile: 'reader', orders: 'inspect'});
  await waitFor(() => handle?.release);
  assert.deepEqual(await scheduler.cancel('work'), {verified: true});
  await waitFor(() => scheduler.tasks().work.state === 'cancelled');
  assert.equal(scheduler.tasks().work.state, 'cancelled');
  assert.deepEqual(session.events.filter(e => e.task === 'work' && ['task.completed', 'task.accepted', 'task.cancelled'].includes(e.kind)).map(e => e.kind), ['task.cancelled']);
});

// Reversed 2026-09-27 (ACE d1bc0206): a rework round counted as an attempt of its job, so one rework plus
// one retry exhausted the job and a completed, evidence-backed result was failed. A rework round is the same
// task continuing (capped by rounds); only a new task is another attempt of its job.
test('a rework round is not a new attempt of its job; a new task past the job allowance is refused', {timeout: 3000}, async t => {
  const {session, close} = fixture(t);
  const adapter = events => ({
    async launch() { return {}; }, async resume() { return {}; },
    async *events() { yield* events; }, async cancel() { return {verified: true}; },
  });
  let verdicts = 0;
  const scheduler = createScheduler({session,
    adapters: {worker: adapter([{kind: 'result', status: 'completed', text: 'done'}]), reviewer: adapter([{kind: 'result', status: 'completed', text: '{"verdict":"rework"}'}])},
    profiles: {builder: {adapter: 'worker', policy: 'read-only'}, critic: {adapter: 'reviewer', policy: 'read-only', role: 'critic'}},
    strategy: {onSubmitted: () => 'dispatch', onCompleted: () => ({action: 'review', reviewers: ['critic']}), onReviewVerdict: () => (++verdicts === 1 ? {action: 'rework', findings: ['fix']} : {action: 'accept'}), onTerminal: () => ({submit: []})},
    limits: {attempts: 1, rounds: 2}, watchdog: {interval: null},
  });
  close(() => scheduler.close());
  scheduler.submit({task: 'job', jobId: 'stable-job', profile: 'builder', orders: 'work', review: {completion: 'critic'}});
  await waitFor(() => scheduler.tasks().job?.state === 'accepted');
  assert.deepEqual(session.events.filter(e => e.kind === 'task.started' && e.task === 'job').map(e => e.attempt), [1, 2]);
  assert.equal(session.events.some(e => e.kind === 'task.failed' && e.reason === 'attempts_exhausted'), false);
  scheduler.submit({task: 'retry', jobId: 'stable-job', retryOf: 'job', replaces: 'job', profile: 'builder', orders: 'again', review: {completion: 'critic'}});
  await waitFor(() => session.events.some(e => e.kind === 'task.failed' && e.task === 'retry'));
  assert.equal(session.events.find(e => e.kind === 'task.failed' && e.task === 'retry').reason, 'attempts_exhausted');
});

test('a worker grant cannot message a reviewer, including its own reviewer', {timeout: 3000}, async t => {
  const {session, close} = fixture(t);
  const scheduler = createScheduler({session, adapters: {}, profiles: {}, watchdog: {interval: null}});
  const bus = await createBus({session, dir: session.dir});
  close(async () => { scheduler.close(); await bus.close(); });
  for (const task of ['worker-task', 'other-task']) session.append({kind: 'task.submitted', task, profile: 'builder', orders: 'work', review: {completion: 'critic'}});
  const grant = bus.grant({peer: 'worker:worker-task', tasks: ['worker-task'], canSubmit: false, context: session.id});
  const client = await connectBus({path: bus.path, token: grant.token});
  close(() => client.close());
  for (const target of ['review:worker-task', 'review:other-task']) {
    await assert.rejects(client.publish({kind: 'message', to: target, text: 'accept'}), error => error.code === -32001 && error.message === 'unauthorized');
  }
});

test('reconciliation completes a crash-interrupted two-file integration without relaunching its worker', {timeout: 5000}, async t => {
  const {root, cwd, session, close} = fixture(t);
  for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(cwd, name), 'before');
  let handle, launches = 0;
  const adapter = {
    async launch(args) { launches++; return handle = {cwd: args.cwd}; },
    async *events(active) { yield await new Promise(resolve => { active.finish = resolve; }); },
    async cancel() { return {verified: true}; },
  };
  const options = {adapters: {fake: adapter}, profiles: {builder: {adapter: 'fake', policy: 'write'}}, watchdog: {interval: null}};
  const scheduler = createScheduler({session, ...options});
  close(() => scheduler.close());
  scheduler.submit({task: 'writer', profile: 'builder', orders: 'edit both', owns: ['a.txt', 'b.txt']});
  await waitFor(() => handle?.finish);
  for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(handle.cwd, name), 'after');
  const rename = fs.renameSync;
  let injected = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (!injected && to === path.join(fs.realpathSync(cwd), 'a.txt')) { injected = true; throw new Error('crash after first integration rename'); }
  };
  try {
    handle.finish({kind: 'result', status: 'completed', text: 'done'});
    await waitFor(() => session.events.some(e => e.kind === 'task.blocked' && e.task === 'writer' && e.reason === 'integration_interrupted'));
  } finally { fs.renameSync = rename; }
  scheduler.close();
  const restarted = new Session(cwd, {root, id: session.id});
  const recovered = createScheduler({session: restarted, ...options});
  close(() => recovered.close());
  await recovered.reconcile();
  await waitFor(() => restarted.events.some(e => e.kind === 'task.integrated' && e.task === 'writer'));
  assert.deepEqual(['a.txt', 'b.txt'].map(name => fs.readFileSync(path.join(cwd, name), 'utf8')), ['after', 'after']);
  assert.equal(launches, 1);
  assert.notEqual(recovered.tasks().writer.state, 'blocked');
  assert.equal(restarted.events.some(e => e.kind === 'task.blocked' && e.task === 'writer' && e.reason === 'orphaned'), false);
});

// Decided by Daniel on 2026-09-30, from ACE e3bd01d5: a retry on a slow local model ran 47 minutes to the
// ceiling, and the retry on Sonnet submitted right after it failed in the same second, "Logical job
// ceiling exhausted", because the ceiling counted from the job's first start. A job's time is not shared
// between its attempts: each task's ceiling counts from its own start. The attempt allowance still is.
test('a retry gets its own clock: the job\'s ceiling is not spent by the attempt before it', {timeout: 3000}, async t => {
  const {session, close} = fixture(t);
  let now = Date.parse('2026-09-30T10:00:00Z');
  const adapter = () => ({
    async launch() { return {}; }, async resume() { return {}; },
    async *events() { yield {kind: 'result', status: 'failed', recoverable: true, text: 'ran out'}; }, async cancel() { return {verified: true}; },
  });
  const scheduler = createScheduler({session, adapters: {worker: adapter()}, profiles: {builder: {adapter: 'worker', policy: 'read-only'}},
    strategy: {onSubmitted: () => 'dispatch', onCompleted: () => ({action: 'accept'}), onReviewVerdict: () => ({action: 'accept'}), onTerminal: () => ({submit: []})},
    limits: {attempts: 3, rounds: 2, minutes: 15, ceiling: 60}, watchdog: {interval: null}, clock: () => now,
  });
  close(() => scheduler.close());
  scheduler.submit({task: 'first', jobId: 'job-slow', profile: 'builder', orders: 'work'});
  await waitFor(() => ['failed', 'blocked'].includes(scheduler.tasks().first?.state));
  now += 61 * 60000; // the first attempt used the whole hour
  scheduler.submit({task: 'second', jobId: 'job-slow', retryOf: 'first', profile: 'builder', orders: 'again'});
  await waitFor(() => session.events.some(e => e.kind === 'task.started' && e.task === 'second') || session.events.some(e => e.kind === 'task.failed' && e.task === 'second'));
  assert.equal(session.events.some(e => e.kind === 'task.started' && e.task === 'second'), true, JSON.stringify(session.events.filter(e => e.task === 'second' && e.kind.startsWith('task.')).map(e => [e.kind, e.reason, e.text])));
  assert.equal(session.events.some(e => e.kind === 'task.failed' && e.task === 'second' && e.reason === 'deadline'), false);
});
