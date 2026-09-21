import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as Ink from 'ink';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {config} from '../src/core.js';
import {createWorkspace, workspaceColumns} from '../src/tui/Workspace.js';
import {createInkTerminal} from '../src/tui/ink-terminal.js';

const Workspace = createWorkspace(React, Ink);
const model = {panes: [{id: 'worker:abc', task: 'abc', profile: 'build', state: 'running', activity: ['worker output']}], transcript: []};
const metadata = {provider: 'claude', model: 'sonnet', mode: 'plan', operation: 'orchestrator', sessionId: 'session-123', cwd: '/project', pendingTurns: 1, quotaLines: ['CLAUDE usage 9%', 'CODEX usage 2%']};

function frame(columns, agentsOpen, view = {}) {
  return stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model, transcriptRows: ['conversation evidence'], view: {columns, rows: 28, agentsOpen, selectedId: 'orchestrator', input: 'my draft', notice: 'Working', metadata, ...view},
  }), {columns}));
}

test('the sidebar is on by default and /sidebar off gives its columns back to the conversation', () => {
  assert.deepEqual(workspaceColumns(120), {total: 120, sidebar: 32, content: 87});
  assert.deepEqual(workspaceColumns(120, {sidebar: false}), {total: 120, sidebar: 0, content: 120});
  assert.deepEqual(workspaceColumns(90, {sidebar: true}), {total: 90, sidebar: 0, content: 90});
  for (const agentsOpen of [false, true]) {
    const shown = frame(120, agentsOpen);
    const hidden = frame(120, agentsOpen, {sidebar: false});
    assert.match(shown, /BOUNCE/);
    assert.doesNotMatch(hidden, /BOUNCE|CLAUDE usage 9%/);
    // The compact header carries the provider and mode once the rail is gone.
    assert.match(hidden, /bounce · claude · plan/);
    assert.match(hidden, /my draft/);
    assert.ok(hidden.split('\n').every(line => stringWidth(line) <= 120));
  }
});

test('the sidebar separates its header, each quota group and the agents list with blank rows', () => {
  const quotaLines = ['CLAUDE', '5-hour limit 38%', '', 'CODEX · Plus', '5-hour limit 0%'];
  const rail = frame(120, false, {metadata: {...metadata, quotaLines}}).split('\n').map(line => line.replace(/^.*│ ?/, '').trim());
  const at = text => rail.findIndex(line => line.startsWith(text));
  assert.deepEqual([rail[at('Session') + 1], rail[at('CLAUDE') + 2], rail[at('CODEX') + 2]], ['', '', '']);
  assert.equal(rail[at('Session') + 2], 'CLAUDE');
  assert.equal(rail[at('CLAUDE') + 3], 'CODEX · Plus');
  assert.equal(rail[at('CODEX') + 3], 'AGENTS · 2');
});

test('config keeps the sidebar on unless told otherwise, and rejects a non-boolean', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-sidebar-config-'));
  try {
    assert.equal(config(root).sidebar, true);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({sidebar: false}));
    assert.equal(config(root).sidebar, false);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({sidebar: 'off'}));
    assert.throws(() => config(root), {message: 'config.sidebar must be true or false'});
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

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
      // in the rail's columns (the header names the model too, on the left)
      assert.ok(lines.some(line => line.lastIndexOf(sentinel) >= columns - 32), sentinel);
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

test('the provider · mode line carries the Jev state only while Jev does something', () => {
  const rail = view => frame(120, false, view).split('\n').map(line => line.replace(/^.*│ ?/, '').trim());
  assert.ok(rail({}).some(line => line === 'claude · plan'));
  assert.ok(rail({metadata: {...metadata, jev: 'jev+routing'}}).some(line => line === 'claude · plan · jev+routing'));
  assert.ok(rail({metadata: {...metadata, jev: ''}}).some(line => line === 'claude · plan'));
});
