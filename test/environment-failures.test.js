// A check that failed because of the machine (git objects, disk, memory, Docker) is not the work's fault: the task is
// held for the orchestrator with the cause, and the worker is not sent back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {environmentCause, ENVIRONMENT_SIGNATURES} from '../src/environment-failures.js';

const failedWith = output => ({command: 'make test', exit: 1, passed: false, output});

test('each known environment signature is recognised, and an ordinary failure is not', () => {
  const samples = {
    git_objects: 'error: unable to read 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nfatal: bad object HEAD',
    disk_full: 'npm ERR! code ENOSPC\nnpm ERR! syscall write',
    out_of_memory: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
    docker_daemon: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
    docker_timeout: 'failed to solve: exporting layers: context deadline exceeded',
  };
  assert.deepEqual(ENVIRONMENT_SIGNATURES.map(signature => signature.cause), Object.keys(samples));
  for (const [cause, output] of Object.entries(samples)) assert.equal(environmentCause(failedWith(output))?.cause, cause, cause);
  assert.equal(environmentCause(failedWith('AssertionError: expected 2 to equal 3\n1 failing')), null);
  assert.equal(environmentCause({...failedWith('ENOSPC'), passed: true}), null);
  assert.equal(environmentCause({...failedWith('ENOSPC'), timedOut: true}), null);
});

const final = summary => JSON.stringify({op: 'final', phase: 'test', text: summary, next: 'none', evidence: [], outcome: 'completed', summary, remaining: ''});
const waitFor = async (fn, timeout = 4000) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('a check that fails on a full disk holds the task with the cause, with no rework round and no restart', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-env-')));
  const session = new Session(root, {root: path.join(root, 'home')});
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: final('done')}]);
  const checkRunner = async ({command}) => ({command, exit: 1, passed: false, output: 'write /tmp/x: no space left on device', ms: 5});
  const scheduler = createScheduler({session, adapters: {worker}, requireFinalReport: true, gitHead: () => null, checkRunner,
    profiles: {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'build it', deadline: null, check: 'make test'});
  await waitFor(() => scheduler.tasks()[task]?.state === 'blocked');
  const blocked = session.events.findLast(e => e.kind === 'task.blocked' && e.task === task);
  assert.equal(blocked.reason, 'check_environment');
  assert.match(blocked.text, /outside the code: the disk is full \(disk_full\)[\s\S]*not a rework round[\s\S]*Do not restart the builder/);
  assert.equal(session.events.findLast(e => e.kind === 'task.check' && e.task === task).environment.cause, 'disk_full');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(session.events.some(e => e.task === task && e.kind === 'task.rework'), false);
  assert.equal(worker.calls.launch, 1);
  assert.equal(worker.calls.resume, 0);
});

test('a check-only task that fails on the machine ends failed with reason environment and the cause', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-env-only-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', args, {cwd: project, stdio: 'ignore'});
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-qm', 'a');
  const session = new Session(project, {root: path.join(root, 'home')});
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(() => [])}, requireFinalReport: true, gitHead: () => null,
    checkRunner: async ({command}) => ({command, exit: 1, passed: false, output: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock', ms: 5}),
    profiles: {analyst: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const {task} = scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'main', check: 'make e2e'});
  await waitFor(() => scheduler.tasks()[task]?.state === 'failed');
  const failed = session.events.findLast(e => e.kind === 'task.failed' && e.task === task);
  assert.equal(failed.reason, 'environment');
  assert.equal(failed.cause, 'docker_daemon');
});

test('a check that could not run holds a task that has no review, instead of leaving it completed', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-env-unrunnable-')));
  const session = new Session(root, {root: path.join(root, 'home')});
  const checkRunner = async ({command}) => ({command, exit: 127, passed: false, unrunnable: true, output: 'sh: 1: make: command not found', ms: 5});
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(() => [{kind: 'result', status: 'completed', text: final('done')}])}, requireFinalReport: true, gitHead: () => null, checkRunner,
    profiles: {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'build it', deadline: null, check: 'make test'});
  await waitFor(() => scheduler.tasks()[task]?.state === 'blocked');
  assert.equal(session.events.findLast(e => e.kind === 'task.blocked' && e.task === task).reason, 'check_unrunnable');
});
