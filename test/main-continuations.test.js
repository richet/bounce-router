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

test('an idle main wakes for accepted, rejected, and unavailable plan decisions', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'handled'}]}));
  service(t, session, mainAdapter);
  for (const [index, kind] of ['plan.accepted', 'plan.rejected', 'plan.unavailable'].entries()) {
    session.append({kind: 'plan.submitted', plan: `p${index}`, phase: 'build', from: 'orchestrator', chunks: []});
    session.append({kind, plan: `p${index}`, phase: 'build', chunks: 0});
    await until(() => mainAdapter.calls.launch + mainAdapter.calls.resume === index + 1);
  }
});

test('failed wake consumers retry at most twice and persist an actionable blocker', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'failed', text: 'transport failed'}]}));
  service(t, session, mainAdapter);
  const outcome = submittedOutcome(session);
  await until(() => session.events.some(row => row.kind === 'main.blocked' && row.reason === 'wake_retry_exhausted'));
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 2);
  const blocked = session.events.findLast(row => row.kind === 'main.blocked');
  assert.deepEqual(blocked.outcomeSeqs, [outcome.seq]);
});

test('successful no-op turns cannot erase a failed outcome and exhaustion atomically records its blocker', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'acknowledged'}]}));
  service(t, session, mainAdapter, {watchdog: {startupMs: 100, runningMs: 100, retryDelayMs: 50, maxWakeAttempts: 2}});
  session.append({kind: 'task.submitted', task: 'failed-work', from: 'orchestrator', profile: 'builder', orders: 'repair'});
  const outcome = session.append({kind: 'task.failed', task: 'failed-work', reason: 'error', text: 'repair failed'});
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 1);
  assert.equal(session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq), false,
    'provider success without an orchestration decision is not disposition evidence');
  await until(() => session.events.some(row => row.kind === 'main.blocked' && row.reason === 'wake_retry_exhausted'));
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 2);
  const disposition = session.events.find(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq);
  assert.equal(disposition.disposition, 'blocked');
  const envelope = fs.readFileSync(session.file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .find(row => row.kind === 'journal.commit' && row.events?.some(event => event.kind === 'main.blocked' && event.reason === 'wake_retry_exhausted'));
  assert.deepEqual(envelope.events.map(row => row.kind), ['main.blocked', 'main.disposition']);
});

test('campaign task outcome dispositions only after the consuming turn schedules durable successor work', async t => {
  const session = fixture(t);
  session.append({kind: 'campaign.started', campaignId: 'release', objective: 'ship', required: ['phase-1', 'phase-2'], from: 'orchestrator'});
  session.append({kind: 'task.submitted', task: 'phase-1', jobId: 'job-1', campaignId: 'release', gate: 'phase-1',
    from: 'orchestrator', profile: 'builder', orders: 'phase one'});
  const outcome = session.append({kind: 'task.completed', task: 'phase-1', summary: 'phase one done'});
  const mainAdapter = adapter(() => {
    session.append({kind: 'task.submitted', task: 'phase-2', jobId: 'job-2', campaignId: 'release', gate: 'phase-2',
      from: 'orchestrator', profile: 'builder', orders: 'phase two'});
    return {events: [{kind: 'result', status: 'completed', text: 'phase two scheduled'}]};
  });
  service(t, session, mainAdapter);
  await until(() => session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq));
  const disposition = session.events.find(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq);
  assert.equal(disposition.disposition, 'scheduled');
  assert.equal(disposition.successor, 'phase-2');
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

test('partly dispatched accepted plan retries finitely then records a concrete blocker', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'will dispatch'}]}));
  service(t, session, mainAdapter);
  session.append({kind: 'plan.submitted', plan: 'partial', phase: 'build', from: 'orchestrator', chunks: [{id: 'a', profile: 'builder', orders: 'a'}, {id: 'b', profile: 'builder', orders: 'b'}]});
  const decision = session.append({kind: 'plan.accepted', planId: 'partial', plan: 'partial', phase: 'build', chunks: 2});
  session.append({kind: 'task.submitted', task: 'task-a', jobId: 'plan:partial:a', planId: 'partial', chunkId: 'a', from: 'orchestrator', profile: 'builder', orders: 'a'});
  await until(() => session.events.some(row => row.kind === 'main.blocked' && row.reason === 'plan_undispatched'));
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 2);
  assert.deepEqual(session.events.findLast(row => row.kind === 'main.blocked').outcomeSeqs, [decision.seq]);
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

test('campaign callback obligations remain pending after narration and exhaust the same finite wake policy', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'still waiting'}]}));
  service(t, session, mainAdapter, {continuationState: () => ({pending: [{kind: 'campaign.pending', campaignId: 'campaign-1', seq: 9,
    text: 'release gate is still unmet'}]})});
  await until(() => session.events.some(row => row.kind === 'main.blocked' && row.reason === 'campaign_blocked'));
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 2);
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
