// The typesafe live adapter as a completion reviewer: fetch-stubbed (never the network), git
// stubbed (never a real repo) — request/response mapping, the verdict line, every skip path,
// and the hard rule that the request never appears in the event stream.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTypesafeLive, buildReviewState, testOutputLines} from '../../src/adapters/typesafe-live.js';
import {JEV_ENDPOINT} from '../../src/jev.js';

const okResponse = (body, {status = 200, headers = {}} = {}) => ({ok: status < 300, status, headers: {get: name => headers[name.toLowerCase()] ?? null}, json: async () => body, text: async () => JSON.stringify(body)});
const drain = async (adapter, handle) => { const events = []; for await (const event of adapter.events(handle)) events.push(event); return events; };
const lastVerdict = events => JSON.parse(events.at(-1).text);

const gitStub = (diff = 'diff --git a/src/x.js b/src/x.js\n+added', untracked = 'notes.md\n') => async args => args[0] === 'diff' ? diff : args[0] === 'ls-files' ? untracked : '';
const review = {stage: 'completion', round: 1, orders: 'Own src/x.js. Add the feature and run npm test.', summary: 'Added it', report: {summary: 'Added it', text: 'Implemented x.\nnpm test\n# tests 12\n# pass 12\n# fail 0', evidence: ['src/x.js'], remaining: ''}, head: 'abc123'};
const settings = {enabled: true, model: 'jev-1.13.0', review: true, routing: {enabled: false, default: null}, confidence: 0.8};
const answers = (choice, confidence, nouls = {}) => ({decision: {type: 'choice', choice, probabilities: {accept: choice === 'accept' ? confidence : 1 - confidence, rework: choice === 'rework' ? confidence : 1 - confidence}, confidence}, ...Object.fromEntries(Object.entries(nouls).map(([name, noul]) => [name, {type: 'noul', noul}]))});

test('state: orders, the final report, the diff against the start ref, untracked files and test lines', async () => {
  const calls = [];
  const git = async (args, cwd) => { calls.push([args, cwd]); return gitStub()(args); };
  const state = await buildReviewState({review, cwd: '/repo', git});
  assert.deepEqual(calls[0], [['diff', 'abc123', '--'], '/repo']);
  assert.equal(state.orders, review.orders);
  assert.equal(state.report.summary, 'Added it');
  assert.deepEqual(state.report.evidence, ['src/x.js']);
  assert.equal(state.diff, 'diff --git a/src/x.js b/src/x.js\n+added');
  assert.equal(state.diff_base, 'abc123');
  assert.deepEqual(state.untracked_files, ['notes.md']);
  assert.deepEqual(state.test_output, ['# tests 12', '# pass 12', '# fail 0']);
  // no recorded start ref → HEAD; a huge diff is truncated with a marker
  const big = await buildReviewState({review: {...review, head: null}, cwd: '/repo', git: gitStub('x'.repeat(100_000), '')});
  assert.ok(big.diff.length < 81_000 && big.diff.endsWith('[… diff truncated at 80000 characters …]'));
  assert.equal(big.diff_base, 'HEAD');
});

test('testOutputLines picks result-looking lines from the report text and evidence, capped', () => {
  assert.deepEqual(testOutputLines({text: 'did things\n12 passing\nrandom\nPASS src/a.test.js', evidence: ['✓ renders', 'src/x.js']}), ['12 passing', 'PASS src/a.test.js', '✓ renders']);
  assert.equal(testOutputLines({text: Array.from({length: 200}, (_, i) => `${i} passed`).join('\n')}).length, 80);
});

test('happy path: the request carries state and questions with the Bearer key; a confident rework yields the verdict line with findings', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({url, options}); return okResponse({model: 'jev-1.13.0', answers: answers('rework', 0.92, {unbacked_tests: 0.88, remaining_work: 0.2}), usage: {input_tokens: 900, output_tokens: 20}}); };
  const adapter = createTypesafeLive({fetchImpl, readKey: () => ({key: 'k-secret', source: 'env'}), readSettings: () => settings, git: gitStub()});
  const handle = await adapter.launch({peer: 'review:t1', profile: {adapter: 'typesafe', model: ''}, orders: 'ignored', cwd: '/repo', dir: '/tmp/x', task: 't1', attempt: 1, review});
  const events = await drain(adapter, handle);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].options.headers.authorization, 'Bearer k-secret');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'jev-1.13.0');
  assert.equal(body.state.orders, review.orders);
  assert.equal(body.questions.decision.type, 'choice');
  // the stream never carries the request, the key, or a raw event
  assert.equal(events.some(e => e.kind === 'raw'), false);
  assert.equal(JSON.stringify(events).includes('k-secret'), false);
  assert.equal(JSON.stringify(events).includes('authorization'), false);
  const verdictRow = events.find(e => e.kind === 'jev' && e.name === 'verdict');
  assert.equal(verdictRow.data.verdict, 'rework');
  assert.equal(verdictRow.data.confidence, 0.92);
  assert.deepEqual(verdictRow.data.fired, ['unbacked_tests']);
  assert.deepEqual(verdictRow.data.probabilities, {accept: 0.07999999999999996, rework: 0.92});
  assert.match(verdictRow.text, /Jev verdict · rework · confidence 0.92 of 0.8 · fired: unbacked_tests/);
  assert.deepEqual(events.find(e => e.kind === 'usage').usage, {input: 900, output: 20});
  assert.equal(events.at(-1).kind, 'result');
  assert.equal(events.at(-1).status, 'completed');
  const verdict = lastVerdict(events);
  assert.equal(verdict.verdict, 'rework');
  assert.equal(verdict.findings.length, 1);
  assert.match(verdict.findings[0], /claims tests it shows no output for/);
  assert.deepEqual(await adapter.cancel(handle), {verified: true});
});

test('a low-confidence rework and a plain accept both end in accept', async () => {
  for (const [choice, confidence] of [['rework', 0.6], ['accept', 0.97]]) {
    const adapter = createTypesafeLive({fetchImpl: async () => okResponse({answers: answers(choice, confidence)}), readKey: () => ({key: 'k', source: 'env'}), readSettings: () => settings, git: gitStub()});
    const events = await drain(adapter, await adapter.launch({profile: {}, cwd: '/repo', review}));
    assert.equal(lastVerdict(events).verdict, 'accept');
    assert.deepEqual(lastVerdict(events).findings, []);
    assert.equal(events.find(e => e.kind === 'jev').name, 'verdict');
  }
});

test('every failure skips with its reason and accepts as today: no key, HTTP error after the 429 retry, timeout, disabled, review off', async () => {
  const cases = [
    {name: 'missing_key', readKey: () => null, fetchImpl: async () => okResponse({answers: {}})},
    {name: 'http_500', readKey: () => ({key: 'k', source: 'file'}), fetchImpl: async () => okResponse({error: 'x'}, {status: 500})},
    {name: 'http_429', readKey: () => ({key: 'k', source: 'file'}), fetchImpl: async () => okResponse({}, {status: 429, headers: {'retry-after': '0'}})},
    {name: 'timeout', readKey: () => ({key: 'k', source: 'file'}), fetchImpl: (url, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))), timeoutMs: 15},
    {name: 'disabled', readKey: () => ({key: 'k', source: 'file'}), fetchImpl: async () => okResponse({answers: {}}), settings: {...settings, enabled: false}},
    {name: 'review_off', readKey: () => ({key: 'k', source: 'file'}), fetchImpl: async () => okResponse({answers: {}}), settings: {...settings, review: false}},
  ];
  for (const c of cases) {
    const adapter = createTypesafeLive({fetchImpl: c.fetchImpl, readKey: c.readKey, readSettings: () => c.settings ?? settings, git: gitStub(), timeoutMs: c.timeoutMs});
    const events = await drain(adapter, await adapter.launch({profile: {}, cwd: '/repo', review}));
    const skipped = events.find(e => e.kind === 'jev');
    assert.equal(skipped.name, 'skipped', c.name);
    assert.equal(skipped.data.reason, c.name);
    assert.match(skipped.text, /accepting as today/);
    assert.deepEqual(lastVerdict(events), {verdict: 'accept', jev: 'skipped', reason: c.name});
  }
});

test('a prelaunch review is not a Jev decision: skipped, accept', async () => {
  const adapter = createTypesafeLive({fetchImpl: async () => { throw new Error('must not be called'); }, readKey: () => ({key: 'k', source: 'env'}), readSettings: () => settings, git: gitStub()});
  const events = await drain(adapter, await adapter.launch({profile: {}, cwd: '/repo', review: {stage: 'prelaunch', orders: 'x'}}));
  assert.equal(events.find(e => e.kind === 'jev').data.reason, 'stage');
  assert.equal(lastVerdict(events).verdict, 'accept');
});

test('a worker launch (no review) is refused: the adapter cannot carry out a task', async () => {
  const adapter = createTypesafeLive({fetchImpl: async () => okResponse({}), readKey: () => ({key: 'k', source: 'env'})});
  await assert.rejects(adapter.launch({profile: {}, orders: 'do it', cwd: '/repo'}), error => error.code === 'unsupported');
  assert.deepEqual(adapter.capabilities(), {executionPolicies: ['read-only']});
  assert.equal(await adapter.deliver({}, {text: 'hi'}), 'queued');
});

test('cancel aborts an in-flight request; the stream ends with a skipped accept', async () => {
  let abortSeen = false;
  const fetchImpl = (url, {signal}) => new Promise((_, reject) => signal.addEventListener('abort', () => { abortSeen = true; reject(signal.reason); }));
  const adapter = createTypesafeLive({fetchImpl, readKey: () => ({key: 'k', source: 'env'}), readSettings: () => settings, git: gitStub()});
  const handle = await adapter.launch({profile: {}, cwd: '/repo', review});
  const drained = drain(adapter, handle);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(await adapter.cancel(handle), {verified: true});
  const events = await drained;
  assert.equal(abortSeen, true);
  assert.equal(events.find(e => e.kind === 'jev').data.reason, 'aborted');
  assert.equal(lastVerdict(events).verdict, 'accept');
});
