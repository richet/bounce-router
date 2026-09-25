// Claude Code fashion: when the main worker's answer ends by proposing what to do next, that
// proposal is prefilled in the prompt as a suggestion — dim, Tab accepts it, typing replaces it —
// so continuing is one key, and the suggestion is never sent by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as Ink from 'ink';
import stripAnsi from 'strip-ansi';
import {suggestionFrom, lastAnswer} from '../src/tui/suggestion.js';
import {createWorkspace} from '../src/tui/Workspace.js';

test('a suggestion is the answer\'s stated next step, as a prompt the user could send', () => {
  const answer = `Completed through Bounce agents:\n\n- Fixed subprocess-helper formatting.\n\nP2 remains unaccepted. Next agent: finish the acceptance audit in smaller chunks, complete outstanding real CLI/Docker and allocation checks, then obtain independent review before P3–P6.\n\nStopped because the analyst exceeded its ten-minute deadline.`;
  assert.equal(suggestionFrom(answer), 'Finish the acceptance audit in smaller chunks, complete outstanding real CLI/Docker and allocation checks, then obtain independent review before P3–P6.');
  assert.equal(suggestionFrom('All done.\n\n**Next:** run the live Docker acceptance and record the result in PROGRESS.md.'), 'Run the live Docker acceptance and record the result in PROGRESS.md.');
  assert.equal(suggestionFrom('Done. Next step: rebase onto main and rerun the gate'), 'Rebase onto main and rerun the gate');
  assert.equal(suggestionFrom('Should I dispatch a re-review of the fix round?'), 'Dispatch a re-review of the fix round');
  assert.equal(suggestionFrom('Do you want me to split P3 into two chunks?'), 'Split P3 into two chunks');
});

test('no suggestion when the answer proposes nothing, asks an open question, or the next step is not a single action', () => {
  assert.equal(suggestionFrom('The gate passes. 78 tests, 0 failures.'), null);
  assert.equal(suggestionFrom('Which exclude should the worktree use: info/exclude or a config include?'), null, 'an open question is for you to answer, not to send back');
  assert.equal(suggestionFrom('Next steps:\n1. finish the audit\n2. run Docker\n3. review'), null, 'a list is not one action');
  assert.equal(suggestionFrom(''), null);
  assert.equal(suggestionFrom('Next: ' + 'x'.repeat(400)), null, 'too long to be a prompt');
});

test('rendered: the suggestion sits dim after the caret while the input is empty, and disappears once the user types', () => {
  const Workspace = createWorkspace(React, Ink);
  const frame = (input, suggestion) => stripAnsi(Ink.renderToString(React.createElement(Workspace, {model: {panes: [], transcript: []}, transcriptRows: ['…'],
    view: {columns: 100, rows: 20, selectedId: 'orchestrator', input, suggestion, notice: '', metadata: {provider: 'claude', mode: 'yolo', operation: 'orchestrator', orchestrator: 'main', sessionId: 's', cwd: '/p', quotaLines: []}}}), {columns: 100}));
  const empty = frame('', 'Finish the acceptance audit in smaller chunks');
  assert.match(empty, /❯ ▏ Finish the acceptance audit in smaller chunks  ⇥ Tab/);
  const typed = frame('re', 'Finish the acceptance audit in smaller chunks');
  assert.equal(typed.includes('Finish the acceptance audit'), false);
  assert.match(typed, /❯ re/);
});

// Found live (ACE session): the prefill never appeared. It was computed from the main.terminal
// row's text, which only carries a failure reason, and only on a daemon-woken turn; a turn's
// answer lives in its last `assistant` row. The answer of a turn is that row, after the turn's
// own prompt (user or handoff), and only when the turn completed.
test('the answer of the last turn is its last assistant row, and none for a cancelled or answerless turn', () => {
  const events = [
    {seq: 1, kind: 'user', text: 'first'},
    {seq: 2, kind: 'assistant', text: 'Next: do the old thing'},
    {seq: 3, kind: 'turn', status: 'completed'},
    {seq: 4, kind: 'handoff', text: 'outcomes'},
    {seq: 5, kind: 'assistant', text: 'Reading the tracker.'},
    {seq: 6, kind: 'task.observed', task: 't1', text: 'Next: a worker line that is not the answer'},
    {seq: 7, kind: 'assistant', text: 'All nine toggles are green. Next: publish the milestone and wait on the review chunks.'},
    {seq: 8, kind: 'turn', status: 'completed'},
  ];
  assert.equal(lastAnswer(events), 'All nine toggles are green. Next: publish the milestone and wait on the review chunks.');
  assert.equal(suggestionFrom(lastAnswer(events)), 'Publish the milestone and wait on the review chunks.');
  assert.equal(lastAnswer([...events, {seq: 9, kind: 'user', text: 'again'}, {seq: 10, kind: 'turn', status: 'completed'}]), null, 'a turn with no answer offers nothing');
  // a classic (non-orchestrator) turn row says how it ended in `text` alone
  assert.equal(lastAnswer([{seq: 1, kind: 'user', text: 'q'}, {seq: 2, kind: 'assistant', text: 'Next: rerun the gate on main'}, {seq: 3, kind: 'turn', text: 'completed'}]), 'Next: rerun the gate on main');
  assert.equal(lastAnswer([{seq: 1, kind: 'user', text: 'q'}, {seq: 2, kind: 'assistant', text: 'Next: rerun the gate on main'}, {seq: 3, kind: 'turn', text: 'cancelled'}]), null);
  assert.equal(lastAnswer([...events, {seq: 9, kind: 'user', text: 'again'}, {seq: 10, kind: 'assistant', text: 'Next: half done'}, {seq: 11, kind: 'turn', status: 'cancelled'}]), null, 'a cancelled turn offers nothing');
});

// Observed (2026-09-25): the prefill never appeared because the orchestrator's answers never state a
// parseable next step ("Say if you want it added"). Its standing orders ask for the one line the
// input box reads, and that line round-trips.
test('the Next line the orchestrator is asked for becomes the prefill', () => {
  const answer = 'The builder fix is in and I checked it.\n- The skill/MCP campaign waits for your approval.\n\nNext: Approve the skill/MCP plan and resume the campaign';
  assert.equal(suggestionFrom(answer), 'Approve the skill/MCP plan and resume the campaign');
});
