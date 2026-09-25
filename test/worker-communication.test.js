import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {taskView} from '../src/task-view.js';
import {handoffBlock} from '../src/main-service.js';
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

test('malformed long answers survive repair failure, restart, and coordinator handoff', {timeout: 4000}, async t => {
  const first = JSON.stringify({...valid, text: 'Evidence '.repeat(2400)}).replace('],"outcome"', ',"outcome"');
  const second = JSON.stringify({...valid, summary: 'Still have findings'}).replace('],"outcome"', ',"outcome"');
  let turns = 0;
  const worker = fakeAdapter(() => [{kind: 'native', sessionId: 'native-audit'},
    {kind: 'result', status: 'completed', text: ++turns === 1 ? first : second}]);
  const {root, session, scheduler, terminal} = setup(t, worker);
  submit(scheduler);
  const ended = await terminal;
  assert.equal(ended.reason, 'incomplete_report');
  assert.match(ended.text, /malformed_json/);
  assert.equal(worker.calls.resume, 1);
  assert.match(worker.resumeCalls[0].message, /malformed_json/);
  const outputs = session.events.filter(row => row.kind === 'task.output');
  assert.deepEqual(outputs.map(row => row.text), [first, second]);
  assert.deepEqual(outputs.map(row => row.attempt), [1, 2]);
  assert.equal(outputs[0].digest, createHash('sha256').update(first).digest('hex'));
  assert.equal(outputs[0].chars, first.length);
  const restored = new Session(root, {root, id: session.id});
  const view = taskView(restored.events, 'audit', {report: true});
  assert.equal(view.rawOutput, second);
  assert.equal(view.candidateReport, null);
  assert.equal(view.invalidReport.outputSeq, outputs[1].seq);
  assert.match(handoffBlock(restored, [ended]), /preserved.*task_get.*full/i);
  assert.equal(session.events.some(row => row.kind === 'task.accepted'), false);
});

test('a successful repair preserves the first answer and creates only a validated candidate', {timeout: 4000}, async t => {
  const malformed = JSON.stringify(valid).replace('],"outcome"', ',"outcome"');
  let turns = 0;
  const worker = fakeAdapter(() => [{kind: 'native', sessionId: 'native-audit'},
    {kind: 'result', status: 'completed', text: ++turns === 1 ? malformed : JSON.stringify(valid)}]);
  const {session, scheduler, terminal} = setup(t, worker);
  submit(scheduler);
  const ended = await terminal;
  assert.equal(ended.kind, 'task.completed');
  assert.equal(session.events.filter(row => row.kind === 'task.output').length, 2);
  assert.deepEqual(taskView(session.events, 'audit', {report: true}).candidateReport, valid);
  assert.equal(session.events.filter(row => row.kind === 'task.reported').length, 1);
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

test('an acknowledged repair report wins over the report-only timeout that fires before the turn ends', {timeout: 3000}, async t => {
  const malformed = JSON.stringify(valid).replace('],"outcome"', ',"outcome"');
  let turns = 0;
  // Turn 2 acknowledges its final report through the report tool, then never yields a result.
  const worker = fakeAdapter(({report}) => {
    if (++turns === 1) return [{kind: 'native', sessionId: 'native-audit'}, {kind: 'result', status: 'completed', text: malformed}];
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

test('a report-only timeout with no acknowledged report still fails with preserved output', {timeout: 3000}, async t => {
  const malformed = JSON.stringify(valid).replace('],"outcome"', ',"outcome"');
  let turns = 0;
  const worker = fakeAdapter(() => ++turns === 1
    ? [{kind: 'native', sessionId: 'native-audit'}, {kind: 'result', status: 'completed', text: malformed}]
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
