// An "unreadable" review was almost always bounce failing to read the reviewer (user, 2026-09-27). Each case
// below was read as no verdict before: the verdict is now read from whatever the reviewer wrote.
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseVerdict} from '../src/verdict.js';

test('a verdict is read from JSON anywhere in the answer: a bare line, fenced, multi-line, or inline after prose', () => {
  assert.equal(parseVerdict('completed', 'Checked it.\n{"verdict":"accept"}').verdict, 'accept');
  assert.deepEqual(parseVerdict('completed', 'Review done.\n```json\n{\n  "verdict": "rework",\n  "findings": ["src/a.js:3 drops the error"]\n}\n```').findings, ['src/a.js:3 drops the error']);
  assert.equal(parseVerdict('completed', 'Final answer: {"verdict": "reject", "questions": ["why?"]} — see above').verdict, 'reject');
  assert.equal(parseVerdict('completed', '{"verdict":"accept"}\nOn reflection:\n{"Verdict":"REWORK","findings":["x"]}').verdict, 'rework', 'the last verdict wins');
});

test('a plain verdict line is read, with the usual synonyms and FINDING lines', () => {
  assert.deepEqual(parseVerdict('completed', 'Looked at the diff.\nFINDING: remove.ts:40 deletes the volume\n**Verdict: FAIL**'), {verdict: 'rework', findings: ['remove.ts:40 deletes the volume'], source: 'text'});
  assert.equal(parseVerdict('completed', 'All good.\nVerdict: PASS').verdict, 'accept');
  assert.equal(parseVerdict('completed', 'Decision: changes requested').verdict, 'rework');
});

test('a turn that did not end cleanly is still read, and reasoning is ignored', () => {
  assert.equal(parseVerdict('failed', 'ran out of steps\n{"verdict":"accept"}').verdict, 'accept');
  assert.equal(parseVerdict('completed', '<think>maybe {"verdict":"reject"}</think>\n{"verdict":"accept"}').verdict, 'accept');
});

test('only text with no verdict in it is unreadable, and it keeps what the reviewer said', () => {
  const none = parseVerdict('completed', 'I looked at the code and it seems mostly fine but I am not sure.');
  assert.equal(none.verdict, 'unreadable');
  assert.equal(none.excerpt, 'I looked at the code and it seems mostly fine but I am not sure.');
  assert.equal(parseVerdict('completed', '').verdict, 'unreadable');
  assert.equal(parseVerdict('completed', 'The verdict is out on this one.').verdict, 'unreadable', 'the word alone is not a verdict');
});
