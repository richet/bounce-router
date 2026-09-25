// src/jev.js: settings, the key's secret store, the HTTP client (fetch-stubbed, never the
// network) and the pure verdict/routing decisions. Everything Jev does is off by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JEV_DEFAULT_MODEL, JEV_ENDPOINT, JEV_KEY_ENV, VERDICT_CHECKS, REPORT_VERDICT_CHECKS,
  normalizeJevSettings, persistedJevSettings, readJevSettings, jevStatusLine, jevSidebarLabel,
  readJevKey, writeJevKey, clearJevKey, retryAfterMs, createJevClient,
  verdictQuestions, decideVerdict, routingFallback, routingQuestions, decideRoute, routeTask, jevReviewerProfile, createJevActivation,
} from '../src/jev.js';
import {Session} from '../src/core.js';

const tmpRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-jev-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
};

const okResponse = (body, {status = 200, headers = {}} = {}) => ({
  ok: status >= 200 && status < 300, status,
  headers: {get: name => headers[name.toLowerCase()] ?? null},
  json: async () => body, text: async () => JSON.stringify(body),
});

test('settings: Jev is off by default, everything it does is on once enabled, the model is pinned, and the persisted shape round-trips', () => {
  assert.deepEqual(normalizeJevSettings(undefined), {enabled: false, model: JEV_DEFAULT_MODEL, review: true, routing: {enabled: true, default: null}, confidence: 0.8});
  assert.deepEqual(normalizeJevSettings({enabled: true}), {enabled: true, model: JEV_DEFAULT_MODEL, review: true, routing: {enabled: true, default: null}, confidence: 0.8});
  assert.equal(normalizeJevSettings({enabled: true, routing: false}).routing.enabled, false);
  assert.equal(normalizeJevSettings({enabled: true, routing: {enabled: false, default: 'build'}}).routing.enabled, false);
  assert.equal(JEV_DEFAULT_MODEL, 'jev-1.13.0');
  const custom = normalizeJevSettings({enabled: true, model: ' jev-1.12.0 ', review: false, routing: {enabled: true, default: 'build'}, confidence: 0.6});
  assert.deepEqual(custom, {enabled: true, model: 'jev-1.12.0', review: false, routing: {enabled: true, default: 'build'}, confidence: 0.6});
  assert.deepEqual(persistedJevSettings(custom), {enabled: true, model: 'jev-1.12.0', review: false, routing: {enabled: true, default: 'build'}, confidence: 0.6});
  assert.deepEqual(persistedJevSettings({enabled: true, routing: true}).routing, true);
  // junk never widens what Jev does
  assert.equal(normalizeJevSettings({enabled: 'yes', confidence: 7, routing: 'on'}).enabled, false);
  assert.equal(normalizeJevSettings({confidence: 7}).confidence, 0.8);
  assert.equal(normalizeJevSettings({routing: 'on'}).routing.enabled, true, 'junk reads as unset, and unset routing is on');
});

test('settings are read from config.json at use time and a missing/broken file reads as disabled', t => {
  const root = tmpRoot(t);
  assert.equal(readJevSettings(root).enabled, false);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({order: ['claude'], jev: {enabled: true, routing: true}}));
  assert.deepEqual(readJevSettings(root).routing, {enabled: true, default: null});
  fs.writeFileSync(path.join(root, 'config.json'), '{not json');
  assert.equal(readJevSettings(root).enabled, false);
});

test('the key lives in a 0600 secrets file, the env var overrides it, and it is never printed whole', t => {
  const root = tmpRoot(t);
  assert.equal(readJevKey({root, env: {}}), null);
  writeJevKey('ts-secret-key-abcd', {root});
  const file = path.join(root, 'secrets.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readJevKey({root, env: {}}), {key: 'ts-secret-key-abcd', source: 'file'});
  assert.deepEqual(readJevKey({root, env: {[JEV_KEY_ENV]: 'env-key-wxyz'}}), {key: 'env-key-wxyz', source: 'env'});
  assert.throws(() => writeJevKey('has space', {root}), /single non-empty token/);
  const status = jevStatusLine({enabled: true}, readJevKey({root, env: {}}));
  assert.match(status, /key …abcd \(file\)/);
  assert.equal(status.includes('ts-secret-key-abcd'), false);
  assert.equal(clearJevKey({root}), true);
  assert.equal(readJevKey({root, env: {}}), null);
  assert.equal(clearJevKey({root}), false);
  assert.equal(fs.existsSync(path.join(root, 'config.json')), false); // the key never touched config.json
});

test('sidebar label is empty while disabled and names what Jev does when enabled', () => {
  assert.equal(jevSidebarLabel({}), '');
  assert.equal(jevSidebarLabel({enabled: true}), 'jev+routing');
  assert.equal(jevSidebarLabel({enabled: true, routing: false}), 'jev');
  assert.equal(jevSidebarLabel({enabled: true, review: false}), 'jev routing');
  assert.equal(jevSidebarLabel({enabled: true, review: false, routing: false}), 'jev idle');
});

test('retry-after reads seconds or an HTTP date, capped, with a short fallback', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('120'), 15_000);
  assert.equal(retryAfterMs(new Date(1_000_000 + 3000).toUTCString(), {now: 1_000_000}), 3000);
  assert.equal(retryAfterMs('soon'), 1000);
  assert.equal(retryAfterMs(null), 1000);
});

test('client: maps the request (Bearer key, state/model/questions) and the response (answers, usage, latency)', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({url, options}); return okResponse({model: 'jev-1.13.0', answers: {q: {type: 'noul', noul: 0.9}}, usage: {input_tokens: 12, output_tokens: 1}}); };
  let now = 100;
  const client = createJevClient({fetchImpl, readKey: () => ({key: 'k-1234', source: 'env'}), clock: () => (now += 50)});
  const result = await client.ask({state: {orders: 'x'}, questions: {q: {type: 'noul', instructions: 'Is this a test?'}}, model: 'jev-1.13.0'});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, JEV_ENDPOINT);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, 'Bearer k-1234');
  assert.deepEqual(JSON.parse(calls[0].options.body), {state: {orders: 'x'}, model: 'jev-1.13.0', questions: {q: {type: 'noul', instructions: 'Is this a test?'}}});
  assert.deepEqual(result.answers, {q: {type: 'noul', noul: 0.9}});
  assert.deepEqual(result.usage, {input_tokens: 12, output_tokens: 1});
  assert.equal(result.model, 'jev-1.13.0');
  assert.equal(result.latencyMs, 50);
});

test('client: no key rejects before any request; 4xx/5xx reject with an http code and never echo the key', async () => {
  let called = 0;
  const client = createJevClient({fetchImpl: async () => { called++; return okResponse({}); }, readKey: () => null});
  await assert.rejects(client.ask({state: 's', questions: {}}), error => error.code === 'missing_key');
  assert.equal(called, 0);
  const failing = createJevClient({fetchImpl: async () => okResponse({error: 'bad key'}, {status: 401}), readKey: () => ({key: 'k-secret', source: 'env'})});
  await assert.rejects(failing.ask({state: 's', questions: {}}), error => error.code === 'http_401' && !error.message.includes('k-secret'));
  const broken = createJevClient({fetchImpl: async () => ({ok: true, status: 200, headers: {get: () => null}, json: async () => ({nope: 1})}), readKey: () => ({key: 'k', source: 'env'})});
  await assert.rejects(broken.ask({state: 's', questions: {}}), error => error.code === 'protocol');
});

test('client: retries once on 429/529 honouring retry-after, then gives up', async () => {
  const sleeps = [];
  let attempts = 0;
  const flaky = createJevClient({
    fetchImpl: async () => (++attempts === 1 ? okResponse({}, {status: 429, headers: {'retry-after': '3'}}) : okResponse({answers: {}})),
    readKey: () => ({key: 'k', source: 'env'}), sleep: async ms => { sleeps.push(ms); },
  });
  const result = await flaky.ask({state: 's', questions: {}});
  assert.deepEqual(result.answers, {});
  assert.deepEqual(sleeps, [3000]);
  assert.equal(attempts, 2);
  attempts = 0;
  const overloaded = createJevClient({fetchImpl: async () => { attempts++; return okResponse({}, {status: 529}); }, readKey: () => ({key: 'k', source: 'env'}), sleep: async () => {}});
  await assert.rejects(overloaded.ask({state: 's', questions: {}}), error => error.code === 'http_529');
  assert.equal(attempts, 2);
});

test('client: a hung request times out via the abort signal with code timeout', async () => {
  const fetchImpl = (url, {signal}) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); });
  const client = createJevClient({fetchImpl, readKey: () => ({key: 'k', source: 'env'}), timeoutMs: 20});
  await assert.rejects(client.ask({state: 's', questions: {}}), error => error.code === 'timeout');
});

test('verdict questions: one accept/rework choice plus 4–8 narrow nouls', () => {
  const questions = verdictQuestions();
  assert.equal(questions.decision.type, 'choice');
  assert.deepEqual(Object.keys(questions.decision.criteria), ['accept', 'rework']);
  const nouls = Object.entries(questions).filter(([, q]) => q.type === 'noul');
  assert.ok(nouls.length >= 4 && nouls.length <= 8, `${nouls.length} nouls`);
  assert.deepEqual(nouls.map(([name]) => name), Object.keys(VERDICT_CHECKS));
});

test('report verdict questions evaluate the assignment and report evidence without diff-only checks', () => {
  const questions = verdictQuestions({review_kind: 'report', diff: ''});
  assert.deepEqual(Object.keys(questions), ['decision', 'assignment_unmet', 'unbacked_evidence', 'remaining_work']);
  assert.deepEqual(Object.keys(REPORT_VERDICT_CHECKS), ['assignment_unmet', 'unbacked_evidence', 'remaining_work']);
  const rework = decideVerdict({decision: {choice: 'rework', confidence: 0.9}, unbacked_evidence: {noul: 0.9}}, {state: {review_kind: 'report', diff: ''}});
  assert.deepEqual([rework.verdict, rework.fired, rework.findings], ['rework', ['unbacked_evidence'], [REPORT_VERDICT_CHECKS.unbacked_evidence.fix]]);
  assert.equal(decideVerdict({decision: {choice: 'accept', confidence: 0.5}}, {state: {review_kind: 'report'}}).verdict, 'unavailable');
});

test('decideVerdict: confident rework reworks with the fired checks as findings; low confidence is unavailable and accept accepts', () => {
  const answers = {
    decision: {type: 'choice', choice: 'rework', probabilities: {accept: 0.1, rework: 0.9}, confidence: 0.9},
    unbacked_tests: {type: 'noul', noul: 0.93}, remaining_work: {type: 'noul', noul: 0.71}, outside_scope: {type: 'noul', noul: 0.05},
  };
  const rework = decideVerdict(answers, {confidence: 0.8});
  assert.equal(rework.verdict, 'rework');
  assert.deepEqual(rework.fired, ['unbacked_tests', 'remaining_work']);
  assert.deepEqual(rework.findings, [VERDICT_CHECKS.unbacked_tests.fix, VERDICT_CHECKS.remaining_work.fix]);
  assert.deepEqual(rework.probabilities, {accept: 0.1, rework: 0.9});
  assert.equal(rework.checks.outside_scope, 0.05);
  assert.equal(rework.checks.empty_diff, null);

  const unsure = decideVerdict({...answers, decision: {...answers.decision, confidence: 0.55}}, {confidence: 0.8});
  assert.equal(unsure.verdict, 'unavailable');
  assert.equal(unsure.choice, 'rework');
  assert.deepEqual(unsure.findings, []);

  const accept = decideVerdict({decision: {choice: 'accept', probabilities: {accept: 0.97, rework: 0.03}, confidence: 0.95}}, {confidence: 0.8});
  assert.equal(accept.verdict, 'accept');
  // a confident rework with no specific check fired still carries one generic finding
  assert.equal(decideVerdict({decision: {choice: 'rework', confidence: 0.99}}).findings.length, 1);
  assert.equal(decideVerdict(undefined).verdict, 'unavailable');
});

const roster = {
  main: {adapter: 'claude', model: 'opus', role: 'orchestrator', policy: 'write'},
  scout: {adapter: 'local', model: 'qwen', role: 'builder', policy: 'read-only', tier: 'cheapest'},
  build: {adapter: 'codex', model: 'gpt-6-astra', role: 'builder', policy: 'write', tier: 'mid'},
  build_claude: {adapter: 'claude', model: 'opus', role: 'builder', policy: 'write', tier: 'strongest'},
  critic: {adapter: 'claude', model: 'opus', role: 'critic', policy: 'read-only'},
  jev: {adapter: 'typesafe', model: '', role: 'critic', policy: 'read-only'},
};

test('routingFallback: the configured default, else the first writing builder that is not the orchestrator', () => {
  assert.equal(routingFallback(roster), 'build');
  assert.equal(routingFallback(roster, 'build_claude'), 'build_claude');
  assert.equal(routingFallback(roster, 'main'), 'build'); // the orchestrator is never a routing target
  assert.equal(routingFallback(roster, 'nope'), 'build');
  assert.equal(routingFallback({main: roster.main, jev: roster.jev}), null);
});

test('routingQuestions: a choice over the routable roster with adapter/model/role/policy/tier/capabilities criteria, plus access nouls', () => {
  const questions = routingQuestions(roster);
  assert.deepEqual(Object.keys(questions.profile.criteria), ['scout', 'build', 'build_claude', 'critic']);
  assert.match(questions.profile.criteria.build, /codex\/gpt-6-astra · role builder · policy write · tier mid: [^·]+$/);
  assert.match(questions.profile.criteria.scout, /read-only \(cannot edit files or run commands\)/);
  // roster notes fill in what a profile leaves out; a profile's own tier/capabilities win
  const noted = routingQuestions({...roster, build: {...roster.build, capabilities: 'Careful, slow, thorough.'}}, {build: {tier: 'strongest', capabilities: 'ignored'}, scout: {tier: 'cheapest', capabilities: 'Fast lookups; weak at multi-step edits.'}});
  assert.match(noted.profile.criteria.build, /tier mid: .* · capabilities: Careful, slow, thorough\.$/);
  assert.match(noted.profile.criteria.scout, /tier cheapest: .* · capabilities: Fast lookups; weak at multi-step edits\.$/);
  assert.match(noted.profile.instructions.guidance, /capabilities/);
  assert.equal(questions.needs_write.type, 'noul');
  assert.equal(questions.needs_shell.type, 'noul');
});

test('decideRoute: a confident, policy-compatible choice wins; otherwise the fallback with the reason', () => {
  const confident = decideRoute({profile: {choice: 'build_claude', probabilities: {build_claude: 0.9, build: 0.1}, confidence: 0.88}, needs_write: {noul: 0.9}, needs_shell: {noul: 0.2}}, {profiles: roster, confidence: 0.8, fallback: 'build'});
  assert.deepEqual(confident, {chosen: 'build_claude', fallback: false, reason: null, probabilities: {build_claude: 0.9, build: 0.1}, confidence: 0.88, needs: {write: true, shell: false}});
  const unsure = decideRoute({profile: {choice: 'build_claude', confidence: 0.4}}, {profiles: roster, confidence: 0.8, fallback: 'build'});
  assert.equal(unsure.chosen, 'build');
  assert.equal(unsure.fallback, true);
  assert.match(unsure.reason, /confidence 0.40 below 0.8/);
  const mismatch = decideRoute({profile: {choice: 'scout', confidence: 0.95}, needs_write: {noul: 0.8}}, {profiles: roster, confidence: 0.8, fallback: 'build'});
  assert.equal(mismatch.chosen, 'build');
  assert.match(mismatch.reason, /scout is read-only but the orders need write access/);
  const readOnlyOk = decideRoute({profile: {choice: 'scout', confidence: 0.95}, needs_write: {noul: 0.1}, needs_shell: {noul: 0.1}}, {profiles: roster, confidence: 0.8, fallback: 'build'});
  assert.equal(readOnlyOk.chosen, 'scout');
  assert.equal(decideRoute({profile: {choice: 'main', confidence: 0.99}}, {profiles: roster, fallback: 'build'}).reason, 'no routable choice');
});

test('routeTask: disabled / routing off / Jev failure all resolve to the fallback and say why; on, it asks over the orders', async () => {
  const asked = [];
  const ask = async ({state, questions, model}) => { asked.push({state, model, keys: Object.keys(questions)}); return {answers: {profile: {choice: 'scout', confidence: 0.9}, needs_write: {noul: 0.05}, needs_shell: {noul: 0.05}}, model: 'jev-1.13.0', latencyMs: 120}; };
  assert.deepEqual((await routeTask({orders: 'find x', profiles: roster, settings: {}, ask})).chosen, 'build');
  assert.equal((await routeTask({orders: 'find x', profiles: roster, settings: {}, ask})).reason, 'jev disabled');
  assert.equal((await routeTask({orders: 'find x', profiles: roster, settings: {enabled: true, routing: false}, ask})).reason, 'routing off');
  assert.equal(asked.length, 0);
  const routed = await routeTask({orders: 'find x', profiles: roster, settings: {enabled: true, routing: true}, ask});
  assert.equal(routed.chosen, 'scout');
  assert.equal(routed.fallback, false);
  assert.equal(routed.model, 'jev-1.13.0');
  assert.deepEqual(asked[0], {state: {orders: 'find x'}, model: 'jev-1.13.0', keys: ['tier', 'profile', 'needs_write', 'needs_shell']});
  // notes may be a (possibly async) function; one that throws only narrows the criteria
  const noted = [];
  await routeTask({orders: 'find x', profiles: roster, settings: {enabled: true}, notes: async () => ({scout: {tier: 'cheapest', capabilities: 'Quick.'}}), ask: async ({questions}) => { noted.push(questions.profile.criteria.scout); return {answers: {}}; }});
  await routeTask({orders: 'find x', profiles: roster, settings: {enabled: true}, notes: async () => { throw new Error('unreadable'); }, ask: async ({questions}) => { noted.push(questions.profile.criteria.scout); return {answers: {}}; }});
  assert.match(noted[0], /capabilities: Quick\.$/);
  assert.doesNotMatch(noted[1], /capabilities/);
  const failed = await routeTask({orders: 'find x', profiles: roster, settings: {enabled: true, routing: {enabled: true, default: 'build_claude'}}, ask: async () => { throw Object.assign(new Error('boom'), {code: 'http_500'}); }});
  assert.deepEqual([failed.chosen, failed.fallback, failed.reason], ['build_claude', true, 'http_500']);
});

test('the synthetic reviewer profile is a read-only typesafe critic whose model follows the settings', () => {
  assert.deepEqual(jevReviewerProfile({mode: 'plan', executables: {claude: '/x'}}), {adapter: 'typesafe', model: '', mode: 'plan', policy: 'read-only', fallback: [], role: 'critic', executables: {claude: '/x'}});
});

test('the daemon answers a user control.jev row with a status row (last 4 key chars only) and refreshes the orders', t => {
  const root = tmpRoot(t);
  const session = new Session(root, {root});
  writeJevKey('ts-secret-key-abcd', {root});
  let refreshed = 0;
  const close = createJevActivation({session, readSettings: () => ({enabled: true, routing: true}), readKey: () => readJevKey({root, env: {}}), refresh: () => { refreshed++; }});
  session.append({kind: 'control.jev', from: 'user'});
  const status = session.events.at(-1);
  assert.equal(status.kind, 'status');
  assert.match(status.text, /Jev \(TypeSafe\): enabled · key …abcd \(file\) .* routing on .* applies to the next decision/);
  assert.equal(refreshed, 1);
  session.append({kind: 'control.jev', from: 'orchestrator'}); // not the user peer: ignored
  assert.equal(session.events.at(-1).kind, 'control.jev');
  close();
  assert.equal(fs.readFileSync(session.file, 'utf8').includes('ts-secret-key-abcd'), false);
});

// A check the worker cannot act on is not a finding. `empty_diff` says "the orders require changes and
// the diff shows none" — when the diff Jev was shown is NOT empty, that check is contradicted by the
// state itself and is dropped; if dropping it leaves a rework with nothing actionable, it is an accept.
test('decideVerdict drops an empty_diff finding when the state shows a diff, and a rework with no actionable finding left becomes an accept', () => {
  const nouls = Object.fromEntries(Object.keys(VERDICT_CHECKS).map(n => [n, {type: 'noul', noul: 0.05}]));
  const rework = choice => ({decision: {type: 'choice', choice: 'rework', probabilities: {rework: 0.95, accept: 0.05}, confidence: 0.95}, ...nouls, ...choice});
  const withDiff = {diff: 'diff --git a/x b/x\n+changed'};
  const onlyEmpty = decideVerdict(rework({empty_diff: {type: 'noul', noul: 0.9}}), {confidence: 0.8, state: withDiff});
  assert.deepEqual([onlyEmpty.verdict, onlyEmpty.fired, onlyEmpty.dropped], ['accept', [], ['empty_diff']]);
  const mixed = decideVerdict(rework({empty_diff: {type: 'noul', noul: 0.9}, unbacked_tests: {type: 'noul', noul: 0.9}}), {confidence: 0.8, state: withDiff});
  assert.deepEqual([mixed.verdict, mixed.fired, mixed.dropped], ['rework', ['unbacked_tests'], ['empty_diff']]);
  const trulyEmpty = decideVerdict(rework({empty_diff: {type: 'noul', noul: 0.9}}), {confidence: 0.8, state: {diff: ''}});
  assert.deepEqual([trulyEmpty.verdict, trulyEmpty.fired], ['rework', ['empty_diff']], 'an empty diff is a real finding when the diff really is empty');
  assert.equal(decideVerdict(rework({}), {confidence: 0.8}).verdict, 'rework', 'no state: nothing is dropped, today\'s behaviour');
});
