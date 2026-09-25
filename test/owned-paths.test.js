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

test('scheduler: an isolated worker ownership violation preserves the source and blocks with its artifact', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-sched-')));
  const cwd = path.join(root, 'ws'); fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'src/cart.js'), 'export const x = 1;\n'); fs.writeFileSync(path.join(cwd, 'src/setup.ts'), 'original\n');
  const saved = {...process.env}; Object.assign(process.env, {FAKE_OC_WRITE: 'src/cart.js:export const x = 2;,src/setup.ts:forbidden edit', FAKE_OC_SCENARIO: 'ok'});
  t.after(() => { delete process.env.FAKE_OC_WRITE; delete process.env.FAKE_OC_SCENARIO; Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true}); });
  const session = new Session(cwd, {root});
  const profiles = {builder: {adapter: 'opencode', model: '', mode: 'yolo', policy: 'write', fallback: [], role: 'builder', executables: {opencode: helper}}};
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'builder', orders: 'change src/cart.js only', owns: ['src/cart.js']});
  assert.deepEqual(row.owns, ['src/cart.js']);
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/cart.js'), 'utf8'), 'export const x = 1;\n', 'the source workspace is unchanged');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/setup.ts'), 'utf8'), 'original\n', 'the forbidden source edit is absent');
  const blocked = session.events.find(e => e.kind === 'task.blocked' && e.task === row.task);
  assert.equal(blocked.reason, 'ownership_violation');
  assert.ok(session.events.some(e => e.kind === 'task.artifact' && e.task === row.task), 'the isolated artifact is retained for inspection');
  // a task without owns is untouched, and a read-only worker never snapshots
  assert.throws(() => scheduler.submit({parent: null, profile: 'builder', orders: 'x', owns: ['/abs']}), /owns/);
  assert.throws(() => scheduler.submit({parent: null, profile: 'builder', orders: 'x', owns: 'src'}), /owns/);
});
