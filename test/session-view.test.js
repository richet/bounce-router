import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionView, formatSessionView} from '../src/session-view.js';

// Rewritten 2026-09-27: campaigns were removed; an old row's campaignId/gate is ignored and the current job is named.
test('groups renamed retries by jobId and reports the latest accepted outcome and the current job', () => {
  const events = [
    {kind: 'task.submitted', seq: 1, task: 'old', jobId: 'job-1', campaignId: 'camp-1', gate: 'review', profile: 'builder', orders: 'change it'},
    {kind: 'task.started', seq: 2, task: 'old'}, {kind: 'task.failed', seq: 3, task: 'old', reason: 'timeout'},
    {kind: 'task.submitted', seq: 4, task: 'retry', jobId: 'job-1', campaignId: 'camp-1', gate: 'review', profile: 'builder-renamed', orders: 'change it'},
    {kind: 'task.started', seq: 5, task: 'retry'}, {kind: 'task.completed', seq: 6, task: 'retry'}, {kind: 'task.accepted', seq: 7, task: 'retry'},
  ];
  const view = sessionView(events);
  assert.equal(view.jobs.length, 1); assert.deepEqual([view.jobs[0].attempts, view.jobs[0].accepted, view.jobs[0].outcome], [2, 1, 'accepted']);
  assert.deepEqual(view.current, {job: 'job-1'});
  assert.match(formatSessionView(view), /Current: job job-1/);
  assert.doesNotMatch(formatSessionView(view), /campaign|gate/i);
});
