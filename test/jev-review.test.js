// Jev completion verdicts and model routing through the real scheduler + reducers, the real
// typesafe adapter with a stubbed fetch (never the network) and fake worker adapters —
// composed exactly like test/policy.test.js. With Jev off, the journal is byte-for-byte
// today's; with it on, a confident rework takes the same path a critic's rework takes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createTypesafeLive} from '../src/adapters/typesafe-live.js';
import {createJevDecisions, jevReviewerProfile, VERDICT_CHECKS} from '../src/jev.js';
import {noReviewStrategy} from '../src/strategy.js';
import * as reducers from '../src/reducers.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-jev-review-'));
  t?.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, session: new Session(root, {root})};
};
const waitFor = async (fn, {timeout = 3000, interval = 5} = {}) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
};
const okResponse = body => ({ok: true, status: 200, headers: {get: () => null}, json: async () => body, text: async () => JSON.stringify(body)});
const answers = (choice, confidence, nouls = {}) => ({decision: {type: 'choice', choice, probabilities: {accept: choice === 'accept' ? confidence : 1 - confidence, rework: choice === 'rework' ? confidence : 1 - confidence}, confidence}, ...Object.fromEntries(Object.entries(nouls).map(([name, noul]) => [name, {type: 'noul', noul}]))});
const KEY = 'ts-live-key-9f3a';
const gitStub = async args => args[0] === 'diff' ? 'diff --git a/x b/x\n+x' : '';

// A scheduler with the Jev seam wired the way reload.js wires it: the `jev` critic profile,
// the typesafe adapter on a stubbed fetch, settings supplied by the test.
function jevScheduler(session, {settings, respond, profiles: extra = {}, strategy, jevOption = true, fetchCalls = []}) {
  const fetchImpl = async (url, options) => { fetchCalls.push({url, options}); return okResponse(await respond(JSON.parse(options.body))); };
  const typesafe = createTypesafeLive({fetchImpl, readKey: () => ({key: KEY, source: 'file'}), readSettings: () => ({enabled: false, model: 'jev-1.13.0', review: true, routing: {enabled: false, default: null}, confidence: 0.8, ...settings}), git: gitStub});
  const profiles = {A: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}, jev: jevReviewerProfile({}), ...extra};
  const jev = jevOption ? createJevDecisions({adapter: typesafe, readSettings: () => ({enabled: false, model: 'jev-1.13.0', review: true, routing: {enabled: false, default: null}, confidence: 0.8, ...settings})}) : null;
  return {profiles, typesafe, jev, fetchCalls};
}

test('Jev on: a root task with no completion reviewer gets the jev critic; a confident rework reworks the same worker with the fired checks, then accepts', async t => {
  const {session} = setup(t);
  let workerRound = 0;
  const worker = fakeAdapter(() => (++workerRound === 1
    ? [{kind: 'native', provider: 'worker', sessionId: 's1'}, {kind: 'result', status: 'completed', text: 'done, tests pass'}]
    : [{kind: 'result', status: 'completed', text: 'reworked with output'}]));
  let reviewRound = 0;
  const {profiles, typesafe, jev, fetchCalls} = jevScheduler(session, {settings: {enabled: true},
    respond: () => (++reviewRound === 1 ? {answers: answers('rework', 0.91, {unbacked_tests: 0.9, empty_diff: 0.1})} : {answers: answers('accept', 0.95)})});
  const launches = [];
  const spied = {...typesafe, launch: args => { launches.push(args); return typesafe.launch(args); }};
  const scheduler = createScheduler({session, adapters: {worker, typesafe: spied}, profiles, jev, gitHead: () => 'start-sha'});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'Own src/x.js; run npm test', deadline: null});
  assert.equal(row.review.completion, 'jev');
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');

  const kinds = session.events.filter(e => e.task === row.task || e.kind === 'peer.joined').map(e => e.kind);
  // the Jev review reserves no start of its own (only the worker's launch and its rework round do)
  assert.deepEqual(kinds, ['task.submitted', 'budget.reserved', 'peer.joined', 'task.started', 'task.completed',
    'review.started', 'model', 'jev.verdict', 'review.finished', 'budget.reserved', 'task.rework', 'task.started',
    'task.completed', 'review.started', 'model', 'jev.verdict', 'review.finished', 'task.accepted']);
  const started = session.events.find(e => e.kind === 'task.started' && e.task === row.task);
  assert.equal(started.head, 'start-sha');
  // the reviewer was handed the raw orders, the completed summary and the start ref — not the decorated review orders
  assert.equal(launches[0].review.stage, 'completion');
  assert.equal(launches[0].review.orders, 'Own src/x.js; run npm test');
  assert.equal(launches[0].review.summary, 'done, tests pass');
  assert.equal(launches[0].review.head, 'start-sha');
  assert.equal(launches[0].profile.adapter, 'typesafe');
  const verdict = session.events.find(e => e.kind === 'jev.verdict');
  assert.equal(verdict.verdict, 'rework');
  assert.equal(verdict.confidence, 0.91);
  assert.deepEqual(verdict.probabilities, {accept: 0.08999999999999997, rework: 0.91});
  assert.deepEqual(verdict.fired, ['unbacked_tests']);
  assert.equal(verdict.from, `review:${row.task}`);
  assert.match(verdict.text, /Jev verdict · rework/);
  const rework = session.events.find(e => e.kind === 'task.rework');
  assert.deepEqual(rework.findings, [VERDICT_CHECKS.unbacked_tests.fix]);
  assert.equal(worker.calls.resume, 1);
  assert.match(worker.resumeCalls[0].message, /Rework round 1:\n- The report claims tests it shows no output for/);
  const finished = session.events.filter(e => e.kind === 'review.finished');
  assert.deepEqual(finished.map(e => e.verdict), ['rework', 'accept']);
  assert.equal(session.events.at(-1).kind, 'task.accepted');
  assert.equal(session.events.at(-1).by, `review:${row.task}`);
  // the key and the request never reach the journal; the state was sent to Jev
  const journal = fs.readFileSync(session.file, 'utf8');
  assert.equal(journal.includes(KEY), false);
  assert.equal(journal.includes('"authorization"'), false);
  assert.equal(session.events.some(e => e.kind === 'raw'), false);
  assert.equal(fetchCalls.length, 2);
  assert.equal(JSON.parse(fetchCalls[0].options.body).state.report.summary, 'done, tests pass');
});

test('a low-confidence rework is accepted as today, with the verdict journaled', async t => {
  const {session} = setup(t);
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const {profiles, typesafe, jev} = jevScheduler(session, {settings: {enabled: true}, respond: () => ({answers: answers('rework', 0.55, {remaining_work: 0.7})})});
  const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles, jev, gitHead: () => null});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');
  assert.equal(session.events.some(e => e.kind === 'task.rework'), false);
  const verdict = session.events.find(e => e.kind === 'jev.verdict');
  assert.equal(verdict.verdict, 'accept');
  assert.equal(verdict.choice, 'rework');
  assert.match(verdict.text, /chose rework below threshold/);
  assert.equal(worker.calls.resume, 0);
});

test('Jev disabled (or review off): the row is untouched and the journal is exactly today\'s', async t => {
  for (const settings of [{enabled: false}, {enabled: true, review: false}]) {
    const {session} = setup(t);
    const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
    const {profiles, typesafe, jev, fetchCalls} = jevScheduler(session, {settings, respond: () => ({answers: {}})});
    const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles, jev, gitHead: () => null});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
    assert.equal(row.review, null);
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
    assert.deepEqual(session.events.filter(e => e.task === row.task || e.kind === 'peer.joined').map(e => e.kind), ['task.submitted', 'budget.reserved', 'peer.joined', 'task.started', 'task.completed']);
    assert.equal(fetchCalls.length, 0);
    assert.equal('head' in session.events.find(e => e.kind === 'task.started'), false);
  }
});

test('no Jev seam at all: task.started carries exactly today\'s keys and git is never asked for HEAD', async t => {
  const {session} = setup(t);
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  let gitCalls = 0;
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {A: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}}, gitHead: () => { gitCalls++; return 'sha'; }});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  const started = session.events.find(e => e.kind === 'task.started');
  assert.deepEqual(Object.keys(started), ['id', 'time', 'kind', 'task', 'attempt', 'requested', 'from', 'context', 'seq']);
  assert.equal(gitCalls, 0);
  assert.equal(fs.readFileSync(session.file, 'utf8').includes('"head"'), false);
});

test('the Jev review never draws from the root starts budget: {starts:1} still accepts, with or without a key', async t => {
  const cases = [
    {name: 'key present', readKey: () => ({key: KEY, source: 'file'}), verdict: 'jev.verdict'},
    {name: 'key missing', readKey: () => null, verdict: 'jev.skipped'},
  ];
  for (const c of cases) {
    const {session} = setup(t);
    const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
    const fetchCalls = [];
    const fetchImpl = async (url, options) => { fetchCalls.push(options); return okResponse({answers: answers('accept', 0.95)}); };
    const settings = {enabled: true, model: 'jev-1.13.0', review: true, routing: {enabled: false, default: null}, confidence: 0.8};
    const typesafe = createTypesafeLive({fetchImpl, readKey: c.readKey, readSettings: () => settings, git: gitStub});
    const profiles = {A: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}, jev: jevReviewerProfile({})};
    const jev = createJevDecisions({adapter: typesafe, readSettings: () => settings});
    const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles, jev, gitHead: () => 'sha'});
    const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, budget: {starts: 1}});
    await waitFor(() => reducers.TERMINAL.has(scheduler.tasks()[row.task]?.state) || scheduler.tasks()[row.task]?.state === 'blocked');
    const kinds = session.events.filter(e => e.task === row.task).map(e => e.kind);
    assert.deepEqual(kinds, ['task.submitted', 'budget.reserved', 'task.started', 'task.completed', 'review.started', ...(c.verdict === 'jev.verdict' ? ['model'] : []), c.verdict, 'review.finished', 'task.accepted'], c.name);
    assert.equal(session.events.some(e => e.kind === 'task.blocked' || e.kind === 'policy.escalated'), false, c.name);
    // the one reservation is the worker's own start; the reviewer added none
    const reservations = session.events.filter(e => e.kind === 'budget.reserved' && e.task === row.task);
    assert.equal(reservations.length, 1, c.name);
    assert.ok(reservations[0].seq < session.events.find(e => e.kind === 'task.started').seq, c.name);
    assert.deepEqual(scheduler.budgets().roots[row.task].remaining, {starts: 0}, c.name);
    if (c.verdict === 'jev.skipped') { assert.equal(session.events.find(e => e.kind === 'jev.skipped').reason, 'missing_key', c.name); assert.equal(fetchCalls.length, 0, c.name); }
    else assert.equal(fetchCalls.length, 1, c.name);
  }
});

test('an explicit review.completion wins; child tasks and non-default strategies are never decorated', async t => {
  const {session} = setup(t);
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const critic = fakeAdapter(() => [{kind: 'result', status: 'completed', text: '{"verdict":"accept"}'}]);
  const {profiles, typesafe, jev, fetchCalls} = jevScheduler(session, {settings: {enabled: true}, respond: () => ({answers: answers('rework', 0.99)}),
    profiles: {C: {adapter: 'critic', model: 'c', mode: 'yolo', fallback: [], role: 'critic', policy: 'read-only'}}});
  const scheduler = createScheduler({session, adapters: {worker, critic, typesafe}, profiles, jev, gitHead: () => null});
  const explicit = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null, review: {completion: 'C'}});
  assert.equal(explicit.review.completion, 'C');
  await waitFor(() => scheduler.tasks()[explicit.task]?.state === 'accepted');
  assert.equal(critic.calls.launch, 1);
  assert.equal(fetchCalls.length, 0);
  const child = scheduler.submit({parent: explicit.task, profile: 'A', orders: 'sub', deadline: null});
  assert.equal(child.review, null);

  const other = setup(t);
  const plain = jevScheduler(other.session, {settings: {enabled: true}, respond: () => ({answers: answers('rework', 0.99)})});
  const noReview = createScheduler({session: other.session, adapters: {worker: fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]), typesafe: plain.typesafe}, profiles: plain.profiles, jev: plain.jev, strategy: noReviewStrategy, gitHead: () => null});
  assert.equal(noReview.submit({parent: null, profile: 'A', orders: 'do it', deadline: null}).review, null);
  assert.equal(noReview.prepare({parent: null, profile: 'A', orders: 'x'}).review, undefined);
});

test('Jev unreachable (HTTP 500 after the retry budget): jev.skipped is journaled and the task is accepted', async t => {
  const {session} = setup(t);
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: 'done'}]);
  const fetchCalls = [];
  const fetchImpl = async (url, options) => { fetchCalls.push(options); return {ok: false, status: 500, headers: {get: () => null}, json: async () => ({}), text: async () => 'boom'}; };
  const typesafe = createTypesafeLive({fetchImpl, readKey: () => ({key: KEY, source: 'file'}), readSettings: () => ({enabled: true, model: 'jev-1.13.0', review: true, routing: {enabled: false, default: null}, confidence: 0.8}), git: gitStub});
  const profiles = {A: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}, jev: jevReviewerProfile({})};
  const jev = createJevDecisions({adapter: typesafe, readSettings: () => ({enabled: true, review: true, routing: {enabled: false, default: null}, confidence: 0.8, model: 'jev-1.13.0'})});
  const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles, jev, gitHead: () => null});
  const row = scheduler.submit({parent: null, profile: 'A', orders: 'do it', deadline: null});
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'accepted');
  const skipped = session.events.find(e => e.kind === 'jev.skipped');
  assert.equal(skipped.reason, 'http_500');
  assert.match(skipped.text, /accepting as today/);
  assert.equal(session.events.some(e => e.kind === 'jev.verdict'), false);
  assert.equal(session.events.some(e => e.kind === 'task.rework'), false);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fs.readFileSync(session.file, 'utf8').includes(KEY), false);
});

// ---- routing: profile "auto" ---------------------------------------------------------------

const roster = () => ({
  A: {adapter: 'worker', model: 'a', mode: 'yolo', fallback: [], role: 'builder', policy: 'write', tier: 'mid'},
  B: {adapter: 'worker', model: 'b', mode: 'yolo', fallback: [], role: 'builder', policy: 'write', tier: 'strongest'},
  R: {adapter: 'worker', model: 'r', mode: 'yolo', fallback: [], role: 'analyst', policy: 'read-only', tier: 'cheapest'},
});

test('routing on: a confident, policy-fitting Jev choice dispatches that profile and journals jev.routed', async t => {
  const {session} = setup(t);
  const launches = [];
  const worker = fakeAdapter(args => { launches.push(args.profile.model); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  const {profiles, typesafe, jev, fetchCalls} = jevScheduler(session, {settings: {enabled: true, review: false, routing: {enabled: true, default: null}},
    respond: body => { assert.deepEqual(Object.keys(body.questions.profile.criteria), ['A', 'B', 'R']); assert.match(body.questions.profile.criteria.B, /tier strongest/); return {answers: {profile: {choice: 'B', probabilities: {A: 0.1, B: 0.85, R: 0.05}, confidence: 0.9}, needs_write: {noul: 0.9}, needs_shell: {noul: 0.7}}, model: 'jev-1.13.0'}; },
    profiles: roster()});
  const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles, jev, gitHead: () => null});
  const row = scheduler.submit({parent: null, profile: 'auto', orders: 'debug the cross-cutting failure', deadline: null});
  assert.equal(row.profile, 'auto');
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  const routed = session.events.find(e => e.kind === 'jev.routed');
  assert.equal(routed.chosen, 'B');
  assert.equal(routed.fallback, false);
  assert.equal(routed.confidence, 0.9);
  assert.deepEqual(routed.probabilities, {A: 0.1, B: 0.85, R: 0.05});
  assert.match(routed.text, /Routed auto → B \(Jev, confidence 0.90\)/);
  assert.deepEqual(launches, ['b']);
  assert.equal(scheduler.tasks()[row.task].profile, 'B');
  assert.equal(session.events.find(e => e.kind === 'peer.joined').profile, 'B');
  assert.equal(JSON.parse(fetchCalls[0].options.body).state.orders, 'debug the cross-cutting failure');
  assert.deepEqual(session.events.filter(e => e.task === row.task || e.kind === 'peer.joined').map(e => e.kind), ['task.submitted', 'jev.routed', 'budget.reserved', 'peer.joined', 'task.started', 'task.completed']);
});

test('routing off, low confidence, a policy mismatch, or no Jev at all: auto resolves to the fallback builder and says why', async t => {
  const cases = [
    {name: 'routing off', settings: {enabled: true, routing: {enabled: false, default: null}}, respond: () => { throw new Error('never asked'); }, reason: 'routing off'},
    {name: 'disabled', settings: {enabled: false, routing: {enabled: true, default: null}}, respond: () => { throw new Error('never asked'); }, reason: 'jev disabled'},
    {name: 'low confidence', settings: {enabled: true, review: false, routing: {enabled: true, default: null}}, respond: () => ({answers: {profile: {choice: 'B', confidence: 0.3}}}), reason: /confidence 0.30 below 0.8/},
    {name: 'policy mismatch', settings: {enabled: true, review: false, routing: {enabled: true, default: null}}, respond: () => ({answers: {profile: {choice: 'R', confidence: 0.95}, needs_write: {noul: 0.9}}}), reason: /R is read-only but the orders need write access/},
    {name: 'http error', settings: {enabled: true, review: false, routing: {enabled: true, default: null}}, respond: () => { throw Object.assign(new Error('x'), {code: 'network'}); }, reason: 'network'},
    {name: 'configured default', settings: {enabled: true, routing: {enabled: false, default: 'B'}}, respond: () => { throw new Error('never asked'); }, reason: 'routing off', expected: 'B'},
    {name: 'no jev seam', jevOption: false, settings: {}, respond: () => { throw new Error('never asked'); }, reason: 'routing unavailable'},
  ];
  for (const c of cases) {
    const {session} = setup(t);
    const launches = [];
    const worker = fakeAdapter(args => { launches.push(args.profile.model); return [{kind: 'result', status: 'completed', text: 'done'}]; });
    const {profiles, typesafe, jev} = jevScheduler(session, {settings: c.settings, respond: c.respond, profiles: roster(), jevOption: c.jevOption !== false});
    const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles, jev, gitHead: () => null});
    const row = scheduler.submit({parent: null, profile: 'auto', orders: 'implement x', deadline: null});
    await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed' || scheduler.tasks()[row.task]?.state === 'accepted');
    const routed = session.events.find(e => e.kind === 'jev.routed');
    assert.equal(routed.chosen, c.expected ?? 'A', c.name);
    assert.equal(routed.fallback, true, c.name);
    if (c.reason instanceof RegExp) assert.match(routed.reason, c.reason, c.name); else assert.equal(routed.reason, c.reason, c.name);
    assert.match(routed.text, /Routed auto → [AB] \(fallback: /, c.name);
    assert.deepEqual(launches, [c.expected === 'B' ? 'b' : 'a'], c.name);
    assert.equal(scheduler.tasks()[row.task].profile, c.expected ?? 'A', c.name);
  }
});

test('auto is refused at submit when the roster has no writing builder to fall back to; other profiles validate as before', t => {
  const {session} = setup(t);
  const scheduler = createScheduler({session, adapters: {}, profiles: {R: {adapter: 'worker', model: 'r', mode: 'yolo', fallback: [], role: 'analyst', policy: 'read-only'}}, gitHead: () => null});
  assert.equal(scheduler.validate({parent: null, profile: 'auto', orders: 'x'}), 'profile');
  assert.equal(scheduler.validate({parent: null, profile: 'nope', orders: 'x'}), 'profile');
  const ok = createScheduler({session, adapters: {}, profiles: roster(), gitHead: () => null});
  assert.equal(ok.validate({parent: null, profile: 'auto', orders: 'x'}), null);
});

test('a reconcile() while an auto route is in flight does not dispatch the task a second time', async t => {
  const {session} = setup(t);
  const launches = [];
  const worker = fakeAdapter(args => { launches.push(args.profile.model); return [{kind: 'result', status: 'completed', text: 'done'}]; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {profiles, typesafe, jev} = jevScheduler(session, {settings: {enabled: true, review: false, routing: {enabled: true, default: null}},
    respond: async () => { await gate; return {answers: {profile: {choice: 'B', probabilities: {A: 0.1, B: 0.85, R: 0.05}, confidence: 0.9}}}; }, profiles: roster()});
  const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles, jev, gitHead: () => null});
  const row = scheduler.submit({parent: null, profile: 'auto', orders: 'implement x', deadline: null});
  await new Promise(resolve => setTimeout(resolve, 10)); // the route is awaiting Jev
  await scheduler.reconcile(); // sees a queued task with no handle — and must leave it to the dispatch that owns it
  release();
  await waitFor(() => scheduler.tasks()[row.task]?.state === 'completed');
  assert.equal(session.events.filter(e => e.kind === 'jev.routed').length, 1);
  assert.deepEqual(launches, ['b']);
  assert.deepEqual(session.events.filter(e => e.task === row.task).map(e => e.kind), ['task.submitted', 'jev.routed', 'budget.reserved', 'task.started', 'task.completed']);
});
