// Phase 4 (docs/plans/in-place-tasks.md §8): the task view, its text skin, the TUI pane and the
// standing orders all name an in-place task as "in place", the user message that authorized it
// (first 80 chars), and Jev's verdict when there was one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {taskView} from '../src/task-view.js';
import {formatTaskView} from '../src/task-report.js';
import {createWorkspaceProjection} from '../src/tui/projection.js';

const at = (s, rest) => ({time: `2026-09-25T18:${String(s).padStart(2, '0')}:00.000Z`, ...rest});
const longMessage = `commit it and push it right now please, and also open a pull request describing exactly what changed in this branch so the reviewers on the team can look it over`;

test('taskView names an in-place task, the cited message (cut to 80 chars) and a confident Jev verdict', () => {
  const log = [
    at(0, {kind: 'user', seq: 1, text: longMessage}),
    at(1, {kind: 'task.submitted', seq: 2, task: 'ip', parent: null, profile: 'I', orders: 'git commit && git push', deadline: null, inPlace: {authorizedBy: 1}}),
    at(2, {kind: 'jev.decided', seq: 3, task: 'ip', decision: 'in_place', verdict: 'authorized', confidence: 0.91, probabilities: {authorized: 0.91}}),
    at(3, {kind: 'task.started', seq: 4, task: 'ip', attempt: 1}),
    at(4, {kind: 'task.completed', seq: 5, task: 'ip', summary: 'committed and pushed'}),
  ];
  const view = taskView(log, 'ip', {now: Date.parse('2026-09-25T18:10:00.000Z')});
  assert.deepEqual(view.inPlace, {authorizedBy: 1, message: `${longMessage.slice(0, 79)}…`, jev: {verdict: 'authorized', confidence: 0.91}});
  const text = formatTaskView(view);
  assert.match(text, /· in place/);
  assert.match(text, /in place: authorized by "commit it and push it right now please/);
  assert.match(text, /jev authorized/);
});

test('taskView carries a jev.skipped verdict too, and a task with no inPlace carries none', () => {
  const log = [
    at(0, {kind: 'user', seq: 1, text: 'commit it'}),
    at(1, {kind: 'task.submitted', seq: 2, task: 'ip', parent: null, profile: 'I', orders: 'git commit', deadline: null, inPlace: {authorizedBy: 1}}),
    at(2, {kind: 'jev.skipped', seq: 3, task: 'ip', reason: 'jev disabled'}),
    at(3, {kind: 'task.started', seq: 4, task: 'ip', attempt: 1}),
    at(4, {kind: 'task.completed', seq: 5, task: 'ip', summary: 'done'}),
  ];
  const view = taskView(log, 'ip', {now: Date.parse('2026-09-25T18:10:00.000Z')});
  assert.deepEqual(view.inPlace, {authorizedBy: 1, message: 'commit it', jev: {verdict: 'skipped', reason: 'jev disabled'}});

  const ordinary = [
    at(0, {kind: 'task.submitted', seq: 1, task: 'copy', parent: null, profile: 'A', orders: 'do x', deadline: null}),
    at(1, {kind: 'task.started', seq: 2, task: 'copy', attempt: 1}),
  ];
  assert.equal(taskView(ordinary, 'copy', {now: Date.now()}).inPlace, null);
});

test('the workspace projection marks an in-place task\'s pane', () => {
  const projection = createWorkspaceProjection();
  projection.ingest({kind: 'task.submitted', id: 'e1', seq: 1, task: 'ip', profile: 'I', inPlace: {authorizedBy: 1}});
  projection.ingest({kind: 'task.submitted', id: 'e2', seq: 2, task: 'copy', profile: 'A'});
  const panes = Object.fromEntries(projection.snapshot().panes.map(p => [p.task, p]));
  assert.equal(panes.ip.inPlace, true);
  assert.equal(panes.copy.inPlace, undefined);
});
