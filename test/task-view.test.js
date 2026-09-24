// The read the orchestrator never had (docs/plans/bridge-interface.md). Found live: with
// no way to ask "what did this task produce", it ran `tail -n 20 journal.jsonl` and 143 KB of raw JSON went
// into the chat. These views answer the same question in a screenful, and hand back a POINTER to the journal
// instead of its contents. Pure: events in, view out — the same fold the TUI renders from.
import test from 'node:test';
import assert from 'node:assert/strict';
import {taskView, taskList, FINDINGS_SHOWN, MILESTONES_SHOWN} from '../src/task-view.js';

const at = (s, rest) => ({time: `2026-09-22T18:${String(s).padStart(2, '0')}:00.000Z`, ...rest});
const log = [
  at(0, {kind: 'task.submitted', seq: 1, task: 'land', parent: null, profile: 'integrator', orders: 'land the P2 fixes', deadline: 900000, review: {completion: 'reviewer'}}),
  at(1, {kind: 'task.started', seq: 2, task: 'land', attempt: 1, requested: 'gpt-5.6-sol'}),
  at(2, {kind: 'task.milestone', seq: 3, task: 'land', phase: 'read', text: 'read the three diffs', next: 'run the gate'}),
  at(3, {kind: 'task.lease.renewed', seq: 4, task: 'land', lease: 1, until: 1800000}),
  at(4, {kind: 'task.finding', seq: 5, task: 'land', finding: {file: 'src/a.ts', line: 12, severity: 'major', title: 'lock released early'}, text: 'FINDING: …'}),
  at(5, {kind: 'task.finding', seq: 6, task: 'land', finding: null, text: 'FINDING: the CLI exits 0 on failure'}),
  at(6, {kind: 'task.milestone', seq: 7, task: 'land', phase: 'gate', text: 'suite green', next: 'report'}),
  at(7, {kind: 'task.completed', seq: 8, task: 'land', summary: 'landed all three fixes; suite 36/36'}),
  at(8, {kind: 'review.started', seq: 9, task: 'land', stage: 'completion', round: 1, profile: 'reviewer'}),
];
const now = Date.parse('2026-09-22T18:10:00.000Z');

test('V1 a task view answers "what is this task doing and what has it produced", bounded', () => {
  const view = taskView(log, 'land', {now, journal: '/x/journal.jsonl'});
  assert.equal(view.task, 'land');
  assert.equal(view.state, 'reviewing');
  assert.equal(view.profile, 'integrator');
  assert.equal(view.reviewer, 'reviewer');
  assert.equal(view.elapsed, '9 min');
  assert.deepEqual(view.lease, {renewals: 1, minutes: 15});
  assert.deepEqual(view.milestones, [{phase: 'read', text: 'read the three diffs', next: 'run the gate'}, {phase: 'gate', text: 'suite green', next: 'report'}]);
  assert.deepEqual(view.findings, {shown: [
    {severity: 'major', file: 'src/a.ts', line: 12, title: 'lock released early'},
    {severity: null, file: null, line: null, title: 'the CLI exits 0 on failure'},
  ], total: 2, more: 0});
  assert.equal(view.summary, 'landed all three fixes; suite 36/36');
  assert.equal(view.blocker, null);
  // the raw material is a pointer, never its contents
  assert.deepEqual(view.journal, {path: '/x/journal.jsonl', task: 'land', fromSeq: 1, toSeq: 9});
  assert.equal(JSON.stringify(view).length < 2000, true, `view is ${JSON.stringify(view).length} characters`);
});

test('V2 a long task stays a screenful: findings and milestones are capped and counted, text is cut', () => {
  const many = [...log];
  for (let i = 0; i < 200; i++) many.push(at(9, {kind: 'task.finding', seq: 10 + i, task: 'land', finding: {file: `src/f${i}.ts`, line: i, severity: 'minor', title: `finding ${i} ${'x'.repeat(400)}`}, text: 'FINDING: …'}));
  const view = taskView(many, 'land', {now, journal: '/x/journal.jsonl'});
  assert.equal(view.findings.shown.length, FINDINGS_SHOWN);
  assert.deepEqual([view.findings.total, view.findings.more], [202, 202 - FINDINGS_SHOWN]);
  assert.equal(view.findings.shown.every(f => f.title.length <= 200), true, 'each finding is cut to a line');
  assert.equal(view.milestones.length <= MILESTONES_SHOWN, true);
  assert.equal(JSON.stringify(view).length < 4000, true, `view is ${JSON.stringify(view).length} characters`);
});

test('V3 what a blocked, failed or unknown task says', () => {
  const blocked = [...log.slice(0, 4), at(5, {kind: 'task.blocked', seq: 5, task: 'land', text: 'needs a credential'})];
  assert.deepEqual([taskView(blocked, 'land', {now}).state, taskView(blocked, 'land', {now}).blocker], ['blocked', 'needs a credential']);
  const failed = [...log.slice(0, 3), at(4, {kind: 'task.failed', seq: 4, task: 'land', reason: 'review_unreadable', text: 'the reviewer returned no readable verdict'})];
  const view = taskView(failed, 'land', {now});
  assert.deepEqual([view.state, view.reason, view.summary], ['failed', 'review_unreadable', 'the reviewer returned no readable verdict']);
  assert.equal(taskView(log, 'nope', {now}), null, 'a task bounce never saw is null, not an empty shape');
});

test('V4 the list is what is live, newest last, one line each', () => {
  const two = [...log,
    at(9, {kind: 'task.submitted', seq: 20, task: 'probe', parent: null, profile: 'reviewer', orders: 'review the locking'}),
    at(9, {kind: 'task.started', seq: 21, task: 'probe', attempt: 1}),
    at(9, {kind: 'task.submitted', seq: 22, task: 'old', parent: null, profile: 'analyst', orders: 'x'}),
    at(9, {kind: 'task.started', seq: 23, task: 'old', attempt: 1}),
    at(9, {kind: 'task.completed', seq: 24, task: 'old', summary: 'done'}),
    at(9, {kind: 'task.accepted', seq: 25, task: 'old', stage: 'completion'})];
  const live = taskList(two, {now});
  assert.deepEqual(live.map(row => [row.task, row.state, row.profile]), [['land', 'reviewing', 'integrator'], ['probe', 'running', 'reviewer']]);
  assert.equal(live[0].doing, 'suite green', 'its last milestone, so the line says what it is on');
  assert.deepEqual(taskList(two, {now, all: true}).map(row => row.task), ['land', 'probe', 'old']);
});

// Found live: a local reviewer produced a 12 KB FAIL verdict with a blocker and a
// working repro; the orchestrator got it cut mid-word at 1,200 characters — "* **Expected**: The system should
// detec…" — then spent six minutes trying `task_get`, four shapes of `bounce wait`, and two --help pages before
// concluding "the bridge exposes only a shortened summary and no full-report option", and started re-reading the
// source itself. Its own orders forbid reading the journal, so BOTH doors were shut. The bounded view stays the
// default; asking for the report is the one deliberate way through.
test('T8 the full report is reachable on request, while the default view stays bounded', () => {
  const verdict = `## FINAL REVIEW REPORT\n\n**Outcome: FAIL**\n\n${'blocker detail '.repeat(400)}END-OF-REPORT`;
  const events = [
    at(1, {kind: 'task.submitted', seq: 1, task: 'rev', profile: 'reviewer', orders: 'review locking', deadline: 900000}),
    at(2, {kind: 'task.started', seq: 2, task: 'rev', requested: 'qwen3.6-35b-a3b-mlx'}),
    at(6, {kind: 'task.completed', seq: 3, task: 'rev', summary: verdict}),
  ];
  assert.equal(verdict.length > 5000, true, 'the live one was 12 KB');

  const bounded = taskView(events, 'rev', {now: Date.parse('2026-09-22T20:10:00.000Z')});
  assert.equal(bounded.summary.length <= 1200, true, `default view is ${bounded.summary.length} characters`);
  assert.match(bounded.summary, /…$/, 'and it says it was cut');
  assert.equal('report' in bounded, false, 'the whole text is not carried unless asked for');

  const full = taskView(events, 'rev', {now: Date.parse('2026-09-22T20:10:00.000Z'), report: true});
  assert.equal(full.report, verdict, 'asked for, the verdict arrives whole — not cut, not reflowed');
  assert.match(full.report, /END-OF-REPORT$/, 'including its last line, which is where a verdict puts its conclusion');
  assert.equal(full.summary.length <= 1200, true, 'the bounded summary is still there beside it');
});
