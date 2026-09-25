import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createTypesafeLive} from '../src/adapters/typesafe-live.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const report = {op: 'final', outcome: 'completed', phase: 'audit', text: 'Read src/main.js; implementation exists.', summary: 'Source audit complete', next: 'Independent verifier runs tests', evidence: ['src/main.js:1'], remaining: ''};
const settle = (session, task) => new Promise(resolve => {
  const off = session.subscribe(row => { if (row.task === task && ['task.accepted', 'task.blocked', 'task.failed'].includes(row.kind)) {off(); resolve(row);} });
});
for (const accepts of [true, false]) test(`uncertain completion review retries the candidate without another analyst start (${accepts ? 'accepted' : 'blocked'})`, {timeout: 4000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-review-recovery-'));
  const session = new Session(root, {root});
  const requests = [];
  const critic = createTypesafeLive({readKey: () => ({key: 'test'}), readSettings: () => ({enabled: true, review: true, confidence: 0.8}), fetchImpl: async (_, options) => {
    requests.push(JSON.parse(options.body));
    return {ok: true, json: async () => ({answers: {decision: {choice: requests.length > 1 && accepts ? 'accept' : 'rework', confidence: requests.length > 1 && accepts ? 0.95 : 0.63}}})};
  }});
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify(report)}]);
  const scheduler = createScheduler({session, adapters: {worker, typesafe: critic}, profiles: {analyst: {adapter: 'worker', role: 'analyst', policy: 'read-only'}, critic: {adapter: 'typesafe', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  const ended = settle(session, 'audit');
  scheduler.submit({task: 'audit', profile: 'analyst', orders: 'Read source only; a separate verifier owns execution.', requires: ['read'], review: {completion: 'critic'}});
  const result = await ended;
  assert.equal(requests.length, 2);
  assert.equal(result.kind, accepts ? 'task.accepted' : 'task.blocked');
  assert.equal(session.events.filter(e => e.kind === 'task.started').length, 1);
  assert.deepEqual(requests[0].state.report, requests[1].state.report);
  const finished = session.events.filter(e => e.kind === 'review.finished');
  assert.equal(finished.length, 2);
  assert.equal(finished[0].candidateSeq, session.events.find(e => e.kind === 'task.reported').seq);
  assert.equal(finished[0].candidateDigest, finished[1].candidateDigest);
  if (!accepts) {
    assert.equal(session.events.find(e => e.kind === 'review.blocked').candidateSeq, finished[0].candidateSeq);
    assert.throws(() => scheduler.submit({profile: 'analyst', retryOf: 'audit', orders: 'Repeat source audit'}), /review.*candidate/i);
  }
});

test('a completed report naming unfinished work is preserved and blocked without a report-only continuation', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-report-contradiction-'));
  const session = new Session(root, {root});
  const unfinished = {...report, remaining: 'Run checks and inspect nine files'};
  const worker = fakeAdapter(() => [{kind: 'native', sessionId: 'worker-session'}, {kind: 'result', status: 'completed', text: JSON.stringify(unfinished)}]);
  worker.resume = async () => {throw new Error('must not repair semantic incompleteness');};
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {analyst: {adapter: 'worker', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  const ended = settle(session, 'audit');
  scheduler.submit({task: 'audit', profile: 'analyst', orders: 'Audit and verify'});
  const result = await ended;
  assert.equal(result.kind, 'task.blocked');
  assert.equal(result.reason, 'report_incomplete');
  assert.deepEqual(session.events.find(e => e.kind === 'task.report.invalid').report, unfinished);
  assert.equal(session.events.some(e => e.kind === 'task.report_requested'), false);
});

test('capability mismatch is refused before a worker is launched, and new orchestrator tasks must declare requirements', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-capability-admission-'));
  const session = new Session(root, {root});
  const worker = fakeAdapter(() => []);
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {analyst: {adapter: 'worker', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  assert.throws(() => scheduler.submit({profile: 'analyst', orders: 'Run tests', requires: ['exec']}), /capability.*exec/);
  assert.throws(() => scheduler.submit({profile: 'analyst', from: 'orchestrator', orders: 'Audit source'}), /requires/);
  assert.equal(session.events.some(e => e.kind === 'task.started'), false);
});

test('worker conclusion cause is retained in the task journal', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-conclusion-cause-'));
  const session = new Session(root, {root});
  const worker = fakeAdapter(() => [{kind: 'diagnostic', text: 'Restarting tools-off conclusion', reason: 'step_cap', phase: 'conclusion', toolsDisabled: true}, {kind: 'result', status: 'completed', text: JSON.stringify(report)}]);
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {analyst: {adapter: 'worker', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  const ended = new Promise(resolve => {const off = session.subscribe(row => {if (row.kind === 'task.completed') {off(); resolve(row);}});});
  scheduler.submit({task: 'audit', profile: 'analyst', orders: 'Audit source', requires: ['read']});
  await ended;
  const diagnostic = session.events.find(e => e.kind === 'task.diagnostic');
  assert.equal(diagnostic?.reason, 'step_cap');
  assert.equal(diagnostic?.toolsDisabled, true);
});

for (const requirements of [undefined, ['exec']]) test(`new plans reject missing or impossible analyst capabilities (${requirements ?? 'missing'})`, {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-plan-capability-'));
  const session = new Session(root, {root});
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(() => [])}, profiles: {analyst: {adapter: 'worker', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  const ended = new Promise(resolve => {const off = session.subscribe(row => {if (['plan.accepted', 'plan.rejected'].includes(row.kind)) {off(); resolve(row);}});});
  session.publish({kind: 'plan.submitted', plan: 'audit-plan', from: 'orchestrator', chunks: [{id: 'source', profile: 'analyst', orders: 'Run checks', requires: requirements}]});
  const result = await ended;
  assert.equal(result.kind, 'plan.rejected');
  assert.equal(result.findings[0].check, 'capabilities');
  assert.equal(session.events.some(e => e.kind === 'task.started'), false);
});

test('legacy retries can adopt declared requirements while modern retries cannot erase them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-retry-requirements-'));
  const session = new Session(root, {root});
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(() => [])}, profiles: {analyst: {adapter: 'worker', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  for (const [id, declared] of [['legacy', undefined], ['modern', ['read']]]) {
    session.append({kind: 'task.submitted', task: id, profile: 'analyst', orders: 'Read source', requires: declared});
    session.append({kind: 'task.failed', task: id, reason: 'backend_unavailable'});
    const retry = scheduler.submit({from: 'orchestrator', profile: 'analyst', retryOf: id, orders: 'Retry source audit', requires: declared ? [] : ['read']});
    assert.deepEqual(retry.requires, ['read']);
  }
});
