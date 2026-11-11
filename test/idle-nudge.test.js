// The idle nudge: an orchestrator between turns with nothing running, held or pending, whose own note still names a
// next step, is asked to dispatch or say what it waits on. Found live: it ran the integration gate detached, outside
// bounce, then sat idle with a red gate until a person noticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createMainService, nextStep} from '../src/main-service.js';
import {orchestratorStatus, formatStatus} from '../src/control-status.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error('fixture did not settle');
};

const NOTE = 'Phase 3 of 4: lint fixes landed.\nNext: run the integration gate on main and fix what it finds';

function setup(t, {settings = {}, note = NOTE} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-idle-nudge-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  let now = Date.parse('2026-11-11T02:00:00Z');
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
  const calls = {launch: 0, prompts: []};
  const mainAdapter = {
    async launch(args) { calls.launch++; calls.prompts.push(args.prompt ?? args.text ?? ''); return {events: [{kind: 'result', status: 'completed', text: 'Waiting on the gate.'}]}; },
    async resume(args) { return this.launch(args); },
    async *events(handle) { for (const event of handle.events) yield event; },
    async cancel() { return {verified: true}; },
  };
  if (note !== null) session.append({kind: 'state', from: 'main', text: note});
  const main = createMainService({session, adapters: {codex: mainAdapter}, profile: {adapter: 'codex', mode: 'plan'},
    settings: {executables: {}, sweepMinutes: 0, escalateMinutes: 0, ...settings}, clock, handoffDelayMs: 5, typedRetryMs: 5,
    watchdog: {startupMs: 100, runningMs: 100, retryDelayMs: 5, maxWakeAttempts: 2}});
  t.after(() => main.close());
  const turnsEnded = () => session.events.filter(row => row.kind === 'main.terminal').length;
  return {session, calls, advance, turnsEnded};
}

test('an idle orchestrator whose note names a next step is nudged once after idleNudgeMinutes, and status shows it', async t => {
  const {session, calls, advance, turnsEnded} = setup(t);
  await advance(4 * 60_000);
  assert.equal(calls.launch, 0, 'four minutes: under the default five');
  await advance(60_000);
  await until(() => turnsEnded() === 1);
  assert.equal(calls.launch, 1);
  const handoff = session.events.find(row => row.kind === 'handoff' && row.idle);
  assert.match(handoff.text, /^You have been idle 5 min with no tasks running or held \(delivered by bounce, not typed by the user\)\. Your note says next: run the integration gate on main and fix what it finds\n\nDispatch it, or say what you are waiting on\. A gate or an integration run is a check-only task \(at \+ check \+ checkTimeoutMinutes\)/);
  const view = orchestratorStatus(session.events);
  assert.deepEqual({nudges: view.idle.nudges, minutes: view.idle.minutes, next: view.idle.next}, {nudges: 1, minutes: 5, next: 'run the integration gate on main and fix what it finds'});
  assert.match(formatStatus(view), /^Idle nudge: 1 since its last dispatch, last at \d\d:\d\dZ after 5 min idle; its note's next: run the integration gate/m);
  await advance(10 * 60_000);
  assert.equal(calls.launch, 1, 'no second nudge inside 15 minutes');
});

test('nudges repeat at most every 15 minutes, stop after three without a dispatch, and start over after one', async t => {
  const {session, calls, advance, turnsEnded} = setup(t);
  await advance(5 * 60_000);
  await until(() => turnsEnded() === 1);
  await advance(15 * 60_000);
  await until(() => turnsEnded() === 2);
  await advance(15 * 60_000);
  await until(() => turnsEnded() === 3);
  assert.equal(calls.launch, 3);
  await advance(60 * 60_000);
  assert.equal(calls.launch, 3, 'three nudges in a row with no dispatch is the cap');
  session.append({kind: 'task.submitted', task: 'gate', from: 'orchestrator', profile: 'analyst', orders: 'gate'});
  session.append({kind: 'task.started', task: 'gate', attempt: 1});
  session.append({kind: 'task.failed', task: 'gate', attempt: 1, reason: 'check_failed', text: 'red'});
  assert.equal(orchestratorStatus(session.events).idle, undefined, 'a dispatch clears the status line');
  await advance(60_000);
  await until(() => turnsEnded() === 4);
  assert.equal(calls.launch, 4, 'the outcome wakes it as usual');
  await advance(5 * 60_000);
  await until(() => turnsEnded() === 5);
  assert.equal(calls.launch, 5, 'a dispatch starts the count over');
});

test('no nudge while a task is open or held, when the note is done or waits on the owner, or with idleNudgeMinutes 0', async t => {
  await t.test('a running task', async t => {
    const {session, calls, advance} = setup(t);
    session.append({kind: 'task.submitted', task: 'slow', from: 'orchestrator', profile: 'builder', orders: 'build'});
    session.append({kind: 'task.started', task: 'slow', attempt: 1});
    await advance(30 * 60_000);
    assert.equal(calls.launch, 0);
  });
  await t.test('a held task', async t => {
    const {session, calls, advance} = setup(t);
    session.append({kind: 'task.submitted', task: 'held', from: 'orchestrator', profile: 'builder', orders: 'build'});
    session.append({kind: 'task.blocked', task: 'held', reason: 'check_failed', text: 'red'});
    await advance(30 * 60_000);
    assert.equal(session.events.some(row => row.kind === 'handoff' && row.idle), false);
  });
  for (const note of ['Batch landed.\nNext: none', 'Next: waiting on the owner\'s go to push', '## Next\n- done', 'All merged, nothing left.', null]) {
    await t.test(`note ${JSON.stringify(note)}`, async t => {
      const {calls, advance} = setup(t, {note});
      await advance(30 * 60_000);
      assert.equal(calls.launch, 0);
    });
  }
  await t.test('idleNudgeMinutes 0', async t => {
    const {calls, advance} = setup(t, {settings: {idleNudgeMinutes: 0}});
    await advance(30 * 60_000);
    assert.equal(calls.launch, 0);
  });
});

test('nextStep reads the first step under or on a Next heading', () => {
  assert.equal(nextStep('Done: a\nNext: b then c'), 'b then c');
  assert.equal(nextStep('**Next:** run the gate'), 'run the gate');
  assert.equal(nextStep('## Next steps\n\n1. split the e2e\n2. merge'), 'split the e2e');
  assert.equal(nextStep('Next — waiting for the owner to approve the push'), null);
  assert.equal(nextStep('Next: blocked on the user answering the schema question'), null);
  assert.equal(nextStep('no heading here'), null);
});
