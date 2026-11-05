// A checkout whose accepted work must never be written into it (`git config bounce.delivery branch`): bounce names the
// worker's own branch in its copy for a `git fetch`. kb control session, 2026-11-05: sessions 1cd37957 and 39886c0b
// wrote accepted work, a tracked .env line included, into the real checkout on main.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {handoffBlock} from '../src/main-service.js';
import {listCopies, endedCopies} from '../src/prune.js';
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
const gitEnv = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'};
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: gitEnv}).trim();

function setup(t, {delivery, commit = true} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-branch-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, 'src'), {recursive: true});
  fs.writeFileSync(path.join(project, 'src/x.js'), 'export const state = "old";\n');
  git(project, 'init', '-q', '-b', 'main'); git(project, 'add', '.'); git(project, 'commit', '-qm', 'First');
  if (delivery) git(project, 'config', 'bounce.delivery', delivery);
  const session = new Session(project, {root: path.join(root, 'home')});
  const adapters = {worker: fakeAdapter(args => {
    fs.writeFileSync(path.join(args.cwd, 'src/x.js'), 'export const state = "new";\n');
    fs.writeFileSync(path.join(args.cwd, 'src/y.js'), 'export const y = 1;\n');
    if (commit) { git(args.cwd, 'checkout', '-qb', 'in-progress'); git(args.cwd, 'add', '-A'); git(args.cwd, 'commit', '-qm', 'in-progress: state is new'); }
    return [{kind: 'result', status: 'completed', text: report('state is now "new"')}];
  })};
  const profiles = {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}};
  const scheduler = createScheduler({session, adapters, profiles, requireFinalReport: true, gitHead: () => null});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const submit = () => scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js', owns: ['src/**'], deadline: null, check: 'grep -q new src/x.js'});
  const settled = task => waitFor(() => ['completed', 'accepted', 'blocked', 'failed'].includes(scheduler.tasks()[task]?.state) && scheduler.tasks()[task].state);
  const row = (kind, task) => session.events.findLast(e => e.kind === kind && e.task === task);
  return {root, project, session, scheduler, submit, settled, row};
}

test('delivery branch: the worker\'s own branch is reported at its head, the checkout is untouched, and a fetch brings it', async t => {
  const f = setup(t, {delivery: 'branch'});
  const {task} = f.submit();
  assert.equal(await f.settled(task), 'completed');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/x.js'), 'utf8'), 'export const state = "old";\n', 'the checkout is not written');
  assert.equal(fs.existsSync(path.join(f.project, 'src/y.js')), false);
  assert.equal(git(f.project, 'status', '--porcelain'), '');
  const delivered = f.row('task.integrated', task);
  const copy = delivered.copy;
  assert.deepEqual([delivered.delivery, delivered.branch, delivered.head, delivered.tree], ['branch', 'in-progress', git(copy, 'rev-parse', 'in-progress'), git(copy, 'rev-parse', 'in-progress^{tree}')]);
  assert.equal(delivered.text, `Delivered as branch in-progress (head ${delivered.head.slice(0, 12)}, tree ${delivered.tree.slice(0, 12)}) in ${copy}, not written into the checkout: git fetch ${copy} in-progress`);
  assert.equal(git(copy, 'log', '-1', '--format=%s'), 'in-progress: state is new', 'bounce made no commit of its own');
  git(f.project, 'fetch', '-q', copy, 'in-progress');
  assert.equal(git(f.project, 'show', 'FETCH_HEAD:src/x.js'), 'export const state = "new";');
  assert.equal(git(f.project, 'show', 'FETCH_HEAD:src/y.js'), 'export const y = 1;');
  assert.match(handoffBlock(f.session, [f.row('task.completed', task)]), /Delivered as branch in-progress \(head /);
});

test('delivery branch: a worker that left changes uncommitted is blocked, and bounce commits nothing', async t => {
  const f = setup(t, {delivery: 'branch', commit: false});
  const {task} = f.submit();
  assert.equal(await f.settled(task), 'blocked');
  const blocked = f.row('task.blocked', task);
  assert.deepEqual([blocked.reason, blocked.paths], ['delivery_uncommitted', ['src/x.js', 'src/y.js']]);
  assert.equal(blocked.text, 'Not delivered: the worker left changes uncommitted: src/x.js, src/y.js. Nothing was written into the checkout; the copy is kept.');
  assert.equal(fs.readFileSync(path.join(f.project, 'src/x.js'), 'utf8'), 'export const state = "old";\n');
});

test('delivery branch: prune keeps a copy whose branch has not reached the checkout, and lets it go once fetched', async t => {
  const f = setup(t, {delivery: 'branch'});
  const {task} = f.submit();
  assert.equal(await f.settled(task), 'completed');
  f.scheduler.close();
  const later = {now: Date.now() + 30 * 86400000, olderThanMs: 7 * 86400000};
  const copy = f.row('task.integrated', task).copy;
  assert.deepEqual(endedCopies(listCopies({root: path.join(f.root, 'home')}), later).map(c => c.dir), [], 'unfetched: kept');
  git(f.project, 'fetch', '-q', copy, 'in-progress');
  assert.deepEqual(endedCopies(listCopies({root: path.join(f.root, 'home')}), later).map(c => c.dir), [copy], 'fetched: free to remove');
});

test('a delivery setting bounce cannot read blocks the task instead of writing the checkout; no setting writes the checkout as before', async t => {
  const bad = setup(t, {delivery: 'brnach'});
  const one = bad.submit();
  assert.equal(await bad.settled(one.task), 'blocked');
  const blocked = bad.row('task.blocked', one.task);
  assert.deepEqual([blocked.reason, blocked.text], ['integration_settings', 'git config bounce.delivery is "checkout" or "branch", not "brnach". Nothing was written into the checkout.']);
  assert.equal(fs.readFileSync(path.join(bad.project, 'src/x.js'), 'utf8'), 'export const state = "old";\n');
  const plain = setup(t, {commit: false});
  const two = plain.submit();
  assert.equal(await plain.settled(two.task), 'completed');
  assert.equal(fs.readFileSync(path.join(plain.project, 'src/x.js'), 'utf8'), 'export const state = "new";\n');
});
