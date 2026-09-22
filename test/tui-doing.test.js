// "What is he doing?" — asked of a main worker that showed only a spinner for seven minutes. It was
// inside `bounce wait` on a task that was on its second attempt. Every worker, the main one included,
// now says what it is doing right now, derived from what is already journaled: thinking, running a
// command (and which), waiting on a task (and that task's own state), or idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import * as Ink from 'ink';
import stripAnsi from 'strip-ansi';
import {doingNow, doingLine} from '../src/tui/status.js';
import {createWorkspace} from '../src/tui/Workspace.js';

let seq = 0;
const at = s => `2026-09-22T05:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.000Z`;
const ev = (s, kind, extra = {}) => ({id: `e${++seq}`, time: at(s), kind, ...extra});
const T = '79981b05-1e51-4da9-bd96-dd0dff5ad464';
const call = (s, name, input, extra = {}) => ev(s, 'tool', {from: 'main', provider: 'claude', text: `${name}: ${JSON.stringify(input)}`, ...extra});
const now = Date.parse(at(60 * 45 + 0)); // 05:45:00

test('the main worker: thinking, then running a command with its description and elapsed time, then waiting on a task it dispatched — with that task\'s state', () => {
  const tasks = {[T]: {profile: 'integrator', state: 'running', attempt: 2, model: 'qwen3.6-35b-a3b-mlx'}};
  const started = [ev(60 * 38 + 0, 'main.started', {from: 'main', state: 'running'})];
  assert.deepEqual(doingNow([...started, ev(60 * 38 + 5, 'progress', {from: 'main', text: 'Thinking · ~50 tokens'})], {tasks, now}), {what: 'thinking', since: at(60 * 38 + 0)}, 'thinking since the turn began, not since the last token count');
  const running = [...started, call(60 * 38 + 18, 'Bash', {command: 'deno test', description: 'Run the focused suite'})];
  assert.deepEqual(doingNow(running, {tasks, now}), {what: 'command', text: 'Bash: Run the focused suite', since: at(60 * 38 + 18)});
  const waiting = [...started, call(60 * 38 + 18, 'Bash', {command: `bounce wait --match '{"kind":"task.completed","task":"${T}"}' --timeout 600`, description: 'Wait for clone-fix gate task'})];
  assert.deepEqual(doingNow(waiting, {tasks, now}), {what: 'waiting', task: T, text: 'waiting on 79981b05 · integrator running (attempt 2, qwen3.6-35b-a3b)', since: at(60 * 38 + 18)});
  // the tool result ends the command: back to thinking until the next call or answer
  const done = [...running, ev(60 * 38 + 40, 'tool', {from: 'main', provider: 'claude', text: 'ok | 21 passed'})];
  assert.equal(doingNow(done, {tasks, now}).what, 'thinking');
  // an answer ends the turn
  assert.deepEqual(doingNow([...done, ev(60 * 39, 'assistant', {from: 'main', text: 'Done.'}), ev(60 * 39, 'main.terminal', {from: 'main', state: 'idle'})], {tasks, now}), {what: 'idle', since: at(60 * 39)});
  // a worker's own rows: the same reading from its activity texts
  const worker = [ev(60 * 42, 'task.started', {task: T}), ev(60 * 42 + 20, 'task.activity', {task: T, text: 'bash running'}), ev(60 * 42 + 30, 'task.activity', {task: T, text: 'bash completed'}), ev(60 * 42 + 31, 'task.activity', {task: T, text: 'read running'})];
  assert.deepEqual(doingNow(worker, {tasks, now, task: T}), {what: 'command', text: 'read', since: at(60 * 42 + 31)});
});

test('one line for the rail and the header: what, the specifics, and for how long', () => {
  assert.equal(doingLine({what: 'waiting', task: T, text: 'waiting on 79981b05 · integrator running (attempt 2, qwen3.6-35b-a3b)', since: at(60 * 38 + 18)}, now, 30), '⏳ waiting on 79981b05 · 6m');
  assert.equal(doingLine({what: 'waiting', task: T, text: 'waiting on 79981b05 · integrator running (attempt 2, qwen3.6-35b-a3b)', since: at(60 * 38 + 18)}, now, 90), '⏳ waiting on 79981b05 · integrator running (attempt 2, qwen3.6-35b-a3b) · 6m');
  assert.equal(doingLine({what: 'command', text: 'Bash: Run the focused suite', since: at(60 * 44 + 50)}, now, 40), '⚙ Bash: Run the focused suite · 10s');
  assert.equal(doingLine({what: 'thinking', since: at(60 * 44 + 58)}, now, 40), '… thinking · 2s');
  assert.equal(doingLine({what: 'idle', since: at(60 * 44)}, now, 40), '');
  assert.equal([...doingLine({what: 'command', text: 'Bash: ' + 'x'.repeat(80), since: at(60 * 44 + 50)}, now, 30)].length <= 30, true);
});

const Workspace = createWorkspace(React, Ink);
test('rendered: the header and the main worker\'s rail row say what it is doing, and a worker pane says the same for its worker', () => {
  const tasks = {[T]: {profile: 'integrator', state: 'running', attempt: 2, model: 'qwen3.6-35b-a3b-mlx'}};
  const events = [ev(60 * 38, 'main.started', {from: 'main', state: 'running'}), call(60 * 38 + 18, 'Bash', {command: `bounce wait --match '{"task":"${T}"}'`, description: 'Wait for clone-fix gate task'})];
  const doing = doingNow(events, {tasks, now});
  const out = stripAnsi(Ink.renderToString(React.createElement(Workspace, {
    model: {panes: [{id: `worker:${T}`, task: T, profile: 'integrator', state: 'running', model: 'qwen3.6-35b-a3b-mlx', activityAt: at(60 * 44 + 50), doing: {what: 'command', text: 'bash: deno test', since: at(60 * 44 + 50)}, activity: ['x']}], transcript: []},
    transcriptRows: ['…'], view: {columns: 120, rows: 24, busy: true, now, selectedId: 'orchestrator', input: '', notice: '', main: {state: 'running', startedAt: at(60 * 38), doing},
      metadata: {provider: 'claude', model: 'claude-fable-5-1', mode: 'yolo', operation: 'orchestrator', orchestrator: 'main', sessionId: 's', cwd: '/p', quotaLines: []}},
  }), {columns: 120}));
  assert.match(out.split('\n')[0], /main · claude-fable-5-1 · working 7m · ⏳ waiting on 79981b05/);
  assert.equal(out.includes('⏳ waiting on 79981b05 · 6m'), true, 'the rail row under main');
  assert.equal(out.includes('⚙ bash: deno test · 10s'), true, 'the rail row under the worker');
});
