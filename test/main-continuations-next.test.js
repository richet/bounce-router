// Observed live (ACE session 159f4746, seq 8857): the orchestrator answered pending task outcomes
// with "waiting on your go-ahead for P4" but recorded no durable successor or named wait, so the
// outcomes stayed pending, kept re-waking it, and after 2 continuation attempts main.blocked
// wake_retry_exhausted stopped the main loop. A turn that closes by asking the user one question
// (its answer ends with a `Next:` line, reload.js's own single-prompt convention) has handed the
// outcome over, not dropped it, and must not count as a failed continuation.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-main-continuations-next-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return new Session(root, {root});
}

// A blocked outcome (not a plain completion, which already disposes as `reported`
// on any completed turn) is what actually needs a durable successor, a named wait, or a Next:
// question before it counts as handed over — the shape of the two live tasks that stayed parked.
function submittedOutcome(session, task = 'work') {
  session.append({kind: 'task.submitted', task, from: 'orchestrator', profile: 'builder', orders: 'repair'});
  return session.append({kind: 'task.blocked', task, reason: 'worker_blocked', text: 'stuck'});
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

test('a turn that closes with a Next: question hands the outcome over instead of exhausting wake retries', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed',
    text: 'Waiting on your go-ahead for P4.\nNext: approve P4'}]}));
  service(t, session, mainAdapter);
  const outcome = submittedOutcome(session);
  await until(() => session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq));
  const disposition = session.events.find(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq);
  assert.equal(disposition.disposition, 'waiting');
  await delay(200);
  assert.equal(session.events.some(row => row.kind === 'main.blocked' && row.reason === 'wake_retry_exhausted'), false);
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 1, 'the resolved outcome must not re-wake the orchestrator');
});

test('successive outcomes each answered with a Next: question never exhaust wake retries', async t => {
  const session = fixture(t);
  let turn = 0;
  const mainAdapter = adapter(() => { turn++; return {events: [{kind: 'result', status: 'completed', text: `Next: step ${turn}`}]}; });
  service(t, session, mainAdapter);
  const first = submittedOutcome(session, 'work-1');
  await until(() => session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === first.seq));
  const second = submittedOutcome(session, 'work-2');
  await until(() => session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === second.seq));
  assert.equal(session.events.some(row => row.kind === 'main.blocked' && row.reason === 'wake_retry_exhausted'), false);
});

// Regression: a turn that neither addresses the outcome nor asks a question still exhausts its wake
// retries — the Next: exception must not swallow real failures. Rewritten 2026-09-27: exhaustion no longer
// blocks the orchestrator; the outcome stays pending (undisposed) and no third wake fires.
test('a turn that neither resolves nor asks still exhausts wake retries, leaving the outcome pending', async t => {
  const session = fixture(t);
  const mainAdapter = adapter(() => ({events: [{kind: 'result', status: 'completed', text: 'acknowledged'}]}));
  service(t, session, mainAdapter);
  const outcome = submittedOutcome(session, 'silent-work');
  await until(() => session.events.filter(row => row.kind === 'main.terminal').length === 2);
  await delay(50);
  assert.equal(mainAdapter.calls.launch + mainAdapter.calls.resume, 2);
  assert.equal(session.events.some(row => row.kind === 'main.disposition' && row.outcomeSeq === outcome.seq), false);
  assert.equal(session.events.some(row => row.kind === 'main.blocked'), false);
});
