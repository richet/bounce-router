// Observed live (2026-09-25, headless run c3d78789): the orchestrator accepted a builder's work over an
// unconfident review gate (task.accepted with overrides, seq 503), but the task stayed `blocked`, its
// isolated fix was never integrated, and because the rework it then dispatched was the blocked task's
// child, that child's own block was treated as carried by its parent and never woke the orchestrator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {tasks} from '../src/reducers.js';
import {pendingMainActions} from '../src/continuations.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (predicate, timeout = 3000) => { const until = Date.now() + timeout; for (;;) { const value = predicate(); if (value) return value; if (Date.now() >= until) throw new Error('timed out'); await new Promise(resolve => setTimeout(resolve, 10)); } };

test('an override accept closes a task held at an unconfident gate, and its rework child then reaches the orchestrator', () => {
  let seq = 0;
  const row = event => ({seq: ++seq, time: '2026-09-25T07:00:00.000Z', ...event});
  const events = [
    row({kind: 'task.submitted', task: 'fix', parent: null, profile: 'builder', orders: 'x', from: 'orchestrator', review: {completion: 'jev'}}),
    row({kind: 'task.started', task: 'fix', attempt: 1}),
    row({kind: 'task.completed', task: 'fix', summary: 'done'}),
    row({kind: 'task.blocked', task: 'fix', reason: 'review_not_accepted', text: 'Review did not accept'}),
    row({kind: 'main.disposition', task: 'fix', actionId: 'outcome:4', outcomeSeq: 4, disposition: 'scheduled'}),
    row({kind: 'task.accepted', task: 'fix', stage: 'completion', by: 'orchestrator', from: 'orchestrator', overrides: 'review_not_accepted', text: 'Re-ran the tests myself.'}),
    row({kind: 'task.submitted', task: 'redo', parent: 'fix', profile: 'builder', orders: 'fix the three defects', from: 'orchestrator', review: {completion: 'jev'}}),
    row({kind: 'task.started', task: 'redo', attempt: 1}),
    row({kind: 'task.completed', task: 'redo', summary: 'done'}),
    row({kind: 'task.blocked', task: 'redo', reason: 'review_not_accepted', text: 'Review did not accept'}),
  ];
  const view = tasks(events);
  assert.equal(view.fix.state, 'accepted');
  assert.deepEqual(pendingMainActions(events).map(action => [action.task, action.kind]), [['redo', 'task.blocked']]);
  // an accept without `overrides` still cannot move a blocked task
  const plain = tasks([...events.slice(0, 4), row({kind: 'task.accepted', task: 'fix', stage: 'completion', by: 'orchestrator'})]);
  assert.equal(plain.fix.state, 'blocked');
});

test('an override accept integrates the isolated work into the checkout before the task is accepted', {timeout: 5000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-gate-override-'));
  const cwd = path.join(root, 'project'); fs.mkdirSync(path.join(cwd, 'src'), {recursive: true}); fs.writeFileSync(path.join(cwd, 'src', 'a.js'), 'old\n');
  const session = new Session(cwd, {root});
  const worker = fakeAdapter(({cwd: work}) => { fs.writeFileSync(path.join(work, 'src', 'a.js'), 'new\n'); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  // No choice/threshold at all: the review produced nothing, so the gate is review_unavailable
  // (a below-bar lean, by contrast, is now accepted with advice — see jev-review.test.js).
  const unavailable = JSON.stringify({verdict: 'unavailable', reason: 'no confident verdict', source: 'jev'});
  const critic = fakeAdapter(() => [{kind: 'result', status: 'completed', text: unavailable}]);
  const scheduler = createScheduler({session, adapters: {worker, critic}, profiles: {builder: {adapter: 'worker', policy: 'write'}, critic: {adapter: 'critic', policy: 'read-only'}},
    gitHead: () => null, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  scheduler.submit({task: 'fix', parent: null, profile: 'builder', from: 'orchestrator', owns: ['src/a.js'], requires: ['read', 'exec', 'write'], orders: 'change a', review: {completion: 'critic'}});
  await waitFor(() => tasks(session.events).fix?.state === 'blocked');
  assert.equal(session.events.findLast(e => e.kind === 'task.blocked' && e.task === 'fix').reason, 'review_unavailable');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'old\n');
  scheduler.acceptOverride({kind: 'task.accepted', task: 'fix', stage: 'completion', by: 'orchestrator', overrides: 'review_unavailable', text: 'Re-ran the tests myself.'});
  await waitFor(() => tasks(session.events).fix?.state === 'accepted');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'a.js'), 'utf8'), 'new\n');
  const integrated = session.events.findIndex(e => e.kind === 'task.integrated' && e.task === 'fix');
  const accepted = session.events.findIndex(e => e.kind === 'task.accepted' && e.task === 'fix');
  assert.equal(integrated >= 0 && integrated < accepted, true, 'integrated before accepted');
});

// Observed live (2026-09-25, session 159f4746 seq 277-395): the orchestrator's own override accept became
// the task's "pending outcome" and re-woke it with the same task every turn until a disposition landed.
test('the orchestrator\'s own accept is not handed back to it as a new outcome', () => {
  let seq = 0;
  const row = event => ({seq: ++seq, time: '2026-09-25T13:08:00.000Z', ...event});
  const events = [
    row({kind: 'task.submitted', task: 'plan', parent: null, profile: 'integrator', orders: 'x', from: 'orchestrator', review: {completion: 'jev'}}),
    row({kind: 'task.started', task: 'plan', attempt: 1}),
    row({kind: 'task.completed', task: 'plan', summary: 'done'}),
    row({kind: 'task.blocked', task: 'plan', reason: 'review_uncertain', text: 'Review uncertain', from: 'bounce'}),
  ];
  assert.deepEqual(pendingMainActions(events).map(action => [action.task, action.kind]), [['plan', 'task.blocked']]);
  events.push(row({kind: 'task.accepted', task: 'plan', stage: 'completion', by: 'orchestrator', from: 'orchestrator', overrides: 'review_uncertain', text: 'Checked it.'}));
  assert.deepEqual(pendingMainActions(events), []);
});
