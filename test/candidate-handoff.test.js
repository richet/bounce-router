import test from 'node:test';
import assert from 'node:assert/strict';
import {handoffBlock} from '../src/main-service.js';

test('review-blocked handoff carries the candidate reference and gate without calling it running', () => {
  const session = {events: [
    {kind: 'task.submitted', seq: 1, task: 'audit', profile: 'analyst', orders: 'audit', from: 'orchestrator'},
    {kind: 'task.started', seq: 2, task: 'audit', attempt: 1},
    {kind: 'task.reported', seq: 470, task: 'audit', attempt: 1, op: 'final', phase: 'done', text: 'full evidence', next: '', evidence: ['test passed'], outcome: 'completed', summary: 'Candidate audit result', remaining: ''},
    {kind: 'task.completed', seq: 471, task: 'audit', summary: 'Candidate audit result'},
    {kind: 'review.blocked', seq: 480, task: 'audit', reason: 'no_repository', candidateSeq: 470},
    {kind: 'task.blocked', seq: 481, task: 'audit', reason: 'review_unavailable', text: 'Required review unavailable: no_repository'},
    {kind: 'task.submitted', seq: 482, task: 'input', profile: 'analyst', orders: 'ask', from: 'orchestrator'},
    {kind: 'task.input_required', seq: 483, task: 'input', text: 'Need the path'},
  ]};
  const text = handoffBlock(session, [session.events[5], session.events[7]]);
  assert.match(text, /Candidate audit result/);
  assert.match(text, /candidate: task\.reported seq 470 · sha256 [a-f0-9]{12}/);
  assert.match(text, /review gate: blocked · no_repository/);
  assert.doesNotMatch(text, /Still running:.*audit/);
  assert.doesNotMatch(text, /Still running:.*input/);
});

test('a task.accepted handoff carries an unsure Jev\'s advice, not just the summary', () => {
  const session = {events: [
    {kind: 'task.submitted', seq: 1, task: 'lean', profile: 'build', orders: 'do it', from: 'orchestrator'},
    {kind: 'task.started', seq: 2, task: 'lean', attempt: 1},
    {kind: 'task.completed', seq: 3, task: 'lean', summary: 'done'},
    {kind: 'task.accepted', seq: 4, task: 'lean', stage: 'completion',
      advice: 'Jev leaned rework (probability 0.86, confidence 0.72 below the 0.8 bar).'},
  ]};
  const text = handoffBlock(session, [session.events[3]]);
  assert.match(text, /Jev leaned rework \(probability 0\.86, confidence 0\.72 below the 0\.8 bar\)\./);
});

test('a completed task\'s remaining work reaches the orchestrator as a follow-up, and "none" adds no line', () => {
  const session = {events: [
    {kind: 'task.submitted', seq: 1, task: 'remove', profile: 'build', orders: 'build remove', from: 'orchestrator'},
    {kind: 'task.started', seq: 2, task: 'remove', attempt: 1},
    {kind: 'task.completed', seq: 3, task: 'remove', summary: 'remove built', remaining: 'register runRemove in src/cli/run.ts'},
    {kind: 'task.accepted', seq: 4, task: 'remove', stage: 'completion'},
    {kind: 'task.submitted', seq: 5, task: 'doctor', profile: 'build', orders: 'build doctor', from: 'orchestrator'},
    {kind: 'task.completed', seq: 6, task: 'doctor', summary: 'doctor built'},
  ]};
  const text = handoffBlock(session, [session.events[3], session.events[5]]);
  assert.match(text, /remaining \(reported by the worker; follow-up work, not done in this task\): register runRemove in src\/cli\/run\.ts/);
  assert.equal(text.match(/remaining \(reported/g).length, 1);
});
