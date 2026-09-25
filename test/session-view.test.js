import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionView, formatSessionView} from '../src/session-view.js';

test('groups renamed retries by jobId and reports the latest accepted outcome and campaign gate', () => {
  const events = [
    {kind: 'task.submitted', seq: 1, task: 'old', jobId: 'job-1', campaignId: 'camp-1', gate: 'review', profile: 'builder', orders: 'change it'},
    {kind: 'task.started', seq: 2, task: 'old'}, {kind: 'task.failed', seq: 3, task: 'old', reason: 'timeout'},
    {kind: 'task.submitted', seq: 4, task: 'retry', jobId: 'job-1', campaignId: 'camp-1', gate: 'review', profile: 'builder-renamed', orders: 'change it'},
    {kind: 'task.started', seq: 5, task: 'retry'}, {kind: 'task.completed', seq: 6, task: 'retry'}, {kind: 'task.accepted', seq: 7, task: 'retry'},
  ];
  const view = sessionView(events);
  assert.equal(view.jobs.length, 1); assert.deepEqual([view.jobs[0].attempts, view.jobs[0].accepted, view.jobs[0].outcome], [2, 1, 'accepted']);
  assert.deepEqual(view.campaign, {id: 'camp-1', gate: 'review', job: 'job-1'});
  assert.match(formatSessionView(view), /Current: campaign camp-1/);
});

test('campaign health exposes unmet gates and an actionable next step before any task exists', () => {
  const events = [{kind: 'campaign.started', seq: 1, time: '2026-09-24T00:00:00.000Z', campaignId: 'scope', objective: 'ship', required: ['build', 'review']}];
  const view = sessionView(events, {now: Date.parse('2026-09-24T00:01:00.000Z')});
  assert.deepEqual(view.campaigns[0].remaining, ['build', 'review']);
  assert.equal(view.campaigns[0].nextAction, 'continue_campaign');
  const blocked = sessionView([...events, {kind: 'campaign.blocked', seq: 2, campaignId: 'scope', reason: 'credentials missing'}]);
  assert.equal(blocked.campaigns[0].nextAction, 'resolve_blocker');
  assert.equal(blocked.campaigns[0].blocker, 'credentials missing');
});
