// Observed live (ACE session 159f4746): tasks 43387649 (blocked report_incomplete) and 151ed901
// (blocked worker_blocked) stayed parked forever after fresh tasks (01416607, 56ae277e) replaced
// them, because bounce never linked a successor's acceptance back to the task it replaced. With
// blocked tasks no longer expiring (ba96be9), that kept waking the orchestrator about outcomes it
// had already moved past, until wake_retry_exhausted blocked the main loop (seq 8857).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler as createSchedulerImpl} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const schedulers = new WeakMap();
const createScheduler = options => {
  const scheduler = createSchedulerImpl(options);
  schedulers.get(options.session)?.add(scheduler);
  return scheduler;
};

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-supersede-'));
  const session = new Session(root, {root});
  const owned = new Set(); schedulers.set(session, owned);
  t.after(async () => {
    for (const scheduler of owned) scheduler.close();
    await new Promise(resolve => setImmediate(resolve));
    fs.rmSync(root, {recursive: true, force: true});
  });
  return {session};
};

const waitFor = async (predicate, timeout = 3000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= until) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

const acceptedRow = (session, task) => ({kind: 'task.accepted', task, stage: 'completion', by: 'user',
  from: 'user', context: session.events.find(e => e.task === task)?.context});

test('a successor accepted under the same jobId cancels the blocked task it replaced', async t => {
  const {session} = setup(t);
  const stuck = fakeAdapter(() => [{kind: 'blocked', text: 'stuck'}]);
  const done = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'stuck', model: 'x', mode: 'yolo', fallback: []}, B: {adapter: 'done', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {stuck, done}, profiles});

  const a = scheduler.submit({parent: null, profile: 'A', orders: 'first attempt', deadline: null});
  await waitFor(() => scheduler.tasks()[a.task]?.state === 'blocked');

  const b = scheduler.submit({parent: null, profile: 'B', orders: 'fresh attempt', deadline: null, replaces: a.task});
  await waitFor(() => scheduler.tasks()[b.task]?.state === 'completed');
  assert.equal(session.events.find(e => e.kind === 'task.submitted' && e.task === b.task).jobId,
    session.events.find(e => e.kind === 'task.submitted' && e.task === a.task).jobId);

  session.append(acceptedRow(session, b.task));
  await waitFor(() => scheduler.tasks()[a.task]?.state === 'cancelled');

  const cancelRow = session.events.findLast(e => e.kind === 'task.cancelled' && e.task === a.task);
  assert.equal(cancelRow.reason, 'superseded');
  assert.equal(cancelRow.text, `Superseded by task ${b.task}`);
});

test('a successor with a different jobId does not touch an unrelated blocked task', async t => {
  const {session} = setup(t);
  const stuck = fakeAdapter(() => [{kind: 'blocked', text: 'stuck'}]);
  const done = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: {adapter: 'stuck', model: 'x', mode: 'yolo', fallback: []}, B: {adapter: 'done', model: 'x', mode: 'yolo', fallback: []}};
  const scheduler = createScheduler({session, adapters: {stuck, done}, profiles});

  const a = scheduler.submit({parent: null, profile: 'A', orders: 'first attempt', deadline: null});
  await waitFor(() => scheduler.tasks()[a.task]?.state === 'blocked');

  const b = scheduler.submit({parent: null, profile: 'B', orders: 'unrelated work', deadline: null});
  await waitFor(() => scheduler.tasks()[b.task]?.state === 'completed');
  assert.notEqual(session.events.find(e => e.kind === 'task.submitted' && e.task === b.task).jobId,
    session.events.find(e => e.kind === 'task.submitted' && e.task === a.task).jobId);

  session.append(acceptedRow(session, b.task));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(scheduler.tasks()[a.task]?.state, 'blocked');
  assert.equal(session.events.some(e => e.kind === 'task.cancelled' && e.task === a.task), false);
});
