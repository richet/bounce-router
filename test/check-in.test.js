// The check-in: whatever the reason nothing woke the orchestrator, while something waits on it (an outcome not handed
// over, a held task, a next step with nothing open) and it has had no turn for checkInMinutes, bounce gives it one.
// Found live: blocked workers sat 200 to 460 minutes after their one wake. Every wake also lists what still waits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createMainService, handoffBlock} from '../src/main-service.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error('fixture did not settle');
};

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-held-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  let now = Date.now();
  const timers = [];
  const clock = {now: () => now, setTimeout: (fn, ms) => { const timer = {fn, at: now + ms}; timers.push(timer); return timer; }, clearTimeout: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); }};
  const advance = async ms => {
    for (let step = 0; step < ms; step += 60_000) {
      await delay(10);
      now += Math.min(60_000, ms - step);
      for (const timer of [...timers].filter(timer => timer.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); }
    }
    await delay(20);
  };
  const calls = {launch: 0, fail: 0};
  const mainAdapter = {
    async launch() { calls.launch++; return {events: [{kind: 'result', status: calls.launch <= calls.fail ? 'failed' : 'completed', text: 'Looking at it.'}]}; },
    async resume(args) { return this.launch(args); },
    async *events(handle) { for (const event of handle.events) yield event; },
    async cancel() { return {verified: true}; },
  };
  const start = (settings = {}) => {
    const main = createMainService({session, adapters: {codex: mainAdapter}, profile: {adapter: 'codex', mode: 'plan'},
      settings: {executables: {}, sweepMinutes: 0, escalateMinutes: 0, idleNudgeMinutes: 0, ...settings}, clock, handoffDelayMs: 5, typedRetryMs: 5,
      watchdog: {startupMs: 100, runningMs: 100, retryDelayMs: 5, maxWakeAttempts: 2}});
    t.after(() => main.close());
    return main;
  };
  // Journal rows carry the real time; the parking is backdated against the fake clock.
  const park = (task, minutesAgo, extra = {}) => {
    session.append({kind: 'task.submitted', task, from: 'orchestrator', profile: 'analyst', orders: 'plan'});
    session.append({kind: 'task.blocked', task, reason: 'worker_blocked', text: 'Blocked: the brief asks me to edit a file outside my copy.', ...extra});
    const row = session.events.at(-1);
    row.time = new Date(now - minutesAgo * 60000).toISOString();
  };
  const turns = () => session.events.filter(row => row.kind === 'main.terminal').length;
  return {session, calls, advance, start, park, turns};
}

const seen = session => session.append({kind: 'main.disposition', actionId: `outcome:${session.events.at(-1).seq}`, outcomeSeq: session.events.at(-1).seq, task: session.events.at(-1).task, disposition: 'seen', from: 'main'});

test('a held task with nothing waking the orchestrator gets a check-in after 10 minutes, then 20, 40 and at most 60 apart', async t => {
  const {session, calls, advance, start, park, turns} = setup(t);
  park('desk-plan', 0);
  seen(session);
  session.append({kind: 'task.submitted', task: 'gate', from: 'orchestrator', profile: 'analyst', orders: 'gate'});
  session.append({kind: 'task.started', task: 'gate', attempt: 1});
  start();
  await advance(9 * 60_000);
  assert.equal(calls.launch, 0, 'under 10 minutes');
  await advance(60_000);
  await until(() => turns() === 1);
  const handoff = session.events.find(row => row.kind === 'handoff' && row.checkIn);
  assert.match(handoff.text, /^bounce check-in: you have had no turn for 10 min while work is open \(delivered by bounce, not typed by the user\)\.\nOpen tasks:\n- task gate · profile analyst · running\nWaiting on your decision:\n- task desk-plan · profile analyst · blocked · reason: worker_blocked · waiting 10 min\n  Blocked: the brief asks me to edit a file outside my copy\.\nA new task does not close one of these: answer the worker \(a message to it\), accept it, send it back, or cancel it\.\n\nCheck the state above against your orders/);
  await advance(19 * 60_000);
  assert.equal(calls.launch, 1, 'nothing new: the next waits 20 minutes');
  await advance(60_000);
  await until(() => turns() === 2);
  await advance(39 * 60_000);
  assert.equal(calls.launch, 2);
  await advance(60_000);
  await until(() => turns() === 3);
  await advance(59 * 60_000);
  assert.equal(calls.launch, 3, 'capped at 60, not 80');
  await advance(60_000);
  await until(() => turns() === 4);
  session.append({kind: 'task.failed', task: 'gate', reason: 'check_failed', text: 'red'});
  await advance(60_000);
  await until(() => turns() === 5);
  assert.equal(calls.launch, 5, 'an outcome wakes it as usual');
  await advance(10 * 60_000);
  await until(() => turns() === 6);
  assert.equal(calls.launch, 6, 'news resets the wait to 10 minutes');
});

test('only running tasks, with nothing waiting on the orchestrator, never trigger a check-in', async t => {
  const {session, calls, advance, start} = setup(t);
  session.append({kind: 'task.submitted', task: 'gate', from: 'orchestrator', profile: 'analyst', orders: 'gate'});
  session.append({kind: 'task.started', task: 'gate', attempt: 1});
  start();
  await advance(120 * 60_000);
  assert.equal(calls.launch, 0);
});

test('an outcome whose wakes all failed is handed over by a check-in', async t => {
  const {session, calls, advance, start, turns} = setup(t);
  calls.fail = 2;
  start();
  session.append({kind: 'task.submitted', task: 'gate', from: 'orchestrator', profile: 'analyst', orders: 'gate'});
  session.append({kind: 'task.failed', task: 'gate', reason: 'check_failed', text: 'lint failed'});
  await advance(3 * 60_000);
  assert.equal(calls.launch, 2, 'wake retries spent');
  await advance(10 * 60_000);
  await until(() => calls.launch === 3);
  assert.match(session.events.findLast(row => row.kind === 'handoff' && row.checkIn).text, /bounce check-in: [^\n]+\nWorker outcomes not yet handed to you[^\n]*\n- task gate · profile analyst · task\.failed · reason: check_failed/);
});

test('a user who stopped a turn keeps automatic wakes paused: no check-in, and status says so; checkInMinutes 0 is off', async t => {
  const {orchestratorStatus, formatStatus} = await import('../src/control-status.js');
  await t.test('paused', async t => {
    const {session, calls, advance, start, park} = setup(t);
    park('desk-plan', 0);
    seen(session);
    session.append({kind: 'main.cancelled', requestId: 'r1', from: 'main'});
    start();
    await advance(60 * 60_000);
    assert.equal(calls.launch, 0);
    assert.match(formatStatus(orchestratorStatus(session.events)), /^Automatic wakes are paused: you stopped a turn at \d\d:\d\dZ; any message turns them back on\.$/m);
  });
  await t.test('off', async t => {
    const {session, calls, advance, start, park} = setup(t);
    park('desk-plan', 0);
    seen(session);
    start({checkInMinutes: 0});
    await advance(60 * 60_000);
    assert.equal(calls.launch, 0);
  });
});

test('every wake lists the tasks still parked, beside the outcomes it hands over', async t => {
  const {session, park} = setup(t);
  park('desk-plan', 12);
  session.append({kind: 'task.submitted', task: 'gate', from: 'orchestrator', profile: 'analyst', orders: 'gate'});
  const ended = session.append({kind: 'task.failed', task: 'gate', reason: 'check_failed', text: 'lint failed'});
  const text = handoffBlock(session, [ended]);
  assert.match(text, /- task gate · profile analyst · task\.failed · reason: check_failed/);
  assert.match(text, /Still waiting on your decision:\n- task desk-plan · profile analyst · blocked · reason: worker_blocked · waiting 12 min\n  Blocked: the brief asks me/);
  assert.equal(handoffBlock(session, [session.events.findLast(row => row.kind === 'task.blocked')]).includes('Still waiting on your decision'), false, 'a task handed now is not listed twice');
});

test('a worker waiting for input counts as held, like a blocked one', async t => {
  const {session, calls, advance, start, turns} = setup(t);
  session.append({kind: 'task.submitted', task: 'asks', from: 'orchestrator', profile: 'analyst', orders: 'plan'});
  session.append({kind: 'task.input_required', task: 'asks', questions: ['Which branch?']});
  seen(session);
  start();
  await advance(10 * 60_000);
  await until(() => turns() === 1);
  assert.match(session.events.find(row => row.kind === 'handoff' && row.checkIn).text, /- task asks · profile analyst · input_required · waiting \d+ min\n  Which branch\?/);
  assert.equal(calls.launch, 1);
});

test('status lists a worker waiting for input beside the blocked ones', async () => {
  const {orchestratorStatus, formatStatus} = await import('../src/control-status.js');
  const events = [
    {seq: 1, kind: 'task.submitted', task: 'asks', from: 'orchestrator', profile: 'analyst', orders: 'plan', time: '2026-11-11T22:00:00Z'},
    {seq: 2, kind: 'task.input_required', task: 'asks', questions: ['Which branch?'], time: '2026-11-11T22:01:00Z'},
  ];
  const view = orchestratorStatus(events, {now: Date.parse('2026-11-11T22:10:00Z')});
  assert.deepEqual(view.blocked, [{task: 'asks', reason: 'asks for input', text: 'Which branch?'}]);
  assert.match(formatStatus(view), /Waiting on a decision:\n  asks · asks for input · Which branch\?/);
});
