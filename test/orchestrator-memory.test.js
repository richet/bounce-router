// The orchestrator's working memory (docs/plans/orchestrator-memory.md). Found live: five sessions in one
// workspace were a single campaign, each starting from an empty journal, and inside a session the
// orchestrator re-derived the situation every wake — which is how ten identical reviewer tasks happened
// without anyone noticing. Its own state note is judgement it rewrites each turn; the campaign view beside
// it is fact bounce derives. Bounce never edits the note: over budget, it asks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionView, STATE_MAX, VIEW_MAX} from '../src/session-view.js';
import {handoff} from '../src/core.js';

const at = (m, rest) => ({time: `2026-09-22T20:${String(m).padStart(2, '0')}:00.000Z`, ...rest});
const ORDERS = 'Review locking and journaling in src/workspaces.';
const campaign = [
  at(16, {kind: 'user', text: 'review P2 in ace'}),
  at(19, {kind: 'plan.submitted', phase: 'p2-verdicts', chunks: [{id: 'lock'}, {id: 'docker'}, {id: 'cli'}]}),
  at(19, {kind: 'plan.accepted', plan: 'p2-verdicts', chunks: 3}),
  at(37, {kind: 'task.submitted', task: 'r1', profile: 'reviewer', orders: ORDERS}),
  at(37, {kind: 'task.started', task: 'r1'}),
  at(42, {kind: 'task.deadline', task: 'r1', reason: 'ceiling'}),
  at(47, {kind: 'task.submitted', task: 'r2', profile: 'reviewer', orders: ORDERS}),
  at(47, {kind: 'task.started', task: 'r2'}),
  at(52, {kind: 'task.deadline', task: 'r2', reason: 'ceiling'}),
  at(56, {kind: 'task.submitted', task: 'b1', profile: 'builder', orders: 'fix the lock release order'}),
  at(56, {kind: 'task.started', task: 'b1'}),
  at(58, {kind: 'task.completed', task: 'b1', summary: 'fixed; suite green'}),
  at(58, {kind: 'task.accepted', task: 'b1', stage: 'completion'}),
  at(59, {kind: 'task.submitted', task: 'r3', profile: 'reviewer', orders: ORDERS}),
  at(59, {kind: 'task.started', task: 'r3'}),
];

test('S1 the campaign view: the phase, what each job has done, and a repeat nobody could see turn by turn', () => {
  const view = sessionView(campaign, {now: Date.parse('2026-09-22T21:00:00.000Z')});
  assert.deepEqual(view.phase, {name: 'p2-verdicts', chunks: 3, accepted: true});
  const reviewJob = view.jobs.find(job => job.profile === 'reviewer');
  assert.deepEqual([reviewJob.attempts, reviewJob.failed, reviewJob.endings], [3, 2, ['ceiling', 'ceiling']]);
  assert.equal(reviewJob.live, 1, 'r3 is still running');
  assert.equal(reviewJob.repeating, true, 'the same job, failing the same way: this is what a single handoff never shows');
  const buildJob = view.jobs.find(job => job.profile === 'builder');
  assert.deepEqual([buildJob.attempts, buildJob.failed, buildJob.accepted], [1, 0, 1]);
  assert.equal(JSON.stringify(view).length <= VIEW_MAX, true, `view is ${JSON.stringify(view).length} characters`);
});

test('S2 the packet leads with the orchestrator\'s own state, then the facts, then the transcript', () => {
  const state = 'Phase p2-verdicts. Locking review failed twice at the ceiling on the 27B — not retrying it there; next is the same scope on codex. Docker and CLI areas untouched.';
  const session = {cwd: '/w', file: '/w/journal.jsonl', events: [...campaign, at(59, {kind: 'state', text: state, from: 'orchestrator'})]};
  const packet = handoff(session, 'carry on');
  assert.match(packet, /Where you are \(your own note, rewritten each turn\):\n/);
  assert.equal(packet.indexOf(state) < packet.indexOf('Campaign:'), true, 'its own words come first');
  assert.equal(packet.indexOf('Campaign:') < packet.indexOf('Recent history'), true, 'then the facts, then raw history');
  assert.match(packet, /reviewer · 3 attempts · 2 failed \(ceiling, ceiling\)/);
  assert.equal(packet.includes('your state note is'), false, 'a note inside its budget is carried without comment');
});

test('S3 only the latest state is carried, and an over-budget one is carried in full with a request to shorten it', () => {
  const older = 'Phase one: reading.';
  const newest = `Phase two: ${'x'.repeat(STATE_MAX)}`;
  const session = {cwd: '/w', file: '/w/journal.jsonl', events: [...campaign,
    at(58, {kind: 'state', text: older, from: 'orchestrator'}),
    at(59, {kind: 'state', text: newest, from: 'orchestrator'})]};
  const packet = handoff(session, 'carry on');
  assert.equal(packet.includes(older), false, 'the superseded state is history, not context');
  assert.equal(packet.includes(newest), true, 'bounce never cuts its memory for it');
  assert.match(packet, new RegExp(`your state note is ${newest.length} characters, over the ${STATE_MAX} budget`));
  assert.match(packet, /rewrite it shorter/);
});

test('S4 a session with no state note yet is asked for one, once', () => {
  const session = {cwd: '/w', file: '/w/journal.jsonl', events: campaign};
  const packet = handoff(session, 'carry on');
  assert.match(packet, /You wrote no state note last turn: end this turn with one/);
  assert.match(packet, /Campaign:/, 'the facts are there either way');
});
