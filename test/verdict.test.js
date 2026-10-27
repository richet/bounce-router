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

// Found by the verification run 2026-10-22: a local reviewer answered with a bold "**FINDING: {…}**" line and no verdict
// line, and the review was unreadable; the team's reviewer.md also asks for a bare "PASS or FAIL" line.
test('a bare PASS/FAIL line is a verdict, emphasis around FINDING is read, and blocking findings alone are a rework', () => {
  assert.equal(parseVerdict('completed', 'Checked the diff and reran npm test.\n\nPASS').verdict, 'accept');
  assert.equal(parseVerdict('completed', '**FAIL**\n- FINDING: {"severity": "major", "title": "x"}').verdict, 'rework');
  const finding = '{"file": "src/slugify.js", "line": 4, "severity": "blocker", "title": "no dash-run collapse"}';
  const bold = parseVerdict('completed', `**FINDING: ${finding}**\n\nThe tests still fail.`);
  assert.equal(bold.verdict, 'rework');
  assert.deepEqual(bold.findings, [finding]);
  assert.equal(parseVerdict('completed', 'FINDING: {"severity": "minor", "title": "a typo"}').verdict, 'accept', 'only minor findings do not send work back');
  assert.equal(parseVerdict('completed', 'All checks done. Verdict:\n## PASS\nℹ tests 9 / pass 9').verdict, 'accept', 'the verdict on the line after its label');
  assert.equal(parseVerdict('completed', `**FINDING: ${finding}**\n## PASS (goal complete: root cause found, no fix applied)`).verdict, 'accept', 'a stated verdict with its reason wins over findings');
  assert.equal(parseVerdict('completed', 'I looked around and it seems fine overall.').verdict, 'unreadable');
});

// Found live 2026-10-24 (task 01660bb6): a reviewer wrote "**FAIL** — two majors" with each major in prose and
// no FINDING lines; the verdict was read as rework but carried no findings, so the builder got "Rework round 1:" and
// nothing else, and blocked itself ("the rework message has no review findings in it").
test('a verdict that sends the work back with no FINDING lines carries the reviewer\'s own text as its finding', () => {
  const text = 'Verification is complete.\n\n**FAIL** — no blockers; two majors.\n\n**Major 1 — Proof not run against the running app.**\n- Repro: `app open --print`, then curl it.';
  const verdict = parseVerdict('completed', text);
  assert.equal(verdict.verdict, 'rework');
  assert.deepEqual(verdict.findings, [text]);
  assert.equal(parseVerdict('completed', 'All good.\n\n**PASS**').findings, undefined, 'an accept needs none');
  const long = parseVerdict('completed', `**FAIL**\n\n${'x'.repeat(9000)}`);
  assert.equal(long.findings[0].length <= 6000, true, 'bounded');
});

// Found live (2026-10-26): two reviews that plainly passed ("PASS. No must-fix issues." and "PASS; no must-fixes.")
// were read as no verdict, because the line went on after a full stop or a semicolon, and the task was blocked.
test('a verdict word that opens a line followed by a sentence is read', async () => {
  const {parseVerdict} = await import('../src/verdict.js');
  assert.equal(parseVerdict('completed', 'PASS. No must-fix issues.\n\nIndependent run: `test` exited 0.').verdict, 'accept');
  assert.equal(parseVerdict('completed', 'PASS; no must-fixes.\n\nIndependent verification:\n- tests: 3 passed').verdict, 'accept');
  assert.equal(parseVerdict('completed', '**FAIL.** The red test was never run.').verdict, 'rework');
  assert.equal(parseVerdict('completed', 'Ok so I looked at the diff and it seems fine overall.').verdict, 'unreadable', 'prose that only starts with a verdict-like word is not a verdict');
});
