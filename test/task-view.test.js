// The read the orchestrator never had (docs/plans/bridge-interface.md). Found live: with
// no way to ask "what did this task produce", it ran `tail -n 20 journal.jsonl` and 143 KB of raw JSON went
// into the chat. These views answer the same question in a screenful, and hand back a POINTER to the journal
// instead of its contents. Pure: events in, view out — the same fold the TUI renders from.
import test from 'node:test';
import assert from 'node:assert/strict';
import {taskView, taskList, FINDINGS_SHOWN, MILESTONES_SHOWN} from '../src/task-view.js';
import {candidateResult} from '../src/task-result.js';
import {formatTaskView} from '../src/task-report.js';

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

test('task view uses the reducer lease and exposes accepted provenance', () => {
  const events = [...log, at(9, {kind: 'review.finished', seq: 10, task: 'land', verdict: 'accept'}), at(10, {kind: 'task.accepted', seq: 11, task: 'land'}), at(10, {kind: 'artifact.captured', seq: 12, task: 'land', artifact: {id: 'a1'}}), at(10, {kind: 'artifact.integrated', seq: 13, task: 'land', status: 'integrated'})];
  const view = taskView(events, 'land', {now});
  assert.equal(view.state, 'accepted');
  assert.deepEqual(view.artifact, {id: 'a1'}); assert.equal(view.integration, 'integrated');
  assert.deepEqual(view.lease, {renewals: 1, minutes: 15});
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

// `bounce tasks` is documented in --help AND the orchestrator's standing orders tell it to run that exact
// command — and it did not exist: only the singular `bounce task` was dispatched, so every orchestrator
// that followed its orders on the shell path got "Unknown command. Use --help."
test('T9 `bounce tasks` is a command, not only a line in the help', async () => {
  const {spawnSync} = await import('node:child_process');
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [cli, ...args], {encoding: 'utf8', env: {...process.env, BOUNCE_HOME: undefined}});
  const plural = run(['tasks', '--json']);
  assert.equal(/Unknown command/.test(plural.stdout + plural.stderr), false,
    `bounce tasks was refused: ${(plural.stdout + plural.stderr).trim().split('\n')[0]}`);
  // and it answers the same shape the singular form does with no id
  const singular = run(['task', '--json']);
  assert.equal(plural.status, singular.status, 'the plural is the same command, not a near-miss');
});

test('artifact provenance reads scheduler journal rows', () => {
  const events = [...log, at(9, {kind: 'task.artifact', seq: 10, task: 'land', artifactId: 'immutable-1', digest: 'digest', resultHash: 'result'}), at(10, {kind: 'task.integrated', seq: 11, task: 'land', artifactId: 'immutable-1', resultHash: 'result'})];
  const view = taskView(events, 'land', {now});
  assert.deepEqual(view.artifact, {id: 'immutable-1', digest: 'digest', resultHash: 'result'});
  assert.equal(view.integration, 'integrated');
});

test('latest reported candidate survives a later blocked review gate (live seq 470 to 481 shape)', () => {
  const report = {op: 'final', phase: 'audit-complete', text: 'Inspected the repository and ran its checks.', next: 'Implement the two missing lifecycle operations.',
    evidence: ['deno check: passed', 'deno test: 79 passed'], outcome: 'completed', summary: 'Audit complete with two remaining lifecycle gaps.', remaining: ''};
  const events = [
    at(0, {kind: 'task.submitted', seq: 460, task: 'audit', profile: 'analyst', orders: 'audit the repository'}),
    at(1, {kind: 'task.started', seq: 461, task: 'audit', attempt: 1, requested: 'qwen'}),
    at(2, {kind: 'task.reported', seq: 470, task: 'audit', attempt: 1, ...report}),
    at(3, {kind: 'task.completed', seq: 471, task: 'audit', summary: report.summary}),
    at(4, {kind: 'review.started', seq: 472, task: 'audit', stage: 'completion', profile: 'jev'}),
    at(5, {kind: 'jev.verdict', seq: 479, task: 'audit', verdict: 'unavailable', choice: 'accept', confidence: 0.42, fired: ['no_repository']}),
    at(6, {kind: 'review.blocked', seq: 480, task: 'audit', stage: 'completion', reason: 'no_repository', candidateSeq: 470}),
    at(7, {kind: 'task.blocked', seq: 481, task: 'audit', reason: 'review_unavailable', text: 'Required review unavailable: no_repository'}),
  ];
  const candidate = candidateResult(events, 'audit');
  assert.deepEqual({...candidate, digest: '<digest>'}, {seq: 470, attempt: 1, digest: '<digest>', outcome: 'completed', summary: report.summary, report});
  assert.match(candidate.digest, /^[a-f0-9]{64}$/);

  const bounded = taskView(events, 'audit', {now});
  assert.deepEqual(bounded.candidate, {seq: 470, attempt: 1, digest: candidate.digest, outcome: 'completed', summary: report.summary});
  assert.deepEqual(bounded.reviewGate, {state: 'blocked', reason: 'no_repository', confidence: 0.42, choice: 'accept', fired: ['no_repository'], candidateSeq: 470});
  assert.equal(bounded.summary, 'Required review unavailable: no_repository');

  const full = taskView(events, 'audit', {now, report: true});
  assert.deepEqual(full.candidateReport, report);
  assert.equal(full.report, JSON.stringify(report));
});

test('a newer candidate does not inherit an older candidate review gate', () => {
  const completed = {op: 'final', phase: 'done', text: 'candidate', next: '', evidence: [], outcome: 'completed', summary: 'candidate', remaining: ''};
  const events = [
    at(0, {kind: 'task.submitted', seq: 1, task: 'audit', profile: 'analyst', orders: 'audit'}),
    at(1, {kind: 'task.reported', seq: 10, task: 'audit', attempt: 1, ...completed, summary: 'candidate A'}),
    at(2, {kind: 'review.started', seq: 11, task: 'audit', stage: 'completion', profile: 'reviewer-a', candidateSeq: 10}),
    at(3, {kind: 'jev.verdict', seq: 12, task: 'audit', verdict: 'accept', confidence: 0.9, fired: []}),
    at(4, {kind: 'review.finished', seq: 13, task: 'audit', stage: 'completion', verdict: 'accept', candidateSeq: 10}),
    at(5, {kind: 'task.reported', seq: 20, task: 'audit', attempt: 2, ...completed, summary: 'candidate B'}),
  ];

  const view = taskView(events, 'audit', {now});
  assert.equal(view.candidate.seq, 20);
  assert.equal(view.reviewGate, null);
  assert.equal(view.reviewer, null);
  assert.equal(view.verdict, null);
});

test('invalid reports expose diagnostics but never replace the latest valid candidate', () => {
  const events = [
    at(0, {kind: 'task.submitted', seq: 1, task: 'audit', profile: 'analyst', orders: 'audit'}),
    at(1, {kind: 'task.reported', seq: 2, task: 'audit', attempt: 1, outcome: 'completed', phase: 'done', text: 'valid text', next: '', evidence: [], summary: 'valid summary', remaining: ''}),
    at(2, {kind: 'task.reported', seq: 3, task: 'audit', attempt: 2, outcome: 'completed', phase: 'done', text: 'contradictory', next: '', evidence: [], summary: 'not actually done', remaining: 'tests remain'}),
    at(2, {kind: 'task.report.invalid', seq: 4, task: 'audit', attempt: 2, diagnostic: 'report_incomplete', report: {outcome: 'completed', remaining: 'tests remain'}}),
    at(3, {kind: 'task.blocked', seq: 5, task: 'audit', reason: 'report_incomplete', text: 'report invalid'}),
  ];
  const bounded = taskView(events, 'audit', {now});
  assert.equal(bounded.candidate.seq, 2);
  assert.equal(bounded.reportDiagnostic, 'report_incomplete');
  assert.equal('invalidReport' in bounded, false);
  const full = taskView(events, 'audit', {now, report: true});
  assert.deepEqual(full.invalidReport, {diagnostic: 'report_incomplete', report: {outcome: 'completed', remaining: 'tests remain'}});
});

test('malformed worker output remains durable and is available only through the full task view', () => {
  const rawOutput = `{"op":"final","phase":"audit","text":"Inspected.","next":"Wait.","evidence":[${Array.from({length: 1_100}, (_, index) => `"evidence ${index}"`).join(',')},"outcome":"blocked","summary":"Needs credentials.","remaining":"Need credentials."}`;
  assert.equal(rawOutput.length > 16_000, true);
  const valid = {op: 'final', phase: 'done', text: 'Valid earlier candidate.', next: '', evidence: [], outcome: 'completed', summary: 'valid summary', remaining: ''};
  const events = [
    at(0, {kind: 'task.submitted', seq: 1, task: 'audit', profile: 'analyst', orders: 'audit'}),
    at(1, {kind: 'task.reported', seq: 2, task: 'audit', attempt: 1, ...valid}),
    at(2, {kind: 'task.output', seq: 3, task: 'audit', attempt: 2, text: rawOutput, status: 'completed', digest: 'sha256:raw', chars: rawOutput.length}),
    at(2, {kind: 'task.report.invalid', seq: 4, task: 'audit', attempt: 2, outputSeq: 3, diagnostic: 'malformed_json: Expected \, or ]', report: null}),
    at(3, {kind: 'task.blocked', seq: 5, task: 'audit', reason: 'malformed_report', text: 'worker final report is malformed'}),
  ];

  const bounded = taskView(events, 'audit', {now});
  assert.deepEqual(bounded.output, {seq: 3, attempt: 2, chars: rawOutput.length, digest: 'sha256:raw', status: 'completed'});
  assert.equal(bounded.candidate.seq, 2, 'invalid raw output never becomes the candidate report');
  assert.equal(bounded.reportDiagnostic, 'malformed_json: Expected \, or ]');
  assert.equal('rawOutput' in bounded, false);
  assert.equal('invalidReport' in bounded, false);
  assert.doesNotMatch(formatTaskView(bounded), /evidence 1099/);

  const full = taskView(events, 'audit', {now, report: true});
  assert.equal(full.rawOutput, rawOutput);
  assert.equal(full.rawOutput.length, rawOutput.length);
  assert.deepEqual(full.invalidReport, {outputSeq: 3, diagnostic: 'malformed_json: Expected \, or ]', report: null});
  assert.match(formatTaskView(full), /unvalidated raw output \(malformed_json: Expected , or \]\):/);
  assert.match(formatTaskView(full), /evidence 1099/);
});
