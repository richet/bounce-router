// A check-only task has no worker: bounce runs its check while the task is still queued. Status and the agents panel
// say the check is running and for how long, not `queued`. Found live: a 12-minute gate shown as queued.
import test from 'node:test';
import assert from 'node:assert/strict';
import {orchestratorStatus, formatStatus} from '../src/control-status.js';
import {taskList} from '../src/task-view.js';
import {createWorkspaceProjection} from '../src/tui/projection.js';

const t0 = Date.parse('2026-11-12T02:03:53Z');
const at = minutes => new Date(t0 + minutes * 60_000).toISOString();
const rows = [
  {kind: 'task.submitted', task: 'gate1234-0000', profile: 'analyst', from: 'orchestrator', at: 'batch', commit: 'f5af910', check: 'sh gate.sh', requires: ['read', 'exec'], time: at(0)},
  {kind: 'task.workspace', task: 'gate1234-0000', attempt: 1, purpose: 'publish', time: at(0)},
  {kind: 'task.milestone', task: 'gate1234-0000', attempt: 1, phase: 'check', text: 'Running the check on batch (f5af910): sh gate.sh', next: 'report the result', time: at(0)},
].map((row, i) => ({id: `r${i}`, seq: i + 1, ...row}));
const passed = [
  {id: 'r3', seq: 4, kind: 'task.check', task: 'gate1234-0000', attempt: 1, passed: true, exit: 0, time: at(13)},
  {id: 'r4', seq: 5, kind: 'task.accepted', task: 'gate1234-0000', by: 'check', checkOnly: true, time: at(13)},
];

test('while bounce runs a check-only task\'s check, status says check running with its minutes', () => {
  const now = t0 + 12 * 60_000;
  assert.deepEqual(taskList(rows, {now}).map(({state, elapsed}) => ({state, elapsed})), [{state: 'checking', elapsed: '12 min'}]);
  assert.match(formatStatus(orchestratorStatus(rows, {now})), /^ {2}gate1234 · analyst · check running · 12 min · Running the check on batch/m);
  assert.deepEqual(taskList(rows.slice(0, 2), {now}).map(row => row.state), ['queued'], 'before the check starts it is queued');
  assert.deepEqual(taskList([...rows, ...passed], {now, all: true}).map(row => row.state), ['accepted']);
});

test('the agents panel shows a running check as work, not queued', () => {
  const projection = createWorkspaceProjection();
  for (const row of rows) projection.ingest(row);
  const pane = projection.snapshot().panes.find(p => p.task === 'gate1234-0000');
  assert.equal(pane.state, 'checking');
  assert.equal(pane.phase, 'check');
});
