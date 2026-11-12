// A reviewer's send-back reaches the worker only when it names a defect: a file or line, or the behaviour that
// fails. One that only asks for more verification left a builder with nothing to fix, blocked, for hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultStrategy, quorumStrategy, namesDefect} from '../src/strategy.js';
import {REVIEW_GATE_REASONS} from '../src/task-result.js';

const api = (extra = {}) => ({submittedRow: () => ({}), roundsUsed: () => 0, roundsCap: () => 1, lastRework: () => null, unverifiedChanges: () => true, checkOf: () => null, copyOf: () => '/copy', ...extra});
const view = {t1: {state: 'completed'}};

test('a text review that sends work back with no defect is held for the orchestrator, not sent to the worker', () => {
  const intent = defaultStrategy.onReviewVerdict('t1', [{verdict: 'rework', source: 'text', findings: ['Needs independent verification before it can be accepted.']}], view, api());
  assert.equal(intent.action, 'escalate');
  assert.equal(intent.reason, 'review_no_defect');
  assert.match(intent.text, /named no defect/);
  assert.match(intent.text, /independent verification/);
  assert.ok(REVIEW_GATE_REASONS.has('review_no_defect'));
});

test('a text review naming a file and line, or a failing behaviour, still sends the work back', () => {
  for (const finding of ['{"file": "src/x.js", "line": 12, "severity": "major", "title": "off by one"}', 'src/cart.js:40 returns null for an empty cart', 'The login test fails: expected 200, got 500']) {
    const intent = defaultStrategy.onReviewVerdict('t1', [{verdict: 'rework', source: 'text', findings: [finding]}], view, api());
    assert.deepEqual(intent, {action: 'rework', findings: [finding]}, finding);
  }
});

test('a quorum send-back with no defect is held too', () => {
  const intent = quorumStrategy(2).onReviewVerdict('t1', [{verdict: 'accept'}, {verdict: 'rework', source: 'text', findings: ['Please double-check the work.']}], view, api());
  assert.equal(intent.reason, 'review_no_defect');
});

test('Jev check findings are actionable as they stand', () => {
  const findings = ['The report claims tests it shows no output for; run them and include the actual result lines.'];
  const intent = defaultStrategy.onReviewVerdict('t1', [{verdict: 'rework', fired: ['unshown_tests'], findings}], view, api());
  assert.deepEqual(intent, {action: 'rework', findings});
});

test('namesDefect', () => {
  assert.equal(namesDefect(['verify independently']), false);
  assert.equal(namesDefect(['add more evidence and confirm it works']), false);
  assert.equal(namesDefect(['e.g. run it again']), false);
  assert.equal(namesDefect(['`parseVerdict` drops the last line']), true);
  assert.equal(namesDefect(['README.md still names the old flag']), true);
  assert.equal(namesDefect(['it throws on an empty list']), true);
});

test('a finding that faults the work without a location still goes back; only checking requests are held', async () => {
  const {asksOnlyForChecking} = await import('../src/strategy.js');
  assert.equal(asksOnlyForChecking(['x is missing']), false);
  assert.equal(asksOnlyForChecking(['An acceptance criterion in the orders is not met.']), false);
  assert.equal(asksOnlyForChecking(['Needs independent verification.']), true);
  assert.equal(asksOnlyForChecking([]), true);
});

test('a finding the reviewer marks outside the task\'s scope is held for the orchestrator at once, not sent back', () => {
  const outside = '{"file": "e2e/update.spec.ts", "severity": "blocker", "scope": "outside", "title": "no signed-install e2e: the harness runs the extracted binary"}';
  const inside = '{"file": "src/x.js", "line": 12, "severity": "major", "title": "off by one"}';
  for (const intent of [
    defaultStrategy.onReviewVerdict('t1', [{verdict: 'rework', source: 'text', findings: [inside, outside]}], view, api()),
    quorumStrategy(2).onReviewVerdict('t1', [{verdict: 'accept'}, {verdict: 'rework', source: 'text', findings: [outside]}], view, api()),
  ]) {
    assert.equal(intent.action, 'escalate');
    assert.equal(intent.reason, 'review_out_of_scope');
    assert.match(intent.text, /outside this task's scope.*Outside its scope: .*signed-install e2e/);
  }
  assert.ok(REVIEW_GATE_REASONS.has('review_out_of_scope'));
});
