import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createTypesafeLive} from '../src/adapters/typesafe-live.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

for (const policy of ['read-only', 'probe']) test(`${policy} analysis reviews its report without a repository or code diff`, {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-analyst-review-'));
  const session = new Session(root, {root});
  const requests = [];
  const typesafe = createTypesafeLive({readKey: () => ({key: 'test-only'}), readSettings: () => ({enabled: true, review: true, confidence: 0.8, model: 'jev-1.13.0'}), git: async () => '',
    fetchImpl: async (_, options) => { requests.push(JSON.parse(options.body)); return {ok: true, json: async () => ({answers: {decision: {choice: 'accept', confidence: 0.95}}})}; }});
  const report = {op: 'final', outcome: 'completed', phase: 'audit', text: 'Source audit: P0-P2 implemented; P3 remains project work, outside this completed audit.', summary: 'Audit complete', next: 'Future implementation: P3', evidence: ['src/cli/run.ts:357', 'Evidence detail '.repeat(80) + 'FINAL_EVIDENCE'], remaining: ''};
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify(report)}]);
  const scheduler = createScheduler({session, adapters: {worker, typesafe}, profiles: {analyst: {adapter: 'worker', role: 'analyst', policy}, critic: {adapter: 'typesafe', policy: 'read-only', role: 'critic'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(async () => { scheduler.close(); await new Promise(resolve => setImmediate(resolve)); fs.rmSync(root, {recursive: true, force: true}); });
  const settled = new Promise(resolve => { const off = session.subscribe(row => { if (row.task === 'audit' && ['task.accepted', 'task.blocked', 'task.failed'].includes(row.kind)) { off(); resolve(row); } }); });
  scheduler.submit({task: 'audit', profile: 'analyst', orders: 'Audit current implementation and list remaining project phases. Do not edit files.', review: {completion: 'critic'}});
  const result = await settled;
  assert.equal(result.kind, 'task.accepted', result.text);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].state.review_kind, 'report');
  assert.equal(requests[0].questions.empty_diff, undefined);
  assert.equal(requests[0].state.report.summary, 'Audit complete');
  assert.equal(requests[0].state.report.next, report.next);
  assert.equal(requests[0].state.report.outcome, 'completed');
  assert.deepEqual(requests[0].state.report.evidence, report.evidence);
});
