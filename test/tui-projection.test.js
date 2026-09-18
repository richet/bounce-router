import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {createWorkspaceProjection} from '../src/tui/projection.js';

test('workspace projection replays once, applies events once, and keeps activity bounded', () => {
  const projection = createWorkspaceProjection({activityLimit: 2, transcriptLimit: 3});
  projection.replay([
    {kind: 'task.submitted', id: '1', seq: 1, time: 't1', task: 'build', profile: 'worker'},
    {kind: 'task.started', id: '2', seq: 2, time: 't2', task: 'build', attempt: 1, requested: 'gpt'},
    {kind: 'task.milestone', id: '3', seq: 3, time: 't3', task: 'build', phase: 'test', text: 'tests', next: 'review'},
  ]);
  projection.ingest({kind: 'task.activity', id: '4', seq: 4, time: 't4', task: 'build', text: 'one'});
  projection.ingest({kind: 'task.activity', id: '5', seq: 5, time: 't5', task: 'build', text: 'two'});
  projection.ingest({kind: 'task.activity', id: '6', seq: 6, time: 't6', task: 'build', text: 'three'});
  projection.ingest({kind: 'task.activity', id: '6', seq: 6, time: 't6', task: 'build', text: 'duplicate'});

  const snapshot = projection.snapshot();
  const visible = snapshot.panes.map(({id, kind, task, profile, state, model, phase, text, next, activity}) => ({id, kind, task, profile, state, model, phase, text, next, activity}));
  assert.deepEqual(visible, [{
    id: 'worker:build', kind: 'worker', task: 'build', profile: 'worker', state: 'running',
    model: 'gpt', phase: 'test', text: 'tests', next: 'review', activity: ['two', 'three'],
  }]);
  assert.equal(snapshot.transcript.length, 3);
});

test('terminal workers leave active panes without losing their final outcome', () => {
  const projection = createWorkspaceProjection();
  projection.replay([
    {kind: 'task.submitted', id: '1', seq: 1, task: 'build', profile: 'worker'},
    {kind: 'task.blocked', id: '2', seq: 2, task: 'build', text: 'need credentials', next: 'provide token'},
    {kind: 'task.completed', id: '3', seq: 3, task: 'build', summary: 'done'},
  ]);
  assert.deepEqual(projection.paneIds(), ['orchestrator']);
  assert.deepEqual(projection.snapshot().outcomes, [{task: 'build', state: 'completed', text: 'done'}]);
});

test('deadline events use the runtime kind and retained outcomes stay bounded', () => {
  const projection = createWorkspaceProjection({outcomeLimit: 2});
  for (let index = 0; index < 3; index++) {
    projection.ingest({kind: 'task.submitted', id: `submit-${index}`, seq: index * 2, task: `task-${index}`, profile: 'worker'});
    projection.ingest({kind: 'task.deadline', id: `deadline-${index}`, seq: index * 2 + 1, task: `task-${index}`, text: `deadline ${index}`});
  }

  assert.deepEqual(projection.paneIds(), ['orchestrator']);
  assert.deepEqual(projection.snapshot().outcomes, [
    {task: 'task-1', state: 'timed_out', text: 'deadline 1'},
    {task: 'task-2', state: 'timed_out', text: 'deadline 2'},
  ]);
});

test('id-only dedupe retains a bounded recent window', () => {
  const projection = createWorkspaceProjection({dedupeLimit: 2});
  assert.equal(projection.ingest({kind: 'note', id: 'old', text: 'old'}), true);
  assert.equal(projection.ingest({kind: 'note', id: 'middle', text: 'middle'}), true);
  assert.equal(projection.ingest({kind: 'note', id: 'recent', text: 'recent'}), true);
  assert.equal(projection.ingest({kind: 'note', id: 'recent', text: 'duplicate recent'}), false);
  assert.equal(projection.ingest({kind: 'note', id: 'old', text: 'old after eviction'}), true);
});

test('worker panes retain progress evidence, current operation, delivery, and meaningful freshness', () => {
  const projection = createWorkspaceProjection();
  projection.replay([
    {kind: 'task.submitted', id: '1', seq: 1, task: 'build', profile: 'worker'},
    {kind: 'task.started', id: '2', seq: 2, task: 'build', requested: 'gpt'},
    {kind: 'task.milestone', id: '3', seq: 3, time: '2026-09-14T00:00:00.000Z', task: 'build', phase: 'verify', text: 'tests running', next: 'review', evidence: ['test.log']},
    {kind: 'task.activity', id: '4', seq: 4, time: '2026-09-14T00:00:01.000Z', task: 'build', text: 'node --test'},
    {kind: 'task.delivered', id: '5', seq: 5, task: 'build', tier: 'live'},
  ]);

  assert.deepEqual(projection.snapshot().panes[0], {
    id: 'worker:build',
    kind: 'worker',
    task: 'build',
    role: 'worker',
    profile: 'worker',
    state: 'running',
    activity: ['node --test'],
    model: 'gpt',
    phase: 'verify',
    text: 'tests running',
    next: 'review',
    evidence: ['test.log'],
    updatedAt: '2026-09-14T00:00:00.000Z',
    operation: 'node --test',
    activityAt: '2026-09-14T00:00:01.000Z',
    delivery: 'live',
    freshness: {
      meaningfulAt: '2026-09-14T00:00:00.000Z',
      activityAt: '2026-09-14T00:00:01.000Z',
    },
  });
});

test('verified replacement keeps the logical pane identity and exposes recovery state', () => {
  const projection = createWorkspaceProjection();
  projection.replay([
    {kind: 'task.submitted', id: '1', seq: 1, task: 'original', profile: 'primary'},
    {kind: 'task.failed', id: '2', seq: 2, task: 'original', reason: 'limited'},
    {kind: 'policy.fallback', id: '3', seq: 3, task: 'original', from_profile: 'primary', to_profile: 'backup'},
    {kind: 'task.submitted', id: '4', seq: 4, task: 'replacement', replaces: 'original', profile: 'backup'},
  ]);

  assert.deepEqual(projection.paneIds(), ['orchestrator', 'worker:original']);
  assert.equal(projection.snapshot().panes[0].task, 'replacement');
  assert.equal(projection.snapshot().panes[0].recovery, 'replacement for original');
});

test('sustained-output projection stays below the 100ms local input-frame budget', () => {
  const projection = createWorkspaceProjection({activityLimit: 400, transcriptLimit: 2000});
  for (let index = 0; index < 4; index++) projection.ingest({kind: 'task.submitted', id: `task-${index}`, seq: index, task: `w${index}`, profile: 'build'});
  const samples = [];
  for (let index = 0; index < 10000; index++) {
    const started = performance.now();
    projection.ingest({kind: 'task.activity', id: `activity-${index}`, seq: index + 10, task: `w${index % 4}`, text: `output ${index}`});
    projection.snapshot();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95 <= 100, `projection p95 ${p95.toFixed(3)}ms exceeds 100ms`);
});

test('a task submitted as profile auto shows the profile the jev.routed row chose', () => {
  const projection = createWorkspaceProjection();
  projection.replay([
    {kind: 'task.submitted', id: '1', seq: 1, task: 'build', profile: 'auto'},
    {kind: 'jev.routed', id: '2', seq: 2, task: 'build', chosen: 'build_claude', fallback: false, confidence: 0.9, text: 'Routed auto → build_claude'},
    {kind: 'task.started', id: '3', seq: 3, task: 'build', attempt: 1},
  ]);
  const pane = projection.snapshot().panes[0];
  assert.equal(pane.profile, 'build_claude');
  assert.equal(pane.state, 'running');
});
