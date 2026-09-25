import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectFinalReport, parseFinalReport, FINAL_REPORT_INSTRUCTION} from '../src/final-report.js';

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
