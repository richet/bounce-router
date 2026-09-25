import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import stripAnsi from 'strip-ansi';
import React from 'react';
import * as Ink from 'ink';
import {createInkTerminal} from '../src/tui/ink-terminal.js';
import {createWorkspace} from '../src/tui/Workspace.js';
import {promptLayout} from '../src/tui/prompt-layout.js';

test('central transcript preserves highlighting and folds tools without dumping worker output', async t => {
  const noColor = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  t.after(() => { if (noColor !== undefined) process.env.NO_COLOR = noColor; });
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 100;
  stdout.rows = 24;
  stdout.isTTY = true;
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const terminal = createInkTerminal({stdin, stdout});
  try {
    await terminal.mount({events: [
      {id: '1', kind: 'tool', provider: 'claude', text: 'Bash: {"description":"Run focused tests","command":"npm test"}'},
      {id: '2', kind: 'tool', provider: 'claude', text: 'Tests passed\nRAW_LINE_TWO\nRAW_LINE_THREE\nRAW_LINE_FOUR\nRAW_LINE_FIVE'},
      {id: '3', kind: 'task.observed', task: 'worker', text: 'WORKER_RAW_DUMP'},
      {id: '4', kind: 'assistant', provider: 'claude', text: '**Verified** the test results.'},
    ]});
  } finally {
    terminal.unmount();
  }
  const plain = stripAnsi(output);
  // A run of the orchestrator's tool calls is one line; none of their pasted output is in the folded view.
  assert.match(plain, /⚙ 1 tool call · last: Bash\(Run focused tests\)/);
  assert.doesNotMatch(plain, /Tests passed|RAW_LINE_|WORKER_RAW_DUMP/);
  // highlighting: the mechanics are dimmed, the answer keeps its markdown emphasis
  assert.match(output, /\x1b\[90m  ⚙ 1 tool call/);
  assert.match(output, /\x1b\[1mVerified/);
});

test('prompt stays visible even with multiline draft and an overflowing command menu', () => {
  const Workspace = createWorkspace(React, Ink);
  const output = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [], transcript: []}, transcriptRows: ['activity'],
    view: {columns: 80, rows: 12, input: 'line one\nline two\nline three', inputCursor: 4,
      inputTarget: 'orchestrator', menu: Array.from({length: 12}, (_, i) => `command ${i}`), notice: 'Working'},
  }), {columns: 80}));
  assert.match(output, /Message orchestrator/);
  assert.match(output, /line one/);
  assert.match(output, /Working/);
  assert.ok(output.split('\n').length <= 12);
});

test('blank transcript rows keep their height so blocks and sections stay separated', () => {
  const Workspace = createWorkspace(React, Ink);
  const rows = ['● Done.', '', '  What changed', '', '  - item', '', '> next prompt'];
  const render = (extra = {}) => stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: 'main', kind: 'orchestrator', task: 'main', profile: 'main', state: 'running', activity: []}], transcript: []},
    transcriptRows: rows, view: {columns: 60, rows: 16, ...extra},
  }), {columns: 60})).split('\n');
  // Ink drops an empty <Text> entirely; the conversation and the orchestrator pane both keep the row.
  assert.deepEqual(render().slice(1, 8).map(row => row.trim()), ['● Done.', '', 'What changed', '', '- item', '', '> next prompt']);
  const pane = render({agentsOpen: true, selectedId: 'main'});
  const start = pane.findIndex(row => row.includes('● Done.'));
  assert.ok(start > 0);
  assert.deepEqual(pane.slice(start, start + 7).map(row => row.replace(/[│ ]/g, '')), ['●Done.', '', 'Whatchanged', '', '-item', '', '>nextprompt']);
});

test('prompt viewport follows the caret instead of always showing the end of a long draft', () => {
  assert.deepEqual(promptLayout('first\nsecond\nthird\nfourth', 2, 20, 2), [
    {before: 'fi', caret: 'r', after: 'st', atEnd: false}, {text: 'second'},
  ]);
  assert.deepEqual(promptLayout('a👍🏽b', 1, 4, 2), [
    {before: 'a', caret: '👍🏽', after: 'b', atEnd: false},
  ]);
  assert.deepEqual(promptLayout('', 0, 20, 2), [{before: '', caret: ' ', after: '', atEnd: true}]);
});

test('worker panes show tool descriptions instead of serialized tool arguments', () => {
  const Workspace = createWorkspace(React, Ink);
  const output = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: 'worker:abc', task: 'abc', profile: 'build', state: 'running',
      activity: ['Bash: {"description":"Run focused tests","command":"npm test"}']}], transcript: []},
    transcriptRows: [], view: {columns: 58, rows: 20, agentsOpen: true, selectedId: 'worker:abc'},
  }), {columns: 58}));
  assert.match(output, /Bash\(Run focused tests\)/);
  assert.doesNotMatch(output, /"description"|"command"/);
});

// Found live: a worker pane's prose was cut to one line ending in "…" (src/tui/Workspace.js
// took only the first formatted row of a multi-line event). A worker's own words must read in
// full, word-wrapped, the same way the orchestrator's own answers do.
test('a worker pane word-wraps a multi-line assistant paragraph across as many rows as it needs', () => {
  const Workspace = createWorkspace(React, Ink);
  const paragraph = 'Read through every controller in the billing domain, confirmed the tax '
    + 'calculation matches the finance spreadsheet line by line, and found one rounding '
    + 'mismatch in the refund path that only shows up for partial refunds issued after a plan change.';
  const output = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: 'worker:abc', task: 'abc', profile: 'build', state: 'running',
      activity: [{text: paragraph, source: 'assistant'}]}], transcript: []},
    transcriptRows: [], view: {columns: 58, rows: 24, agentsOpen: true, selectedId: 'worker:abc'},
  }), {columns: 58}));
  // Every word of the paragraph is present (nothing truncated with "…"), spread across several rows.
  for (const word of ['controller', 'billing', 'spreadsheet', 'mismatch', 'partial', 'change.']) {
    assert.match(output, new RegExp(word), `expected "${word}" to survive word-wrapping`);
  }
  const rowsWithParagraphWords = output.split('\n').filter(row => /controller|billing|spreadsheet|mismatch|partial|change\./.test(row));
  assert.ok(!rowsWithParagraphWords.some(row => row.includes('…')), 'no paragraph row was truncated with an ellipsis');
  assert.ok(rowsWithParagraphWords.length >= 3, `expected the paragraph across several rows, got ${rowsWithParagraphWords.length}`);
});

test('consecutive tool-call activity rows collapse into one dim counter line', () => {
  const Workspace = createWorkspace(React, Ink);
  const activity = [
    {text: 'read completed', source: 'activity'}, {text: 'read completed', source: 'activity'}, {text: 'read completed', source: 'activity'},
    {text: 'bash completed', source: 'activity'}, {text: 'bash completed', source: 'activity'},
  ];
  const output = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: 'worker:abc', task: 'abc', profile: 'build', state: 'running', activity}], transcript: []},
    transcriptRows: [], view: {columns: 58, rows: 20, agentsOpen: true, selectedId: 'worker:abc'},
  }), {columns: 58}));
  assert.match(output, /read ×3 · bash ×2/);
  assert.equal(output.split('read completed').length - 1, 0, 'the five raw status rows are gone, not just folded');
  assert.equal(output.split('read ×3').length - 1, 1, 'one collapsed line, not one per entry');
});

test('a generating heartbeat never appears in the worker pane body (it already shows in the header)', () => {
  const Workspace = createWorkspace(React, Ink);
  const activity = [
    {text: 'generating · step open 30 s', source: 'activity'},
    {text: 'about to open the migration file', source: 'assistant'},
  ];
  const output = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: 'worker:abc', task: 'abc', profile: 'build', state: 'running', operation: 'generating · step open 30 s', activity}], transcript: []},
    transcriptRows: [], view: {columns: 58, rows: 20, agentsOpen: true, selectedId: 'worker:abc'},
  }), {columns: 58}));
  const bodyRows = output.split('\n').filter(row => !row.includes('operation:'));
  assert.ok(!bodyRows.some(row => /generating · step open 30 s/.test(row)), 'heartbeat rendered outside the header operation: line');
  assert.match(output, /about to open the migration file/);
});

// A restart replay holds only journaled `task.observed` rows; older ones carry no `source` field
// at all. Their prose must still show in full, not be mistaken for tool bookkeeping.
test('a replayed observed row with no source field still shows as prose', () => {
  const Workspace = createWorkspace(React, Ink);
  const output = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: 'worker:abc', task: 'abc', profile: 'build', state: 'running',
      activity: [{text: 'restarted mid-run, still reviewing the migration diff', source: null}]}], transcript: []},
    transcriptRows: [], view: {columns: 58, rows: 20, agentsOpen: true, selectedId: 'worker:abc'},
  }), {columns: 58}));
  assert.match(output, /restarted mid-run, still reviewing the/);
  assert.match(output, /migration/);
  assert.match(output, /diff/);
});

// Found live (2026-09-25): a blocked pane's header read `blocked · phase: done` with the worker's
// own success prose ("All four ordered steps completed successfully…") sitting right under it, and
// no reason anywhere above the fold. The blocking text must lead the pane's details.
test('a blocked pane shows its blocking reason prominently above the stale success prose', () => {
  const Workspace = createWorkspace(React, Ink);
  const output = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: 'worker:8b02db16', task: '8b02db16', profile: 'builder', state: 'blocked',
      phase: 'done', text: 'All four ordered steps completed successfully',
      blocked: 'Artifact integration conflict: src/core/operation.ts; isolated work preserved',
      activity: []}], transcript: []},
    transcriptRows: [], view: {columns: 58, rows: 20, agentsOpen: true, selectedId: 'worker:8b02db16'},
  }), {columns: 58}));
  assert.match(output, /blocked: Artifact integration conflict/);
  const lines = output.split('\n');
  const blockedLine = lines.findIndex(row => row.includes('blocked: Artifact integration conflict'));
  const proseLine = lines.findIndex(row => row.includes('All four ordered steps completed successfully'));
  assert.ok(blockedLine >= 0 && proseLine >= 0 && blockedLine < proseLine, 'the blocking reason must appear before the stale success prose');
});

test('live thinking counters collapse to one row that keeps up with the latest reading', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 100;
  stdout.rows = 24;
  stdout.isTTY = true;
  let output = '';
  stdout.on('data', chunk => {output += chunk;});
  let resolveFrame, requestedRevision = Infinity;
  const terminal = createInkTerminal({stdin, stdout, onFrame: event => {
    if (event.revision >= requestedRevision) resolveFrame?.();
  }});
  const tick = async (id, text) => {
    output = '';
    const frame = new Promise(resolve => {resolveFrame = resolve;});
    terminal.ingest({id, kind: 'progress', provider: 'claude', text});
    requestedRevision = terminal.debugState().revision;
    await frame;
    return stripAnsi(output);
  };
  try {
    await terminal.mount({events: [
      {id: 'tool', kind: 'tool', provider: 'claude', text: 'Bash: {"description":"List commits"}'},
      {id: 'model', kind: 'model', provider: 'claude', model: 'claude-opus-5'},
    ]});
    assert.doesNotMatch(stripAnsi(output), /claude · model/);
    await tick('p1', 'Thinking · ~50 tokens');
    await tick('p2', 'Thinking · ~150 tokens');
    const frame = await tick('p3', 'Thinking · ~265 tokens');
    assert.match(frame, /Thinking · ~265 tokens/);
    assert.doesNotMatch(frame, /~50 tokens|~150 tokens|claude · model/);
    assert.equal(frame.split('Thinking').length - 1, 1);
  } finally {
    terminal.unmount();
  }
});

test('details expand tool output and folding restores the compact view without stale cached rows', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 110;
  stdout.rows = 30;
  stdout.isTTY = true;
  let output = '';
  stdout.on('data', chunk => {output += chunk;});
  let resolveFrame, requestedRevision = Infinity;
  const terminal = createInkTerminal({stdin, stdout, onFrame: event => {
    if (event.revision >= requestedRevision) resolveFrame?.();
  }});
  const update = async details => {
    output = '';
    const frame = new Promise(resolve => {resolveFrame = resolve;});
    requestedRevision = terminal.update({details});
    await frame;
    return stripAnsi(output);
  };
  try {
    await terminal.mount({events: [
      {id: 'tool', kind: 'tool', text: 'First line\nsecond\nthird\nfourth\nHIDDEN_DETAIL'},
      {id: 'response', kind: 'assistant', text: '## Answer\n\n**Readable** result.'},
      {id: 'terminal', kind: 'main.terminal', status: 'completed', text: '## Answer\n\n**Readable** result.'},
    ]});
    assert.doesNotMatch(stripAnsi(output), /HIDDEN_DETAIL|\*\*|##/);
    const expanded = await update(true);
    assert.match(expanded, /HIDDEN_DETAIL/);
    assert.equal(expanded.split('Readable result.').length - 1, 1);
    const folded = await update(false);
    assert.match(folded, /details folded/);
    assert.doesNotMatch(folded, /HIDDEN_DETAIL/);
  } finally {
    terminal.unmount();
  }
});
