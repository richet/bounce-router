// A check-only task (submit with `at`): no worker turn, the check runs on that commit in a copy, and the task ends
// accepted or failed. It never goes through delivery, so it never ends blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const setup = (t, {delivery = 'branch'} = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-check-only-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@example.com'); git(project, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(project, 'version.txt'), 'one\n');
  git(project, 'add', '.'); git(project, 'commit', '-qm', 'one');
  const first = git(project, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(project, 'version.txt'), 'two\n');
  git(project, 'commit', '-qam', 'two');
  if (delivery) git(project, 'config', 'bounce.delivery', delivery);
  const session = new Session(project, {root: path.join(root, 'home')});
  const worker = fakeAdapter(() => { throw new Error('a check-only task launched a worker'); });
  const scheduler = createScheduler({session, adapters: {worker}, requireFinalReport: true, gitHead: () => null,
    profiles: {analyst: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {project, session, scheduler, worker, first};
};
const waitFor = async (fn, timeout = 5000) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const ended = (scheduler, task) => waitFor(() => ['accepted', 'failed', 'blocked'].includes(scheduler.tasks()[task]?.state) && scheduler.tasks()[task].state);

test('a passed check on a ref ends accepted, not delivery_detached, under branch delivery', async t => {
  const {session, scheduler, worker, first} = setup(t);
  const {task} = scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: first.slice(0, 7), check: 'grep -qx one version.txt'});
  assert.equal(await ended(scheduler, task), 'accepted');
  assert.equal(session.events.find(e => e.kind === 'task.submitted' && e.task === task).commit, first);
  const check = session.events.findLast(e => e.kind === 'task.check' && e.task === task);
  assert.equal(check.passed, true);
  assert.equal(check.head, first);
  assert.equal(worker.calls.launch, 0);
  assert.equal(session.events.some(e => e.task === task && ['task.blocked', 'task.integrated', 'policy.escalated'].includes(e.kind)), false);
});

test('a failed check ends failed with its output', async t => {
  const {session, scheduler} = setup(t);
  const {task} = scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'main', check: 'cat version.txt; exit 3'});
  assert.equal(await ended(scheduler, task), 'failed');
  const failed = session.events.findLast(e => e.kind === 'task.failed' && e.task === task);
  assert.equal(failed.reason, 'check_failed');
  assert.match(failed.text, /exit 3.*main[\s\S]*two/);
});

test('a ref that names no commit is refused at submit, before any copy or worker', t => {
  const {session, scheduler} = setup(t);
  assert.throws(() => scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'deadbee', check: 'true'}), /at \(deadbee names no commit in the checkout/);
  assert.throws(() => scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'main'}), /check-only task needs a check/);
  assert.equal(session.events.some(e => e.kind === 'task.submitted'), false);
});
