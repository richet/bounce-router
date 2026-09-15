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
      {id: '2', kind: 'tool', provider: 'claude', text: 'Tests passed\nRAW_LINE_TWO\nRAW_LINE_THREE'},
      {id: '3', kind: 'task.observed', task: 'worker', text: 'WORKER_RAW_DUMP'},
      {id: '4', kind: 'assistant', provider: 'claude', text: '**Verified** the test results.'},
    ]});
  } finally {
    terminal.unmount();
  }
  const plain = stripAnsi(output);
  assert.match(plain, /Bash  Run focused tests/);
  assert.match(plain, /Tests passed.*\(\+2 lines\)/);
  assert.doesNotMatch(plain, /RAW_LINE_TWO|RAW_LINE_THREE|WORKER_RAW_DUMP/);
  assert.match(output, /\x1b\[35m/);
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
  assert.match(output, /Bash  Run focused tests/);
  assert.doesNotMatch(output, /"description"|"command"/);
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
      {id: 'tool', kind: 'tool', text: 'First line\nHIDDEN_DETAIL'},
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
