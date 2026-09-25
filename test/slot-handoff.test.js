import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {takeCheckpoint} from '../src/checkpoint.js';
import {hostless} from './helpers/local-fakes.js';
import {waitFor, tmpSession, teardown} from './helpers/wait.js';

const local = (role, model = 'm') => ({adapter: 'opencode', backend: 'lmstudio', endpoint: 'lmstudio', model, mode: 'yolo', policy: 'write', fallback: [], role, agent: {name: role, description: 'x', policy: 'write', prompt: 'x'}, derived: true, localOptions: {}});
const reviewerOn = model => ({...local('reviewer', model), policy: 'read-only', agent: {...local('reviewer', model).agent, policy: 'read-only'}});
const passResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
const endpoints = (extra = {}) => ({endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 1, ...extra}}});
const slotMilestone = (session, task) => session.events.some(row => row.task === task && row.kind === 'task.milestone' && /local slot/.test(row.text));
const releases = (session, task) => session.events.filter(row => row.kind === 'task.slot.released' && row.task === task);
// A started `{never: true}` worker the test ends later with a result of its choosing.
function endable(adapter) {
  const started = new Map();
  const launch = adapter.launch;
  adapter.launch = async function (args) {
    const handle = await launch.call(this, args);
    started.set(args.peer.startsWith('review:') ? args.peer : args.orders.split('\n')[0], handle);
    return handle;
  };
  const end = (name, result) => {
    const handle = started.get(name);
    handle.after = [result];
    handle.ended = true;
    for (const waiter of handle.waiters.splice(0)) waiter();
  };
  return {started, end};
}
const valid = {op: 'final', phase: 'audit', text: 'Done.', next: 'Review.', evidence: [], outcome: 'completed', summary: 'Done.', remaining: ''};

for (const [name, firstResult, releasedState] of [
  ['blocked final report', {kind: 'result', status: 'completed', text: JSON.stringify({op: 'final', phase: 'audit', text: 'Cannot finish.', next: 'Wait for credentials.', evidence: [], outcome: 'blocked', summary: 'Need credentials.', remaining: 'Need credentials.'})}, 'task.blocked'],
  ['input-required final report', {kind: 'result', status: 'completed', text: JSON.stringify({op: 'final', phase: 'audit', text: 'Need an answer.', next: 'Ask the user.', evidence: [], outcome: 'input_required', summary: 'Need an answer.', remaining: 'Need an answer.'})}, 'task.input_required'],
  ['failed worker stream', {kind: 'result', status: 'failed', text: 'worker runtime failed'}, 'task.failed'],
]) test(`a ${name} frees its local slot for a queued worker`, {timeout: 3_000}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-slot-handoff-')));
  const session = new Session(root, {root});
  const first = Promise.withResolvers();
  const launched = [];
  const adapter = fakeAdapter(({orders}) => {
    launched.push(orders.split('\n')[0]);
    return orders.startsWith('first') ? first.promise : {never: true};
  });
  const localResolver = {resolve: async ({profile}) => ({...profile, providerID: 'lmstudio', opencodeConfig: {}}), configure() {}};
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {worker: local('worker')}, localResolver,
    gitHead: () => null, requireFinalReport: true,
    localSettings: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 1}}}});
  t.after(async () => { await scheduler.stop(); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });

  const firstTask = scheduler.submit({parent: null, profile: 'worker', orders: 'first', deadline: null});
  await waitFor(() => launched.length === 1, {timeout: 1000});
  const second = scheduler.submit({parent: null, profile: 'worker', orders: 'second', deadline: null});
  await waitFor(() => session.events.some(row => row.task === second.task && row.kind === 'task.milestone' && /local slot/.test(row.text)), {timeout: 1000});

  first.resolve([firstResult]);
  await waitFor(() => session.events.some(row => row.task === firstTask.task && row.kind === releasedState), {timeout: 1000});
  const released = await waitFor(() => session.events.find(row => row.task === firstTask.task && row.kind === 'task.slot.released'), {timeout: 1000});
  await waitFor(() => launched.includes('second'), {timeout: 1000});
  assert.equal(session.events.some(row => row.kind === 'orchestration.action.requested'
    && row.actionId === `dispatch:${second.task}:${released.seq}`), true);
});


test('a launch failure gives its local slot to a queued worker exactly once', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-launch-');
  const gate = Promise.withResolvers();
  const launched = [];
  const adapter = fakeAdapter(({orders}) => {
    launched.push(orders.split('\n')[0]);
    return orders.startsWith('first') ? gate.promise.then(() => ({launchError: 'boom'})) : {never: true};
  });
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {worker: local('worker')}, localResolver: passResolver,
    gitHead: () => null, localSettings: endpoints()});
  teardown(t, scheduler, root);
  const first = scheduler.submit({parent: null, profile: 'worker', orders: 'first', deadline: null});
  await waitFor(() => launched.length === 1, {timeout: 1000});
  const second = scheduler.submit({parent: null, profile: 'worker', orders: 'second', deadline: null});
  await waitFor(() => slotMilestone(session, second.task), {timeout: 1000});
  gate.resolve();
  await waitFor(() => session.events.some(row => row.task === first.task && row.kind === 'task.failed'), {timeout: 1000});
  await waitFor(() => launched.includes('second'), {timeout: 1000});
  const released = releases(session, first.task);
  assert.deepEqual(released.map(row => row.stage), ['launch']);
  assert.equal(session.events.some(row => row.kind === 'orchestration.action.requested' && row.actionId === `dispatch:${second.task}:${released[0].seq}`), true);
});

test('cancelling a worker still in local admission gives its slot to a queued worker exactly once', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-admission-');
  const launched = [];
  const adapter = fakeAdapter(({orders}) => { launched.push(orders.split('\n')[0]); return {never: true}; });
  const held = Promise.withResolvers();
  const localResolver = {resolve: async ({profile, signal}) => {
    if (profile.role === 'held') await new Promise((resolve, reject) => { held.resolve(); signal.addEventListener('abort', () => reject(signal.reason), {once: true}); });
    return {...profile, providerID: 'lmstudio', opencodeConfig: {}};
  }, configure() {}};
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {held: local('held'), worker: local('worker')}, localResolver,
    gitHead: () => null, localSettings: endpoints()});
  teardown(t, scheduler, root);
  const first = scheduler.submit({parent: null, profile: 'held', orders: 'first', deadline: null});
  await held.promise;
  const second = scheduler.submit({parent: null, profile: 'worker', orders: 'second', deadline: null});
  await waitFor(() => slotMilestone(session, second.task), {timeout: 1000});
  await scheduler.cancel(first.task);
  await waitFor(() => launched.includes('second'), {timeout: 1000});
  assert.deepEqual(launched, ['second']);
  assert.equal(session.events.filter(row => row.task === first.task && row.kind === 'task.cancelled').length, 1);
  assert.deepEqual(releases(session, first.task).map(row => row.stage), ['launch']);
});

test('a worker cancelled while its launch is pending gives its slot back once the launch resolves', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-late-launch-');
  const gate = Promise.withResolvers();
  const launched = [];
  const adapter = fakeAdapter(({orders}) => {
    launched.push(orders.split('\n')[0]);
    return orders.startsWith('first') ? gate.promise.then(() => ({never: true})) : {never: true};
  });
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {worker: local('worker')}, localResolver: passResolver,
    gitHead: () => null, localSettings: endpoints()});
  teardown(t, scheduler, root);
  const first = scheduler.submit({parent: null, profile: 'worker', orders: 'first', deadline: null});
  await waitFor(() => launched.length === 1, {timeout: 1000});
  const second = scheduler.submit({parent: null, profile: 'worker', orders: 'second', deadline: null});
  await waitFor(() => slotMilestone(session, second.task), {timeout: 1000});
  await scheduler.cancel(first.task);
  gate.resolve();
  await waitFor(() => session.events.some(row => row.task === first.task && row.kind === 'task.cancelled'), {timeout: 1000});
  await waitFor(() => launched.includes('second'), {timeout: 1000});
  assert.equal(adapter.calls.cancel, 1);
  assert.equal(releases(session, first.task).length, 1);
});

test('an adopted worker holds its slot until its stream ends, then releases it once', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-adopt-');
  const launched = [];
  const adapter = fakeAdapter(({orders}) => { launched.push(orders.split('\n')[0]); return {never: true}; });
  const workers = endable(adapter);
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {worker: local('worker')}, localResolver: passResolver,
    gitHead: () => null, localSettings: endpoints()});
  teardown(t, scheduler, root);
  const firstTask = scheduler.submit({parent: null, profile: 'worker', orders: 'first', deadline: null});
  await waitFor(() => launched.length === 1, {timeout: 1000});
  const second = scheduler.submit({parent: null, profile: 'worker', orders: 'second', deadline: null});
  await waitFor(() => slotMilestone(session, second.task), {timeout: 1000});
  await waitFor(() => session.events.some(row => row.task === firstTask.task && row.kind === 'task.started'), {timeout: 1000});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(releases(session, firstTask.task).length, 0);
  assert.deepEqual(launched, ['first']);
  workers.end('first', {kind: 'result', status: 'completed', text: 'done'});
  await waitFor(() => launched.includes('second'), {timeout: 1000});
  assert.deepEqual(releases(session, firstTask.task).map(row => row.stage), [undefined]);
});

test('a failed report-only resume releases its slot once, after the worker handle ends', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-resume-');
  const launched = [];
  let firstTurns = 0;
  const adapter = fakeAdapter(({orders, message}) => {
    const name = (orders ?? 'first-resume').split('\n')[0];
    launched.push(name);
    if (name === 'first' && ++firstTurns === 1) return [{kind: 'native', sessionId: 'native-first'}, {kind: 'result', status: 'completed', text: '{"op":"final","outcome":'}];
    if (message) return {launchError: 'resume refused'};
    return {never: true};
  });
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {worker: local('worker')}, localResolver: passResolver,
    gitHead: () => null, requireFinalReport: true, localSettings: endpoints()});
  teardown(t, scheduler, root);
  const gate = Promise.withResolvers();
  const off = session.subscribe(row => { if (row.kind === 'task.report_requested') gate.resolve(); });
  const firstTask = scheduler.submit({parent: null, profile: 'worker', orders: 'first', deadline: null});
  const second = scheduler.submit({parent: null, profile: 'worker', orders: 'second', deadline: null});
  await gate.promise; off();
  await waitFor(() => session.events.some(row => row.task === firstTask.task && row.kind === 'task.blocked'), {timeout: 1000});
  await waitFor(() => launched.includes('second'), {timeout: 1000});
  assert.equal(slotMilestone(session, second.task), true);
  assert.equal(adapter.calls.resume, 1);
  assert.equal(session.events.findLast(row => row.task === firstTask.task && row.kind === 'task.blocked').reason, 'report_repair_unavailable');
  assert.equal(releases(session, firstTask.task).length, 1);
});

test('local prelaunch reviews obey the endpoint slot limit', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-review-');
  const launched = [];
  const firstReview = Promise.withResolvers();
  const adapter = fakeAdapter(({peer}) => {
    launched.push(peer);
    return launched.filter(name => name.startsWith('review:')).length === 1 ? firstReview.promise : {never: true};
  });
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {worker: local('worker'), reviewer: reviewerOn('m')}, localResolver: passResolver,
    gitHead: () => null, localSettings: endpoints()});
  teardown(t, scheduler, root);
  const first = scheduler.submit({parent: null, profile: 'worker', orders: 'first', deadline: null, review: {prelaunch: 'reviewer', completion: 'reviewer'}});
  const second = scheduler.submit({parent: null, profile: 'worker', orders: 'second', deadline: null, review: {prelaunch: 'reviewer', completion: 'reviewer'}});
  // The second task waits either at the dispatch gate or at review admission; never beside the first.
  await waitFor(() => launched.length === 1, {timeout: 1000});
  await waitFor(() => slotMilestone(session, second.task) || session.events.some(row => row.task === second.task && row.kind === 'review.started'), {timeout: 1000});
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(launched, [`review:${first.task}`]);
  firstReview.resolve([{kind: 'result', status: 'completed', text: '{"verdict":"reject"}'}]);
  await waitFor(() => session.events.some(row => row.task === first.task && row.kind === 'task.rejected'), {timeout: 1000});
  await waitFor(() => launched.length === 2, {timeout: 1000});
  assert.deepEqual(launched, [`review:${first.task}`, `review:${second.task}`]);
  assert.deepEqual(releases(session, first.task).map(row => row.stage), ['review']);
});

test('a completion review waiting for a model slot is cancellable and leaves no reservation', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-review-cancel-');
  const launched = [];
  const adapter = fakeAdapter(({peer, orders}) => {
    launched.push(peer);
    if (peer.startsWith('review:')) return {never: true};
    return orders.startsWith('first') ? [{kind: 'result', status: 'completed', text: 'done'}] : {never: true};
  });
  const workers = endable(adapter);
  // Two endpoint slots, one per model: the busy worker runs the reviewer's model, the first worker another.
  const scheduler = createScheduler({...hostless, session, adapters: {opencode: adapter}, profiles: {worker: local('worker', 'm'), busy: local('busy', 'r'), reviewer: reviewerOn('r')},
    localResolver: passResolver, gitHead: () => null, localSettings: endpoints({maxConcurrent: 2, slotsPerModel: 1})});
  teardown(t, scheduler, root);
  const busy = scheduler.submit({parent: null, profile: 'busy', orders: 'busy', deadline: null});
  await waitFor(() => session.events.some(row => row.task === busy.task && row.kind === 'task.started'), {timeout: 1000});
  const first = scheduler.submit({parent: null, profile: 'worker', orders: 'first', deadline: null, review: {completion: 'reviewer'}});
  await waitFor(() => session.events.some(row => row.task === first.task && row.kind === 'review.started'), {timeout: 1000});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(launched.some(peer => peer.startsWith('review:')), false);
  await scheduler.cancel(first.task);
  await waitFor(() => session.events.some(row => row.task === first.task && row.kind === 'task.cancelled'), {timeout: 1000});
  assert.equal(launched.some(peer => peer.startsWith('review:')), false);
  // The abandoned admission neither launched nor holds the slot: the busy worker's end releases the only one.
  assert.deepEqual(releases(session, first.task).map(row => row.stage), [undefined]);
  workers.end('busy', {kind: 'result', status: 'completed', text: 'done'});
  await waitFor(() => releases(session, busy.task).length === 1, {timeout: 1000});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(launched.some(peer => peer.startsWith('review:')), false);
});

test('queued local work is dispatched once each after a daemon restart', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-slot-restart-');
  const held = Promise.withResolvers();
  // Like the real resolver, it stops when the daemon closes and aborts it.
  const stalled = {resolve: async ({signal}) => { held.resolve(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true})); }, configure() {}};
  const before = createScheduler({...hostless, session, adapters: {opencode: fakeAdapter(() => ({never: true}))}, profiles: {worker: local('worker')}, localResolver: stalled,
    gitHead: () => null, localSettings: endpoints()});
  const first = before.submit({parent: null, profile: 'worker', orders: 'first', deadline: null});
  await held.promise;
  const second = before.submit({parent: null, profile: 'worker', orders: 'second', deadline: null});
  await waitFor(() => slotMilestone(session, second.task), {timeout: 1000});
  before.close();

  const reopened = new Session(root, {root, id: session.id});
  const launched = [];
  const adapter = fakeAdapter(({orders}) => { launched.push(orders.split('\n')[0]); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  const after = createScheduler({...hostless, session: reopened, adapters: {opencode: adapter}, profiles: {worker: local('worker')}, localResolver: passResolver,
    gitHead: () => null, localSettings: endpoints()});
  teardown(t, after, root);
  await after.reconcile();
  await waitFor(() => reopened.events.some(row => row.task === second.task && row.kind === 'task.completed'), {timeout: 1000});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(launched.sort(), ['first', 'second']);
  assert.equal(reopened.events.some(row => row.task === first.task && row.kind === 'task.completed'), true);
});

test('a dispatch interrupted during its checkpoint is launched once after a restart, not twice', {timeout: 3_000}, async t => {
  const {root, session} = tmpSession('bounce-restart-dispatch-');
  const clean = async () => ({status: 0, stdout: ''});
  const checkpoint = await takeCheckpoint({cwd: session.cwd, run: clean});
  const cloud = {adapter: 'fake', model: 'x', mode: 'yolo', fallback: []};
  const interrupted = Promise.withResolvers();
  const before = createScheduler({...hostless, session, adapters: {fake: fakeAdapter(() => ({never: true}))}, profiles: {A: cloud}, gitHead: () => null,
    checkpointRunner: () => { interrupted.resolve(); return new Promise(() => {}); }});
  const row = before.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, checkpoint});
  await interrupted.promise;
  before.close();

  const reopened = new Session(root, {root, id: session.id});
  const adapter = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  // The re-check takes a moment, as a real one does: both recovery paths are inside it at once.
  const after = createScheduler({...hostless, session: reopened, adapters: {fake: adapter}, profiles: {A: cloud}, gitHead: () => null,
    checkpointRunner: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return {status: 0, stdout: ''}; }});
  teardown(t, after, root);
  await after.reconcile();
  await waitFor(() => reopened.events.some(e => e.task === row.task && e.kind === 'task.completed'), {timeout: 1000});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(adapter.calls.launch, 1);
  assert.equal(reopened.events.filter(e => e.task === row.task && e.kind === 'task.started').length, 1);
});

// Observed live (reviewer 080b39ce): a 9 KB FAIL verdict needed its report repaired, the repair was refused
// as "the machine is swapping", and the task failed incomplete_report.
// A repair continues the same local session, so no cloud AI can take it: it waits, and if it never
// runs the task is blocked with the answer it already gave.
const finalReport = {op: 'final', phase: 'review', text: 'Reviewed.', next: 'None', evidence: [], outcome: 'completed', summary: 'Verdict: FAIL, one blocker.', remaining: ''};
function pressureScenario(t, {deadline = null} = {}) {
  const {root, session} = tmpSession('bounce-swap-repair-');
  let pressured = false;
  const answer = '**Verdict: FAIL**\n\n## FINDING 1 (blocker): Docker cancellation does not set report.childExitCode';
  const adapter = fakeAdapter(({message}) => {
    if (!message) { pressured = true; return [{kind: 'native', sessionId: 'native-review'}, {kind: 'result', status: 'completed', text: answer}]; }
    return [{kind: 'result', status: 'completed', text: JSON.stringify(finalReport)}];
  });
  const machine = {read: () => ({known: true, available: 64 * 1024 ** 3, total: 128 * 1024 ** 3, pressure: pressured ? 2 : 1}), underPressure: () => pressured};
  const scheduler = createScheduler({...hostless, resources: machine, session, adapters: {opencode: adapter}, profiles: {worker: local('worker')}, localResolver: passResolver,
    gitHead: () => null, requireFinalReport: true, watchdog: {interval: null}, localSettings: endpoints({pollMs: 5})});
  teardown(t, scheduler, root);
  const row = scheduler.submit({parent: null, profile: 'worker', orders: 'review it', deadline});
  return {session, scheduler, row, adapter, answer, ease: () => { pressured = false; }};
}

test('a report repair that meets memory pressure waits for it to ease, then completes', {timeout: 3_000}, async t => {
  const {session, row, adapter, ease} = pressureScenario(t);
  await waitFor(() => session.events.some(e => e.task === row.task && e.kind === 'task.milestone' && /^Waiting for warning memory pressure to ease before repairing the report on lmstudio$/.test(e.text)), {timeout: 1000});
  assert.equal(adapter.calls.resume, 0);
  ease();
  await waitFor(() => session.events.some(e => e.task === row.task && e.kind === 'task.completed'), {timeout: 1000});
  assert.equal(session.events.some(e => e.task === row.task && e.kind === 'task.failed'), false);
  assert.equal(adapter.calls.resume, 1);
});

test('a report repair that never gets to run blocks with the answer the worker already gave', {timeout: 3_000}, async t => {
  const {session, row, adapter} = pressureScenario(t, {deadline: 400});
  const blocked = await waitFor(() => session.events.find(e => e.task === row.task && e.kind === 'task.blocked'), {timeout: 2_500});
  const output = session.events.find(e => e.task === row.task && e.kind === 'task.output');
  assert.equal(blocked.reason, 'report_repair_unavailable');
  assert.match(blocked.text, new RegExp(`^The worker answered \\(${output.chars} chars, output seq ${output.seq}\\): "\\*\\*Verdict: FAIL\\*\\*`));
  assert.match(blocked.text, /Its report could not be repaired: Local task deadline exceeded\. Read it with task_get full; accept it, resubmit it, or continue it on a cloud AI if the user agrees\.$/);
  assert.equal(session.events.some(e => e.task === row.task && e.kind === 'task.failed'), false);
  assert.equal(adapter.calls.resume, 0);
});
