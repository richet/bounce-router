// Step-budget renewal (found live, ACE session 159f4746, task 43387649): a local OpenCode worker
// made steady progress for 8 minutes, then hit its own step cap (opencode's `maxSteps`, distinct
// from bounce's own lease). The adapter already asks the same session once, tools off, for its
// answer (opencode-live.js) — but that answer, synthesized from a truncated "Maximum Steps
// Reached" turn, was still treated as final: task.blocked report_incomplete, and the orchestrator
// switched AI instead of letting the same worker keep going. A worker's own step cap ending its
// turn is not the task ending: while it is still making progress, bounce resumes the same worker
// with a short "keep going" message instead — bounded like a lease, so a worker that is only
// repeating itself still stops.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const base = {op: 'final', phase: 'implement', text: 'Implemented the change', next: 'Keep going', summary: 'Working on it', evidence: []};
const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-step-renewal-'));
  const session = new Session(root, {root});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, session};
};
const waitFor = async (fn, {timeout = 4000} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const stepCapTurn = (remaining, {call = 'edit src/a.js', change = true} = {}) => [
  {kind: 'native', sessionId: 'opencode-session'},
  {kind: 'activity', text: 'editing', call, change},
  {kind: 'diagnostic', text: 'opencode stopped at its step cap; asked once, tools off, for its answer', reason: 'step_cap', phase: 'conclusion', toolsDisabled: true},
  {kind: 'result', status: 'completed', text: JSON.stringify({...base, outcome: 'completed', remaining})},
];

test('a step-capped turn that is still making progress resumes the same worker instead of blocking, and eventually completes', {timeout: 4000}, async t => {
  const {session} = setup(t);
  let calls = 0;
  const worker = fakeAdapter(() => {
    calls++;
    return calls === 1 ? stepCapTurn('Finish the remaining tests') : [{kind: 'result', status: 'completed', text: JSON.stringify({...base, outcome: 'completed', remaining: ''})}];
  });
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {build: {adapter: 'worker', policy: 'write'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const submitted = scheduler.submit({task: 'implement', profile: 'build', orders: 'Implement the feature'});
  const completed = await waitFor(() => session.events.find(e => e.kind === 'task.completed' && e.task === submitted.task));
  assert.ok(completed);
  const renewed = session.events.filter(e => e.kind === 'task.steps.renewed' && e.task === submitted.task);
  assert.equal(renewed.length, 1);
  assert.equal(renewed[0].renewal, 1);
  assert.match(renewed[0].text, /^You reached the step limit for one turn, not the end of the task\. Continue from where you stopped; the remaining work is: Finish the remaining tests$/);
  assert.equal(session.events.some(e => e.kind === 'task.blocked' && e.task === submitted.task), false);
  assert.equal(worker.calls.resume, 1);
  assert.match(worker.resumeCalls[0].message, /You reached the step limit for one turn/);
});

test('a step-capped turn that only repeated an earlier turn\'s tool calls does not renew (today\'s block-and-decide path)', {timeout: 4000}, async t => {
  const {session} = setup(t);
  const worker = fakeAdapter(() => stepCapTurn('Still working through it', {call: 'read src/a.js', change: false}));
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {build: {adapter: 'worker', policy: 'write'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const submitted = scheduler.submit({task: 'audit', profile: 'build', orders: 'Audit the module'});
  const blocked = await waitFor(() => session.events.find(e => e.kind === 'task.blocked' && e.task === submitted.task));
  assert.equal(blocked.reason, 'report_incomplete');
  // The first turn renews once (nothing came before it to repeat); the second turn repeats the
  // first's only tool call with no change, so the loop guard refuses a second renewal.
  const renewed = session.events.filter(e => e.kind === 'task.steps.renewed' && e.task === submitted.task);
  assert.equal(renewed.length, 1);
  assert.equal(worker.calls.resume, 1);
});

test('step renewal stops at its cap of 3, even while the worker keeps progressing', {timeout: 4000}, async t => {
  const {session} = setup(t);
  let calls = 0;
  const worker = fakeAdapter(() => {
    calls++;
    return stepCapTurn('More work remains', {call: `edit src/file-${calls}.js`, change: true});
  });
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {build: {adapter: 'worker', policy: 'write'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const submitted = scheduler.submit({task: 'grind', profile: 'build', orders: 'Grind through the work'});
  const blocked = await waitFor(() => session.events.find(e => e.kind === 'task.blocked' && e.task === submitted.task));
  assert.equal(blocked.reason, 'report_incomplete');
  const renewed = session.events.filter(e => e.kind === 'task.steps.renewed' && e.task === submitted.task);
  assert.deepEqual(renewed.map(e => e.renewal), [1, 2, 3]);
  assert.equal(worker.calls.resume, 3);
});

test('a completed report naming unfinished work with no step cap involved still blocks without any renewal', {timeout: 3000}, async t => {
  const {session} = setup(t);
  const worker = fakeAdapter(() => [{kind: 'native', sessionId: 's'}, {kind: 'result', status: 'completed', text: JSON.stringify({...base, outcome: 'completed', remaining: 'Run the tests'})}]);
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {build: {adapter: 'worker', policy: 'write'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => scheduler.close());
  const submitted = scheduler.submit({task: 'plain', profile: 'build', orders: 'Do the work'});
  const blocked = await waitFor(() => session.events.find(e => e.kind === 'task.blocked' && e.task === submitted.task));
  assert.equal(blocked.reason, 'report_incomplete');
  assert.equal(session.events.some(e => e.kind === 'task.steps.renewed'), false);
  assert.equal(worker.calls.resume, 0);
});
