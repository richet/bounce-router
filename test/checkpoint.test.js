import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler as createSchedulerImpl} from '../src/scheduler.js';
import {takeCheckpoint, sameTree} from '../src/checkpoint.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const schedulers = new WeakMap();
const createScheduler = options => {
  const scheduler = createSchedulerImpl(options);
  schedulers.get(options.session)?.add(scheduler);
  return scheduler;
};

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-checkpoint-'));
  const session = new Session(root, {root});
  const owned = new Set(); schedulers.set(session, owned);
  t?.after(async () => {
    for (const scheduler of owned) scheduler.close();
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {root, session};
};

const waitFor = async (fn, {timeout = 2000, interval = 5} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};

// A fake runner keyed by the npm subcommand ('test' or 'run'), so a single object can stand
// in for both `npm test` and `npm run check` calls made by takeCheckpoint.
const fakeRunner = ({test: testResult, check: checkResult}) => async (cmd, args) => {
  if (args[0] === 'test') return testResult;
  return checkResult;
};
const throwingRunner = () => { throw new Error('boom'); };
const fakeGit = snapshot => () => snapshot;

test('C1 takeCheckpoint: complete summary lines and check exit 0 yield parsed tests and check ok', async () => {
  const run = fakeRunner({test: {status: 0, stdout: '# tests 5\n# pass 5\n# fail 0\n'}, check: {status: 0, stdout: ''}});
  const cp = await takeCheckpoint({cwd: '/does/not/matter', run, git: fakeGit({head: 'abc', status: '', diff: ''})});
  assert.deepEqual(cp.tests, {pass: 5, total: 5, fail: 0});
  assert.equal(cp.check, 'ok');
});

test('C2 takeCheckpoint: no summary lines yields tests null and check fail; a throwing runner yields both null without throwing', async () => {
  const run = fakeRunner({test: {status: 1, stdout: 'no summary here\n'}, check: {status: 1, stdout: ''}});
  const cp = await takeCheckpoint({cwd: '/does/not/matter', run, git: fakeGit({head: 'abc', status: '', diff: ''})});
  assert.equal(cp.tests, null);
  assert.equal(cp.check, 'fail');

  const cp2 = await takeCheckpoint({cwd: '/does/not/matter', run: throwingRunner, git: fakeGit({head: 'abc', status: '', diff: ''})});
  assert.equal(cp2.tests, null);
  assert.equal(cp2.check, null);

  // Partial summary: '# pass' and '# tests' present but '# fail' missing must still yield
  // null, never a partial object built from the two present lines.
  //
  // Toggle (observed, then reverted — not part of src/checkpoint.js): a buggy parseTests that
  // requires only 'pass' and 'total' and defaults a missing 'fail' to 0 —
  //   function buggyParseTests(stdout) {
  //     const pass = stdout.match(/^# pass (\d+)/m), total = stdout.match(/^# tests (\d+)/m), fail = stdout.match(/^# fail (\d+)/m);
  //     if (!pass || !total) return null;
  //     return {pass: Number(pass[1]), total: Number(total[1]), fail: fail ? Number(fail[1]) : 0};
  //   }
  // run against '# tests 5\n# pass 5\n' (no '# fail' line) returns {pass:5,total:5,fail:0} —
  // non-null — which would make this test's `assert.equal(cp3.tests, null)` fail. That
  // confirms the assertion below discriminates the all-three-lines-required behavior rather
  // than passing on any input.
  const run3 = fakeRunner({test: {status: 0, stdout: '# tests 5\n# pass 5\n'}, check: {status: 0, stdout: ''}});
  const cp3 = await takeCheckpoint({cwd: '/does/not/matter', run: run3, git: fakeGit({head: 'abc', status: '', diff: ''})});
  assert.equal(cp3.tests, null);
});

test('C3 sameTree: compares only head/status/diff, ignoring tests/check', () => {
  const a = {head: 'h', status: 's', diff: 'd', tests: {pass: 1, total: 1, fail: 0}, check: 'ok'};
  const b = {head: 'h', status: 's', diff: 'd', tests: null, check: 'fail'};
  assert.equal(sameTree(a, b), true);
  const c = {...a, status: 'different'};
  assert.equal(sameTree(a, c), false);
});

test('C4 scheduler: dispatch refuses when the tree no longer matches the submitted checkpoint', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const run = fakeRunner({test: {status: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n'}, check: {status: 0, stdout: ''}});
  const checkpoint = await takeCheckpoint({cwd: session.cwd, run, git: fakeGit({head: 'h1', status: '', diff: ''})});
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, checkpointRunner: fakeRunner({test: {status: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n'}, check: {status: 0, stdout: ''}})});
  // Force a mismatch: dispatch re-checks against session.cwd with the real gitSnapshot (no
  // fake git injected on the scheduler side), which returns '(unavailable)' fields for this
  // non-git tmp dir — deliberately different from the fabricated 'h1' head above.
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, checkpoint});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');

  assert.equal(scheduler.tasks()[row.task].reason, 'baseline');
  // CONTRACT.md §4 (amendment A2): the reservation and the availableStarts check are one
  // synchronous span, before the checkpoint's own await — so a baseline refusal reserves
  // first, then releases what it never consumed.
  const kinds = session.events.filter(e => e.task === row.task).map(e => e.kind);
  assert.deepEqual(kinds.filter(kind => !kind.startsWith('orchestration.action.')), ['task.submitted', 'budget.reserved', 'budget.released', 'task.failed']);
  assert.deepEqual(kinds.filter(kind => kind.startsWith('orchestration.action.')), ['orchestration.action.requested', 'orchestration.action.started', 'orchestration.action.requested', 'orchestration.action.started', 'orchestration.action.settled', 'orchestration.action.settled']);
  const released = session.events.find(e => e.kind === 'budget.released' && e.task === row.task);
  assert.deepEqual(released.amount, {starts: 1});
  assert.equal(released.text, 'baseline refusal');
  // No `budget` on this submission: it's its own root with no declared allowance.
  const budgets = scheduler.budgets().roots[row.task];
  assert.equal(budgets.reserved.starts, 1);
  assert.equal(budgets.released.starts, 1);
  assert.equal(adapter.calls.launch, 0);
});

test('C5 scheduler: dispatch proceeds when the re-checked tree matches the submitted checkpoint', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const runner = fakeRunner({test: {status: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n'}, check: {status: 0, stdout: ''}});
  // No fake git injected: both the pre-submit checkpoint and dispatch's internal re-check use
  // the real gitSnapshot against the same non-git tmp dir, so both see identical '(unavailable)'
  // head/status/diff triples deterministically.
  const checkpoint = await takeCheckpoint({cwd: session.cwd, run: runner});
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, checkpointRunner: runner});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, checkpoint});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');

  assert.equal(session.events.some(e => e.kind === 'budget.reserved' && e.task === row.task), true);
  assert.equal(session.events.some(e => e.kind === 'task.started' && e.task === row.task), true);
});

test('C6 scheduler: submit without a checkpoint dispatches as today, never calling the runner', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  let calls = 0;
  const countingRunner = async () => { calls++; return {status: 0, stdout: ''}; };
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles, checkpointRunner: countingRunner});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');

  assert.equal(calls, 0);
});

test('C7 submit: a non-object checkpoint is rejected as malformed; null/undefined still mean "none"', t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {fake: adapter}, profiles});

  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, checkpoint: 'not-an-object'}),
    {message: 'malformed: checkpoint'});
  assert.throws(() => scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, checkpoint: 42}),
    {message: 'malformed: checkpoint'});

  // null/undefined are explicitly "no checkpoint" and must not be rejected.
  assert.doesNotThrow(() => scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, checkpoint: null}));
  assert.doesNotThrow(() => scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null}));
});
