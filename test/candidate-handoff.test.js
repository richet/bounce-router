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

// docs/plans/lessons-and-sweep.md §1: the moment a lesson is in hand is when accepted work is redone, or a
// check has failed twice. The handoff asks then, and only then.
test('the handoff asks for a lesson after a correction of accepted work or a check that failed twice, and otherwise does not', () => {
  const session = {events: [
    {kind: 'task.submitted', seq: 1, task: 'first', profile: 'builder', orders: 'build', from: 'orchestrator'},
    {kind: 'task.started', seq: 2, task: 'first', attempt: 1},
    {kind: 'task.completed', seq: 3, task: 'first', summary: 'done'},
    {kind: 'task.accepted', seq: 4, task: 'first', stage: 'completion', by: 'strategy'},
    {kind: 'task.submitted', seq: 5, task: 'redo', profile: 'claude_sonnet', orders: 'the tests were placeholders; redo it', from: 'orchestrator', retryOf: 'first', replaces: 'first'},
    {kind: 'task.started', seq: 6, task: 'redo', attempt: 1},
    {kind: 'task.completed', seq: 7, task: 'redo', summary: 'redone'},
    {kind: 'task.accepted', seq: 8, task: 'redo', stage: 'completion', by: 'strategy'},
    {kind: 'task.submitted', seq: 9, task: 'held', profile: 'builder', orders: 'build', from: 'orchestrator', check: 'npm test'},
    {kind: 'task.started', seq: 10, task: 'held', attempt: 1},
    {kind: 'task.blocked', seq: 11, task: 'held', reason: 'check_failed', text: 'The task\'s check still fails after its one rework round'},
    {kind: 'task.submitted', seq: 12, task: 'plain', profile: 'builder', orders: 'build', from: 'orchestrator'},
    {kind: 'task.started', seq: 13, task: 'plain', attempt: 1},
    {kind: 'task.completed', seq: 14, task: 'plain', summary: 'done'},
    {kind: 'task.accepted', seq: 15, task: 'plain', stage: 'completion', by: 'strategy'},
  ]};
  const ask = /If there is a lesson a worker should know next time in this project, record it: the lesson tool \(or publish lesson\.learned\) with agent \(the job it is for, or all\) and text \(one sentence, imperative, no task ids\)\. If there is none, say nothing\./;
  const redo = handoffBlock(session, [session.events[7]]);
  assert.match(redo, /This task redid work that had been accepted \(first\)\. If there is a lesson/);
  assert.match(redo, ask);
  const held = handoffBlock(session, [session.events[10]]);
  assert.match(held, /This check failed twice\. If there is a lesson/);
  assert.equal(handoffBlock(session, [session.events[14]]).includes('lesson'), false, 'an ordinary acceptance asks nothing');
});

// docs/plans/standing-workers.md §3: the handoff lists the standing workers — what each has done, who is
// busy, idle or held, and how heavy its last context was — so the overseer can assign, continue or retire.
test('the handoff carries the roster of standing workers', () => {
  const t0 = Date.parse('2026-10-01T10:00:00Z');
  const at = m => new Date(t0 + m * 60000).toISOString();
  const session = {events: [
    {kind: 'task.submitted', seq: 1, task: 'a', profile: 'builder', orders: 'x', from: 'orchestrator', time: at(0)},
    {kind: 'task.launch.requested', seq: 2, task: 'a', worker: 'builder#1', time: at(0)},
    {kind: 'task.started', seq: 3, task: 'a', attempt: 1, time: at(0)},
    {kind: 'peer.native', seq: 4, from: 'worker:a', provider: 'opencode', sessionId: 's1', time: at(0)},
    {kind: 'task.usage', seq: 5, task: 'a', usage: {input: 48000, output: 300}, time: at(1)},
    {kind: 'task.completed', seq: 6, task: 'a', summary: 'done', time: at(2)},
    {kind: 'task.accepted', seq: 7, task: 'a', stage: 'completion', by: 'strategy', time: at(2)},
    {kind: 'task.submitted', seq: 8, task: 'b', profile: 'builder', orders: 'y', from: 'orchestrator', time: at(3)},
    {kind: 'task.launch.requested', seq: 9, task: 'b', worker: 'builder#2', time: at(3)},
    {kind: 'task.started', seq: 10, task: 'b', attempt: 1, time: at(3)},
    {kind: 'task.submitted', seq: 11, task: 'c', profile: 'reviewer', orders: 'z', from: 'orchestrator', time: at(4)},
    {kind: 'task.launch.requested', seq: 12, task: 'c', worker: 'reviewer#1', time: at(4)},
    {kind: 'task.started', seq: 13, task: 'c', attempt: 1, time: at(4)},
    {kind: 'task.completed', seq: 14, task: 'c', summary: 'reviewed', time: at(5)},
    {kind: 'task.accepted', seq: 15, task: 'c', stage: 'completion', by: 'strategy', time: at(5)},
    {kind: 'worker.retired', seq: 16, worker: 'reviewer#1', profile: 'reviewer', by: 'orchestrator', time: at(6)},
  ]};
  const text = handoffBlock(session, [session.events[6]]);
  const roster = text.slice(text.indexOf('Your workers:')).split('\n');
  assert.equal(roster[0], 'Your workers:');
  assert.match(roster[1], /^- builder#1 · 1 task · idle \d+ min · last context 48k tokens$/);
  assert.equal(roster[2], '- builder#2 · 1 task · busy on b · no session to continue');
  assert.equal(roster.length, 3, 'a retired worker is not listed');
});
