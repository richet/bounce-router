import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createMainService} from '../src/main-service.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error('fixture did not settle');
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-main-continuations-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return new Session(root, {root});
}

function submittedOutcome(session, task = 'work') {
  session.append({kind: 'task.submitted', task, from: 'orchestrator', profile: 'builder', orders: 'repair'});
  return session.append({kind: 'task.completed', task, summary: 'repair complete'});
}

function adapter(script) {
  const calls = {launch: 0, resume: 0, cancel: 0};
  return {
    calls,
    async launch(args) { calls.launch++; return script(args, calls.launch); },
    async resume(args) { calls.resume++; return script(args, calls.launch + calls.resume); },
    async *events(handle) {
      if (handle.events) for (const event of handle.events) yield event;
      else yield await new Promise(resolve => { handle.release = resolve; });
    },
    async cancel(handle) { calls.cancel++; handle.release?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
}

function service(t, session, mainAdapter, options = {}) {
  const main = createMainService({
    session,
    adapters: {codex: mainAdapter},
    profile: {adapter: 'codex', mode: 'plan'},
    settings: {executables: {}},
    handoffDelayMs: 5,
    typedRetryMs: 5,
    watchdog: {startupMs: 100, runningMs: 100, retryDelayMs: 5, maxWakeAttempts: 2},
    ...options,
  });
  t.after(() => main.close());
  return main;
}

test('startup reconciliation wakes an outcome persisted before main service creation', async t => {
  const session = fixture(t);
  submittedOutcome(session);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'reported'}]}));
  service(t, session, mainAdapter);
  await until(() => mainAdapter.calls.launch === 1);
  assert.equal(session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq), true);
});

// Plans were removed 2026-09-29: an old journal's plan.submitted/plan.accepted/plan.rejected/
// plan.unavailable rows still replay, but no longer wake an idle main — there is no decision left
// to hand over.
test('an idle main does not wake for old journal plan rows: they replay and change nothing', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'handled'}]}));
  service(t, session, mainAdapter);
  session.append({kind: 'plan.submitted', plan: 'p0', phase: 'build', from: 'orchestrator', chunks: []});
  session.append({kind: 'plan.accepted', plan: 'p0', phase: 'build', chunks: 0});
  session.append({kind: 'plan.rejected', plan: 'p0', phase: 'build', chunks: 0});
  session.append({kind: 'plan.unavailable', plan: 'p0', phase: 'build', chunks: 0});
  session.append({kind: 'plan.drift', task: 'x', planId: 'p0', chunkId: 'a', reason: 'unknown plan chunk'});
  await delay(50);
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 0, 'plan rows carry no outcome to wake for');
});

// Rewritten 2026-09-27: bounce never blocks the orchestrator. After its continuation attempts it stops
// waking it for the same outcomes, which stay pending, and the next user prompt is accepted and carries them.
test('failed wake consumers retry at most twice, then stop waking without blocking the orchestrator', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'failed', text: 'transport failed'}]}));
  const main = service(t, session, mainAdapter);
  const outcome = submittedOutcome(session);
  await until(() => mainAdapter.calls.launch + mainAdapter.calls.resume === 2 && session.events.filter(row => row.kind === 'main.terminal').length === 2);
  await delay(50);
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 2, 'no third automatic wake');
  assert.equal(session.events.some(row => row.kind === 'main.blocked'), false);
  assert.equal(main.state().state, 'idle');
  const started = main.run({text: 'what happened?'});
  assert.equal(started.accepted, true);
  const handoff = session.events.findLast(row => row.kind === 'handoff');
  assert.deepEqual(handoff.outcomeSeqs, [outcome.seq], 'the unresolved outcome rides in front of the user\'s prompt');
  // the typed prompt is refused as well, tried once more, and ends before the session goes away
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 3);
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 4);
});

// Rewritten 2026-09-27: exhaustion no longer records a blocker; the failed outcome simply stays pending.
test('successful no-op turns cannot erase a failed outcome, and exhaustion leaves it pending without a blocker', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'acknowledged'}]}));
  const main = service(t, session, mainAdapter, {watchdog: {startupMs: 100, runningMs: 100, retryDelayMs: 50, maxWakeAttempts: 2}});
  session.append({kind: 'task.submitted', task: 'failed-work', from: 'orchestrator', profile: 'builder', orders: 'repair'});
  const outcome = session.append({kind: 'task.failed', task: 'failed-work', reason: 'error', text: 'repair failed'});
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 1);
  assert.equal(session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq), false,
    'provider success without an orchestration decision is not disposition evidence');
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 2);
  await delay(150);
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 2);
  assert.equal(session.events.some(row => row.kind === 'main.blocked'), false);
  assert.equal(session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq), false, 'still pending, still visible');
  assert.equal(main.state().state, 'idle');
});

// Rewritten 2026-09-27: campaigns were removed. A failed outcome is still dispositioned only once the
// consuming turn schedules durable successor work for the same job.
test('a failed outcome dispositions only after the consuming turn schedules durable successor work', async t => {
  const session = fixture(t);
  session.append({kind: 'task.submitted', task: 'phase-1', jobId: 'job-1',
    from: 'orchestrator', profile: 'builder', orders: 'phase one'});
  const outcome = session.append({kind: 'task.failed', task: 'phase-1', reason: 'error', text: 'phase one broke'});
  const mainAdapter = adapter(() => {
    session.append({kind: 'task.submitted', task: 'phase-1b', jobId: 'job-1', retryOf: 'phase-1',
      from: 'orchestrator', profile: 'builder', orders: 'phase one, again'});
    return {events: [{kind: 'result', status: 'completed', text: 'phase one resubmitted'}]};
  });
  service(t, session, mainAdapter);
  await until(() => session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq));
  const disposition = session.events.find(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq);
  assert.equal(disposition.disposition, 'scheduled');
  assert.equal(disposition.successor, 'phase-1b');
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 1);
});

test('wait delivery is dispositioned only when its consuming main turn completes', async t => {
  const session = fixture(t);
  const handles = [];
  const mainAdapter = adapter(() => { const handle = {}; handles.push(handle); return handle; });
  const main = service(t, session, mainAdapter);
  main.run({id: 'consumer', text: 'wait for task'});
  await until(() => handles[0]?.release);
  const outcome = submittedOutcome(session);
  session.append({kind: 'wait.served', task: 'work', served: outcome.seq, from: 'orchestrator'});
  handles[0].release({kind: 'result', status: 'failed', text: 'transport lost'});
  await until(() => mainAdapter.calls.launch + mainAdapter.calls.resume === 2);
  assert.equal(session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq), false);
  handles[1].release({kind: 'result', status: 'completed', text: 'reported'});
  await until(() => session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq));
});

test('a durably requested turn with no starting row is replayed after restart', async t => {
  const session = fixture(t);
  session.commit([
    {kind: 'user', text: 'recover me'},
    {kind: 'main.requested', requestId: 'recoverable', wake: false, text: 'recover me', provider: 'codex', mode: 'plan', images: []},
  ], {ref: 'main-request:recoverable', version: 2});
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'recovered'}]}));
  service(t, session, mainAdapter);
  await until(() => session.events.some(row => row.kind === 'main.terminal' && row.requestId === 'recoverable'));
  assert.equal(mainAdapter.calls.launch, 1);
});

test('explicit cancellation suppresses automatic restart of pending outcomes', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed'}]}));
  const main = service(t, session, mainAdapter, {handoffDelayMs: 30});
  submittedOutcome(session);
  await main.cancel();
  await delay(60);
  assert.equal(mainAdapter.calls.launch, 0);
  assert.equal(session.events.findLast(row => row.kind === 'main.cancelled').reason, 'user_cancelled');
  await main.close();
  const afterRestart = adapter(() => ({events: [{kind: 'result', status: 'completed'}]}));
  service(t, session, afterRestart, {handoffDelayMs: 5});
  await delay(30);
  assert.equal(afterRestart.calls.launch, 0);
});

// The orchestrator's own terminal row for the task is not news to hand back (continuations.js), so it
// needs no disposition; what matters is that it never re-wakes the orchestrator.
test('an orchestrator-authored terminal row after a consumed wait never re-wakes the orchestrator', async t => {
  const session = fixture(t);
  const handles = [];
  const mainAdapter = adapter(() => { const handle = {}; handles.push(handle); return handle; });
  const main = service(t, session, mainAdapter);
  main.run({id: 'consumer', text: 'wait'});
  await until(() => handles[0]?.release);
  const outcome = submittedOutcome(session);
  session.append({kind: 'wait.served', task: 'work', served: outcome.seq, from: 'orchestrator'});
  const accepted = session.append({kind: 'task.accepted', task: 'work', from: 'orchestrator'});
  handles[0].release({kind: 'result', status: 'completed', text: 'reported'});
  await until(() => session.events.some(row => row.kind === 'main.terminal'));
  await delay(50);
  assert.equal(session.events.some(row => row.kind === 'main.wake.scheduled' && row.outcomeSeqs?.includes(accepted.seq)), false);
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 1);
});

test('running resume timeout retries once only after verified termination', async t => {
  const session = fixture(t);
  let clockNow = 0;
  let nextTimer = 0;
  const timers = new Map();
  const clock = {
    now: () => clockNow,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, {at: clockNow + ms, fn}); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      clockNow += ms;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= clockNow);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
    },
  };
  let launches = 0;
  let resumes = 0;
  let releaseResume;
  const mainAdapter = {
    async launch() { launches++; return {fresh: launches > 1}; },
    async resume() { resumes++; return {}; },
    async *events(handle) {
      if (!handle.fresh && launches === 1 && resumes === 0) {
        yield {kind: 'native', provider: 'codex', sessionId: 'thread-1'};
        yield {kind: 'result', status: 'completed', text: 'initial'};
        return;
      }
      if (resumes === 1 && !handle.fresh) {
        yield await new Promise(resolve => { releaseResume = resolve; });
        return;
      }
      yield {kind: 'result', status: 'completed', text: 'fresh recovery'};
    },
    async cancel(handle) { releaseResume?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
  const main = service(t, session, mainAdapter, {clock, watchdog: {startupMs: 10, runningMs: 10, retryDelayMs: 1, maxWakeAttempts: 2}});
  main.run({id: 'initial', text: 'begin'});
  await until(() => session.events.some(row => row.kind === 'main.terminal' && row.requestId === 'initial'));
  main.run({id: 'resume-me', text: 'continue'});
  await until(() => releaseResume);
  clock.advance(10);
  await until(() => session.events.some(row => row.kind === 'main.recovery'));
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 3);
  assert.equal(resumes, 1);
  assert.equal(launches, 2);
  assert.equal(session.events.filter(row => row.kind === 'main.recovery').length, 1);
});

test('startup timeout without process identity blocks with a typed termination-uncertain failure', async t => {
  const session = fixture(t);
  let fire;
  const clock = {
    now: () => 0,
    setTimeout(fn) { fire = fn; return 1; },
    clearTimeout() {},
  };
  const mainAdapter = {launch: () => new Promise(() => {}), async *events() {}, async cancel() { return {verified: true}; }};
  const main = createMainService({session, adapters: {codex: mainAdapter}, profile: {adapter: 'codex'}, settings: {}, clock,
    watchdog: {startupMs: 10, runningMs: 10, retryDelayMs: 1, maxWakeAttempts: 2}});
  main.run({id: 'unknown-process', text: 'start'});
  await until(() => fire);
  const blocked = new Promise(resolve => {
    const stop = main.subscribe(row => { if (row.kind === 'main.blocked') { stop(); resolve(row); } });
  });
  fire();
  const row = await blocked;
  assert.equal(row.reason, 'termination_uncertain');
  assert.deepEqual(row.failure, {code: 'main_timeout', stage: 'startup'});
  assert.equal((await main.close()).verified, false);
});

// docs/plans/lessons-and-sweep.md §2 (Daniel, 2026-10-01). Found live (ACE e3bd01d5, 2026-09-30): two held
// tasks waited 91 minutes with nothing running and nothing waking the orchestrator. After sweepMinutes
// with nothing in flight and held work waiting, one turn asks what is waiting; answered, it is not
// repeated until something else happens; a running task or a pending outcome means no sweep.
test('the quiet sweep asks the orchestrator about held work once, after nothing has happened for sweepMinutes', async t => {
  const session = fixture(t);
  let now = Date.parse('2026-10-01T10:00:00Z');
  const timers = [];
  const clock = {now: () => now, setTimeout: (fn, ms) => { const timer = {fn, at: now + ms}; timers.push(timer); return timer; }, clearTimeout: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); }};
  // timers are armed after a tick (startup reconciliation is deferred): settle first, then move the clock
  const advance = async ms => { await new Promise(resolve => setTimeout(resolve, 20)); now += ms; for (const timer of [...timers].filter(timer => timer.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } await new Promise(resolve => setTimeout(resolve, 20)); };
  session.append({kind: 'task.submitted', task: 'held', from: 'orchestrator', profile: 'builder', orders: 'build'});
  session.append({kind: 'task.started', task: 'held', attempt: 1});
  session.append({kind: 'task.artifact', task: 'held', cwd: '/w/1a2b3c4d'});
  session.append({kind: 'task.blocked', task: 'held', reason: 'unverified', text: 'Nothing that runs this work has verified it, so it waits for you.', time: new Date(now).toISOString()});
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'Nothing is waiting beyond the held task; leaving it.'}]}));
  // one wake per outcome here (the default retries an unresolved outcome once), so the launches count sweeps
  service(t, session, mainAdapter, {clock, settings: {executables: {}, sweepMinutes: 1}, handoffDelayMs: 5, watchdog: {startupMs: 100, runningMs: 100, retryDelayMs: 5, maxWakeAttempts: 1}});
  // the held outcome itself wakes the orchestrator first, as before (its wake timer runs on the driven clock too)
  await advance(10);
  await until(() => mainAdapter.calls.launch === 1);
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 1);
  assert.equal(session.events.some(row => row.kind === 'main.requested' && row.sweep), false, 'the first turn is the outcome wake, not a sweep');

  await advance(30_000);
  assert.equal(mainAdapter.calls.launch, 1, 'half a minute: too soon');
  await advance(30_000);
  await until(() => mainAdapter.calls.launch === 2);
  const sweep = session.events.find(row => row.kind === 'main.requested' && row.sweep);
  assert.ok(sweep, 'the sweep is a request row marked sweep');
  const handoff = session.events.find(row => row.kind === 'handoff' && row.sweep);
  assert.equal(handoff.text.startsWith('Nothing has happened for 1 minutes (delivered by bounce, not typed by the user). Nothing is running; this is waiting on you:\n- task held · profile builder · held · reason: unverified · for 1 min · work in /w/1a2b3c4d\n  Nothing that runs this work has verified it, so it waits for you.'), true, handoff.text);
  assert.equal(handoff.text.endsWith('or say that nothing is, and end your turn.'), true);
  assert.equal(session.events.some(row => row.kind === 'status' && /Nothing has happened for 1 minutes and 1 held task\(s\) wait for the orchestrator; asking it\./.test(row.text)), true);
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 2);

  // answered with nothing new since: no second sweep, however long the quiet
  await advance(10 * 60_000);
  assert.equal(mainAdapter.calls.launch, 2, 'a sweep answered is not repeated over the same silence');

  // something happens (another task is held) and the quiet period re-arms
  session.append({kind: 'task.submitted', task: 'second', from: 'orchestrator', profile: 'builder', orders: 'build'});
  session.append({kind: 'task.started', task: 'second', attempt: 1});
  session.append({kind: 'task.blocked', task: 'second', reason: 'check_failed', text: 'The task\'s check still fails.', time: new Date(now).toISOString()});
  await advance(10);
  await until(() => mainAdapter.calls.launch === 3); // the outcome wake
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 3);
  await advance(60_000);
  await until(() => mainAdapter.calls.launch === 4);
  assert.equal(session.events.filter(row => row.kind === 'main.requested' && row.sweep).length, 2);
});

test('no sweep while a task runs, with sweepMinutes 0, or with nothing held', async t => {
  const session = fixture(t);
  let now = Date.parse('2026-10-01T10:00:00Z');
  const timers = [];
  const clock = {now: () => now, setTimeout: (fn, ms) => { const timer = {fn, at: now + ms}; timers.push(timer); return timer; }, clearTimeout: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); }};
  // timers are armed after a tick (startup reconciliation is deferred): settle first, then move the clock
  const advance = async ms => { await new Promise(resolve => setTimeout(resolve, 20)); now += ms; for (const timer of [...timers].filter(timer => timer.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } await new Promise(resolve => setTimeout(resolve, 20)); };
  session.append({kind: 'task.submitted', task: 'held', from: 'orchestrator', profile: 'builder', orders: 'build'});
  session.append({kind: 'task.started', task: 'held', attempt: 1});
  session.append({kind: 'task.blocked', task: 'held', reason: 'unverified', text: 'waits', time: new Date(now).toISOString()});
  session.append({kind: 'task.submitted', task: 'busy', from: 'orchestrator', profile: 'builder', orders: 'build'});
  session.append({kind: 'task.started', task: 'busy', attempt: 1});
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'ok'}]}));
  service(t, session, mainAdapter, {clock, settings: {executables: {}, sweepMinutes: 1}, handoffDelayMs: 5});
  await advance(10);
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 1);
  await advance(5 * 60_000);
  assert.equal(session.events.some(row => row.kind === 'main.requested' && row.sweep), false, 'a running task means nothing is quiet');

  const off = fixture(t);
  off.append({kind: 'task.submitted', task: 'held', from: 'orchestrator', profile: 'builder', orders: 'build'});
  off.append({kind: 'task.started', task: 'held', attempt: 1});
  off.append({kind: 'task.blocked', task: 'held', reason: 'unverified', text: 'waits', time: new Date(now).toISOString()});
  const offAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'ok'}]}));
  service(t, off, offAdapter, {clock, settings: {executables: {}, sweepMinutes: 0}, handoffDelayMs: 5});
  await advance(10);
  await until(() => off.events.filter(row => row.kind === 'main.terminal').length === 1);
  await advance(60 * 60_000);
  assert.equal(off.events.some(row => row.kind === 'main.requested' && row.sweep), false, 'sweepMinutes 0 is off');
});
