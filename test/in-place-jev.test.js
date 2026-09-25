// Phase 2b (docs/plans/in-place-tasks.md §2): Jev's risk check for an in-place task — a Choice
// over {authorized, exceeds, unrelated} given the cited user message first, the other user
// messages since the last in-place task, and the orders. Confident exceeds/unrelated refuses;
// unconfident/off/unavailable falls back to the structural check (the task runs) with a
// jev.skipped row saying why. A fake `jev` object (matching the seam scheduler.js calls:
// `.settings()` and `.inPlace(...)`) stands in for the real TypeSafe HTTP call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {decideInPlace, inPlaceQuestions} from '../src/jev.js';

const waitFor = async (predicate, timeout = 2_000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

function tmpSession(prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return {root, session: new Session(root, {root})};
}
const teardown = (t, scheduler, root) => t.after(async () => { await scheduler.stop(); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
const writer = {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'};

function submitInPlace(scheduler, session, orders, text = 'commit it') {
  const user = session.append({kind: 'user', text, from: 'user'});
  return scheduler.submit({parent: null, profile: 'A', orders, deadline: null, requires: ['write', 'exec'], inPlace: {authorizedBy: user.seq}});
}

test('a confident authorized verdict lets the task run and journals jev.decided with probabilities', async t => {
  const {root, session} = tmpSession('bounce-inplace-jev-auth-');
  const calls = [];
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const jev = {settings: () => ({enabled: true}), inPlace: async args => { calls.push(args); return {verdict: 'authorized', confidence: 0.92, probabilities: {authorized: 0.92, exceeds: 0.05, unrelated: 0.03}, model: 'jev-1.13.0'}; }};
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null, jev});
  teardown(t, scheduler, root);

  const row = submitInPlace(scheduler, session, 'git commit -m done');
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].citedText, 'commit it');
  const decided = session.events.find(e => e.kind === 'jev.decided' && e.task === row.task);
  assert.equal(decided.verdict, 'authorized');
  assert.equal(decided.confidence, 0.92);
  assert.deepEqual(decided.probabilities, {authorized: 0.92, exceeds: 0.05, unrelated: 0.03});
});

for (const [verdict, reason] of [['exceeds', 'in_place_exceeds_request'], ['unrelated', 'in_place_unrelated']]) {
  test(`a confident ${verdict} verdict refuses the task with ${reason} and Jev's lean`, async t => {
    const {root, session} = tmpSession(`bounce-inplace-jev-${verdict}-`);
    const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
    const jev = {settings: () => ({enabled: true}), inPlace: async () => ({verdict, confidence: 0.9, probabilities: {[verdict]: 0.9}, model: 'jev-1.13.0'})};
    const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null, jev});
    teardown(t, scheduler, root);
    const row = submitInPlace(scheduler, session, 'git commit -m done && git push');
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'failed');
    const failed = session.events.find(e => e.kind === 'task.failed' && e.task === row.task);
    assert.equal(failed.reason, reason);
    assert.match(failed.text, new RegExp(verdict));
    assert.equal(adapter.calls.launch, 0, 'the worker never ran');
  });
}

test('an unconfident Jev verdict falls back to the structural check: the task runs, and jev.skipped names why', async t => {
  const {root, session} = tmpSession('bounce-inplace-jev-unconfident-');
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const jev = {settings: () => ({enabled: true}), inPlace: async () => ({verdict: 'unresolved', reason: 'confidence 0.55 below 0.8', confidence: 0.55, probabilities: {}, model: 'jev-1.13.0'})};
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null, jev});
  teardown(t, scheduler, root);
  const row = submitInPlace(scheduler, session, 'git commit -m done');
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  const skipped = session.events.find(e => e.kind === 'jev.skipped' && e.task === row.task);
  assert.equal(skipped.reason, 'confidence 0.55 below 0.8');
});

test('Jev off (no jev seam at all): the task runs on the structural check, jev.skipped says unavailable', async t => {
  const {root, session} = tmpSession('bounce-inplace-jev-off-');
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null, jev: null});
  teardown(t, scheduler, root);
  const row = submitInPlace(scheduler, session, 'git commit -m done');
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  const skipped = session.events.find(e => e.kind === 'jev.skipped' && e.task === row.task);
  assert.equal(skipped.reason, 'jev unavailable');
});

test('the cited message rides first, and only user messages since the prior in-place task are sent', async t => {
  const {root, session} = tmpSession('bounce-inplace-jev-window-');
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const calls = [];
  const jev = {settings: () => ({enabled: true}), inPlace: async args => { calls.push(args); return {verdict: 'authorized', confidence: 0.9, probabilities: {}, model: null}; }};
  const scheduler = createScheduler({session, adapters: {worker: adapter}, profiles: {A: writer}, gitHead: () => null, jev});
  teardown(t, scheduler, root);

  const first = session.append({kind: 'user', text: 'commit P0', from: 'user'});
  const firstRow = scheduler.submit({parent: null, profile: 'A', orders: 'git commit -m p0', deadline: null, requires: ['write', 'exec'], inPlace: {authorizedBy: first.seq}});
  await waitFor(() => scheduler.tasks()[firstRow.task]?.state === 'completed');

  session.append({kind: 'user', text: 'now build the widget', from: 'user'}); // unrelated chatter before the next in-place task
  const second = session.append({kind: 'user', text: 'push it', from: 'user'});
  const secondRow = scheduler.submit({parent: null, profile: 'A', orders: 'git push', deadline: null, requires: ['write', 'exec'], inPlace: {authorizedBy: second.seq}});
  await waitFor(() => scheduler.tasks()[secondRow.task]?.state === 'completed');

  assert.equal(calls[1].citedText, 'push it');
  assert.deepEqual(calls[1].messages, ['push it', 'now build the widget']);
  assert.equal(calls[1].messages.includes('commit P0'), false, 'a message from before the prior in-place task is not resent');
});

test('inPlaceQuestions/decideInPlace: a confident choice at or above the bar resolves; below it, unresolved', () => {
  const {questions, state} = inPlaceQuestions({citedText: 'commit it', messages: ['commit it'], orders: 'git commit'});
  assert.equal(state.cited_message, 'commit it');
  assert.ok(questions.risk.criteria.exceeds);
  assert.deepEqual(decideInPlace({risk: {choice: 'authorized', confidence: 0.85}}, {confidence: 0.8}),
    {verdict: 'authorized', choice: 'authorized', confidence: 0.85, threshold: 0.8, probabilities: {}});
  assert.equal(decideInPlace({risk: {choice: 'exceeds', confidence: 0.5}}, {confidence: 0.8}).verdict, 'unresolved');
});
