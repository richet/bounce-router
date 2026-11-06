// A finished task's check and its completion review run at the same time (docs/plans/faster-verification.md). kb
// control session, 2026-11-04 (run a639d737): tasks sat "held before a decision" 11–64 minutes while gates ran one
// after another and reviews were dispatched only after them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {handoffBlock} from '../src/main-service.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (fn, timeout = 5000) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const report = summary => JSON.stringify({op: 'final', phase: 'complete', text: summary, next: '', evidence: [], outcome: 'completed', summary, remaining: ''});
const verdict = (value, findings = []) => [{kind: 'result', status: 'completed', text: JSON.stringify({verdict: value, findings})}];
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'}}).trim();

// The check is held open until the test lets it finish, so what happens while it runs can be seen.
function setup(t, {passes = true, reviewSays = 'accept'} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-faster-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), {recursive: true});
  fs.writeFileSync(path.join(project, 'src/x.js'), 'export const state = "old";\n');
  git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'First');
  const session = new Session(project, {root: path.join(root, 'home')});
  const seen = {reviewOrders: null};
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const checkRunner = async ({command, cwd}) => { await held; return {command, cwd, exit: passes ? 0 : 1, passed: passes, output: passes ? 'ok' : 'FAIL: x is old'}; };
  const adapters = {
    worker: fakeAdapter(args => { fs.writeFileSync(path.join(args.cwd, 'src/x.js'), 'export const state = "new";\n'); return [{kind: 'result', status: 'completed', text: report('state is now "new"')}]; }),
    reviewer: fakeAdapter(args => { seen.reviewOrders = args.orders; return verdict(reviewSays, reviewSays === 'accept' ? [] : ['x is wrong']); }),
  };
  const profiles = {
    builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'},
    critic: {adapter: 'reviewer', model: 'r', mode: 'yolo', fallback: [], role: 'reviewer', policy: 'read-only'},
  };
  const scheduler = createScheduler({session, adapters, profiles, requireFinalReport: true, gitHead: () => null, checkRunner});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const submit = (extra = {}) => scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js', owns: ['src/x.js'], deadline: null, check: 'npm test', review: {completion: 'critic'}, ...extra});
  const rows = (kind, task) => session.events.filter(e => e.kind === kind && e.task === task);
  return {session, scheduler, submit, rows, seen, release, project};
}

test('the review runs while the check runs; the verdict waits for the check, and the check row names the tree it passed on', async t => {
  const f = setup(t);
  const {task} = f.submit();
  await waitFor(() => f.rows('review.finished', task).length);
  assert.equal(f.rows('task.check', task).length, 0, 'the review finished while the check was still running');
  assert.equal(f.rows('task.accepted', task).length, 0, 'no decision before the check');
  f.release();
  await waitFor(() => ['accepted', 'blocked', 'failed'].includes(f.scheduler.tasks()[task]?.state));
  assert.equal(f.scheduler.tasks()[task].state, 'accepted');
  const check = f.rows('task.check', task)[0];
  const copy = check.cwd;
  const index = path.join(os.tmpdir(), `bounce-index-${process.pid}`);
  t.after(() => fs.rmSync(index, {force: true}));
  const env = {...process.env, GIT_INDEX_FILE: index};
  execFileSync('git', ['add', '-A'], {cwd: copy, env});
  assert.deepEqual([check.passed, check.head, check.tree], [true, git(copy, 'rev-parse', 'HEAD'), execFileSync('git', ['write-tree'], {cwd: copy, env, encoding: 'utf8'}).trim()]);
  assert.equal(git(copy, 'status', '--porcelain'), 'M src/x.js', 'the copy\'s own index is untouched');
  const accepted = f.rows('task.accepted', task).at(-1);
  assert.match(handoffBlock(f.session, [accepted]), new RegExp(`check: passed \\(exit code 0\\) on tree ${check.tree.slice(0, 12)} \\(head ${check.head.slice(0, 12)}\\)`));
  // bounce runs the check, so the reviewer reads with a read-only shell and runs nothing.
  assert.match(f.seen.reviewOrders, /bounce runs this task's check \(npm test\) itself, at the same time as your review: do not run tests, the stack CLI or anything that writes\. Read the change with read-only commands \(cat, sed, grep, git show, git diff, git log\)\./);
});

test('a failed check sends the work back even when the review accepted it', async t => {
  const f = setup(t, {passes: false});
  const {task} = f.submit();
  await waitFor(() => f.rows('review.finished', task).length);
  f.release();
  await waitFor(() => f.rows('task.rework', task).length || ['accepted', 'blocked', 'failed'].includes(f.scheduler.tasks()[task]?.state));
  assert.equal(f.rows('task.accepted', task).length, 0);
  assert.match(f.rows('task.rework', task)[0].findings.join('\n'), /FAIL: x is old/);
});

test('without a check the reviewer is not told bounce runs one', async t => {
  const f = setup(t);
  f.release();
  const {task} = f.submit({check: undefined});
  await waitFor(() => f.rows('review.finished', task).length);
  assert.equal(f.seen.reviewOrders.includes('bounce runs this task\'s check'), false);
});

// kb control, 2026-11-05: one full gate run takes 8 CPU and 16 GB of a 64 GB Docker VM. Checks share a machine-wide
// cap (gateSlots) as a queue that waits, never a failure, and each check row says how long it waited.
import {createMachineSlots} from '../src/machine-slots.js';
test('with one gate slot, a second task\'s check waits for the first to finish, says so, and records the wait', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-gates-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), {recursive: true});
  fs.writeFileSync(path.join(project, 'src/x.js'), 'old\n');
  git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'First');
  const session = new Session(project, {root: path.join(root, 'home')});
  let running = 0, most = 0, release;
  const first = new Promise(resolve => { release = resolve; });
  const checkRunner = async ({command, cwd}) => {
    running++; most = Math.max(most, running);
    if (command === 'gate one') await first; else await new Promise(resolve => setTimeout(resolve, 20));
    running--;
    return {command, cwd, exit: 0, passed: true, output: 'ok'};
  };
  const adapters = {worker: fakeAdapter(args => { fs.writeFileSync(path.join(args.cwd, 'src/x.js'), 'new\n'); return [{kind: 'result', status: 'completed', text: report('done')}]; })};
  const scheduler = createScheduler({session, adapters, profiles: {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}},
    requireFinalReport: true, gitHead: () => null, checkRunner, gateSlots: 1, gatePollMs: 10, machineSlots: createMachineSlots({dir: path.join(root, 'machine')})});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const one = scheduler.submit({parent: null, profile: 'builder', orders: 'a', owns: ['src/**'], deadline: null, check: 'gate one'});
  await waitFor(() => running === 1);
  const two = scheduler.submit({parent: null, profile: 'builder', orders: 'b', owns: ['src/**'], deadline: null, check: 'gate two'});
  const waiting = await waitFor(() => session.events.find(e => e.kind === 'task.milestone' && e.task === two.task && e.phase === 'check' && /Waiting for a gate slot/.test(e.text)));
  assert.equal(waiting.text, 'Waiting for a gate slot: 1 of 1 gate runs on this machine are in use. The check runs when one is free.');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(session.events.some(e => e.kind === 'task.check' && e.task === two.task), false, 'still queued while the first runs');
  release();
  await waitFor(() => ['accepted'].includes(scheduler.tasks()[two.task]?.state) && scheduler.tasks()[one.task]?.state === 'accepted');
  assert.equal(most, 1, 'never two gate runs at once');
  const rows = [one.task, two.task].map(task => session.events.find(e => e.kind === 'task.check' && e.task === task));
  assert.equal(typeof rows[0].queuedMs, 'number');
  assert.equal(session.events.some(e => e.kind === 'task.milestone' && e.task === one.task && /Waiting for a gate slot/.test(e.text)), false, 'the first never queued');
  assert.ok(rows[1].queuedMs >= 60, `waited ${rows[1].queuedMs} ms`);
});
