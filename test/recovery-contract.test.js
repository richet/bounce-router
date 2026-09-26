import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createBus, connectBus} from '../src/bus.js';

function heldAdapter() {
  let release;
  const result = new Promise(resolve => { release = resolve; });
  return {
    launch: async () => ({}),
    async *events() { yield await result; },
    cancel: async () => ({verified: true}),
    complete(status = 'completed', text = status) { release({kind: 'result', status, text}); },
  };
}

function rowAfter(session, predicate) {
  const existing = session.events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise(resolve => {
    const stop = session.subscribe(row => { if (predicate(row)) { stop(); resolve(row); } });
  });
}

test('cancelling a pending launch cannot start fallback before verified termination', {timeout: 2000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-launch-contract-'));
  const session = new Session(root, {root});
  let resolveLaunch, cancelCalls = 0, replacements = 0;
  const adapter = {launch: () => new Promise(resolve => { resolveLaunch = resolve; }),
    async *events() {}, cancel: async () => { cancelCalls++; return {verified: false}; }};
  const scheduler = createScheduler({session, adapters: {A: adapter, B: {...adapter, launch: async () => { replacements++; return {}; }}},
    profiles: {A: {adapter: 'A', fallback: ['B']}, B: {adapter: 'B'}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const row = scheduler.submit({profile: 'A', orders: 'work'});
  assert.equal(typeof resolveLaunch, 'function');
  assert.equal((await scheduler.cancel(row.task, {reason: 'watchdog'})).verified, false);
  assert.equal(replacements, 0);
  resolveLaunch({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelCalls, 1);
  assert.equal(replacements, 0);
  assert.equal(scheduler.tasks()[row.task].state, 'blocked');
  assert.equal(session.events.some(event => event.kind === 'task.cancelled'), false);
});

test('fallback refusal distinguishes absent configuration from incompatible profiles', async t => {
  for (const configured of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-reason-contract-'));
    const session = new Session(root, {root});
    const adapter = heldAdapter();
    const scheduler = createScheduler({session, adapters: {A: adapter}, profiles: {
      A: {adapter: 'A', policy: 'read-only', fallback: configured ? ['B'] : []},
      B: {adapter: 'A', policy: 'yolo'},
    }, watchdog: {interval: null}});
    t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
    scheduler.submit({profile: 'A', orders: 'work'});
    await rowAfter(session, row => row.kind === 'task.started');
    adapter.complete('limited');
    const refusal = await rowAfter(session, row => row.kind === 'policy.fallback.skipped');
    assert.equal(refusal.reason, configured ? 'no_compatible_profile' : 'no_profile_configured');
  }
});

test('crash replay retains unknown writers as blocked and refuses new dispatch', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-orphan-contract-'));
  const session = new Session(root, {root});
  session.append({kind: 'task.submitted', task: 'orphan', profile: 'A', orders: 'work'});
  session.append({kind: 'task.started', task: 'orphan', attempt: 1});
  let launches = 0;
  const adapter = {...heldAdapter(), launch: async () => { launches++; return {}; }};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles: {A: {adapter: 'A'}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  assert.equal(scheduler.tasks().orphan.state, 'blocked');
  assert.equal((await scheduler.cancel('orphan')).verified, false);
  const row = scheduler.submit({profile: 'A', orders: 'replacement'});
  assert.equal(scheduler.tasks()[row.task].state, 'blocked');
  assert.equal(launches, 0);
});

test('observed work has bounded durable checkpoints distinct from worker reports', {timeout: 2000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-observed-contract-'));
  const session = new Session(root, {root});
  const adapter = {launch: async () => ({}), cancel: async () => ({verified: true}),
    async *events() { for (let n = 0; n < 100; n++) yield {kind: 'tool', text: `tool ${n}`}; yield {kind: 'result', status: 'failed'}; }};
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles: {A: {adapter: 'A'}}, requireFinalReport: true, clock: () => 0, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  scheduler.submit({profile: 'A', orders: 'work'});
  await rowAfter(session, row => row.kind === 'task.failed');
  assert.equal(session.events.filter(row => row.kind === 'task.observed').length, 1);
  assert.equal(session.events.some(row => row.kind === 'task.milestone'), false);
});

test('an already-waiting bus client and a dependent follow the replacement to success', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-lineage-contract-'));
  const session = new Session(root, {root});
  const first = heldAdapter(), replacement = heldAdapter(), dependent = heldAdapter();
  const scheduler = createScheduler({session, adapters: {first, replacement, dependent}, profiles: {
    A: {adapter: 'first', mode: 'plan', fallback: ['B']},
    B: {adapter: 'replacement', mode: 'plan'},
    D: {adapter: 'dependent', mode: 'plan'},
  }, watchdog: {interval: null}});
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate});
  const grant = bus.grant({peer: 'user', canSubmit: true, tasks: [], context: session.id});
  const client = await connectBus({path: bus.path, token: fs.readFileSync(grant.file, 'utf8').trim()});
  t.after(async () => { first.complete(); replacement.complete(); dependent.complete(); scheduler.close(); await client.close(); await bus.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const original = scheduler.submit({profile: 'A', orders: 'work'});
  const waiting = scheduler.submit({profile: 'D', orders: 'after work', depends_on: [original.task]});
  await rowAfter(session, row => row.kind === 'task.started' && row.task === original.task);
  const outcome = client.wait({match: {kind: 'task.completed', task: original.task}, timeout: 1000});
  // This request is ordered after wait over the same socket, so wait is subscribed first.
  await client.events();
  first.complete('limited');
  const retry = await rowAfter(session, row => row.kind === 'task.submitted' && row.replaces === original.task);
  await rowAfter(session, row => row.kind === 'task.started' && row.task === retry.task);
  assert.equal(scheduler.tasks()[waiting.task].state, 'queued');
  replacement.complete();
  const actual = await outcome;
  assert.equal(actual?.task, retry.task);
  assert.equal(actual?.kind, 'task.completed');
  // Default policy deliberately waits for acceptance, not merely model completion.
  session.append({kind: 'task.accepted', task: retry.task, by: 'orchestrator'});
  await rowAfter(session, row => row.kind === 'task.started' && row.task === waiting.task);
  dependent.complete();
});

test('logical outcome wait stays pending until completion review decides', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-reviewed-contract-'));
  const session = new Session(root, {root});
  const worker = heldAdapter(), critic = heldAdapter();
  const scheduler = createScheduler({session, adapters: {worker, critic}, profiles: {
    W: {adapter: 'worker', mode: 'plan'}, C: {adapter: 'critic', role: 'critic', mode: 'plan'},
  }, watchdog: {interval: null}});
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate});
  const grant = bus.grant({peer: 'user', canSubmit: true, context: session.id});
  const client = await connectBus({path: bus.path, token: fs.readFileSync(grant.file, 'utf8').trim()});
  t.after(async () => { worker.complete(); critic.complete(); scheduler.close(); await client.close(); await bus.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const row = scheduler.submit({profile: 'W', orders: 'work', review: {completion: 'C'}});
  await rowAfter(session, row => row.kind === 'task.started');
  let resolved = false;
  const outcome = client.wait({match: {kind: 'task.completed', task: row.task}, timeout: 2000}).then(value => { resolved = true; return value; });
  await client.events();
  worker.complete();
  await rowAfter(session, row => row.kind === 'review.started');
  await client.events();
  assert.equal(resolved, false, 'a completed worker is not an accepted reviewed assignment');
  critic.complete('completed', '{"verdict":"accept"}');
  assert.equal((await outcome).kind, 'task.accepted');
});

// A worker's own final answer is the source of truth whenever it has one at all: a non-empty
// answer synthesizes directly (see final-report.test.js / worker-communication.test.js), so only
// a literally empty answer still gets a turn back — and that turn asks in plain words, not the
// bounce_report tool it just failed to use (src/scheduler.js requestPlainAnswer).
test('an empty final answer gets one plain-words resume and accepts its scoped response', {timeout: 2000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-report-contract-'));
  const session = new Session(root, {root});
  let scheduler, grant, resumes = 0;
  const adapter = {
    launch: async ({orders}) => { assert.match(orders, /call the bounce_report tool/); assert.doesNotMatch(orders, /bounce report --report/); return {attempt: 1}; },
    async resume({message}) {
      resumes++;
      assert.match(message, /plain words/i);
      assert.doesNotMatch(message, /call the bounce_report tool/);
      assert.doesNotMatch(message, /bounce report --report/);
      assert.throws(() => scheduler.report({...grant, attempt: 1, report: {op: 'milestone', phase: 'old', text: 'late', next: 'none'}}), /stale report/);
      scheduler.report({...grant, report: {op: 'final', outcome: 'completed', phase: 'done', text: 'Verified', next: 'none', summary: 'Actual result', evidence: ['test/log'], remaining: ''}});
      return {attempt: 2};
    },
    async *events() { yield {kind: 'native', provider: 'A', sessionId: 'thread'}; yield {kind: 'result', status: 'completed', text: ''}; },
    cancel: async () => ({verified: true}),
  };
  scheduler = createScheduler({session, adapters: {codex: adapter}, profiles: {A: {adapter: 'codex', mode: 'plan'}}, requireFinalReport: true, reportGrant: identity => { grant = identity; return {}; }, limits: {attempts: 1}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const submitted = scheduler.submit({profile: 'A', orders: 'work', budget: {starts: 2}});
  await rowAfter(session, row => ['task.failed', 'task.completed'].includes(row.kind) && row.task === submitted.task);
  assert.equal(resumes, 1);
  assert.equal(scheduler.tasks()[submitted.task].state, 'completed');
  assert.equal(scheduler.tasks()[submitted.task].summary, 'Actual result');
  assert.equal(scheduler.budgets().roots[submitted.task].remaining.starts, 0);
});

test('watchdog does not kill a worker producing observed work solely for missing milestones', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-progress-contract-'));
  const session = new Session(root, {root});
  let now = 0;
  const adapter = heldAdapter();
  adapter.deliver = async () => 'live';
  const scheduler = createScheduler({session, adapters: {A: adapter}, profiles: {A: {adapter: 'A', mode: 'plan'}}, clock: () => now, watchdog: {interval: null, silence: 100, stall: 10, grace: 5}});
  t.after(async () => { adapter.complete(); await rowAfter(session, row => row.kind === 'task.completed'); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const submitted = scheduler.submit({profile: 'A', orders: 'long work', deadline: 1000});
  await rowAfter(session, row => row.kind === 'task.started');
  for (const time of [20, 21, 40]) {
    now = time;
    session.publish({kind: 'task.activity', task: submitted.task, text: 'Tool completed', time: new Date(now).toISOString()});
    await scheduler.tick();
  }
  assert.equal(scheduler.tasks()[submitted.task].state, 'running');
});

test('restart after verified worker exit without an outcome exposes a concrete recovery blocker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-ended-gap-'));
  const session = new Session(root, {root});
  session.append({kind: 'task.submitted', task: 'ended', profile: 'A', orders: 'work'});
  session.append({kind: 'task.started', task: 'ended', attempt: 1});
  session.append({kind: 'task.attempt.ended', task: 'ended', attempt: 1, verifiedTermination: true});
  const scheduler = createScheduler({session, adapters: {A: heldAdapter()}, profiles: {A: {adapter: 'A'}}, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  await scheduler.reconcile();
  assert.equal(scheduler.tasks().ended.state, 'blocked');
  assert.equal(session.events.findLast(e => e.kind === 'task.blocked')?.reason, 'outcome_recovery_required');
});
