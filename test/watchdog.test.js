// CONTRACT.md §6: Phase 5 watchdog acceptance — deterministic escalation ladder under an
// injected clock, atomic reservations/release, and the spend fold. Composed real scheduler +
// reducers + fake adapters, exactly like test/scheduler.test.js and test/policy.test.js. No real
// timers: `watchdog.interval: null` on every scheduler here, `tick()` driven by hand against a
// fake clock the test controls (`now`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import * as reducers from '../src/reducers.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-watchdog-'));
  t?.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, session: new Session(root, {root})};
};

const waitFor = async (fn, {timeout = 2000, interval = 5} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};

const worker = (adapterKey = 'A') => ({adapter: adapterKey, model: 'w', mode: 'yolo', fallback: []});

test('W1 silent hang: escalate once, correct with a delivered message, then cancel after grace', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock, watchdog: {interval: null, silence: 120000, stall: 600000, grace: 120000}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  now = 119000;
  await scheduler.tick();
  assert.equal(session.events.some(e => e.kind === 'policy.escalated' && e.task === row.task), false);

  now = 120000;
  await scheduler.tick();
  const escalated1 = session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task);
  assert.equal(escalated1.length, 1);
  assert.equal(escalated1[0].reason, 'silent');
  assert.equal(escalated1[0].evidence.sinceActivity, 120000);

  now = 125000;
  await scheduler.tick();
  const corrected = session.events.filter(e => e.kind === 'policy.corrected' && e.task === row.task);
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].reason, 'silent');
  const delivered = await waitFor(() => session.events.find(e => e.kind === 'task.delivered' && e.task === row.task));
  assert.equal(delivered.tier, 'live');
  assert.equal(adapter.calls.deliver, 1);
  assert.equal(adapter.deliveries[0].event.text, 'bounce watchdog: silent for 125 s — use bounce report --report <json> with op:milestone and evidence, or op:blocked with the blocker; include phase, text and next');

  for (let t2 = 130000; t2 <= 244000; t2 += 10000) { now = t2; await scheduler.tick(); }
  assert.equal(session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task).length, 1);
  assert.equal(session.events.filter(e => e.kind === 'policy.corrected' && e.task === row.task).length, 1);

  now = 245000;
  await scheduler.tick();
  const cancelledEsc = session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task && e.reason === 'cancelled');
  assert.equal(cancelledEsc.length, 1);
  assert.equal(cancelledEsc[0].text, 'silent persisted through correction and grace');
  assert.equal(session.events.some(e => e.kind === 'task.cancelled' && e.task === row.task), true);
  assert.equal(adapter.calls.cancel, 1);
});

test('W2 observed activity requests missing milestones but never cancels solely for missing reports', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock, watchdog: {interval: null, silence: 120000, stall: 600000, grace: 120000}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  // Activity every 10s is the constant background condition for this whole scenario — it must
  // keep flowing through the correction and grace window too, or `silent` would independently
  // fire once activity lapsed and the `stalled` ladder being tested here would stall itself.
  for (let t2 = 10000; t2 <= 590000; t2 += 10000) {
    now = t2;
    session.publish({kind: 'task.activity', task: row.task, text: 'still going', from: `worker:${row.task}`, context: row.context, time: new Date(now).toISOString()});
    await scheduler.tick();
  }
  assert.equal(session.events.some(e => e.kind === 'policy.escalated' && e.task === row.task), false);

  now = 600000;
  await scheduler.tick();
  const escalated = session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].reason, 'stalled');

  now = 605000;
  session.publish({kind: 'task.activity', task: row.task, text: 'still going', from: `worker:${row.task}`, context: row.context, time: new Date(now).toISOString()});
  await scheduler.tick();
  const corrected = session.events.filter(e => e.kind === 'policy.corrected' && e.task === row.task);
  assert.equal(corrected.length, 1);
  assert.equal(corrected[0].reason, 'stalled');
  await waitFor(() => session.events.some(e => e.kind === 'task.delivered' && e.task === row.task));

  for (let t2 = 615000; t2 < 725000; t2 += 10000) {
    now = t2;
    session.publish({kind: 'task.activity', task: row.task, text: 'still going', from: `worker:${row.task}`, context: row.context, time: new Date(now).toISOString()});
    await scheduler.tick();
  }
  assert.equal(session.events.some(e => e.kind === 'task.cancelled' && e.task === row.task), false);

  now = 725000;
  session.publish({kind: 'task.activity', task: row.task, text: 'still going', from: `worker:${row.task}`, context: row.context, time: new Date(now).toISOString()});
  await scheduler.tick();
  assert.equal(session.events.some(e => e.kind === 'task.cancelled' && e.task === row.task), false);
  assert.equal(adapter.calls.cancel, 0);
  await scheduler.cancel(row.task);
});

test('W3 declared long test: a declared expect suppresses silent until it elapses, then the normal silence window applies', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock, watchdog: {interval: null, silence: 120000, stall: 600000, grace: 120000}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  now = 60000;
  session.publish({kind: 'task.activity', task: row.task, text: 'long probe starting', expect: 300000, from: `worker:${row.task}`, context: row.context, time: new Date(now).toISOString()});
  await scheduler.tick();
  assert.equal(session.events.some(e => e.kind === 'policy.escalated' && e.task === row.task), false);

  now = 180000;
  await scheduler.tick();
  assert.equal(session.events.some(e => e.kind === 'policy.escalated' && e.task === row.task), false);

  now = 361000;
  await scheduler.tick();
  const escalated = session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].reason, 'silent');
});

test('W4 immediate blocker: escalated once with to:orchestrator, a second tick adds nothing', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const adapter = fakeAdapter(() => [{kind: 'blocked', text: 'need credentials'}]);
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, from: 'orchestrator'});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  now = 1000;
  await scheduler.tick();
  const escalated = session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].reason, 'blocked');
  assert.equal(escalated[0].text, 'need credentials');
  assert.equal(escalated[0].to, 'orchestrator');

  now = 2000;
  await scheduler.tick();
  assert.equal(session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task).length, 1);
});

test('W5 duplicate alerts: many ticks inside the window add exactly one correction; a milestone resets the signature', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock, watchdog: {interval: null, silence: 120000, stall: 600000, grace: 120000}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  now = 120000;
  await scheduler.tick();
  assert.equal(session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task).length, 1);

  for (let t2 = 121000; t2 <= 140000; t2 += 1000) { now = t2; await scheduler.tick(); }
  assert.equal(session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task).length, 1);
  assert.equal(session.events.filter(e => e.kind === 'policy.corrected' && e.task === row.task).length, 1);

  now = 200000;
  session.append({kind: 'task.milestone', task: row.task, text: 'made progress', evidence: null, from: `worker:${row.task}`, context: row.context, time: new Date(now).toISOString()});
  await scheduler.tick();
  assert.equal(session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task).length, 1); // still just the first one

  now = 319000;
  await scheduler.tick();
  assert.equal(session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task).length, 1);

  now = 320000;
  await scheduler.tick();
  const escalated = session.events.filter(e => e.kind === 'policy.escalated' && e.task === row.task);
  assert.equal(escalated.length, 2);
  assert.equal(escalated[1].reason, 'silent');
});

test('W6 an explicit deadline is a lease too: activity through it renews it, and no activity in the next one asks for the conclusion', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock, watchdog: {interval: null, silence: 120000, stall: 600000, grace: 120000}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: 30000});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  for (let t2 = 5000; t2 <= 30000; t2 += 5000) {
    now = t2;
    session.publish({kind: 'task.activity', task: row.task, text: 'ping', from: `worker:${row.task}`, context: row.context, time: new Date(now).toISOString()});
    await scheduler.tick();
  }
  assert.deepEqual(session.events.filter(e => e.kind === 'task.lease.renewed' && e.task === row.task).map(e => [e.lease, e.until]), [[1, 60000]]);
  assert.equal(session.events.some(e => (e.kind === 'task.deadline' || e.kind === 'task.concluding') && e.task === row.task), false);
  assert.equal(adapter.calls.cancel, 0);

  now = 60000;
  await scheduler.tick();
  assert.deepEqual(session.events.filter(e => e.kind === 'task.concluding' && e.task === row.task).map(e => e.reason), ['no_progress']);
  assert.equal(session.events.some(e => e.kind === 'policy.fallback.skipped' && e.task === row.task && e.reason === 'explicit_cancellation'), false, 'a deadline is not an explicit cancellation');
});

test('W7 deadline default: a null deadline runs under limits.minutes as its lease', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, clock, limits: {lines: 150, probes: 6, minutes: 1, rounds: 2}, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');

  now = 59000;
  await scheduler.tick();
  assert.equal(session.events.some(e => e.kind === 'task.concluding' && e.task === row.task), false);

  now = 60000;
  await scheduler.tick();
  assert.equal(session.events.some(e => e.kind === 'task.concluding' && e.task === row.task), true);
});

test('W8 simultaneous reservations: two children back to back reserve exactly once, the gate opens to exactly one launch', async t => {
  const {session} = setup(t);
  const gate = Promise.withResolvers();
  const checkpointRunner = () => gate.promise.then(() => ({status: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n'}));
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, checkpointRunner, watchdog: {interval: null}});
  // The root's own launch spends one of its two starts, leaving exactly one for whichever
  // child wins the race below — both children draw on this SAME root budget (§4).
  const rootRow = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null, budget: {starts: 2}});
  await waitFor(() => scheduler.tasks()[rootRow.task]?.state === 'completed');
  const launchesBeforeChildren = adapter.calls.launch;

  const checkpoint = {head: '(unavailable)', status: '(unavailable)', diff: '(unavailable)'};
  const row1 = scheduler.submit({parent: rootRow.task, profile: 'A', orders: 'c1', deadline: null, checkpoint});
  const row2 = scheduler.submit({parent: rootRow.task, profile: 'A', orders: 'c2', deadline: null, checkpoint});
  // Neither dispatch has resolved its checkpoint await yet (gated): reservation must already be
  // decided synchronously, before the gate opens.
  const reservedNow = session.events.filter(e => e.kind === 'budget.reserved' && [row1.task, row2.task].includes(e.task));
  assert.equal(reservedNow.length, 1);
  const failedNow = session.events.filter(e => e.kind === 'task.failed' && e.reason === 'budget' && [row1.task, row2.task].includes(e.task));
  assert.equal(failedNow.length, 1);

  gate.resolve();
  const winner = reservedNow[0].task;
  await waitFor(() => scheduler.tasks()[winner]?.state === 'completed');
  assert.equal(adapter.calls.launch - launchesBeforeChildren, 1); // exactly one of the two children ever launched
});

test('W9 released reservation: baseline refusal and a launch-throw release what they reserved; cancel never releases', async t => {
  const {root: sroot, session} = setup(t);
  // baseline refusal
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: workerAdapter}, profiles, watchdog: {interval: null}});
  const rootRow = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null, budget: {starts: 2}});
  await waitFor(() => scheduler.tasks()[rootRow.task]?.state === 'completed');

  const badCheckpoint = {head: 'nope', status: 'dirty', diff: 'x'};
  const baselineRow = scheduler.submit({parent: null, profile: 'A', orders: 'bad', deadline: null, checkpoint: badCheckpoint});
  await waitFor(() => scheduler.tasks()[baselineRow.task]?.state === 'failed');
  assert.equal(scheduler.tasks()[baselineRow.task].reason, 'baseline');
  const reserved1 = session.events.find(e => e.kind === 'budget.reserved' && e.task === baselineRow.task);
  const released1 = session.events.find(e => e.kind === 'budget.released' && e.task === baselineRow.task);
  assert.equal(reserved1 !== undefined, true);
  assert.deepEqual(released1?.amount, {starts: 1});
  scheduler.close(); // one scheduler at a time on a shared session — the next one must not double-dispatch this session's rows

  // launch throwing 'missing'
  const missingAdapter = fakeAdapter(() => ({launchError: 'missing'}));
  const profiles2 = {M: worker('M')};
  const scheduler2 = createScheduler({session, adapters: {M: missingAdapter}, profiles: profiles2, watchdog: {interval: null}});
  const missingRoot = scheduler2.submit({parent: null, profile: 'M', orders: 'm', deadline: null, budget: {starts: 1}});
  await waitFor(() => scheduler2.tasks()[missingRoot.task]?.state === 'failed');
  assert.equal(scheduler2.tasks()[missingRoot.task].reason, 'missing');
  const released2 = session.events.find(e => e.kind === 'budget.released' && e.task === missingRoot.task);
  assert.deepEqual(released2?.amount, {starts: 1});
  assert.equal(reducers.budgets(session.events).roots[missingRoot.task].remaining.starts, 1);
  scheduler2.close();

  // a cancelled running task does not release
  const neverAdapter = fakeAdapter(() => ({never: true}));
  const profiles3 = {N: worker('N')};
  const scheduler3 = createScheduler({session, adapters: {N: neverAdapter}, profiles: profiles3, watchdog: {interval: null}});
  const neverRow = scheduler3.submit({parent: null, profile: 'N', orders: 'n', deadline: null, budget: {starts: 1}});
  await waitFor(() => scheduler3.tasks()[neverRow.task]?.state === 'running');
  await scheduler3.cancel(neverRow.task);
  assert.equal(scheduler3.tasks()[neverRow.task].state, 'cancelled');
  assert.equal(session.events.some(e => e.kind === 'budget.released' && e.task === neverRow.task), false);
  assert.equal(reducers.budgets(session.events).roots[neverRow.task].remaining.starts, 0);
});

test('W10 parent cancel with grandchildren: post-order cancellation, three cancel calls', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, depthCap: 2, watchdog: {interval: null}});
  const root = scheduler.submit({parent: null, profile: 'A', orders: 'root', deadline: null});
  await waitFor(() => scheduler.tasks()[root.task]?.state === 'running');
  const child = scheduler.submit({parent: root.task, profile: 'A', orders: 'child', deadline: null});
  await waitFor(() => scheduler.tasks()[child.task]?.state === 'running');
  const grandchild = scheduler.submit({parent: child.task, profile: 'A', orders: 'grandchild', deadline: null});
  await waitFor(() => scheduler.tasks()[grandchild.task]?.state === 'running');

  const result = await scheduler.cancel(root.task);
  assert.deepEqual(result, {verified: true});
  const order = session.events.filter(e => e.kind === 'task.cancelled').map(e => e.task);
  assert.deepEqual(order, [grandchild.task, child.task, root.task]);
  assert.equal(adapter.calls.cancel, 3);
});

test('W11 spend fold: usage summed over the root tree, measured flips false with an unmeasured task, matches a direct recomputation', async t => {
  const {session} = setup(t);
  const rootAdapter = fakeAdapter(() => [{kind: 'usage', usage: {input: 10, output: 5}}, {kind: 'result', status: 'completed', text: 'root done'}]);
  const childAdapter = fakeAdapter(() => [{kind: 'usage', usage: {input: 1, cache_read: 7}}, {kind: 'result', status: 'completed', text: 'child done'}]);
  const thirdAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'no usage'}]);
  const profiles = {R: worker('R'), C: worker('C'), T: worker('T')};
  const scheduler = createScheduler({session, adapters: {R: rootAdapter, C: childAdapter, T: thirdAdapter}, profiles, watchdog: {interval: null}});
  const rootRow = scheduler.submit({parent: null, profile: 'R', orders: 'root', deadline: null});
  await waitFor(() => scheduler.tasks()[rootRow.task]?.state === 'completed');
  const childRow = scheduler.submit({parent: rootRow.task, profile: 'C', orders: 'child', deadline: null});
  await waitFor(() => scheduler.tasks()[childRow.task]?.state === 'completed');

  let spend = reducers.spend(session.events);
  assert.deepEqual(spend.roots[rootRow.task].usage, {input: 11, cache_read: 7, output: 5});
  assert.equal(spend.roots[rootRow.task].tokens, 23);
  assert.equal(spend.roots[rootRow.task].measured, true);

  const thirdRow = scheduler.submit({parent: rootRow.task, profile: 'T', orders: 'third', deadline: null});
  await waitFor(() => scheduler.tasks()[thirdRow.task]?.state === 'completed');
  spend = reducers.spend(session.events);
  assert.equal(spend.roots[rootRow.task].measured, false);

  // Recompute directly from the journal and assert equality with the reducer.
  const relevant = [rootRow.task, childRow.task, thirdRow.task];
  const recomputed = {};
  for (const e of session.events) if (e.kind === 'task.usage' && relevant.includes(e.task)) for (const k in e.usage) recomputed[k] = (recomputed[k] || 0) + e.usage[k];
  assert.deepEqual(spend.roots[rootRow.task].usage, recomputed);
});

test('W12 ticks are inert for classic/non-running tasks: an empty session, a waiting parent, a reviewing task', async t => {
  const {session} = setup(t);
  let now = 0;
  const clock = () => now;
  const emptyScheduler = createScheduler({session, adapters: {}, profiles: {}, clock, watchdog: {interval: null}});
  const before = session.events.length;
  now = 10_000_000;
  await emptyScheduler.tick();
  assert.equal(session.events.length, before);
  emptyScheduler.close();

  const {session: session2} = setup(t);
  let now2 = 0;
  const clock2 = () => now2;
  const parentAdapter = fakeAdapter(() => ({never: true}));
  const childAdapter = fakeAdapter(() => ({never: true}));
  const profiles = {P: worker('P'), K: worker('K')};
  const scheduler2 = createScheduler({session: session2, adapters: {P: parentAdapter, K: childAdapter}, profiles, clock: clock2, watchdog: {interval: null}});
  const parentRow = scheduler2.submit({parent: null, profile: 'P', orders: 'p', deadline: null});
  await waitFor(() => scheduler2.tasks()[parentRow.task]?.state === 'running');
  const childRow = scheduler2.submit({parent: parentRow.task, profile: 'K', orders: 'k', deadline: null});
  await waitFor(() => scheduler2.tasks()[parentRow.task]?.state === 'waiting');

  now2 = 10_000_000;
  await scheduler2.tick();
  assert.equal(session2.events.some(e => e.kind === 'policy.escalated' && e.task === parentRow.task), false);

  const {session: session3} = setup(t);
  let now3 = 0;
  const clock3 = () => now3;
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const criticAdapter = fakeAdapter(() => ({never: true}));
  const profiles3 = {W: worker('W'), Crit: {adapter: 'crit', model: 'c', mode: 'yolo', fallback: [], role: 'critic'}};
  const scheduler3 = createScheduler({session: session3, adapters: {W: workerAdapter, crit: criticAdapter}, profiles: profiles3, clock: clock3, watchdog: {interval: null}});
  const reviewingRow = scheduler3.submit({parent: null, profile: 'W', orders: 'w', deadline: null, review: {completion: 'Crit'}});
  await waitFor(() => scheduler3.tasks()[reviewingRow.task]?.state === 'reviewing');

  now3 = 10_000_000;
  await scheduler3.tick();
  assert.equal(session3.events.some(e => e.kind === 'policy.escalated' && e.task === reviewingRow.task), false);
});

test('W13 completion review launch throwing releases the reservation it never consumed (F1/A4, mirrors W9 for the completion path)', async t => {
  const {session} = setup(t);
  const workerAdapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'worker done'}]);
  const criticAdapter = fakeAdapter(() => ({launchError: 'missing'}));
  const profiles = {W: worker('W'), Crit: {adapter: 'crit', model: 'c', mode: 'yolo', fallback: [], role: 'critic'}};
  const scheduler = createScheduler({session, adapters: {W: workerAdapter, crit: criticAdapter}, profiles, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'W', orders: 'w', deadline: null, review: {completion: 'Crit'}, budget: {starts: 5}});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'blocked');

  // peer.joined carries `name`, not `task` — filtered out here like every other task-scoped test.
  const kinds = session.events.filter(e => e.task === row.task && !e.kind.startsWith('orchestration.') && !['task.attempt.ended', 'task.cancel.requested', 'task.workspace', 'task.launch.requested', 'task.artifact'].includes(e.kind)).map(e => e.kind);
  assert.deepEqual(kinds, [
    'task.submitted', 'budget.reserved', 'task.started', 'task.output', 'task.completed',
    'budget.reserved', 'review.started', 'review.finished', 'budget.released', 'policy.escalated', 'task.blocked',
  ]);
  const released = session.events.filter(e => e.kind === 'budget.released' && e.task === row.task);
  assert.equal(released.length, 1);
  assert.deepEqual(released[0].amount, {starts: 1});
  assert.equal(released[0].text, 'review launch failed'); // same release text as the prelaunch path (F1/A4)
  assert.equal(reducers.budgets(session.events).roots[row.task].remaining.starts, 4); // 5 - (worker's 1 + review's 1) + review's release
});

test('W14 the live activity map is pruned when a task goes terminal (F2/A5)', async t => {
  const {session} = setup(t);
  const adapter = fakeAdapter(() => ({never: true}));
  const profiles = {A: worker()};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles, watchdog: {interval: null}});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'x', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'running');
  session.publish({kind: 'task.activity', task: row.task, text: 'ping', from: `worker:${row.task}`, context: row.context});
  await waitFor(() => scheduler._activitySize() === 1);

  await scheduler.cancel(row.task);
  assert.equal(scheduler.tasks()[row.task].state, 'cancelled');
  assert.equal(scheduler._activitySize(), 0);
});
