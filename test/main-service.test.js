import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createBus, connectBus} from '../src/bus.js';
import {createMainService} from '../src/main-service.js';

function fixture(t, provider = 'codex') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-main-service-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const pending = [], calls = [];
  const adapter = {
    async launch(args) { calls.push(['launch', args]); return {turnId: 'vendor-turn'}; },
    async resume(args) { calls.push(['resume', args]); return {turnId: 'next-turn'}; },
    async *events() {
      yield {kind: 'native', provider, sessionId: 'native-thread'};
      yield {kind: 'assistant', text: 'Working'};
      yield await new Promise(resolve => pending.push(resolve));
    },
    async deliver(handle, args) { calls.push(['deliver', args]); return 'live'; },
    async cancel() { calls.push(['cancel']); pending.shift()?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
  const main = createMainService({session, adapters: {[provider]: adapter}, profile: {adapter: provider, mode: 'plan'}, settings: {executables: {}}, brief: 'Orders'});
  t.after(() => main.close());
  return {main, session, calls, pending};
}

function nextEvent(main, kind) {
  return new Promise(resolve => {
    const stop = main.subscribe(event => { if (event.kind === kind) { stop(); resolve(event); } });
  });
}

for (const provider of ['claude', 'codex', 'muse']) test(`${provider} roster uses generic delivery and is included on resumed orchestrator turns`, async t => {
  const f = fixture(t, provider);
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'before-setup', text: 'work'});
  await started;
  const notice = 'LocalWorker → local/qwen (read-only); never substitute a cloud worker';
  f.session.append({kind: 'local.profiles.activated', names: ['LocalWorker'], text: notice});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.find(([kind]) => kind === 'deliver')[1].text, notice);
  assert.equal(f.calls.filter(([kind]) => kind === 'cancel').length, 0);
  const ended = nextEvent(f.main, 'main.terminal');
  f.pending.shift()({kind: 'result', status: 'completed'});
  await ended;
  const resumed = nextEvent(f.main, 'main.started');
  f.main.run({id: 'after-setup', text: 'test the local worker'});
  await resumed;
  assert.ok(f.calls.find(([kind]) => kind === 'resume')[1].message.includes(notice));
});

test('daemon main acknowledges immediately, steers the held turn and resumes native continuity', async t => {
  const f = fixture(t);
  const started = nextEvent(f.main, 'main.started');
  assert.equal((await f.main.run({id: 'request-1', text: 'work'})).accepted, true);
  assert.equal((await started).turnId, 'vendor-turn');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.main.deliver({id: 'message-1', text: 'correction', expectedTurnId: 'vendor-turn'})).tier, 'live');
  assert.equal(f.calls.find(([kind]) => kind === 'deliver')[1].text, 'correction');
  assert.equal((await f.main.deliver({id: 'stale', text: 'wrong', expectedTurnId: 'old'})).reason, 'turn_changed');
  const completed = nextEvent(f.main, 'main.terminal');
  f.pending.shift()({kind: 'result', status: 'completed', text: 'Done'});
  assert.equal((await completed).status, 'completed');
  assert.equal(f.session.events.some(event => event.kind === 'assistant' && event.text === 'Working'), true);
  const resumed = nextEvent(f.main, 'main.started');
  await f.main.run({id: 'request-2', text: 'more'}); await resumed;
  assert.equal(f.calls.find(([kind]) => kind === 'resume')[1].native.sessionId, 'native-thread');
});

test('daemon main denies stale cancellation and refuses false completion on missing terminal result', async t => {
  const f = fixture(t);
  const started = nextEvent(f.main, 'main.started');
  await f.main.run({id: 'request-1', text: 'work'}); await started;
  assert.equal((await f.main.cancel({id: 'another-request'})).reason, 'turn_changed');
  assert.equal(f.calls.some(([kind]) => kind === 'cancel'), false);
  const ended = nextEvent(f.main, 'main.terminal');
  await f.main.cancel({id: 'request-1'});
  assert.equal((await ended).status, 'interrupted');
});

test('daemon main does not resume an unverified writer after a crash', async t => {
  const f = fixture(t);
  f.session.append({kind: 'main.started', requestId: 'lost', turnId: 'lost-turn', from: 'main'});
  let launches = 0;
  const main = createMainService({session: f.session, adapters: {codex: {launch: async () => { launches++; return {}; }}}, profile: {adapter: 'codex'}, settings: {}});
  assert.equal(main.state().state, 'blocked');
  assert.equal(main.run({text: 'more work'}).reason, 'termination_unverified');
  assert.equal((await main.cancel()).verified, false);
  assert.equal((await main.close()).verified, false);
  assert.equal(launches, 0);
});

test('main validates user attachments and passes only its saved image copies', async t => {
  const f = fixture(t);
  const file = path.join(f.session.cwd, 'sample.png');
  fs.writeFileSync(file, Buffer.from([137,80,78,71,13,10,26,10]));
  const started = nextEvent(f.main, 'main.started');
  assert.equal(f.main.run({text: 'describe this', files: [file]}).accepted, true);
  await started;
  const images = f.calls[0][1].userImages;
  assert.equal(images.length, 1);
  assert.notEqual(images[0].path, file);
  assert.equal(images[0].path.startsWith(path.join(f.session.dir, 'images')), true);
});

test('switching back to a native provider includes the intervening provider handoff', async t => {
  const f = fixture(t);
  const calls = [];
  const adapter = provider => ({
    async launch(args) { calls.push({provider, ...args}); return {}; },
    async resume(args) { calls.push({provider, ...args}); return {}; },
    async *events() { yield {kind: 'native', provider, sessionId: `${provider}-thread`}; yield {kind: 'assistant', text: `${provider} UNIQUE_RESULT`}; yield {kind: 'result', status: 'completed'}; },
    async cancel() { return {verified: true}; },
  });
  const main = createMainService({session: f.session, adapters: {codex: adapter('codex'), claude: adapter('claude')}, profile: {adapter: 'codex', mode: 'plan'}, settings: {}});
  t.after(() => main.close());
  for (const provider of ['codex', 'claude', 'codex']) {
    const terminal = nextEvent(main, 'main.terminal');
    main.run({provider, text: 'continue'});
    await terminal;
  }
  assert.equal(calls[2].native.sessionId, 'codex-thread');
  assert.match(calls[2].message, /claude UNIQUE_RESULT/);
});

test('daemon main records the slash line a request was expanded from and rejects a malformed one', async t => {
  const f = fixture(t);
  assert.equal(f.main.run({id: 'bad', text: 'work', typed: 'triage'}).reason, 'invalid_typed');
  assert.equal(f.main.run({id: 'bad', text: 'work', typed: 7}).reason, 'invalid_typed');
  assert.equal((await f.main.run({id: 'request-1', text: 'Command: /triage — file\n\nTriage REC-1', typed: '/triage REC-1'})).accepted, true);
  const user = f.session.events.find(e => e.kind === 'user');
  assert.equal(user.typed, '/triage REC-1');
  assert.match(user.text, /Triage REC-1/);
  f.pending.shift()?.({kind: 'result', status: 'completed', text: 'Done'});
});

// --- wake-up on worker outcomes (fix/orchestrator-handoff) ---------------------------------
// The daemon owns the main agent: when it is idle and a root task it submitted ends, the daemon
// starts the next turn itself with the outcome in front of it.
function wakeFixture(t, {handoffDelayMs = 10} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-main-wake-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const pending = [], calls = [], launchErrors = []; // launchErrors: messages the next launches/resumes reject with
  const adapter = {
    async launch(args) { calls.push(['launch', args]); if (launchErrors.length) throw new Error(launchErrors.shift()); return {turnId: `turn-${calls.length}`}; },
    async resume(args) { calls.push(['resume', args]); if (launchErrors.length) throw new Error(launchErrors.shift()); return {turnId: `turn-${calls.length}`}; },
    async *events() {
      yield {kind: 'native', provider: 'codex', sessionId: 'native-thread'};
      yield await new Promise(resolve => pending.push(resolve));
    },
    async deliver() { return 'live'; },
    async cancel() { pending.shift()?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
  const main = createMainService({session, adapters: {codex: adapter}, profile: {adapter: 'codex', mode: 'plan'}, settings: {executables: {}}, brief: 'Orders', handoffDelayMs});
  t.after(() => main.close());
  const finishTurn = async (text = 'Done') => {
    while (!pending.length) await new Promise(resolve => setImmediate(resolve)); // the turn's stream is being consumed
    const ended = nextEvent(main, 'main.terminal');
    pending.shift()({kind: 'result', status: 'completed', text});
    await ended;
  };
  // One completed orchestrator turn behind us, so the wake-up is a resume, not the first turn.
  const settle = async () => {
    const started = nextEvent(main, 'main.started');
    main.run({id: 'first', text: 'delegate'});
    await started;
    await finishTurn('Two workers running; I will synthesize when they report.');
  };
  const submit = (task, {from = 'orchestrator', parent = null, profile = 'build', replaces = null, review = null} = {}) => {
    session.append({kind: 'task.submitted', task, parent, from, profile, orders: 'go', deadline: null, replaces, review});
    session.append({kind: 'task.started', task, attempt: 1, from: `worker:${task}`});
  };
  const quiet = ms => new Promise(resolve => setTimeout(resolve, ms));
  const promptOf = call => call[1].message ?? call[1].orders;
  // A real bus over the same session, so a peer's `wait` journals (or does not) exactly as in the daemon.
  let bus = null;
  const peer = async (name, tasks = []) => {
    bus ??= await createBus({session, dir: session.dir});
    t.after(() => bus.close());
    const client = await connectBus({path: bus.path, token: bus.grant({peer: name, canSubmit: true, tasks, context: session.id}).token});
    t.after(() => client.close());
    return client;
  };
  return {main, session, calls, pending, launchErrors, finishTurn, settle, submit, quiet, promptOf, peer};
}

test('an idle orchestrator is woken with the completed task summary as a new, distinctly journaled turn', async t => {
  const f = wakeFixture(t);
  await f.settle();
  f.submit('a2cf5450');
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.reported', task: 'a2cf5450', attempt: 1, outcome: 'completed', summary: 'Wrote tasks/jev/jev-facts.md'});
  f.session.append({kind: 'task.completed', task: 'a2cf5450', summary: 'Wrote tasks/jev/jev-facts.md', from: 'worker:a2cf5450'});
  assert.equal((await woken).handoff, true);
  await nextEvent(f.main, 'main.started');
  const prompt = f.promptOf(f.calls.at(-1));
  assert.match(prompt, /task a2cf5450 · profile build · task\.completed/);
  assert.match(prompt, /Wrote tasks\/jev\/jev-facts\.md/);
  assert.match(prompt, /Continue your orders/);
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.equal(row.wake, true);
  assert.deepEqual(row.tasks, ['a2cf5450']);
  assert.equal(row.from, 'bounce');
  assert.match(row.text, /Wrote tasks\/jev\/jev-facts\.md/);
  // The synthetic prompt is never a `user` row: the transcript and --json can tell them apart.
  assert.equal(f.session.events.filter(e => e.kind === 'user').length, 1);
  assert.equal(f.main.state().state, 'running');
  await f.finishTurn('Synthesized.');
  // Nothing new ended: idle again, and no second wake-up for the same outcome.
  await f.quiet(40);
  assert.equal(f.session.events.filter(e => e.kind === 'handoff').length, 1);
  assert.equal(f.main.state().state, 'idle');
});

test('several tasks ending within the window become one wake-up turn, failures with reason and text', async t => {
  const f = wakeFixture(t, {handoffDelayMs: 30});
  await f.settle();
  f.submit('t-done'); f.submit('t-fail', {profile: 'build_claude'});
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.completed', task: 't-done', summary: 'x'.repeat(5000), from: 'worker:t-done'});
  f.session.append({kind: 'task.failed', task: 't-fail', reason: 'reported_failure', text: 'tests red', from: 'worker:t-fail'});
  await woken;
  await nextEvent(f.main, 'main.started');
  assert.equal(f.session.events.filter(e => e.kind === 'main.starting').length, 2);
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.deepEqual(row.tasks, ['t-done', 't-fail']);
  assert.match(row.text, /task t-fail · profile build_claude · task\.failed · reason: reported_failure\n  tests red/);
  assert.ok(row.text.length < 5000 + 1000, 'per-task outcome text is capped');
  await f.finishTurn();
});

test('a user prompt that arrives first carries the outcomes instead of being raced by a wake-up', async t => {
  const f = wakeFixture(t, {handoffDelayMs: 50});
  await f.settle();
  f.submit('t1');
  f.session.append({kind: 'task.completed', task: 't1', summary: 'the summary', from: 'worker:t1'});
  const started = nextEvent(f.main, 'main.started');
  assert.equal(f.main.run({id: 'typed', text: 'what happened?'}).accepted, true);
  await started;
  const prompt = f.promptOf(f.calls.at(-1));
  assert.match(prompt, /task t1 · profile build · task\.completed\n  the summary/);
  assert.match(prompt, /what happened\?$/);
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.equal(row.wake, false);
  assert.equal(f.session.events.findLast(e => e.kind === 'user').text, 'what happened?');
  await f.finishTurn();
  await f.quiet(80); // the wake timer fires into an already-answered outcome: no synthetic turn
  assert.equal(f.session.events.filter(e => e.kind === 'main.starting').length, 2);
  assert.equal(f.session.events.filter(e => e.kind === 'handoff').length, 1);
});

test('a task that ends during a turn and is not returned by one of its waits wakes the orchestrator at its next idle', async t => {
  const f = wakeFixture(t);
  await f.settle();
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'busy', text: 'more'});
  await started;
  f.submit('unwaited');
  f.session.append({kind: 'task.completed', task: 'unwaited', summary: 'ended mid-turn', from: 'worker:unwaited'});
  await f.quiet(40);
  assert.equal(f.session.events.filter(e => e.kind === 'main.starting').length, 2, 'no wake while a turn is running');
  const woken = nextEvent(f.main, 'main.starting');
  await f.finishTurn('Turn over without waiting.');
  assert.equal((await woken).handoff, true);
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.deepEqual(row.tasks, ['unwaited']);
  assert.match(row.text, /task unwaited · profile build · task\.completed\n  ended mid-turn/);
  await nextEvent(f.main, 'main.started');
  await f.finishTurn();
  await f.quiet(40);
  assert.equal(f.session.events.filter(e => e.kind === 'handoff').length, 1, 'delivered once');
});

test('a terminal row returned by the orchestrator\'s own wait is seen (no wake); one returned to the user grant is not', async t => {
  const f = wakeFixture(t);
  await f.settle();
  const orchestrator = await f.peer('orchestrator');
  const user = await f.peer('user');
  f.submit('waited'); f.submit('theirs-to-wait');
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'busy', text: 'more'});
  await started;
  const waited = orchestrator.wait({match: {kind: 'task.completed', task: 'waited'}, timeout: 5000});
  const observed = user.wait({match: {kind: 'task.completed', task: 'theirs-to-wait'}, timeout: 5000});
  f.session.append({kind: 'task.completed', task: 'waited', summary: 'seen by wait', from: 'worker:waited'});
  f.session.append({kind: 'task.completed', task: 'theirs-to-wait', summary: 'seen by the user only', from: 'worker:theirs-to-wait'});
  assert.equal((await waited).kind, 'task.completed');
  assert.equal((await observed).kind, 'task.completed');
  const served = f.session.events.filter(e => e.kind === 'wait.served');
  assert.deepEqual(served.map(e => [e.task, e.outcome, e.from]), [['waited', 'task.completed', 'orchestrator']]);
  assert.equal(served[0].served, f.session.events.find(e => e.kind === 'task.completed' && e.task === 'waited').seq);
  const woken = nextEvent(f.main, 'main.starting');
  await f.finishTurn();
  await woken;
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.deepEqual(row.tasks, ['theirs-to-wait']);
  await nextEvent(f.main, 'main.started');
  await f.finishTurn();
  // Idle now, with a wait answered from the journal: still seen, still no wake.
  f.submit('later');
  f.session.append({kind: 'task.failed', task: 'later', reason: 'reported_failure', text: 'red', from: 'worker:later'});
  assert.equal((await orchestrator.wait({match: {kind: 'task.completed', task: 'later'}, timeout: 5000})).kind, 'task.failed');
  await f.quiet(40);
  assert.equal(f.session.events.filter(e => e.kind === 'handoff').length, 1);
  assert.equal(f.main.state().state, 'idle');
});

test('a task the orchestrator waited on and then accepted itself is not re-announced at its next idle', async t => {
  const f = wakeFixture(t);
  await f.settle();
  const orchestrator = await f.peer('orchestrator', ['self-accepted']);
  f.submit('self-accepted');
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'busy', text: 'more'});
  await started;
  const waited = orchestrator.wait({match: {kind: 'task.completed', task: 'self-accepted'}, timeout: 5000});
  f.session.append({kind: 'task.completed', task: 'self-accepted', summary: 'seen by wait', from: 'worker:self-accepted'});
  assert.equal((await waited).kind, 'task.completed');
  const accepted = await orchestrator.publish({kind: 'task.accepted', task: 'self-accepted', stage: 'completion'});
  assert.equal(accepted.from, 'orchestrator');
  assert.ok(accepted.seq > f.session.events.find(e => e.kind === 'wait.served').served, 'the accept lands after the served row');
  await f.finishTurn();
  await f.quiet(40);
  assert.equal(f.session.events.filter(e => e.kind === 'handoff').length, 0);
  assert.equal(f.main.state().state, 'idle');
});

test('a user-grant accept after the orchestrator\'s wait is not re-announced; one on a task no wait returned still wakes', async t => {
  const f = wakeFixture(t);
  await f.settle();
  const orchestrator = await f.peer('orchestrator');
  const user = await f.peer('user', ['waited', 'unwaited']);
  f.submit('waited'); f.submit('unwaited');
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'busy', text: 'more'});
  await started;
  const waited = orchestrator.wait({match: {kind: 'task.completed', task: 'waited'}, timeout: 5000});
  f.session.append({kind: 'task.completed', task: 'waited', summary: 'seen by wait', from: 'worker:waited'});
  assert.equal((await waited).kind, 'task.completed');
  await user.publish({kind: 'task.accepted', task: 'waited', stage: 'completion'});
  await f.finishTurn();
  await f.quiet(40);
  assert.equal(f.session.events.filter(e => e.kind === 'handoff').length, 0);
  assert.equal(f.main.state().state, 'idle');
  // Idle, and the user closes a task the orchestrator was never handed: that is news.
  f.session.append({kind: 'task.completed', task: 'unwaited', summary: 'never waited', from: 'worker:unwaited'});
  const woken = nextEvent(f.main, 'main.starting');
  await user.publish({kind: 'task.accepted', task: 'unwaited', stage: 'completion'});
  await woken;
  await nextEvent(f.main, 'main.started');
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.deepEqual(row.tasks, ['unwaited']);
  assert.match(row.text, /task unwaited · profile build · task\.accepted/);
  await f.finishTurn();
});

test('a wake-up whose turn fails to launch keeps the outcomes pending: one re-arm, then the next prompt carries them', async t => {
  const f = wakeFixture(t, {handoffDelayMs: 20});
  await f.settle();
  f.submit('lost');
  f.launchErrors.push('codex: usage limit reached', 'codex: usage limit reached');
  const failed = nextEvent(f.main, 'main.terminal');
  f.session.append({kind: 'task.completed', task: 'lost', summary: 'must not be lost', from: 'worker:lost'});
  assert.equal((await failed).status, 'failed');
  const again = nextEvent(f.main, 'main.terminal');
  assert.equal((await again).status, 'failed');
  await f.quiet(60);
  const attempts = f.session.events.filter(e => e.kind === 'main.starting' && e.handoff);
  assert.equal(attempts.length, 2, 'one re-arm, no retry loop');
  assert.equal(f.session.events.filter(e => e.kind === 'main.started').length, 1, 'neither wake-up began');
  assert.match(f.session.events.findLast(e => e.kind === 'status').text, /ride on the next prompt/);
  assert.equal(f.main.state().state, 'idle');
  const started = nextEvent(f.main, 'main.started');
  assert.equal(f.main.run({id: 'typed', text: 'status?'}).accepted, true);
  await started;
  assert.match(f.promptOf(f.calls.at(-1)), /task lost · profile build · task\.completed\n  must not be lost[\s\S]*status\?$/);
  const rows = f.session.events.filter(e => e.kind === 'handoff');
  assert.deepEqual(rows.map(r => [r.wake, r.tasks, r.requestId]), [[true, ['lost'], attempts[0].requestId], [true, ['lost'], attempts[1].requestId], [false, ['lost'], 'typed']]);
  await f.finishTurn();
  await f.quiet(60);
  assert.equal(f.session.events.filter(e => e.kind === 'handoff').length, 3, 'delivered by the turn that began');
  assert.equal(f.main.state().state, 'idle');
});

test('no wake-up for a child task, a user-submitted task, or a replaced failure', async t => {
  const f = wakeFixture(t);
  await f.settle();
  f.submit('parent');
  f.submit('child', {parent: 'parent'});
  f.session.append({kind: 'task.completed', task: 'child', summary: 'child done', from: 'worker:child'});
  f.submit('theirs', {from: 'user'});
  f.session.append({kind: 'task.completed', task: 'theirs', summary: 'user task', from: 'worker:theirs'});
  f.submit('limited-one');
  f.session.append({kind: 'task.failed', task: 'limited-one', reason: 'limited', text: 'usage limit', from: 'worker:limited-one'});
  f.session.append({kind: 'policy.fallback', task: 'limited-one', from_profile: 'build', to_profile: 'build_claude', reason: 'limited'});
  f.submit('limited-two', {profile: 'build_claude', replaces: 'limited-one', from: 'bounce'});
  await f.quiet(60);
  assert.equal(f.session.events.filter(e => e.kind === 'main.starting').length, 1);
  assert.equal(f.session.events.some(e => e.kind === 'handoff'), false);
  // The replacement is the orchestrator's own work: its end wakes, naming what it replaced.
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.completed', task: 'limited-two', summary: 'done on claude', from: 'worker:limited-two'});
  await woken;
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.deepEqual(row.tasks, ['limited-two']);
  assert.match(row.text, /task limited-two · profile build_claude · task\.completed · replaces limited-one\n  done on claude/);
  assert.match(row.text, /Still running: parent \(build, running\)/);
  await nextEvent(f.main, 'main.started');
  await f.finishTurn();
});

test('a completed task awaiting its completion review is not an outcome until it is accepted', async t => {
  const f = wakeFixture(t);
  await f.settle();
  f.submit('reviewed', {review: {completion: 'critic'}});
  f.session.append({kind: 'task.completed', task: 'reviewed', summary: 'draft', from: 'worker:reviewed'});
  await f.quiet(40);
  assert.equal(f.session.events.some(e => e.kind === 'handoff'), false);
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.accepted', task: 'reviewed', stage: 'completion', by: 'review:reviewed'});
  await woken;
  const row = f.session.events.findLast(e => e.kind === 'handoff');
  assert.match(row.text, /task reviewed · profile build · task\.accepted\n  draft/);
  await nextEvent(f.main, 'main.started');
  await f.finishTurn();
});

test('a wake-up honours the same refusals as a typed prompt and is dropped once the service closes', async t => {
  const f = wakeFixture(t, {handoffDelayMs: 20});
  await f.settle();
  f.submit('late');
  await f.main.close();
  f.session.append({kind: 'task.completed', task: 'late', summary: 'after close', from: 'worker:late'});
  await f.quiet(60);
  assert.equal(f.session.events.some(e => e.kind === 'handoff'), false);
  assert.equal(f.session.events.filter(e => e.kind === 'main.starting').length, 1);
});

// Fake process events pass through the real Claude live normalizer for the incident.
async function failoverFixture(t, {status = 'limited', verified = true, fallback, codexStatus = 'completed', stop, backup = {}, launchError} = {}) {
  const {createClaudeLive} = await import('../src/adapters/claude-live.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-main-failover-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root}), calls = [];
  const normalizer = createClaudeLive();
  const line = raw => ({kind: 'line', text: JSON.stringify(raw)});
  const claude = {
    async launch(args) { calls.push(['claude', args]); if (launchError) throw launchError; return {turnId: 'claude-turn'}; },
    async *events() {
      yield {kind: 'assistant', text: 'Partial work: inspect the existing patch.'};
      if (status === 'missing-event') { yield {kind: 'error', code: 'missing', text: 'spawn ENOENT'}; return; }
      if (status !== 'limited') { yield {kind: 'result', status, text: 'ordinary failure'}; return; }
      yield* normalizer.events({live: {events: (async function* () {
        yield line({type: 'rate_limit_event', rate_limit_info: {status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1900000000}});
        yield line({type: 'result', subtype: 'error', is_error: true, result: 'request aborted'});
      })()}});
    },
    async cancel() { calls.push(['stop-claude']); if (stop) await stop(); return {verified}; },
  };
  const codex = {
    async launch(args) { calls.push(['codex', args]); return {turnId: 'codex-turn'}; },
    async resume(args) { calls.push(['resume-codex', args]); return {turnId: 'codex-next'}; },
    async *events() { yield {kind: 'native', sessionId: 'astra-thread'}; yield {kind: 'result', status: codexStatus}; },
    async cancel() { calls.push(['stop-codex']); return {verified: true}; },
  };
  const profile = {adapter: 'claude', model: 'opus', mode: 'plan', role: 'orchestrator', fallback: fallback ?? []};
  const settings = {order: ['codex', 'claude', 'codex'], models: {codex: 'gpt-6-astra'}, cooldownMinutes: 30,
    orchestrator: 'main', profiles: {main: {...profile}}};
  if (fallback === undefined) delete settings.profiles.main.fallback;
  const profiles = {backup: {adapter: 'codex', model: 'explicit-astra', mode: 'yolo', fallback: ['backup'], ...backup}};
  const main = createMainService({session, adapters: {claude, codex}, profile, settings, profiles, brief: 'Standing orchestrator orders'});
  t.after(() => main.close());
  const run = async params => { const done = nextEvent(main, 'main.terminal'); main.run({text: 'Finish the requested fix', ...params}); return done; };
  return {session, calls, main, run, adapters: {claude, codex}, profile, settings, profiles};
}

test('structured Claude five_hour rejection resumes logical request on Astra after termination, then stays sticky', async t => {
  const f = await failoverFixture(t);
  f.session.append({kind: 'note', text: 'Keep the prior design'});
  assert.equal((await f.run({id: 'logical', model: 'explicit-opus'})).status, 'completed');
  assert.deepEqual(f.calls.map(c => c[0]), ['claude', 'stop-claude', 'codex', 'stop-codex']);
  assert.equal(f.calls[0][1].profile.model, 'explicit-opus');
  const args = f.calls[2][1];
  assert.equal(args.profile.model, 'gpt-6-astra');
  assert.equal(args.profile.role, 'orchestrator');
  assert.equal(args.profile.mode, 'plan');
  assert.match(args.orders, /Standing orchestrator orders/);
  assert.match(args.orders, /Partial work/);
  assert.match(args.orders, /Keep the prior design/);
  assert.match(args.orders, /Finish the requested fix/);
  assert.equal(f.session.events.filter(e => e.kind === 'user').length, 1);
  assert.equal(f.session.events.filter(e => e.kind === 'main.terminal').length, 1);
  assert.deepEqual(f.session.events.filter(e => e.kind === 'main.starting').map(e => [e.requestId, e.provider]), [['logical', 'claude'], ['logical', 'codex']]);
  assert.ok(f.session.events.find(e => e.kind === 'cooldown').until > Date.now());
  assert.equal(f.main.state().provider, 'codex');
  assert.equal(f.session.active, 'codex');
  await f.run();
  assert.equal(f.calls.at(-2)[0], 'resume-codex');
  assert.equal(f.calls.at(-2)[1].profile.model, 'gpt-6-astra');
});

for (const status of ['failed', 'interrupted']) test(`main ${status} stops without fallback`, async t => {
  const f = await failoverFixture(t, {status});
  assert.equal((await f.run()).status, status);
  assert.equal(f.calls.some(c => c[0] === 'codex'), false);
});

test('exhausted routes attempt each provider once and cooldown prevents subsequent launches', async t => {
  const f = await failoverFixture(t, {codexStatus: 'limited'});
  assert.equal((await f.run()).status, 'unavailable');
  assert.equal(f.calls.filter(c => ['claude', 'codex'].includes(c[0])).length, 2);
  const count = f.calls.length;
  assert.equal((await f.run()).status, 'unavailable');
  assert.equal(f.calls.length, count);
});

test('explicit empty main fallback disables routing; explicit profile uses its model and narrows mode', async t => {
  const disabled = await failoverFixture(t, {fallback: []});
  assert.equal((await disabled.run()).status, 'unavailable');
  assert.equal(disabled.calls.some(c => c[0] === 'codex'), false);
  const enabled = await failoverFixture(t, {fallback: ['backup']});
  assert.equal((await enabled.run()).status, 'completed');
  assert.equal(enabled.calls[2][1].profile.model, 'explicit-astra');
  assert.equal(enabled.calls[2][1].profile.mode, 'plan');
});

test('unverified termination blocks fallback and new requests', async t => {
  const f = await failoverFixture(t, {verified: false});
  const blocked = nextEvent(f.main, 'main.blocked');
  f.main.run({text: 'work'});
  await blocked;
  assert.equal(f.main.run({text: 'more'}).reason, 'termination_unverified');
  assert.equal(f.calls.some(c => c[0] === 'codex'), false);
});

test('cancel during termination verification prevents fallback', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = await failoverFixture(t, {stop: () => barrier});
  const ended = f.run();
  while (!f.calls.some(c => c[0] === 'stop-claude')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.some(c => c[0] === 'codex'), false);
  const cancelled = f.main.cancel();
  release();
  await cancelled;
  assert.equal((await ended).status, 'interrupted');
  assert.equal(f.calls.some(c => c[0] === 'codex'), false);
});

test('fallback profile restrictions survive subsequent turns and daemon restart', async t => {
  const f = await failoverFixture(t, {fallback: ['backup'], backup: {mode: 'plan', policy: 'read-only'}});
  f.profile.mode = 'yolo';
  await f.run();
  await f.run({mode: 'yolo'});
  assert.equal(f.calls.at(-2)[1].profile.mode, 'plan');
  assert.equal(f.calls.at(-2)[1].profile.policy, 'read-only');
  await f.main.close();
  const main = createMainService(f);
  t.after(() => main.close());
  assert.equal(main.state().mode, 'plan');
  assert.equal(main.state().policy, 'read-only');
  const done = nextEvent(main, 'main.terminal');
  main.run({text: 'continue after restart', mode: 'yolo'});
  await done;
  assert.equal(f.calls.at(-2)[0], 'resume-codex');
  assert.equal(f.calls.at(-2)[1].profile.model, 'explicit-astra');
  assert.equal(f.calls.at(-2)[1].profile.mode, 'plan');
  assert.equal(f.calls.at(-2)[1].profile.policy, 'read-only');
});

test('routing snapshots current view settings; explicit profile policy still wins', async t => {
  const f = await failoverFixture(t);
  const routing = {order: ['codex'], models: {codex: 'next-request-model'}};
  const done = f.run({routing});
  routing.models.codex = 'changed-too-late';
  await done;
  assert.equal(f.calls[2][1].profile.model, 'next-request-model');
  const explicit = await failoverFixture(t, {fallback: []});
  assert.equal((await explicit.run({routing})).status, 'unavailable');
  assert.equal(explicit.calls.some(c => c[0] === 'codex'), false);
});

for (const status of ['missing-event', 'missing']) test(`main routes missing CLI (${status}) without cooldown`, async t => {
  const f = await failoverFixture(t, status === 'missing' ? {launchError: Object.assign(new Error('CLI missing'), {code: 'missing'})} : {status});
  assert.equal((await f.run()).status, 'completed');
  assert.equal(f.calls.some(c => c[0] === 'codex'), true);
  assert.equal(f.session.events.some(e => e.kind === 'cooldown'), false);
});

test('launch rejection retaining a process handle must verify termination before fallback', async t => {
  const f = await failoverFixture(t, {verified: false,
    launchError: Object.assign(new Error('usage limit'), {code: 'limited', handle: {turnId: 'owned-launch'}})});
  const blocked = nextEvent(f.main, 'main.blocked');
  f.main.run({text: 'work'});
  await blocked;
  assert.equal(f.calls.some(c => c[0] === 'codex'), false);
  assert.equal(f.main.state().state, 'blocked');
});

test('fallback waits for verified termination even after the limited result arrived', async t => {
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const f = await failoverFixture(t, {stop: () => barrier});
  const done = f.run();
  while (!f.calls.some(c => c[0] === 'stop-claude')) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.main.run({text: 'second writer'}).reason, 'busy');
  assert.equal(f.calls.some(c => c[0] === 'codex'), false);
  release();
  assert.equal((await done).status, 'completed');
  assert.equal(f.calls.some(c => c[0] === 'codex'), true);
});

test('daemon reload reads new configured routes while keeping the sticky selection', async t => {
  const f = await failoverFixture(t);
  await f.run();
  await f.main.close();
  f.session.append({kind: 'cooldown', provider: 'claude', until: 0});
  f.adapters.codex.events = async function* () { yield {kind: 'result', status: 'limited'}; };
  f.adapters.claude.events = async function* () { yield {kind: 'result', status: 'completed'}; };
  const before = f.calls.length;
  let reads = 0;
  const main = createMainService({...f, readRouting: () => { reads++; return {order: ['claude'], models: {claude: 'reloaded-opus'}}; }});
  t.after(() => main.close());
  const done = nextEvent(main, 'main.terminal');
  main.run({text: 'after reload'});
  await done;
  assert.equal(reads, 1);
  assert.equal(f.calls[before][0], 'resume-codex');
  assert.equal(f.calls[before][1].profile.model, 'gpt-6-astra');
  assert.equal(f.calls.at(-2)[0], 'claude');
  assert.equal(f.calls.at(-2)[1].profile.model, 'reloaded-opus');
});

test('a limited launch without process ownership cannot authorize another writer', async t => {
  const f = await failoverFixture(t, {launchError: Object.assign(new Error('usage limit'), {code: 'limited'})});
  const blocked = nextEvent(f.main, 'main.blocked');
  f.main.run({text: 'work'});
  await blocked;
  assert.equal(f.main.run({text: 'another writer'}).reason, 'termination_unverified');
  assert.equal(f.calls.some(c => c[0] === 'codex'), false);
});

// Found live, three sessions, the most common way the orchestrator goes quiet: a worker exits and its
// task parks in `input_required` or `blocked`. Those states are in no terminal set, no handoff kind and
// no watchdog branch, so nothing wakes the orchestrator, nothing settles a parent and no deadline ever
// fires — and the row itself holds a question addressed to the owner. Each occurrence ended only when
// the user cancelled, after 40 minutes, 89 minutes, and one that simply ran out of journal.
test('a task that parks asking for input wakes the orchestrator, carrying the question', async t => {
  const f = wakeFixture(t);
  await f.settle();
  f.submit('df6d627f');
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.attempt.ended', task: 'df6d627f', attempt: 1});
  f.session.append({kind: 'task.input_required', task: 'df6d627f', from: 'worker:df6d627f',
    text: 'Rework round 1 blocked on owner authorisation: the unmet criterion needs a decision.'});
  assert.equal((await woken).handoff, true, 'the orchestrator is woken, not left waiting on a dead worker');
  const started = await nextEvent(f.main, 'main.started');
  const prompt = f.promptOf(f.calls.at(-1));
  assert.match(prompt, /df6d627f/);
  assert.match(prompt, /Rework round 1 blocked on owner authorisation/, 'the question reaches it verbatim');
  assert.equal(started !== undefined, true);
});

test('a task blocked after its worker exits wakes the orchestrator too', async t => {
  const f = wakeFixture(t);
  await f.settle();
  f.submit('09a56f5c');
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.attempt.ended', task: '09a56f5c', attempt: 1});
  f.session.append({kind: 'task.blocked', task: '09a56f5c', from: 'worker:09a56f5c', text: 'unreadable review verdict'});
  assert.equal((await woken).handoff, true);
  await nextEvent(f.main, 'main.started');
  assert.match(f.promptOf(f.calls.at(-1)), /unreadable review verdict/);
});

// The child's news travels up only while an ancestor is still alive to carry it. Found live: the
// orchestrator named an already-accepted task as the parent, so the chain was dead on arrival and the
// child's completion woke nobody.
test('a task whose whole parent chain has already ended wakes the orchestrator itself', async t => {
  const f = wakeFixture(t);
  await f.settle();
  f.submit('4109832f');
  // The parent's own end is its own wake: let that turn happen and finish, so the service is idle and
  // the next wake can only be the child's.
  const parentWoke = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.completed', task: '4109832f', summary: 'builder done', from: 'worker:4109832f'});
  f.session.append({kind: 'task.accepted', task: '4109832f', stage: 'completion', from: 'bounce'});
  await parentWoke;
  await nextEvent(f.main, 'main.started');
  await f.finishTurn('Builder accepted; following up.');
  f.submit('ccec5ed4', {parent: '4109832f'});
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.completed', task: 'ccec5ed4', summary: 'the 9 baseline failures are fixed', from: 'worker:ccec5ed4'});
  assert.equal((await woken).handoff, true, 'a dead parent cannot carry the news, so the child carries it');
  await nextEvent(f.main, 'main.started');
  assert.match(f.promptOf(f.calls.at(-1)), /the 9 baseline failures are fixed/);
});

// A handoff counted as delivered the moment its turn STARTED. Found live: a wake turn that produced
// nothing (a vendor resume that returned zero turns) still marked the outcome handed over, so it was
// never re-offered. That specific vendor case is fixed in the adapter; this closes the general hole —
// a wake turn that did not complete has not told the orchestrator anything.
test('an outcome is handed over only by a wake turn that completed, not one that was interrupted', async t => {
  const f = wakeFixture(t);
  await f.settle();
  f.submit('8302c5f5');
  const woken = nextEvent(f.main, 'main.starting');
  f.session.append({kind: 'task.completed', task: '8302c5f5', summary: 'P2 majors fixed', from: 'worker:8302c5f5'});
  const request = (await woken).requestId;
  await nextEvent(f.main, 'main.started');
  const ended = nextEvent(f.main, 'main.terminal');
  await f.main.cancel({id: request});           // the wake turn is interrupted before it says anything
  await ended;

  // The next turn must still carry that outcome: nothing has told the orchestrator about it.
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'after', text: 'carry on'});
  await started;
  assert.match(f.promptOf(f.calls.at(-1)), /P2 majors fixed/, 'an interrupted wake does not consume the outcome');
});

// Found live: the orchestrator ended a turn having dispatched nothing — its submit had been refused — and
// said "bounce is evaluating it and will resume the campaign with the verdict". Nothing was running, so no
// outcome could ever arrive and no wake could ever fire. A turn that ends with no work and no pending
// outcome is a dead end: the user is told, and the orchestrator is woken ONCE to notice it itself.
test('a turn that ends with nothing running and nothing pending is a dead end: said once, woken once', async t => {
  const f = wakeFixture(t);
  // The shape that failed live: bounce accepted the plan, then the turn ended without dispatching a chunk
  // because the submit was refused. An ordinary turn that dispatches nothing is NOT this and is not nudged.
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'first', text: 'plan it'});
  await started;
  f.session.append({kind: 'plan.submitted', phase: 'rework', chunks: [{id: 'repair'}], from: 'orchestrator'});
  f.session.append({kind: 'plan.accepted', plan: 'rework', chunks: 1, from: 'bounce'});
  await f.finishTurn('I submitted the plan; bounce will resume the campaign with the verdict.');
  const said = f.session.events.filter(e => e.kind === 'status' && /dispatched nothing/i.test(e.text ?? ''));
  assert.equal(said.length, 1, 'the user is told, in their own transcript');
  const woken = await nextEvent(f.main, 'main.starting');
  assert.equal(woken.handoff, true);
  await nextEvent(f.main, 'main.started');
  assert.match(f.promptOf(f.calls.at(-1)), /dispatched nothing/i, 'and the orchestrator is told what happened');

  // ...and if that turn also dispatches nothing, it is not woken again: one nudge, never a loop.
  await f.finishTurn('Still nothing to do.');
  await f.quiet(60);
  assert.equal(f.session.events.filter(e => e.kind === 'main.starting').length, 2, 'no second nudge');
});
