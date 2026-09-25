// T3c: a message answering a worker's OWN blocked/input-required state (op:blocked, op:final
// outcome blocked/input_required, or a completed-but-unfinished report) resumes that exact
// worker instead of sitting queued forever — the only thing that folded a queued message in
// before this was a REVIEW-triggered rework round (src/scheduler.js resumeOnMessage).
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-blocked-resume-'));
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

const worker = () => ({adapter: 'worker', model: 'w', mode: 'yolo', fallback: []});
const critic = () => ({adapter: 'critic', model: 'c', mode: 'yolo', fallback: [], role: 'critic'});
const valid = {op: 'final', phase: 'implement', text: 'implemented the change', next: 'wait for a decision',
  evidence: [], outcome: 'completed', summary: 'Done', remaining: ''};
const blockedEnvelope = summary => JSON.stringify({...valid, outcome: 'blocked', summary});

test('a message answering a worker\'s own blocked outcome resumes it, and a later completed report completes the task', async t => {
  const {session} = setup(t);
  let turn = 0;
  const workerAdapter = fakeAdapter(() => {
    turn++;
    if (turn === 1) return [{kind: 'native', sessionId: 'native-1'}, {kind: 'result', status: 'completed', text: blockedEnvelope('Need a decision: commit the docs?')}];
    return [{kind: 'result', status: 'completed', text: JSON.stringify(valid)}];
  });
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter}, profiles: {A: worker()}, requireFinalReport: true, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');
  const blocked = session.events.findLast(e => e.kind === 'task.blocked' && e.task === row.task);
  assert.equal(blocked.reason, 'worker_blocked');
  assert.equal(blocked.text, 'Need a decision: commit the docs?');

  const message = session.append({kind: 'message', to: `worker:${row.task}`, text: 'no, do not commit the docs', from: 'user'});
  await waitFor(() => workerAdapter.calls.resume === 1);
  assert.match(workerAdapter.resumeCalls[0].message, /no, do not commit the docs/);
  assert.equal(workerAdapter.resumeCalls[0].native.sessionId, 'native-1');
  // Two rows for the same message: 'queued' at first (no live handle), then 'next-turn' once
  // resumeWorker folds it into the resume (src/scheduler.js resumeWorker's pending-message loop).
  const delivered = session.events.filter(e => e.kind === 'task.delivered' && e.message === message.id);
  assert.deepEqual(delivered.map(e => e.tier), ['queued', 'next-turn']);
  const started = session.events.filter(e => e.kind === 'task.started' && e.task === row.task);
  assert.equal(started.length, 2);
  assert.equal(started[1].resumed, true);

  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  assert.equal(scheduler.budgets().roots[row.task].reserved.rounds, 1);
});

test('a task blocked at an unconfident review gate does not resume on a message', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'native', sessionId: 'native-2'}, {kind: 'result', status: 'completed', text: 'done'}]);
  const lean = JSON.stringify({verdict: 'unavailable', findings: [], confidence: 0.3, threshold: 0.8, choice: 'rework',
    probabilities: {rework: 0.7, accept: 0.3}, fired: ['unbacked_tests'], leanFindings: ['Paste the test output.'], source: 'jev'});
  const criticAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: lean}]);
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter, critic: criticAdapter}, profiles: {A: worker(), C: critic()}, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');
  const blocked = session.events.findLast(e => e.kind === 'task.blocked' && e.task === row.task);
  assert.equal(blocked.reason, 'review_not_accepted');

  session.append({kind: 'message', to: `worker:${row.task}`, text: 'go ahead and accept it', from: 'user'});
  await waitFor(() => session.events.some(e => e.kind === 'task.delivered'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(workerAdapter.calls.resume, 0);
  assert.equal(session.events.findLast(e => e.kind === 'task.delivered').tier, 'queued');
  assert.equal(scheduler.tasks()[row.task].state, 'blocked');
});

test('a worker blocked with no resumable native session leaves the message queued and escalates why', async t => {
  const {session} = setup(t);
  // No {kind:'native', ...} event: nothing to resume.
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: blockedEnvelope('Need a decision: commit the docs?')}]);
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter}, profiles: {A: worker()}, requireFinalReport: true, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  session.append({kind: 'message', to: `worker:${row.task}`, text: 'no, do not commit the docs', from: 'user'});
  const escalated = await waitFor(() => session.events.find(e => e.kind === 'policy.escalated' && e.task === row.task && e.reason === 'blocked_message_unresumable'));
  assert.match(escalated.text, /no resumable native session/);
  assert.equal(workerAdapter.calls.resume, 0);
  assert.equal(session.events.findLast(e => e.kind === 'task.delivered').tier, 'queued');
  assert.equal(scheduler.tasks()[row.task].state, 'blocked');
});

test('two messages back to back fold into one resume', async t => {
  const {session} = setup(t);
  let turn = 0;
  const workerAdapter = fakeAdapter(() => {
    turn++;
    if (turn === 1) return [{kind: 'native', sessionId: 'native-3'}, {kind: 'result', status: 'completed', text: blockedEnvelope('Which approach?')}];
    return {never: true};
  });
  const scheduler = createScheduler({session, adapters: {worker: workerAdapter}, profiles: {A: worker()}, requireFinalReport: true, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  session.append({kind: 'message', to: `worker:${row.task}`, text: 'use approach A', from: 'user'});
  session.append({kind: 'message', to: `worker:${row.task}`, text: 'and write a test for it', from: 'user'});
  await waitFor(() => workerAdapter.calls.resume === 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(workerAdapter.calls.resume, 1);
  assert.match(workerAdapter.resumeCalls[0].message, /use approach A/);
  assert.match(workerAdapter.resumeCalls[0].message, /and write a test for it/);
  assert.equal(session.events.filter(e => e.kind === 'task.delivered' && e.tier === 'next-turn').length, 2);
});
