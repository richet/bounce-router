// "Is it still working?" — asked of a live session where nothing on screen moved. The status of
// the main worker and of every agent is a glyph that animates while it works, the model it runs on
// (a local model by its short identifier: the whole name never fits the rail), and how long ago it
// last did something.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as Ink from 'ink';
import stripAnsi from 'strip-ansi';
import {SPINNER, glyph, shortModel, quietFor, agentRow, rowColor} from '../src/tui/status.js';
import {createWorkspace} from '../src/tui/Workspace.js';

test('a working state animates with the clock; every other state has one fixed glyph', () => {
  assert.equal(SPINNER.length, 10);
  assert.deepEqual([0, 120, 240, 1200].map(now => glyph('running', now)), [SPINNER[0], SPINNER[1], SPINNER[2], SPINNER[0]]);
  assert.equal(glyph('working', 360), SPINNER[3]);
  assert.deepEqual(['queued', 'ready', 'completed', 'accepted', 'failed', 'cancelled', 'timed_out', 'rejected', 'blocked', 'input_required', 'whatever'].map(state => glyph(state, 999)),
    ['◌', '●', '✓', '✓', '✗', '✗', '✗', '✗', '!', '?', '●']);
});

test('a model is named by its identifier: no provider path, no packaging suffixes; a cloud model keeps its short name', () => {
  assert.equal(shortModel('lmstudio/qwen3-coder-30b-a3b-instruct-mlx@4bit'), 'qwen3-coder-30b-a3b');
  assert.equal(shortModel('qwen3-coder-next-mlx'), 'qwen3-coder-next');
  assert.equal(shortModel('qwen3.8-27b-mlx@4bit'), 'qwen3.8-27b');
  assert.equal(shortModel('Qwen3.8-27B-MLX-8bit-GGUF'), 'Qwen3.8-27B');
  assert.equal(shortModel('claude/sonnet'), 'sonnet');
  assert.equal(shortModel('claude-fable-5-1[1m]'), 'claude-fable-5-1');
  assert.equal(shortModel('gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(shortModel(''), '');
  assert.equal(shortModel(undefined), '');
});

test('how long since it last did something: seconds, then minutes, then hours; nothing when unknown', () => {
  const at = '2026-09-21T05:00:00.000Z', now = Date.parse(at);
  assert.deepEqual([500, 12_000, 125_000, 7_300_000].map(ms => quietFor(at, now + ms)), ['now', '12s', '2m', '2h']);
  assert.equal(quietFor(null, now), '');
  assert.equal(quietFor('not a date', now), '');
});

test('one rail row per agent fits the rail: the job, its model, and the quiet time, with the model giving way first', () => {
  const now = Date.parse('2026-09-21T05:00:12.000Z');
  const pane = {profile: 'builder@lmstudio/qwen3-coder-next-mlx', state: 'running', model: 'qwen3-coder-next-mlx', activityAt: '2026-09-21T05:00:00.000Z'};
  assert.equal(agentRow(pane, now, 30), `${SPINNER[glyphIndex(now)]} builder qwen3-coder-next 12s`);
  const long = {...pane, profile: 'integrator@lmstudio/qwen3-coder-30b-a3b-instruct-mlx@4bit', model: 'qwen3-coder-30b-a3b-instruct-mlx@4bit'};
  const row = agentRow(long, now, 30);
  assert.equal(row, `${SPINNER[glyphIndex(now)]} integrator qwen3-coder-… 12s`);
  assert.equal([...row].length <= 30, true);
  assert.equal(agentRow({profile: 'reviewer', state: 'accepted', model: ''}, now, 30), '✓ reviewer accepted');
  assert.equal(agentRow({profile: 'build', state: 'failed', model: 'gpt-5.6-terra'}, now, 30), '✗ build gpt-5.6-terra failed');
  assert.equal(agentRow({profile: 'analyst', state: 'queued', model: ''}, now, 30), '◌ analyst queued');
  // a finished row that is too long keeps the model and drops the word: the glyph already says it
  assert.equal(agentRow({profile: 'reviewer@lmstudio/qwen3.8-27b-mlx@4bit', state: 'accepted', model: 'qwen3.8-27b-mlx@4bit'}, now, 30), '✓ reviewer qwen3.8-27b');
  // working but silent for two minutes or more is the stall signal
  assert.deepEqual([119_000, 120_000].map(ms => rowColor({...pane, activityAt: new Date(now - ms).toISOString()}, now)), ['yellow', 'red']);
  assert.deepEqual([rowColor({profile: 'x', state: 'accepted'}, now), rowColor({profile: 'x', state: 'failed'}, now), rowColor({profile: 'x', state: 'queued'}, now)], ['green', 'red', 'gray']);
});
const glyphIndex = now => Math.floor(now / 120) % 10;

const Workspace = createWorkspace(React, Ink);
const frame = view => stripAnsi(Ink.renderToString(React.createElement(Workspace, {
  model: {panes: [{id: 'worker:abc', task: 'abcdef123456', profile: 'builder@lmstudio/qwen3-coder-next-mlx', state: 'running', model: 'qwen3-coder-next-mlx', activityAt: '2026-09-21T05:00:00.000Z', activity: ['x']}], transcript: []},
  transcriptRows: ['hello'], view: {columns: 120, rows: 28, selectedId: 'orchestrator', input: '', notice: '', now: Date.parse('2026-09-21T05:00:12.000Z'),
    metadata: {provider: 'claude', model: 'claude-fable-5-1[1m]', mode: 'yolo', operation: 'orchestrator', orchestrator: 'main', sessionId: 's', cwd: '/p', quotaLines: []}, ...view},
}), {columns: 120}));

test('rendered: the header and the rail say the main worker is working, on what, and for how long; at rest they say ready', () => {
  const now = Date.parse('2026-09-21T05:00:12.000Z'), spin = SPINNER[glyphIndex(now)];
  const busy = frame({busy: true, main: {state: 'running', startedAt: '2026-09-21T04:58:00.000Z'}});
  assert.equal(busy.split('\n')[0].startsWith(`${spin} main · claude-fable-5-1 · working 2m`), true, busy.split('\n')[0]);
  assert.equal(busy.includes(`${spin} main claude-fable-5-1 2m`), true, 'the rail row of the main worker');
  assert.equal(busy.includes(`${spin} builder qwen3-coder-next 12s`), true, 'the rail row of the agent');
  const idle = frame({busy: false, main: {state: 'ready'}});
  assert.equal(idle.split('\n')[0].startsWith('● main · claude-fable-5-1 · ready'), true, idle.split('\n')[0]);
  assert.equal(idle.includes(spin + ' main'), false);
  // the agent pane's title carries the same glyph and the short model, not the whole name
  const open = frame({agentsOpen: true, busy: false, main: {state: 'ready'}});
  assert.equal(open.includes(`${spin} builder · abcdef12 · qwen3-coder-next`), true);
  assert.equal(open.includes('instruct-mlx'), false);
});
