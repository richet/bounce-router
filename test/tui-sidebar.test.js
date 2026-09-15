import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as Ink from 'ink';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {PassThrough} from 'node:stream';
import {createWorkspace} from '../src/tui/Workspace.js';
import {createInkTerminal} from '../src/tui/ink-terminal.js';

const Workspace = createWorkspace(React, Ink);
const model = {panes: [{id: 'worker:abc', task: 'abc', profile: 'build', state: 'running', activity: ['worker output']}], transcript: []};
const metadata = {provider: 'claude', model: 'sonnet', mode: 'plan', operation: 'orchestrator', sessionId: 'session-123', cwd: '/project', pendingTurns: 1, quotaLines: ['CLAUDE usage 9%', 'CODEX usage 2%']};

function frame(columns, agentsOpen) {
  return stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model, transcriptRows: ['conversation evidence'], view: {columns, rows: 28, agentsOpen, selectedId: 'orchestrator', input: 'my draft', notice: 'Working', metadata},
  }), {columns}));
}

test('right status rail stays beside conversation and split panes, never below input', () => {
  for (const [columns, agentsOpen] of [[100, false], [100, true], [140, false], [140, true]]) {
    const lines = frame(columns, agentsOpen).split('\n');
    const brand = lines.findIndex(line => line.includes('BOUNCE'));
    const quota = lines.findIndex(line => line.includes('CLAUDE usage 9%'));
    const input = lines.findIndex(line => line.includes('my draft'));
    assert.equal(brand, 0);
    assert.ok(lines[brand].indexOf('BOUNCE') >= columns - 32);
    assert.ok(quota > brand && quota < input);
    assert.ok(lines[quota].indexOf('CLAUDE usage 9%') >= columns - 32);
    assert.match(lines.join('\n'), /CODEX usage 2%/);
    assert.match(lines.join('\n'), /Session session-/);
    assert.match(lines.join('\n'), /1 prompt queued/);
    assert.ok(lines.length <= 28);
    assert.ok(lines.every(line => stringWidth(line) <= columns));
    for (const sentinel of ['sonnet', '/project', 'orchestrator ·', 'CODEX usage 2%']) {
      assert.ok(lines.find(line => line.includes(sentinel)).indexOf(sentinel) >= columns - 32);
    }
    assert.ok(lines[input].indexOf('my draft') < columns - 32);
  }
});

test('resizing across sidebar breakpoint preserves selected pane and input', {timeout: 2000}, async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  stdout.columns = 100;
  stdout.rows = 24;
  let completeFrame;
  stdout.on('data', () => {});
  const terminal = createInkTerminal({stdin, stdout, onFrame: event => completeFrame?.(event)});
  try {
    await terminal.mount({agentsOpen: true, selectedId: 'worker:abc', input: 'retained draft', metadata,
      events: [{kind: 'task.submitted', task: 'abc', profile: 'build', id: 'submitted'}]});
    for (const columns of [99, 100]) {
      const expectedRevision = terminal.debugState().revision + 1;
      const rendered = new Promise(resolve => {
        completeFrame = event => {
          if (event.revision >= expectedRevision) resolve();
        };
      });
      stdout.columns = columns;
      stdout.emit('resize');
      await rendered;
      const snapshot = terminal.snapshot();
      const text = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
        model: snapshot, transcriptRows: [], view: snapshot.view,
      }), {columns}));
      assert.equal(text.includes('BOUNCE'), columns === 100);
      assert.match(text, /retained draft/);
      assert.equal(terminal.snapshot().view.selectedId, 'worker:abc');
      assert.equal(terminal.snapshot().view.agentsOpen, true);
    }
  } finally {
    terminal.unmount();
  }
});

test('narrow layout retains compact status and the draft without a squeezed sidebar', () => {
  const output = frame(58, true);
  assert.match(output, /bounce · claude · plan/);
  assert.match(output, /my draft/);
  assert.doesNotMatch(output, /BOUNCE/);
  assert.ok(output.split('\n').every(line => stringWidth(line) <= 58));
});
