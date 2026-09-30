// Observed live (session 159f4746, task 59e7f63a, 2026-09-25): a task blocked at an UNCONFIDENT
// review gate (gone since 2026-09-27) offered the orchestrator only one way out (task.accepted with overrides). Its attempt
// to send the work back as a retry was refused ("review gate unresolved; preserved candidate must be
// reviewed, not rerun"), so it accepted work it disagreed with. task.rework is the symmetric "send
// back": the SAME worker is resumed with the orchestrator's own findings, spending one rework round —
// exactly what a CONFIDENT Jev rework verdict does (src/strategy.js onReviewVerdict {action: 'rework'}
// → src/scheduler.js applyVerdictIntent's rework branch → resumeWorker).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createBus, connectBus} from '../src/bus.js';
import {createScheduler} from '../src/scheduler.js';
import {tasks, budgets} from '../src/reducers.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (predicate, timeout = 3000) => {
  const until = Date.now() + timeout;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= until) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

// Rewritten 2026-09-27: unconfident review gates are gone (a review now sends work back at most once and
// otherwise accepts with advice). The orchestrator may send finished work back whenever the task holds it —
// blocked, under review, or asking for input. Here: the worker completes and its review is still running.
async function setupAtGate(t, {workerScript, budget} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-rework-override-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const worker = fakeAdapter(workerScript ?? (() => [{kind: 'native', sessionId: 'native-1'}, {kind: 'result', status: 'completed', text: 'done'}]));
  const critic = fakeAdapter(() => ({never: true}));
  const scheduler = createScheduler({session, adapters: {worker, critic},
    profiles: {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'write'},
      C: {adapter: 'critic', model: 'c', mode: 'yolo', fallback: [], policy: 'read-only', role: 'critic'}},
    gitHead: () => null, watchdog: {interval: null}});
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate, prepare: scheduler.prepare,
    report: scheduler.report, accept: scheduler.acceptOverride, rework: scheduler.reworkOverride});
  t.after(async () => { await bus.close(); scheduler.close(); });
  scheduler.submit({task: 'fix', parent: null, profile: 'builder', from: 'orchestrator', requires: ['read', 'exec', 'write'], orders: 'change a', review: {completion: 'C'}, ...(budget ? {budget} : {})});
  await waitFor(() => tasks(session.events).fix?.state === 'reviewing' && critic.calls.launch === 1);
  return {root, session, scheduler, bus, worker, critic};
}

const connect = async (bus, peer, opts = {}) => {
  const {token} = bus.grant({peer, tasks: ['fix'], canSubmit: true, ...opts});
  return connectBus({path: bus.path, token});
};

test('task.rework on work under review resumes the same worker with the findings text, one rework round', {timeout: 5000}, async t => {
  // First (launch) call completes; the resumed call never completes, so the resumed 'running' state
  // is observable instead of racing straight back into a second review round.
  let calls = 0;
  const workerScript = () => { calls++; return calls === 1 ? [{kind: 'native', sessionId: 'native-1'}, {kind: 'result', status: 'completed', text: 'done'}] : {never: true}; };
  const {session, bus, worker} = await setupAtGate(t, {workerScript});
  const orchestrator = await connect(bus, 'orchestrator');
  t.after(() => orchestrator.close());
  const row = await orchestrator.publish({kind: 'task.rework', task: 'fix', text: 'The tests are not actually asserting on the new field; add a real assertion.'});
  assert.deepEqual([row.kind, row.overrides], ['task.rework', 'reviewing']);
  await waitFor(() => worker.calls.resume === 1);
  assert.equal(worker.resumeCalls[0].native.sessionId, 'native-1');
  assert.match(worker.resumeCalls[0].message, /The tests are not actually asserting on the new field; add a real assertion\./);
  assert.equal(session.events.filter(e => e.kind === 'task.rework' && e.task === 'fix').length, 1);
  assert.equal(session.events.findLast(e => e.kind === 'task.rework' && e.task === 'fix').round, 1);
  await waitFor(() => tasks(session.events).fix?.state === 'running');
  assert.equal(budgets(session.events).roots.fix.reserved.rounds, 1);
});

test('task.rework without text is refused, saying exactly what to send', async t => {
  const {bus} = await setupAtGate(t);
  const orchestrator = await connect(bus, 'orchestrator');
  t.after(() => orchestrator.close());
  const message = 'invalid event: task.rework needs text naming what must be fixed, e.g. {"kind":"task.rework","task":"<id>","text":"<what to fix>"}';
  await assert.rejects(orchestrator.publish({kind: 'task.rework', task: 'fix'}), error => error.code === -32602 && error.message === message);
  await assert.rejects(orchestrator.publish({kind: 'task.rework', task: 'fix', text: '   '}), error => error.code === -32602 && error.message === message);
});

test('task.rework on a task with no finished work is refused; on a worker_blocked task it resumes the worker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-rework-override-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  // 'run' never ends (stays running); 'ask' says it is blocked and ends, a resumable worker_blocked task.
  const worker = fakeAdapter(({orders}) => orders.startsWith('go') ? {never: true} : orders.startsWith('ask') ? [{kind: 'native', sessionId: 'native-1'}, {kind: 'blocked', text: 'needs a decision'}] : {never: true});
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'write'}}, gitHead: () => null, watchdog: {interval: null}});
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate, prepare: scheduler.prepare, report: scheduler.report, accept: scheduler.acceptOverride, rework: scheduler.reworkOverride});
  t.after(async () => { await bus.close(); scheduler.close(); });
  scheduler.submit({task: 'run', parent: null, profile: 'builder', from: 'orchestrator', requires: ['read', 'exec', 'write'], orders: 'go'});
  await waitFor(() => tasks(session.events).run?.state === 'running');
  scheduler.submit({task: 'ask', parent: null, profile: 'builder', from: 'orchestrator', requires: ['read', 'exec', 'write'], orders: 'ask first'});
  await waitFor(() => tasks(session.events).ask?.state === 'blocked' && session.events.some(e => e.kind === 'peer.native' && e.from === 'worker:ask'));
  const {token} = bus.grant({peer: 'orchestrator', tasks: ['run', 'ask'], canSubmit: true});
  const orchestrator = await connectBus({path: bus.path, token});
  t.after(() => orchestrator.close());
  await assert.rejects(orchestrator.publish({kind: 'task.rework', task: 'run', text: 'fix it'}),
    error => error.code === -32602 && error.message === 'invalid event: task.rework: task run is running; only work that is blocked, under review or asking for input goes back to its worker — for finished work submit a follow-up task with retryOf run');
  const row = await orchestrator.publish({kind: 'task.rework', task: 'ask', text: 'use the second option'});
  assert.equal(row.overrides, 'worker_blocked');
  await waitFor(() => worker.calls.resume === 1);
  assert.match(worker.resumeCalls[0].message, /use the second option/);
});

// Rewritten 2026-09-27: the orchestrator's own send-back is its decision; an exhausted rounds budget no
// longer refuses it (it used to: rework_rounds_exhausted).
test('task.rework with the round budget exhausted still sends the work back', async t => {
  const {bus, worker} = await setupAtGate(t, {budget: {rounds: 0}});
  const orchestrator = await connect(bus, 'orchestrator');
  t.after(() => orchestrator.close());
  const row = await orchestrator.publish({kind: 'task.rework', task: 'fix', text: 'fix the defects'});
  assert.equal(row.kind, 'task.rework');
  await waitFor(() => worker.calls.resume === 1);
});

test('task.rework from a non-orchestrator peer is refused', async t => {
  const {bus} = await setupAtGate(t);
  const {token} = bus.grant({peer: 'worker:fix', tasks: ['fix']});
  const worker = await connectBus({path: bus.path, token});
  t.after(() => worker.close());
  await assert.rejects(worker.publish({kind: 'task.rework', task: 'fix', text: 'fix it'}), error => error.code === -32001);
});
