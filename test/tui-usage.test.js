// The short usage box beside the prompt: each subscription's windows as "N% used", where the full sidebar is not
// drawn — classic inline, which has no sidebar, and the orchestrator's full screen when it is too narrow for one.
// 2026-10-26: inline lost the sidebar and with it what the plans have left.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as Ink from 'ink';
import stripAnsi from 'strip-ansi';
import {quotaStrip} from '../src/quota.js';
import {createWorkspace} from '../src/tui/Workspace.js';

const now = Date.parse('2026-10-26T12:00:00Z');
const store = {
  claude: {provider: 'claude', time: '2026-10-26T11:59:00Z', windows: [{label: '5h', percent: 34, resetsAt: now + 3600000}, {label: '7d', percent: 12, resetsAt: now + 3 * 86400000}]},
  codex: {provider: 'codex', time: '2026-10-26T11:00:00Z', windows: [{label: '5h', percent: 100, resetsAt: now - 1}, {label: '7d', percent: 81, resetsAt: now + 86400000}]},
  muse: {provider: 'muse', windows: [], error: 'muse does not report quota'},
};

test('the usage box gives each subscription one line of percentages under a legend', () => {
  assert.deepEqual(quotaStrip(store, ['claude', 'codex', 'muse'], {now}), [
    'USAGE · of your whole plan',
    'claude  5h 34% · 7d 12%',
    'codex   5h reset · 7d 81%',
    'muse    no reading',
  ]);
  assert.deepEqual(quotaStrip(store, ['claude'], {now, cooldowns: {claude: now + 1000}}), ['USAGE · of your whole plan', 'claude  5h 34% · 7d 12% · cooldown']);
  assert.deepEqual(quotaStrip({}, [], {now}), []);
});

test('a window at 80% or more is painted as a warning, and a spent one as an error', () => {
  const paint = {warn: s => `<w>${s}</w>`, high: s => `<h>${s}</h>`};
  const lines = quotaStrip({codex: {windows: [{label: '5h', percent: 100, resetsAt: now + 1}, {label: '7d', percent: 81, resetsAt: now + 1}, {label: '1d', percent: 10, resetsAt: now + 1}]}}, ['codex'], {now, paint});
  assert.equal(lines[1], 'codex  <h>5h 100%</h> · <w>7d 81%</w> · 1d 10%');
});

const Workspace = createWorkspace(React, Ink);
const model = {panes: [], transcript: []};
const usageLines = ['USAGE · of your whole plan', 'claude  5h 34% · 7d 12%', 'codex   5h 8% · 7d 40%'];
const rowsOf = (element, columns) => stripAnsi(Ink.renderToString(element, {columns})).split('\n');
const view = (columns, extra = {}) => ({columns, rows: 24, input: 'my draft', notice: '', sidebar: true, metadata: {provider: 'claude', mode: 'yolo', usageLines, quotaLines: ['QUOTA FULL']}, ...extra});

test('classic inline draws the usage box beside the prompt, not beside the history', () => {
  const rows = rowsOf(React.createElement(Workspace, {model, view: view(100), inline: {staticKey: 0, staticItems: [{id: 'a1', lines: ['an earlier answer']}], liveRows: []}}), 100);
  const prompt = rows.findIndex(row => row.includes('Message'));
  assert.notEqual(prompt, -1);
  assert.match(rows[prompt], /│ USAGE · of your whole plan/, rows.join('\n'));
  assert.match(rows[prompt + 1], /❯ my draft.*claude  5h 34% · 7d 12%/);
  assert.match(rows[prompt + 2], /codex   5h 8% · 7d 40%/);
  assert.equal(rows.find(row => row.includes('an earlier answer')).includes('USAGE'), false);
  assert.equal(rows.some(row => row.includes('QUOTA FULL')), false, 'not the full sidebar');
});

test('the usage box goes with /sidebar off, and on a terminal too narrow to hold it beside the prompt', () => {
  const inline = {staticKey: 0, staticItems: [], liveRows: []};
  assert.equal(rowsOf(React.createElement(Workspace, {model, view: view(100, {sidebar: false}), inline}), 100).some(row => row.includes('USAGE')), false);
  assert.equal(rowsOf(React.createElement(Workspace, {model, view: view(70), inline}), 70).some(row => row.includes('USAGE')), false);
});

test('the orchestrator draws the usage box only where its full sidebar does not fit', () => {
  const narrow = rowsOf(React.createElement(Workspace, {model, transcriptRows: ['conversation'], view: view(90)}), 90);
  assert.match(narrow.find(row => row.includes('Message')), /USAGE/);
  const wide = rowsOf(React.createElement(Workspace, {model, transcriptRows: ['conversation'], view: view(120)}), 120);
  assert.equal(wide.some(row => row.includes('USAGE')), false);
  assert.equal(wide.some(row => row.includes('QUOTA FULL')), true);
});
