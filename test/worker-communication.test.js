import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {taskView} from '../src/task-view.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const valid = {op: 'final', phase: 'audit', text: 'Inventory finished', next: 'Review findings',
  evidence: ['src/main.js:1'], outcome: 'completed', summary: 'Inventory complete', remaining: ''};

function setup(t, worker, watchdog = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-communication-'));
  const session = new Session(root, {root});
  const scheduler = createScheduler({session, adapters: {worker},
    profiles: {analyst: {adapter: 'worker', policy: 'read-only'}}, requireFinalReport: true,
    watchdog: {interval: null, ...watchdog}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const terminal = new Promise(resolve => {
    const off = session.subscribe(row => {
      if (row.task === 'audit' && ['task.completed', 'task.accepted', 'task.failed', 'task.blocked'].includes(row.kind)) {
        off(); resolve(row);
      }
    });
  });
  return {root, session, scheduler, terminal};
}

const submit = scheduler => scheduler.submit({task: 'audit', profile: 'analyst',
  from: 'orchestrator', orders: 'Inventory this source; report findings, do not implement them.', requires: ['read']});

// The worker's own final answer is the source of truth the moment no valid structured report
// survives parsing (src/final-report.js synthesizeReport): a long malformed-JSON answer is
// synthesized directly, never spending a repair turn asking the model to fix its own formatting.
// Observed live (session 159f4746, 7/19 tasks): a good prose final answer over a missing report
// was lost to a report repair that timed out or was unavailable.
test('a long malformed-JSON answer is synthesized directly, with no repair round', {timeout: 3000}, async t => {
  const malformed = JSON.stringify({...valid, text: 'Evidence '.repeat(2400)}).replace('],"outcome"', ',"outcome"');
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: malformed}]);
  const {session, scheduler, terminal} = setup(t, worker);
  submit(scheduler);
  const ended = await terminal;
  assert.equal(ended.kind, 'task.completed');
  assert.equal(worker.calls.resume, 0, 'no repair round is ever requested for a non-empty answer');
  const invalid = session.events.find(row => row.kind === 'task.report.invalid');
  assert.match(invalid.diagnostic, /^malformed_json/);
  const synthesized = session.events.find(row => row.kind === 'task.report.synthesized');
  assert.equal(synthesized.rule, 'default_completed');
  assert.deepEqual(synthesized.sources, {outcome: 'answer', phase: 'answer', summary: 'answer', remaining: 'answer', next: 'answer', evidence: 'answer'});
  const outputs = session.events.filter(row => row.kind === 'task.output');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].digest, createHash('sha256').update(malformed).digest('hex'));
  assert.equal(session.events.some(row => row.kind === 'task.accepted'), false);
});

// A malformed `bounce_report`-shaped answer (parsed JSON, rejected only for one missing field)
// keeps every field it got right; synthesis fills only what was missing, from the same answer.
test('a malformed report missing only its summary is synthesized by filling that one field', {timeout: 3000}, async t => {
  const missingSummary = JSON.stringify({...valid, summary: undefined});
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: missingSummary}]);
  const {session, scheduler, terminal} = setup(t, worker);
  submit(scheduler);
  const ended = await terminal;
  assert.equal(ended.kind, 'task.completed');
  assert.equal(worker.calls.resume, 0);
  const invalid = session.events.find(row => row.kind === 'task.report.invalid');
  assert.match(invalid.diagnostic, /^malformed_report: summary/);
  const synthesized = session.events.find(row => row.kind === 'task.report.synthesized');
  const reported = session.events.find(row => row.kind === 'task.reported');
  assert.equal(synthesized.sources.summary, 'answer');
  for (const field of ['outcome', 'phase', 'next', 'evidence']) assert.equal(synthesized.sources[field], 'worker', `${field} kept its own value`);
  assert.equal(reported.phase, valid.phase);
  assert.deepEqual(reported.evidence, valid.evidence);
  assert.equal(ended.summary, reported.summary);
});

for (const verified of [true, false]) {
  test(`an exhausted worker stream resolves promptly with verified termination ${verified}`, {timeout: 3000}, async t => {
    const worker = fakeAdapter(() => ({events: [{kind: 'assistant', text: 'Starting the inspection'}], cancel: {verified}}));
    const {session, scheduler, terminal} = setup(t, worker);
    submit(scheduler);
    const ended = await terminal;
    assert.equal(ended.kind, verified ? 'task.failed' : 'task.blocked');
    assert.equal(ended.reason, verified ? 'worker_runtime' : 'termination_unverified');
    assert.match(ended.text, verified ? /stream ended without a terminal result/ : /termination unverified/);
    assert.equal(session.events.some(row => row.kind === 'task.completed'), false);
  });
}

test('a scoped worker is instructed to use the acknowledged report tool and preserves staged payload', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-report-tool-orders-'));
  const session = new Session(root, {root});
  let orders;
  const worker = {
    async launch(args) {
      orders = args.orders;
      args.report({report: valid});
      return {};
    },
    async *events() { yield {kind: 'result', status: 'completed', text: 'Submitted through tool'}; },
    async cancel() { return {verified: true}; },
  };
  const scheduler = createScheduler({session, adapters: {codex: worker},
    profiles: {analyst: {adapter: 'codex', policy: 'read-only'}},
    reportGrant: () => ({BOUNCE_REPORT_BUS: '/unused', BOUNCE_REPORT_TOKEN_FILE: '/unused-token'}),
    requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  const completed = new Promise(resolve => {
    const off = session.subscribe(row => {
      if (row.kind === 'task.completed') {off(); resolve(row);}
    });
  });
  scheduler.submit({task: 'audit', profile: 'analyst', orders: 'Inventory only'});
  await completed;
  assert.match(orders, /call the bounce_report tool/);
  assert.match(orders, /Completion is relative to your assigned scope/);
  assert.deepEqual(session.events.find(row => row.kind === 'task.report.staged').report, valid);
  assert.deepEqual(taskView(session.events, 'audit', {report: true}).candidateReport, valid);
  assert.equal(session.events.some(row => row.kind === 'task.report_requested'), false);
});

// Only a literally empty answer still gets a turn back — and only in plain words, never the JSON
// schema again (src/scheduler.js requestPlainAnswer). Its reply is then synthesized the same way
// as any other answer.
test('an empty answer gets one plain-words continuation, whose reply is synthesized', {timeout: 3000}, async t => {
  let turns = 0;
  const worker = fakeAdapter(() => [{kind: 'native', sessionId: 'native-audit'},
    {kind: 'result', status: 'completed', text: ++turns === 1 ? '' : 'Done: inventoried the source tree, nothing to report.'}]);
  const {session, scheduler, terminal} = setup(t, worker);
  submit(scheduler);
  const ended = await terminal;
  assert.equal(ended.kind, 'task.completed');
  assert.equal(worker.calls.resume, 1);
  assert.doesNotMatch(worker.resumeCalls[0].message, /op:final|outcome|summary|schema/i, 'the continuation asks in plain words, not the report schema');
  assert.match(worker.resumeCalls[0].message, /plain words/i);
  const requested = session.events.find(row => row.kind === 'task.report_requested');
  assert.equal(requested.diagnostic, 'no_answer');
  const synthesized = session.events.find(row => row.kind === 'task.report.synthesized');
  assert.equal(synthesized.attempt, 2);
  assert.equal(ended.summary, 'Done: inventoried the source tree, nothing to report.');
});

test('an acknowledged report wins over the report-only timeout that fires before the plain-answer turn ends', {timeout: 3000}, async t => {
  let turns = 0;
  // Turn 2 (asked in plain words after an empty turn 1) acknowledges its final report through
  // the report tool, then never yields a result.
  const worker = fakeAdapter(({report}) => {
    if (++turns === 1) return [{kind: 'native', sessionId: 'native-audit'}, {kind: 'result', status: 'completed', text: ''}];
    report({report: valid});
    return {never: true};
  });
  const {session, scheduler, terminal} = setup(t, worker, {reportOnly: 50});
  submit(scheduler);
  const ended = await terminal;
  assert.equal(ended.kind, 'task.completed');
  assert.equal(ended.summary, 'Inventory complete');
  const reported = session.events.filter(row => row.kind === 'task.reported');
  assert.deepEqual(reported.map(row => row.attempt), [2]);
  assert.deepEqual(session.events.filter(row => row.kind === 'task.attempt.ended').map(row => [row.attempt, row.verifiedTermination]), [[1, true], [2, true]]);
  assert.equal(session.events.some(row => row.kind === 'task.failed'), false);
});

test('a report-only timeout with no answer at all still fails, never for formatting alone', {timeout: 3000}, async t => {
  let turns = 0;
  const worker = fakeAdapter(() => ++turns === 1
    ? [{kind: 'native', sessionId: 'native-audit'}, {kind: 'result', status: 'completed', text: ''}]
    : {never: true});
  const {session, scheduler, terminal} = setup(t, worker, {reportOnly: 50});
  submit(scheduler);
  const ended = await terminal;
  assert.equal(ended.kind, 'task.failed');
  assert.equal(ended.reason, 'incomplete_report');
  assert.equal(ended.text, 'Final report request timed out; original worker output is preserved; use task_get full.');
  assert.equal(session.events.some(row => row.kind === 'task.reported'), false);
});

// Observed live (reviewer c33dcf6b): a PASS verdict reported with remaining "None." was blocked as unfinished work.
// Found live (159f4746 eeebd5b9, sonnet): "None for the assigned P3 steps 1 and 3 scope." was read as owed work.
for (const nothing of ['None.', 'N/A', 'nothing', '-', 'None — all three steps completed and the scratch test was removed.', 'None for the assigned P3 steps 1 and 3 scope.', 'Nothing within this task\'s scope.', 'None in scope.']) test(`a completed report whose remaining says "${nothing}" completes, by text and by tool`, {timeout: 3000}, async t => {
  const byText = setup(t, fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify({...valid, remaining: nothing})}]));
  submit(byText.scheduler);
  assert.equal((await byText.terminal).kind, 'task.completed');
  const byTool = setup(t, fakeAdapter(({report}) => { report({report: {...valid, remaining: nothing}}); return [{kind: 'result', status: 'completed', text: 'done'}]; }));
  submit(byTool.scheduler);
  assert.equal((await byTool.terminal).kind, 'task.completed');
});

for (const owed of ['Re-run the corrupt-tail probes.', 'None of the Docker probes ran.', 'None for now, but the lint step still fails.']) test(`a completed report that names unfinished work still blocks: "${owed}"`, {timeout: 3000}, async t => {
  const {scheduler, terminal} = setup(t, fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify({...valid, remaining: owed})}]));
  submit(scheduler);
  const ended = await terminal;
  assert.deepEqual([ended.kind, ended.reason, ended.text], ['task.blocked', 'report_incomplete', owed]);
});
