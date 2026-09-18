import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
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
  const pending = [], calls = [];
  const adapter = {
    async launch(args) { calls.push(['launch', args]); return {turnId: `turn-${calls.length}`}; },
    async resume(args) { calls.push(['resume', args]); return {turnId: `turn-${calls.length}`}; },
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
  // One idle orchestrator turn behind us, so `since it last went idle` has a real boundary.
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
  return {main, session, calls, pending, finishTurn, settle, submit, quiet, promptOf};
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

test('no wake-up for a task that ended while the orchestrator was awake, a child task, a user-submitted task, or a replaced failure', async t => {
  const f = wakeFixture(t);
  await f.settle();
  const started = nextEvent(f.main, 'main.started');
  f.main.run({id: 'busy', text: 'more'});
  await started;
  f.submit('seen');
  f.session.append({kind: 'task.completed', task: 'seen', summary: 'seen by wait', from: 'worker:seen'}); // orchestrator was running: it waited on this itself
  await f.finishTurn();
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
  assert.equal(f.session.events.filter(e => e.kind === 'main.starting').length, 2);
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
