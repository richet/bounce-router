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
// Reversed 2026-09-25: an unconfident Jev answer is accepted with its lean as advice (see
// jev-review.test.js) — no identical re-ask; the review stays bound to the reported candidate.
test('an uncertain completion review accepts the candidate with advice, without another analyst start or a re-ask', {timeout: 4000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-review-recovery-'));
  const session = new Session(root, {root});
  const requests = [];
  const critic = createTypesafeLive({readKey: () => ({key: 'test'}), readSettings: () => ({enabled: true, review: true, confidence: 0.8}), fetchImpl: async (_, options) => {
    requests.push(JSON.parse(options.body));
    // under the send-back bar, so still uncertain
    return {ok: true, json: async () => ({answers: {decision: {choice: 'rework', confidence: 0.55}}})};
  }});
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: JSON.stringify(report)}]);
  const scheduler = createScheduler({session, adapters: {worker, typesafe: critic}, profiles: {analyst: {adapter: 'worker', role: 'analyst', policy: 'read-only'}, critic: {adapter: 'typesafe', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  const ended = settle(session, 'audit');
  scheduler.submit({task: 'audit', profile: 'analyst', orders: 'Read source only; a separate verifier owns execution.', requires: ['read'], review: {completion: 'critic'}});
  const result = await ended;
  assert.equal(requests.length, 1);
  assert.equal(result.kind, 'task.accepted');
  assert.match(result.advice, /^Jev leaned rework/);
  assert.equal(session.events.filter(e => e.kind === 'task.started').length, 1);
  const finished = session.events.filter(e => e.kind === 'review.finished');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].candidateSeq, session.events.find(e => e.kind === 'task.reported').seq);
  assert.equal(session.events.some(e => e.kind === 'review.reasked' || e.kind === 'task.blocked'), false);
});

// Reversed 2026-09-26 (ACE d1bc0206): blocking "done, but X remains" threw away finished work whose X
// was another task's job, and it was redone on Opus. It now completes; X reaches the orchestrator as a
// follow-up. Still no report-only repair turn.
test('a completed report naming unfinished work completes with that work as a follow-up, without a report-only continuation', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-report-contradiction-'));
  const session = new Session(root, {root});
  const unfinished = {...report, remaining: 'Run checks and inspect nine files'};
  const worker = fakeAdapter(() => [{kind: 'native', sessionId: 'worker-session'}, {kind: 'result', status: 'completed', text: JSON.stringify(unfinished)}]);
  worker.resume = async () => {throw new Error('must not repair semantic incompleteness');};
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {analyst: {adapter: 'worker', policy: 'read-only'}}, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  const ended = new Promise(resolve => { const off = session.subscribe(row => { if (row.task === 'audit' && ['task.completed', 'task.blocked', 'task.failed'].includes(row.kind)) {off(); resolve(row);} }); });
  scheduler.submit({task: 'audit', profile: 'analyst', orders: 'Audit and verify'});
  const result = await ended;
  assert.equal(result.kind, 'task.completed');
  assert.equal(result.summary, unfinished.summary);
  assert.equal(result.remaining, 'Run checks and inspect nine files');
  assert.equal(session.events.some(e => e.kind === 'task.report.invalid'), false);
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

test('a profile whose sandbox cannot honor docker is refused at submit with the capability-mismatch message', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-docker-capability-'));
  const session = new Session(root, {root});
  const worker = fakeAdapter(() => []);
  // A codex-adapter probe (or any read-only profile) has no allow-list mechanism for the Docker
  // socket (src/adapters/codex-live.js permissionsFor): task-capabilities.js refuses it docker.
  const scheduler = createScheduler({session, adapters: {worker}, profiles: {
    codexProbe: {adapter: 'codex', policy: 'probe'}, readOnly: {adapter: 'claude', policy: 'read-only'},
  }, requireFinalReport: true, watchdog: {interval: null}});
  t.after(() => {scheduler.close(); fs.rmSync(root, {recursive: true, force: true});});
  assert.throws(() => scheduler.submit({profile: 'codexProbe', orders: 'check docker', requires: ['read', 'exec', 'docker']}), /capability mismatch: docker unavailable on codexProbe/);
  assert.throws(() => scheduler.submit({profile: 'readOnly', orders: 'check docker', requires: ['read', 'docker']}), /capability mismatch: docker unavailable on readOnly/);
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
