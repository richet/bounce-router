// The loop nobody was watching (ACE session c70dbb61, 2026-09-22): ten reviewer tasks in two hours, the same
// scope on the same local model every time, each killed at its 60-minute ceiling and immediately replaced.
// Bounce guards loops inside a turn — a repeated tool call, empty steps, silence — and had nothing that
// noticed the SYSTEM repeating itself. The orchestrator could not notice either: it sees one outcome per
// handoff, never the pattern, and its orders say "resubmit what is left".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {sameJob, failedAttempts, REPEAT_LIMIT} from '../src/loop-guard.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async fn => { const start = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - start > 4000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 5)); } };
const setup = t => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-loop-'))); t.after(() => fs.rmSync(root, {recursive: true, force: true})); return new Session(root, {root}); };
const ORDERS = 'Review locking and journaling in src/workspaces. Report blockers with a reproducing command.';

test('G1 the same job is the same job: profile plus what it asks for, whitespace and wrapping aside', () => {
  assert.equal(sameJob({profile: 'reviewer', orders: ORDERS}, {profile: 'reviewer', orders: ORDERS.replace('. ', '.\n  ')}), true);
  assert.equal(sameJob({profile: 'reviewer', orders: ORDERS}, {profile: 'builder', orders: ORDERS}), false, 'a different agent is a different job');
  assert.equal(sameJob({profile: 'reviewer', orders: ORDERS}, {profile: 'reviewer', orders: 'Review Docker ownership only.'}), false, 'a different scope is a different job');
});

test('G2 attempts that died the same way are counted, completions are not', () => {
  const log = [
    {kind: 'task.submitted', task: 'a', profile: 'reviewer', orders: ORDERS, time: 't1'},
    {kind: 'task.deadline', task: 'a', reason: 'ceiling', time: 't2'},
    {kind: 'task.submitted', task: 'b', profile: 'reviewer', orders: ORDERS, time: 't3'},
    {kind: 'task.cancelled', task: 'b', reason: 'watchdog', time: 't4'},
    {kind: 'task.submitted', task: 'c', profile: 'reviewer', orders: 'something else', time: 't5'},
    {kind: 'task.deadline', task: 'c', reason: 'ceiling', time: 't6'},
    {kind: 'task.submitted', task: 'd', profile: 'reviewer', orders: ORDERS, time: 't7'},
    {kind: 'task.completed', task: 'd', summary: 'PASS', time: 't8'},
  ];
  const attempts = failedAttempts(log, {profile: 'reviewer', orders: ORDERS});
  assert.deepEqual(attempts.map(a => [a.task, a.reason]), [['a', 'ceiling'], ['b', 'watchdog']], 'the other scope and the one that finished are not this job failing');
  assert.equal(REPEAT_LIMIT, 2);
});

test('G3 a third identical submission is refused, and the refusal says what to change', async t => {
  const session = setup(t);
  let fate = () => ({never: true});
  const adapter = fakeAdapter(() => fate());
  const scheduler = createScheduler({session, adapters: {A: adapter}, watchdog: {interval: null}, limits: {minutes: 1, ceiling: 1},
    profiles: {reviewer: {adapter: 'A', model: 'local-27b', mode: 'yolo', fallback: [], role: 'reviewer', policy: 'probe'}}});
  t.after(() => scheduler.close());
  // two attempts at the same job, both killed the way the live ones were
  for (const id of ['one', 'two']) {
    const row = scheduler.submit({parent: null, profile: 'reviewer', orders: ORDERS, deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');
    session.append({kind: 'task.deadline', task: row.task, reason: 'ceiling', text: `no final answer (${id})`});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'timed_out');
  }
  fate = () => [{kind: 'result', status: 'completed', text: 'done'}];
  const third = scheduler.submit({parent: null, profile: 'reviewer', orders: `${ORDERS}\n`, deadline: null});
  const refused = await waitFor(() => session.events.find(e => e.kind === 'task.failed' && e.task === third.task));
  assert.equal(refused.reason, 'repeat');
  assert.equal(refused.text, 'reviewer has already failed this same job twice on local-27b (ceiling, ceiling). Change something before asking again: a narrower scope, a different AI, or hand it back. Resubmitting it unchanged is a loop.');
  assert.equal(adapter.calls.launch, 2, 'the third attempt never launched');
  // a different scope is not the same job, and runs
  const other = scheduler.submit({parent: null, profile: 'reviewer', orders: 'Review Docker ownership only.', deadline: null});
  await waitFor(() => scheduler.tasks()[other.task]?.state === 'completed');
  assert.equal(adapter.calls.launch, 3);
});

// The orchestrator sees one outcome per handoff and never the pattern — that is why it kept resubmitting.
test('G4 the handoff names the repetition, so the orchestrator can stop before bounce refuses', async () => {
  const {handoffBlock} = await import('../src/main-service.js');
  const rows = [
    {kind: 'task.submitted', task: 'a', parent: null, profile: 'reviewer', orders: ORDERS, seq: 1, from: 'orchestrator'},
    {kind: 'task.started', task: 'a', seq: 2},
    {kind: 'task.deadline', task: 'a', reason: 'ceiling', seq: 3},
    {kind: 'task.submitted', task: 'b', parent: null, profile: 'reviewer', orders: ORDERS, seq: 4, from: 'orchestrator'},
    {kind: 'task.started', task: 'b', seq: 5},
    {kind: 'task.deadline', task: 'b', reason: 'ceiling', text: 'no final answer 900 s after being asked to conclude', seq: 6},
  ];
  const text = handoffBlock({events: rows}, [rows.at(-1)]);
  assert.match(text, /this job has now failed 2 times the same way \(ceiling, ceiling\): change the scope or the AI before asking again/);
});
