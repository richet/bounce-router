// The answer contract (docs/plans/answer-contract.md). Six separate fixes in two days all came from one
// gap: an answer was "the last text on the stream", and three speakers share that stream — the worker, its
// thinking, and the runtime itself. Every shape below was taken from a real session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SPEAKER, classifyText, createAnswer} from '../src/adapters/live-common.js';

test('A1 who is speaking: the worker, its thinking, or the runtime', () => {
  // the worker, plainly
  assert.deepEqual(classifyText('opencode', '  FAIL: the boundary is off by one  '), {speaker: SPEAKER.worker, text: 'FAIL: the boundary is off by one'});
  // opencode's own step-cap notice (live: it became a review's verdict and blocked the task)
  const cap = '</think>\n\nCRITICAL - MAXIMUM STEPS REACHED\n\nThe maximum number of steps allowed for this task has been reached. Tools are disabled until next user input.';
  assert.equal(classifyText('opencode', cap).speaker, SPEAKER.runtime);
  // ...but a model that titles its own summary after the notice is the worker speaking (observed live: the
  // summary was filed as runtime noise and the reviewer failed with "no answer")
  const summary = '\n</think>\n\n## Maximum Steps Reached - Final Summary\n\n### Work Completed\n1. Baseline: 148 passed, 1 failed.\n\n### Remaining Tasks\n1. Re-run the corrupt-tail probes.';
  assert.equal(classifyText('opencode', summary).speaker, SPEAKER.worker);
  assert.match(classifyText('opencode', summary).text, /^## Maximum Steps Reached - Final Summary\n\n### Work Completed/);
  assert.equal(classifyText('opencode', 'Maximum steps for this agent have been reached').speaker, SPEAKER.runtime);
  // opencode refusing a path is the runtime too
  assert.equal(classifyText('opencode', 'auto-rejecting permission ask for /etc/hosts').speaker, SPEAKER.runtime);
  // thinking: a closed block, or a stray marker with nothing else left
  assert.deepEqual(classifyText('opencode', '<think>let me look again</think>'), {speaker: SPEAKER.thinking, text: '<think>let me look again</think>'});
  assert.deepEqual(classifyText('opencode', '<think>weighing it</think>\nPASS: it holds'), {speaker: SPEAKER.worker, text: 'PASS: it holds'});
  // a vendor that marks its own stream is believed over any pattern
  assert.equal(classifyText('codex', 'thinking about the diff', {marked: 'thinking'}).speaker, SPEAKER.thinking);
  assert.equal(classifyText('claude', 'anything at all', {marked: 'runtime'}).speaker, SPEAKER.runtime);
  // a vendor with nothing to match keeps the worker's text
  assert.equal(classifyText('muse', 'done: 3 files changed').speaker, SPEAKER.worker);
});

test('A2 the answer is what the WORKER said after its last tool call', () => {
  const answer = createAnswer();
  assert.equal(answer.value, null, 'nothing said yet');
  answer.said(SPEAKER.worker, "I'll start by reading the owned files.");
  assert.equal(answer.value, "I'll start by reading the owned files.");
  answer.tooled();
  assert.equal(answer.value, null, 'an opener before six minutes of tool work is not an answer');
  answer.said(SPEAKER.thinking, 'still weighing it');
  answer.said(SPEAKER.runtime, 'MAXIMUM STEPS REACHED');
  assert.equal(answer.value, null, 'neither the thinking nor the runtime can answer for the worker');
  answer.said(SPEAKER.worker, '```');
  assert.equal(answer.value, null, 'a closing fence says nothing');
  answer.said(SPEAKER.worker, 'FAIL: two blockers');
  assert.equal(answer.value, 'FAIL: two blockers');
  assert.equal(answer.spoken, 'FAIL: two blockers', 'what it last said, whether or not tools followed');
});
