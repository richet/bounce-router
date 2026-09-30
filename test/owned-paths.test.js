// owns is a hint, not a fence (2026-09-29): the paths a task's worker and the orchestrator plan
// its work around. bounce no longer widens or blocks over them — the task row still carries owns,
// validated and corrected at submit as before, but what protects the checkout afterwards is
// src/workspace-artifacts.js's integrateArtifact refusing a file the checkout no longer matches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createOpencodeLive} from '../src/adapters/opencode-live.js';

const helper = fileURLToPath(new URL('./helpers/fake-opencode.js', import.meta.url));
const waitFor = async (check, ms = 8000) => { const start = Date.now(); for (;;) { const value = check(); if (value) return value; if (Date.now() - start > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

function sandbox(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owned-sched-')));
  const cwd = path.join(root, 'ws'); fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  const saved = {...process.env};
  t.after(() => { for (const key of ['FAKE_OC_WRITE', 'FAKE_OC_SCENARIO', 'FAKE_OC_TURN_MS']) delete process.env[key]; Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, cwd};
}
const builderProfiles = () => ({builder: {adapter: 'opencode', model: '', mode: 'yolo', policy: 'write', fallback: [], role: 'builder', executables: {opencode: helper}}});

// a: a worker's change outside the task's declared owns is not a violation any more — it is simply
// part of the artifact, integrated with everything else, with no note and no block.
test('a: a worker that changes a file outside the task\'s owns completes and integrates normally, with no owns.extended or blocked row', async t => {
  const {root, cwd} = sandbox(t);
  fs.writeFileSync(path.join(cwd, 'src/cart.js'), 'export const x = 1;\n'); fs.writeFileSync(path.join(cwd, 'src/setup.ts'), 'original\n');
  Object.assign(process.env, {FAKE_OC_WRITE: 'src/cart.js:export const x = 2;,src/setup.ts:the two-line fix', FAKE_OC_SCENARIO: 'ok'});
  const session = new Session(cwd, {root});
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles: builderProfiles()});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'builder', orders: 'change src/cart.js', owns: ['src/cart.js']});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/cart.js'), 'utf8'), 'export const x = 2;');
  assert.equal(fs.readFileSync(path.join(cwd, 'src/setup.ts'), 'utf8'), 'the two-line fix', 'the change outside owns is integrated too');
  const artifactRow = session.events.find(e => e.kind === 'task.artifact' && e.task === row.task);
  const artifact = JSON.parse(fs.readFileSync(artifactRow.file, 'utf8'));
  assert.deepEqual(artifact.changes.map(change => change.path).sort(), ['src/cart.js', 'src/setup.ts']);
  assert.equal(session.events.some(e => e.kind === 'task.owns.extended' && e.task === row.task), false);
  assert.equal(session.events.some(e => e.kind === 'task.blocked' && e.task === row.task), false);
});

test('scheduler: owns is corrected at submit (invalid entries dropped, a bare string wrapped) exactly as before', async t => {
  const {root, cwd} = sandbox(t);
  const session = new Session(cwd, {root});
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles: builderProfiles()});
  t.after(() => scheduler.close());
  // Invalid owns are corrected, not refused: an absolute path is dropped, a bare string is a list of one.
  const dropped = scheduler.prepare({parent: null, profile: 'builder', orders: 'x', owns: ['/abs']});
  assert.deepEqual([dropped.owns, dropped.corrections], [undefined, ['owns: dropped ["/abs"] (owned paths are relative, inside the checkout, without ..); none remain, so it owns what it changes']]);
  const wrapped = scheduler.prepare({parent: null, profile: 'builder', orders: 'x', owns: 'src'});
  assert.deepEqual([wrapped.owns, wrapped.corrections], [['src'], ['owns: given as "src", taken as ["src"]']]);
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
