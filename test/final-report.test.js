import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectFinalReport, parseFinalReport, synthesizeReport, FINAL_REPORT_INSTRUCTION} from '../src/final-report.js';

const completed = {
  op: 'final', phase: 'complete', text: 'Implemented the report parser.', next: 'none',
  evidence: ['npm test -- test/final-report.test.js: 4 passed'], outcome: 'completed',
  summary: 'Added final-report validation.', remaining: '',
};

test('accepts one explicit final-report envelope and preserves the legacy report fields', () => {
  const parsed = parseFinalReport(`Work is complete.\n\n\`\`\`json\n${JSON.stringify(completed)}\n\`\`\``);
  assert.deepEqual(parsed, completed);
});

test('prose, malformed envelopes, and unfinished completed claims are unresolved', () => {
  for (const value of [
    'Implemented it and tests pass.',
    '{"outcome":"completed"}',
    JSON.stringify({...completed, remaining: 'still need to run tests'}),
    JSON.stringify({...completed, op: 'milestone'}),
  ]) {
    assert.equal(parseFinalReport(value), null);
  }
});

test('a JSON-shaped worker answer with an omitted evidence bracket is malformed JSON, not missing', () => {
  // Sanitized from the live failure shape: the worker supplied a final envelope but omitted
  // the evidence-array close immediately before outcome. Do not infer the missing bracket.
  const omittedEvidenceBracket = `{"op":"final","phase":"audit","text":"Inspected the repository.","next":"Wait for direction.","evidence":["src/scheduler.js","node --test: passed","report boundary checked","candidate preserved","review gate blocked","raw output retained","journal examined","no semantic repair","fixture sanitized","diagnostic shown","task_get full","evidence eleven","evidence twelve","evidence thirteen","evidence fourteen","evidence fifteen","evidence sixteen","evidence seventeen","outcome":"blocked","summary":"Work needs direction.","remaining":"Need credentials."}`;
  const inspected = inspectFinalReport(omittedEvidenceBracket);
  assert.equal(inspected.report, null);
  assert.match(inspected.diagnostic, /^malformed_json: /);
  assert.equal(parseFinalReport(omittedEvidenceBracket), null);
});

test('non-success outcomes retain their explicit remaining reason', () => {
  const parsed = parseFinalReport(JSON.stringify({...completed, outcome: 'blocked', remaining: 'Need credentials.'}));
  assert.equal(parsed.outcome, 'blocked');
  assert.equal(parsed.remaining, 'Need credentials.');
});

test('normalizes a bounded string list used for informational next steps', () => {
  const parsed = parseFinalReport(JSON.stringify({...completed, next: ['Run the focused test', 'Report the result']}));
  assert.equal(parsed.next, 'Run the focused test\nReport the result');
  assert.equal(parseFinalReport(JSON.stringify({...completed, next: ['valid', 3]})), null);
  assert.equal(parseFinalReport(JSON.stringify({...completed, next: ['x'.repeat(16_001)]})), null);
});

test('losslessly folds a live-shaped next list and 41 evidence strings into the bounded representation', () => {
  const next = Array.from({length: 6}, (_, index) => `Follow-up ${index + 1}`);
  const evidence = Array.from({length: 41}, (_, index) => `Observed evidence ${index + 1}`);
  const parsed = parseFinalReport(JSON.stringify({...completed, next, evidence}));
  assert.equal(parsed.next, next.join('\n'));
  assert.deepEqual(parsed.evidence.slice(0, 31), evidence.slice(0, 31));
  assert.equal(parsed.evidence[31], evidence.slice(31).join('\n'));
  assert.equal(parsed.evidence.length, 32);
});

test('representation repair never coerces semantic types or discards overlong evidence', () => {
  assert.equal(parseFinalReport(JSON.stringify({...completed, evidence: [...Array(32).fill('ok'), 3]})), null);
  assert.equal(parseFinalReport(JSON.stringify({...completed, evidence: [...Array(31).fill('ok'), 'x'.repeat(16_001), 'last']})), null);
  assert.equal(parseFinalReport(JSON.stringify({...completed, outcome: 'maybe'})), null);
  assert.equal(parseFinalReport(JSON.stringify({...completed, remaining: ['unfinished']})), null);
});

test('the local-worker instruction states the report boundary types and bounds', () => {
  assert.match(FINAL_REPORT_INSTRUCTION, /phase, text, next, summary and remaining must each be strings/);
  assert.match(FINAL_REPORT_INSTRUCTION, /next must be one string, not an array/);
  assert.match(FINAL_REPORT_INSTRUCTION, /at most 32 strings/);
  assert.match(FINAL_REPORT_INSTRUCTION, /outcome reflects only the assigned task/);
});

// Observed live (session 159f4746, 7/19 tasks): a good prose final answer, with no structured
// report at all, was lost to a report repair that timed out or was unavailable. synthesizeReport
// is the worker's own answer turned into the report bounce needs, with no candidate to merge.
test('a short plain-prose answer synthesizes into a completed report, by default', () => {
  const synthesis = synthesizeReport('Done: renamed the variable, tests pass.');
  assert.deepEqual(synthesis.report, {
    op: 'final', phase: 'synthesized', text: 'Done: renamed the variable, tests pass.', next: '',
    evidence: [], outcome: 'completed', summary: 'Done: renamed the variable, tests pass.', remaining: '', synthesized: true,
  });
  assert.equal(synthesis.rule, 'default_completed');
  assert.deepEqual(synthesis.sources, {outcome: 'answer', phase: 'answer', summary: 'answer', remaining: 'answer', next: 'answer', evidence: 'answer'});
});

test('the outcome rule reads only the first paragraph, and only its own small set of markers', () => {
  assert.equal(synthesizeReport('Blocked: cannot proceed without the API key.').report.outcome, 'blocked');
  assert.equal(synthesizeReport('❌ Blocked\n\nCould not reach the database.').report.outcome, 'blocked');
  assert.equal(synthesizeReport('The build failed with three compile errors.').report.outcome, 'failed');
  assert.equal(synthesizeReport('Implemented the fix.\n\nA prior attempt here had failed.').report.outcome, 'completed',
    'a later paragraph mentioning "failed" does not override a clean first paragraph');
});

test('summary reads the first heading when there is one, else the first paragraph', () => {
  const withHeading = synthesizeReport('## Final Report\n\nInventoried the source tree and found no issues.');
  assert.equal(withHeading.report.summary, 'Final Report');
  const withoutHeading = synthesizeReport('Inventoried the source tree.\n\nFound no issues.');
  assert.equal(withoutHeading.report.summary, 'Inventoried the source tree.');
});

test('remaining reads the body of a Remaining/Next/Not done heading when present, else empty', () => {
  const withRemaining = synthesizeReport('## Final Report\n\nDid the work.\n\n### Not Done\n\nThe lint step still fails.\n\n### Evidence\n\nsrc/a.js');
  assert.equal(withRemaining.report.remaining, 'The lint step still fails.');
  assert.equal(synthesizeReport('## Final Report\n\nDid the work, all of it.').report.remaining, '');
});

// A malformed `bounce_report` call (parsed JSON, rejected by validateReport) is not discarded: its
// own valid fields win over synthesis, and only what it was missing is filled from the answer.
test('a malformed report candidate contributes its own valid fields; synthesis fills only the rest', () => {
  const answer = '## Final Report\n\nRenamed the variable and reran the suite.';
  const candidate = {op: 'final', phase: 'cleanup', text: 'Renamed x to total.', next: 'Run the full suite.',
    evidence: ['src/a.js:12'], outcome: 'completed'}; // missing summary: rejected by validateReport
  const synthesis = synthesizeReport(answer, candidate);
  assert.equal(synthesis.report.phase, 'cleanup');
  assert.equal(synthesis.report.next, 'Run the full suite.');
  assert.deepEqual(synthesis.report.evidence, ['src/a.js:12']);
  assert.equal(synthesis.report.outcome, 'completed');
  assert.equal(synthesis.report.summary, 'Final Report', 'the one missing field is filled from the answer');
  assert.deepEqual(synthesis.sources, {outcome: 'worker', phase: 'worker', summary: 'answer', remaining: 'answer', next: 'worker', evidence: 'worker'});
});

test('a candidate outcome synonym still wins over the answer-derived fallback', () => {
  const synthesis = synthesizeReport('All good here.', {outcome: 'Success'});
  assert.equal(synthesis.report.outcome, 'completed');
  assert.equal(synthesis.sources.outcome, 'worker');
});
