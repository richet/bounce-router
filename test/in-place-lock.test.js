// Phase 3 (docs/plans/in-place-tasks.md §5/§6): the integration lock. While an in-place task is
// `running`, an `integrate` action stays pending (never started) and runs — in order — once the
// task leaves `running`. A copy worker running in parallel is never paused for it. A second
// in-place task queues (`in_place_busy`) until the first ends. Restart replay: an orphaned
// in-place task keeps the lock held, so a pending integration still waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {tasks as tasksView} from '../src/reducers.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {createAttemptWorkspace, captureArtifact} from '../src/workspace-artifacts.js';
import {requestAction} from '../src/orchestration.js';

const waitFor = async (predicate, timeout = 3_000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const settle = () => new Promise(resolve => setTimeout(resolve, 60));

function setup(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'old\n');
  const session = new Session(cwd, {root});
  return {root, cwd, session};
}
const builder = {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'};
const inplaceProfile = {...builder, adapter: 'inplace'};

// A started `{never: true}` in-place worker the test ends later, like test/slot-handoff.test.js's `endable`.
function endable(adapter) {
  const started = new Map();
  const launch = adapter.launch;
  adapter.launch = async function (args) {
    const handle = await launch.call(this, args);
    started.set(args.orders, handle);
    return handle;
  };
  const end = (name, result) => {
    const handle = started.get(name);
    handle.after = [result];
    handle.ended = true;
    for (const waiter of handle.waiters.splice(0)) waiter();
  };
  return {started, end};
}

test('an integration requested while an in-place task is running stays pending; a parallel copy worker is never paused', async t => {
  const {root, cwd, session} = setup('bounce-inplace-lock-');
  const inplace = fakeAdapter(() => ({never: true}));
  const worker = fakeAdapter(({cwd: work}) => { fs.writeFileSync(path.join(work, 'src', 'a.js'), 'new\n'); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  const {end} = endable(inplace);
  const scheduler = createScheduler({session, adapters: {inplace, worker}, profiles: {I: inplaceProfile, A: builder}, gitHead: () => null, watchdog: {interval: null}});
  t.after(async () => { await scheduler.stop(); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });

  const user = session.append({kind: 'user', text: 'commit it', from: 'user'});
  const ip = scheduler.submit({parent: null, profile: 'I', orders: 'git commit', deadline: null, requires: ['write', 'exec'], inPlace: {authorizedBy: user.seq}});
  await waitFor(() => tasksView(session.events)[ip.task]?.state === 'running');

  const fix = scheduler.submit({task: 'fix', parent: null, profile: 'A', from: 'orchestrator', owns: ['src/a.js'], requires: ['read', 'exec', 'write'], orders: 'change a'});
  await waitFor(() => session.events.some(e => e.kind === 'task.integration.requested' && e.task === 'fix'));
  await settle();
  // The copy worker's own process already ran to completion on its own schedule — one launch,
  // no cancel — nothing about the lock touched its lease; only the file-copy step (and with it,
  // the durable task.completed bookkeeping, which is always gated on integration) waits.
  assert.equal(worker.calls.launch, 1, 'the copy worker ran exactly once: no retry, no second attempt forced by the lock');
  assert.equal(tasksView(session.events).fix.state, 'running');
  assert.equal(session.events.some(e => e.kind === 'task.completed' && e.task === 'fix'), false);
  assert.equal(session.events.some(e => e.kind === 'task.integrated' && e.task === 'fix'), false, 'integration stayed gated');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'old\n');
  const waiting = session.events.find(e => e.kind === 'task.milestone' && e.task === 'fix' && e.reason === 'in_place_busy');
  assert.match(waiting.text, new RegExp(`waiting for ${ip.task} \\(in place\\)`, 'i'));

  end(ip.orders, {kind: 'result', status: 'completed', text: 'done'});
  await waitFor(() => tasksView(session.events)[ip.task]?.state === 'completed');
  await waitFor(() => session.events.some(e => e.kind === 'task.integrated' && e.task === 'fix'));
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'new\n');
});

test('a second in-place task waits (in_place_busy) for the first, then runs', async t => {
  const {root, session} = setup('bounce-inplace-lock-second-');
  const inplace = fakeAdapter(() => ({never: true}));
  const {end} = endable(inplace);
  const scheduler = createScheduler({session, adapters: {inplace}, profiles: {I: inplaceProfile}, gitHead: () => null, watchdog: {interval: null}});
  t.after(async () => { await scheduler.stop(); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });

  const first = session.append({kind: 'user', text: 'commit it', from: 'user'});
  const one = scheduler.submit({parent: null, profile: 'I', orders: 'first', deadline: null, requires: ['write', 'exec'], inPlace: {authorizedBy: first.seq}});
  await waitFor(() => tasksView(session.events)[one.task]?.state === 'running');

  const second = session.append({kind: 'user', text: 'push it', from: 'user'});
  const two = scheduler.submit({parent: null, profile: 'I', orders: 'second', deadline: null, requires: ['write', 'exec'], inPlace: {authorizedBy: second.seq}});
  await waitFor(() => session.events.some(e => e.kind === 'task.milestone' && e.task === two.task && e.reason === 'in_place_busy'));
  assert.equal(tasksView(session.events)[two.task].state, 'queued');

  end(one.orders, {kind: 'result', status: 'completed', text: 'done'});
  await waitFor(() => tasksView(session.events)[one.task]?.state === 'completed');
  await waitFor(() => tasksView(session.events)[two.task]?.state === 'running' || tasksView(session.events)[two.task]?.state === 'completed');
});

test('restart replay: an orphaned in-place task keeps its lock, so a pending integration still waits', async t => {
  const {root, cwd, session} = setup('bounce-inplace-lock-restart-');
  const row = event => session.append({...event}); // Session assigns its own seq/time
  const user = row({kind: 'user', text: 'commit it', from: 'user'});
  row({kind: 'task.submitted', task: 'ip', parent: null, profile: 'I', from: 'orchestrator',
    orders: 'git commit', requires: ['write', 'exec'], inPlace: {authorizedBy: user.seq}});
  row({kind: 'task.started', task: 'ip', attempt: 1}); // no task.attempt.ended: a lost worker, exactly a restart finds

  // A 'fix' task whose artifact was already captured and its integration already durably
  // requested before the crash — the exact state a restart mid-integration leaves (§5 "queued
  // integrations still wait for its resolution").
  const wdir = path.join(root, 'tasks', 'fix');
  fs.mkdirSync(wdir, {recursive: true, mode: 0o700});
  const workspace = createAttemptWorkspace({cwd, dir: wdir, owns: ['src/a.js'], attemptId: 'fix-1'});
  fs.writeFileSync(path.join(workspace.cwd, 'src', 'a.js'), 'new\n');
  const artifact = captureArtifact(workspace);
  row({kind: 'task.submitted', task: 'fix', parent: null, profile: 'A', from: 'orchestrator', owns: ['src/a.js'], requires: ['read', 'exec', 'write'], orders: 'change a'});
  row({kind: 'task.started', task: 'fix', attempt: 1});
  row({kind: 'task.attempt.ended', task: 'fix', attempt: 1, verifiedTermination: true});
  const artifactFile = path.join(workspace.dir, 'artifacts', `${artifact.id}.json`);
  row({kind: 'task.artifact', task: 'fix', attempt: 1, artifactId: artifact.id, digest: artifact.digest, resultHash: artifact.resultHash, file: artifactFile, dir: workspace.dir, cwd: workspace.cwd});
  requestAction(session, {actionId: `integrate:fix:${artifact.id}`, type: 'integrate', task: 'fix',
    payload: {artifactId: artifact.id, file: artifactFile, dir: workspace.dir, continuation: {kind: 'task.completed', task: 'fix', summary: 'done'}}},
  [{kind: 'task.integration.requested', task: 'fix', artifactId: artifact.id, digest: artifact.digest}]);

  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {I: inplaceProfile, A: builder}, gitHead: () => null, watchdog: {interval: null}});
  t.after(async () => { await scheduler.stop(); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });

  await waitFor(() => session.events.some(e => e.kind === 'task.blocked' && e.task === 'ip' && e.reason === 'orphaned'));
  // reload.js calls scheduler.reconcile() on `--resume`: this is what actually re-drives a
  // pending action left over from before the crash (the integrate action's own subscription
  // only ever sees NEW `orchestration.action.requested` rows, not history).
  await scheduler.reconcile();
  await settle();
  assert.equal(session.events.some(e => e.kind === 'task.integrated' && e.task === 'fix'), false, 'the pending integration stayed gated behind the orphaned in-place task');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'old\n');
});
