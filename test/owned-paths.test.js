// Found live (ACE session, task 71e30c96): a local write worker filed a blocked report about a file
// its orders forbade, then edited it anyway and reported "Task Complete". Jev caught it, but the edit
// stayed in the tree while the rework ran. A task may now declare `owns`: the paths its worker may
// change. After a write worker's turn, every change outside them is reverted and journaled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createOpencodeLive} from '../src/adapters/opencode-live.js';
import {ownedBy, treeSnapshot, revertOutside} from '../src/owned-paths.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const helper = fileURLToPath(new URL('./helpers/fake-opencode.js', import.meta.url));
const waitFor = async (check, ms = 8000) => { const start = Date.now(); for (;;) { const value = check(); if (value) return value; if (Date.now() - start > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('owns: exact files and globs, relative to the workspace; anything else is outside', () => {
  const owns = ['src/cart.js', 'src/coupons/**', 'test/*.test.js'];
  assert.deepEqual(['src/cart.js', 'src/coupons/a.js', 'src/coupons/deep/b.js', 'test/x.test.js'].map(f => ownedBy(f, owns)), [true, true, true, true]);
  assert.deepEqual(['src/pricing.js', 'test/deep/x.test.js', 'README.md', 'src/cart.js.bak'].map(f => ownedBy(f, owns)), [false, false, false, false]);
  assert.equal(ownedBy('anything', []), true, 'no owns declared: nothing is guarded');
});

test('a snapshot of the tree, and the revert of every change outside the owned paths: edits restored, new files removed, deleted files put back', () => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-')));
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(cwd, f)), {recursive: true}); fs.writeFileSync(path.join(cwd, f), s); };
  w('src/cart.js', 'cart'); w('src/pricing.js', 'pricing'); w('tests/git_test.ts', 'test'); w('.git/HEAD', 'ref'); w('node_modules/x/index.js', 'dep');
  const before = treeSnapshot(cwd);
  assert.deepEqual(Object.keys(before).sort(), ['src/cart.js', 'src/pricing.js', 'tests/git_test.ts'], '.git and node_modules are not part of the tree');
  w('src/cart.js', 'cart changed');            // owned: stays
  w('src/pricing.js', 'pricing changed');      // forbidden edit
  w('src/setup.ts', 'new forbidden file');     // forbidden creation
  fs.rmSync(path.join(cwd, 'tests/git_test.ts'));  // forbidden deletion
  const reverted = revertOutside(cwd, before, ['src/cart.js']);
  assert.deepEqual(reverted, ['src/pricing.js', 'src/setup.ts', 'tests/git_test.ts']);
  assert.equal(fs.readFileSync(path.join(cwd, 'src/cart.js'), 'utf8'), 'cart changed');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/pricing.js'), 'utf8'), 'pricing');
  assert.equal(fs.existsSync(path.join(cwd, 'src/setup.ts')), false);
  assert.equal(fs.readFileSync(path.join(cwd, 'tests/git_test.ts'), 'utf8'), 'test');
  assert.deepEqual(revertOutside(cwd, treeSnapshot(cwd), ['src/cart.js']), [], 'nothing to revert on an unchanged tree');
  fs.rmSync(cwd, {recursive: true, force: true});
});

// Found live (ACE session 159f4746, task d59ce7f5): a green fix blocked outright because it also
// needed a two-line change to a file outside `owns`, and a retryOf could not widen `owns` to
// recover (prepare() forced the original's). A change outside `owns` is only refused when it is
// actually unsafe — touched in the real checkout since the attempt started, or claimed by another
// still-running task — never merely for being outside the declared list.
function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-sched-')));
  const cwd = path.join(root, 'ws'); fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  const saved = {...process.env};
  t.after(() => { for (const key of ['FAKE_OC_WRITE', 'FAKE_OC_SCENARIO', 'FAKE_OC_TURN_MS']) delete process.env[key]; Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, cwd};
}
const builderProfiles = () => ({builder: {adapter: 'opencode', model: '', mode: 'yolo', policy: 'write', fallback: [], role: 'builder', executables: {opencode: helper}}});

test('scheduler: an unowned edit unchanged in the checkout since the attempt baseline extends owns and integrates', async t => {
  const {root, cwd} = sandbox(t);
  fs.writeFileSync(path.join(cwd, 'src/cart.js'), 'export const x = 1;\n'); fs.writeFileSync(path.join(cwd, 'src/setup.ts'), 'original\n');
  Object.assign(process.env, {FAKE_OC_WRITE: 'src/cart.js:export const x = 2;,src/setup.ts:the two-line fix', FAKE_OC_SCENARIO: 'ok'});
  const session = new Session(cwd, {root});
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles: builderProfiles()});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'builder', orders: 'change src/cart.js', owns: ['src/cart.js']});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/cart.js'), 'utf8'), 'export const x = 2;');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/setup.ts'), 'utf8'), 'the two-line fix', 'the harmless extra edit is integrated too');
  const extended = session.events.find(e => e.kind === 'task.owns.extended' && e.task === row.task);
  assert.deepEqual(extended.paths, ['src/setup.ts']);
  assert.equal(session.events.some(e => e.kind === 'task.blocked' && e.task === row.task), false);
});

test('scheduler: an unowned edit changed in the checkout since the attempt baseline still blocks, naming the reason', async t => {
  const {root, cwd} = sandbox(t);
  fs.writeFileSync(path.join(cwd, 'src/cart.js'), 'export const x = 1;\n'); fs.writeFileSync(path.join(cwd, 'src/setup.ts'), 'original\n');
  Object.assign(process.env, {FAKE_OC_WRITE: 'src/cart.js:export const x = 2;,src/setup.ts:forbidden edit', FAKE_OC_SCENARIO: 'ok', FAKE_OC_TURN_MS: '150'});
  const session = new Session(cwd, {root});
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles: builderProfiles()});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'builder', orders: 'change src/cart.js only', owns: ['src/cart.js']});
  assert.deepEqual(row.owns, ['src/cart.js']);
  await waitFor(() => session.events.some(e => e.kind === 'task.workspace' && e.task === row.task));
  fs.writeFileSync(path.join(cwd, 'src/setup.ts'), 'someone else edited this meanwhile'); // real checkout moves after the baseline copy
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/cart.js'), 'utf8'), 'export const x = 1;\n', 'the source workspace is unchanged');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/setup.ts'), 'utf8'), 'someone else edited this meanwhile', 'the forbidden source edit is absent');
  const blocked = session.events.find(e => e.kind === 'task.blocked' && e.task === row.task);
  assert.equal(blocked.reason, 'ownership_violation');
  assert.match(blocked.text, /src\/setup\.ts \(changed in the checkout since the attempt baseline\)/);
  assert.ok(session.events.some(e => e.kind === 'task.artifact' && e.task === row.task), 'the isolated artifact is retained for inspection');
  assert.equal(session.events.some(e => e.kind === 'task.owns.extended' && e.task === row.task), false);
  // a task without owns is untouched, and a read-only worker never snapshots
  assert.throws(() => scheduler.submit({parent: null, profile: 'builder', orders: 'x', owns: ['/abs']}), /owns/);
  assert.throws(() => scheduler.submit({parent: null, profile: 'builder', orders: 'x', owns: 'src'}), /owns/);
});

test('scheduler: an unowned edit claimed by another still-running task blocks, naming the owner', async t => {
  const {root, cwd} = sandbox(t);
  fs.writeFileSync(path.join(cwd, 'src/cart.js'), 'export const x = 1;\n'); fs.writeFileSync(path.join(cwd, 'src/setup.ts'), 'original\n');
  const session = new Session(cwd, {root});
  // A fake, non-local adapter here: real opencode workers on this profile share a single local
  // concurrency slot (admitLocal), which would queue the second task behind the held first one
  // forever rather than exercising the ownership check this test is actually about.
  const adapter = fakeAdapter(({orders, cwd: workspace}) => {
    if (orders.includes('hold')) return {never: true};
    fs.writeFileSync(path.join(workspace, 'src/cart.js'), 'export const x = 2;');
    fs.writeFileSync(path.join(workspace, 'src/setup.ts'), 'conflicting edit');
    return [{kind: 'result', status: 'completed', text: 'done'}];
  });
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles: {builder: {adapter: 'fake', model: '', mode: 'yolo', policy: 'write', fallback: [], role: 'builder'}}});
  t.after(() => scheduler.close());
  const holder = scheduler.submit({parent: null, profile: 'builder', orders: 'hold setup.ts', owns: ['src/setup.ts']});
  await waitFor(() => scheduler.tasks()[holder.task]?.state === 'running');
  const row = scheduler.submit({parent: null, profile: 'builder', orders: 'change src/cart.js only', owns: ['src/cart.js']});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');
  const blocked = session.events.find(e => e.kind === 'task.blocked' && e.task === row.task);
  assert.equal(blocked.reason, 'ownership_violation');
  assert.match(blocked.text, new RegExp(`src/setup\\.ts \\(owned by active task ${holder.task}\\)`));
  await scheduler.cancel(holder.task);
});

test('scheduler: a retryOf submit may carry its own owns, replacing the inherited list', async t => {
  const {root, cwd} = sandbox(t);
  fs.writeFileSync(path.join(cwd, 'src/cart.js'), 'export const x = 1;\n');
  Object.assign(process.env, {FAKE_OC_WRITE: 'src/cart.js:export const x = 2;', FAKE_OC_SCENARIO: 'ok'});
  const session = new Session(cwd, {root});
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles: builderProfiles()});
  t.after(() => scheduler.close());
  const first = scheduler.submit({parent: null, profile: 'builder', orders: 'change src/cart.js only', owns: ['src/cart.js']});
  await waitFor(() => scheduler.tasks()[first.task]?.state === 'completed');
  // Found live (ACE session 159f4746, task d59ce7f5): a retryOf could not widen `owns` to recover
  // a blocked attempt because prepare() always forced the original's owns onto it.
  const retry = scheduler.submit({retryOf: first.task, profile: 'builder', orders: 'change both files', owns: ['src/cart.js', 'src/setup.ts']});
  assert.deepEqual(retry.owns, ['src/cart.js', 'src/setup.ts'], 'the retry\'s own owns replaces the original, narrower list');
  const noOwns = scheduler.submit({retryOf: retry.task, profile: 'builder', orders: 'try again'});
  assert.deepEqual(noOwns.owns, ['src/cart.js', 'src/setup.ts'], 'omitting owns on the next retry still inherits from its predecessor');
});
