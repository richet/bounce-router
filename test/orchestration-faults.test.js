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

test('a rework cannot launch a second attempt after its logical job cap', {timeout: 3000}, async t => {
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
  await waitFor(() => session.events.some(e => e.kind === 'task.failed' && e.task === 'job' && e.reason === 'attempts_exhausted'));
  assert.deepEqual(session.events.filter(e => e.kind === 'task.started' && e.task === 'job').map(e => e.attempt), [1]);
  assert.equal(scheduler.tasks().job.reason, 'attempts_exhausted');
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
