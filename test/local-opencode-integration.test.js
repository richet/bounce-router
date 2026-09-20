import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createOpencodeLive} from '../src/adapters/opencode-live.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

// A local worker is a worker: the real scheduler drives the real OpenCode adapter against the
// one-shot fake, in the project directory itself — no copy, no publish gate, no report protocol.
const helper = fileURLToPath(new URL('./helpers/fake-opencode.js', import.meta.url));
const setup = (t, env = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-integration-')));
  const saved = {...process.env}; Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) delete process.env[key]; Object.assign(process.env, saved); fs.rmSync(root, {recursive: true, force: true}); });
  return {root, session: new Session(root, {root})};
};
const waitFor = async (check, ms = 8000) => { const start = Date.now(); for (;;) { const value = check(); if (value) return value; if (Date.now() - start > ms) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };
const local = (extra = {}) => ({adapter: 'opencode', model: '', mode: 'yolo', fallback: [], executables: {opencode: helper}, ...extra});

test('a local write worker edits the project itself, and its answer completes the task', async t => {
  const {root, session} = setup(t, {FAKE_OC_WRITE: 'src/a.js:export const x = 2;'});
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles: {coder: local({policy: 'write'})}});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'coder', orders: 'set x to 2'});
  await waitFor(() => scheduler.tasks()[row.task].state === 'completed');
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'export const x = 2;');
  assert.equal(session.events.find(e => e.kind === 'task.completed' && e.task === row.task).summary, 'echo: set x to 2');
});

test('under a required final report, a local worker\'s answer IS the report: completed, marked synthesized, no continuation', async t => {
  const {session} = setup(t);
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({})}, profiles: {analyst: local({policy: 'read-only'})}, requireFinalReport: true});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'analyst', orders: 'scout'});
  await waitFor(() => scheduler.tasks()[row.task].state === 'completed');
  const done = session.events.find(e => e.kind === 'task.completed' && e.task === row.task);
  assert.equal(done.summary, 'echo: scout');
  assert.equal(done.synthesized, true);
  assert.equal(session.events.some(e => e.kind === 'task.report_requested'), false, 'the report-only continuation is gone for local workers');
  assert.equal(session.events.filter(e => e.kind === 'task.started' && e.task === row.task).length, 1);
});

test('a local runtime failure is recoverable: the same job falls back to the next AI in its chain', async t => {
  const {session} = setup(t, {FAKE_OC_SCENARIO: 'fail'});
  const cloud = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done via cloud'}]);
  const profiles = {analyst: local({policy: 'read-only', fallback: ['analyst~2']}), 'analyst~2': {adapter: 'claude', model: 'sonnet', mode: 'yolo', policy: 'read-only', fallback: []}};
  const scheduler = createScheduler({session, adapters: {opencode: createOpencodeLive({}), claude: cloud}, profiles});
  t.after(() => scheduler.close());
  const row = scheduler.submit({parent: null, profile: 'analyst', orders: 'scout'});
  const fallback = await waitFor(() => session.events.find(e => e.kind === 'policy.fallback'));
  assert.deepEqual([fallback.from_profile, fallback.to_profile, fallback.reason], ['analyst', 'analyst~2', 'worker_runtime']);
  assert.match(session.events.find(e => e.kind === 'task.failed' && e.task === row.task).text, /opencode exited 1: Error: connect ECONNREFUSED/);
  const retry = await waitFor(() => session.events.find(e => e.kind === 'task.submitted' && e.profile === 'analyst~2'));
  await waitFor(() => scheduler.tasks()[retry.task].state === 'completed');
});

test('a cloud worker that hits its limit falls back to a local worker, task preserved', async t => {
  const {session} = setup(t);
  const limited = fakeAdapter(() => [{kind: 'result', status: 'limited', text: 'quota'}]);
  const profiles = {build: {adapter: 'claude', model: 'sonnet', mode: 'yolo', fallback: ['build~2']}, 'build~2': local({policy: 'write'})};
  const scheduler = createScheduler({session, adapters: {claude: limited, opencode: createOpencodeLive({})}, profiles});
  t.after(() => scheduler.close());
  scheduler.submit({parent: null, profile: 'build', orders: 'implement it'});
  const retry = await waitFor(() => session.events.find(e => e.kind === 'task.submitted' && e.profile === 'build~2'));
  await waitFor(() => scheduler.tasks()[retry.task].state === 'completed');
  assert.match(session.events.find(e => e.kind === 'task.completed' && e.task === retry.task).summary, /^echo: implement it/);
});
