// Found live: the orchestrator handed ONE worker "finish P2 as the sole integration owner" with a
// 40-minute deadline. It worked the whole time, was never reviewed along the way, ran into its
// deadline with two tests red, and nothing was accepted. Big work is phases in sequence, each phase
// made of chunks that run in parallel where their paths are disjoint — and the scheduler holds the
// orchestrator to it: no single task may be given more than the cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler, WATCHDOG_DEFAULTS} from '../src/scheduler.js';
import {taskLimits, breakdownOrders, TASK_MINUTES, TASK_CEILING_MINUTES} from '../src/reload.js';
import {progressRow} from '../src/tui/status.js';
import {conversationEvents} from '../src/tui/transcript.js';
import {createFormatter} from '../src/format.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async fn => { const start = Date.now(); for (;;) { const value = fn(); if (value) return value; if (Date.now() - start > 8000) throw new Error('timed out'); await new Promise(r => setTimeout(r, 10)); } };

test('a task asked to run longer than the ceiling is refused before it launches; one longer than the lease runs', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-chunk-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {build: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}};
  const scheduler = createScheduler({session, adapters: {worker}, profiles, limits: taskLimits({})});
  t.after(() => scheduler.close());
  const big = scheduler.submit({parent: null, profile: 'build', orders: 'finish P2', deadline: 90 * 60000});
  const refused = await waitFor(() => session.events.find(e => e.kind === 'task.failed' && e.task === big.task));
  assert.deepEqual([refused.reason, refused.text], ['size', 'a 90-minute task exceeds the 60-minute ceiling: give it at most 60 minutes; bounce renews its lease while it makes progress']);
  assert.equal(worker.calls.launch, 0);
  const chunk = scheduler.submit({parent: null, profile: 'build', orders: 'review the tree', deadline: 40 * 60000});
  await waitFor(() => scheduler.tasks()[chunk.task]?.state === 'completed');
  assert.equal(worker.calls.launch, 1);
});

test('the lease is 15 minutes and the ceiling 60 unless the config says otherwise, and ORDERS sizes by scope, not minutes', () => {
  assert.deepEqual([TASK_MINUTES, TASK_CEILING_MINUTES], [15, 60]);
  assert.deepEqual(taskLimits({}), {minutes: 15, ceiling: 60});
  assert.deepEqual(taskLimits({taskMinutes: 30}), {minutes: 30, ceiling: 60});
  assert.deepEqual(taskLimits({taskMinutes: 90}), {minutes: 90, ceiling: 90});
  assert.deepEqual(taskLimits({taskMinutes: 10, taskCeilingMinutes: 45}), {minutes: 10, ceiling: 45});
  for (const bad of [0, -5, 1.5, '20', 999]) assert.throws(() => taskLimits({taskMinutes: bad}), /taskMinutes must be a whole number of minutes from 1 to 240/);
  for (const bad of [0, 1.5, '20', 999]) assert.throws(() => taskLimits({taskCeilingMinutes: bad}), /^Error: taskCeilingMinutes must be a whole number of minutes from 1 to 240, and at least taskMinutes$/);
  assert.throws(() => taskLimits({taskMinutes: 30, taskCeilingMinutes: 20}), /taskCeilingMinutes must be a whole number of minutes from 1 to 240, and at least taskMinutes/);
  const lines = breakdownOrders(15, {jevOn: true, ceiling: 60});
  assert.equal(lines[0], 'Break big work down: phases in sequence, each phase made of chunks that run in parallel.');
  assert.equal(lines[1], 'A task runs under a 15-minute lease that bounce renews while the worker makes progress, up to a 60-minute ceiling; a deadline over the ceiling is refused (task.failed, reason size) before anything runs. Size a chunk by scope (one owner, one acceptance), not by minutes: long work is normal.');
  const text = lines.join('\n');
  for (const part of ['depends_on', 'disjoint owned paths', 'Review each phase before the next one starts', 'For work big enough to need phases, do not hand one worker the whole job',
    'A chunk that stops making progress or reaches the ceiling is asked for its conclusion and reported as is: resubmit what is left with that progress in its orders, or record the concrete campaign blocker after bounded recovery.'])
    assert.equal(text.includes(part), true, part);
  for (const gone of ['No task may be given more than', 'split what is left', 'do not extend it', 'smaller']) assert.equal(text.includes(gone), false, gone);
  assert.equal(breakdownOrders(15, {ceiling: 60}).join('\n').includes('a deadline over the ceiling, and'), true);
});

test('the stall alarm does not fire on a test run: silence means five minutes, and no milestone for ten is still a stall', () => {
  assert.deepEqual([WATCHDOG_DEFAULTS.silence, WATCHDOG_DEFAULTS.stall], [300_000, 600_000]);
});

test('progress is visible where you look: the rail names the phase and how long since the last milestone, the worker\'s block names the phase', () => {
  const now = Date.parse('2026-09-21T15:41:00.000Z');
  const pane = {profile: 'codex_terra', state: 'running', phase: 'P2 integration cycle 1/3', updatedAt: '2026-09-21T15:32:08.000Z'};
  assert.equal(progressRow(pane, now, 30), '  └ P2 integration cycle… · 8m');
  assert.equal([...progressRow(pane, now, 30)].length <= 30, true);
  assert.equal(progressRow({...pane, phase: 'test'}, now, 30), '  └ test · 8m');
  assert.equal(progressRow({...pane, state: 'accepted'}, now, 30), '', 'only while it works');
  assert.equal(progressRow({profile: 'x', state: 'running'}, now, 30), '  └ no milestone yet');

  const T = '650959c5-bf76-4ee9-802c-c2afa5b69ef6';
  const events = [{id: '1', time: '2026-09-21T15:21:00.000Z', kind: 'task.submitted', task: T, profile: 'codex_terra'}, {id: '2', time: '2026-09-21T15:21:20.000Z', kind: 'task.started', task: T, requested: 'gpt-5.6-terra'},
    {id: '3', time: '2026-09-21T15:32:08.000Z', kind: 'task.milestone', task: T, phase: 'test', text: 'Fresh baseline recorded 66 passed / 1 failed.'}];
  const formatter = createFormatter({color: false, compact: true});
  const lines = conversationEvents(events).flatMap(row => formatter.event(row, 80));
  assert.deepEqual(lines, ['● codex_terra · running · gpt-5.6-terra · phase: test', '  Fresh baseline recorded 66 passed / 1 failed.']);
});
