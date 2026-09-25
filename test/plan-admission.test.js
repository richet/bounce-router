import test from 'node:test';
import assert from 'node:assert/strict';
import {admittedPlanDispatches, planTaskAdmission} from '../src/plan-admission.js';

const at = (seq, row) => ({id: `e${seq}`, time: new Date(seq * 1000).toISOString(), seq, ...row});
const acceptedPlan = () => [
  at(1, {kind: 'plan.submitted', plan: 'p1', chunks: [
    {id: 'prepare', profile: 'builder', orders: 'prepare', owns: ['src/base.js'], depends_on: [], deadline: 1000},
    {id: 'build', profile: 'builder', orders: 'build', owns: ['src/app.js'], depends_on: ['prepare'], deadline: 2000},
  ]}),
  at(2, {kind: 'plan.accepted', plan: 'p1', planId: 'p1', chunks: 2}),
];
const prepareTask = at(3, {kind: 'task.submitted', task: 'prepare-task', jobId: 'plan:p1:prepare', planId: 'p1', chunkId: 'prepare',
  profile: 'builder', orders: 'prepare', owns: ['src/base.js'], depends_on: [], deadline: 1000});
const buildSpec = {task: 'build-task', jobId: 'plan:p1:build', planId: 'p1', chunkId: 'build',
  profile: 'builder', orders: 'build', owns: ['src/app.js'], depends_on: ['prepare-task'], deadline: 2000};

test('ad-hoc tasks remain outside plan admission', () => {
  const spec = {task: 'one-off', profile: 'builder', orders: 'inspect'};
  assert.deepEqual(planTaskAdmission([], spec), {ok: true, spec, planned: false});
});

test('planned tasks require paired correlation, an accepted plan, and a real unique chunk', () => {
  assert.equal(planTaskAdmission([], {...buildSpec, chunkId: undefined}).reason, 'plan correlation requires planId and chunkId');
  assert.equal(planTaskAdmission(acceptedPlan().slice(0, 1), buildSpec).reason, 'plan is not accepted');
  assert.equal(planTaskAdmission([
    ...acceptedPlan().slice(0, 1),
    at(2, {kind: 'plan.rejected', plan: 'p1'}),
  ], buildSpec).reason, 'plan is not accepted');
  assert.equal(planTaskAdmission(acceptedPlan(), {...buildSpec, chunkId: 'missing'}).reason, 'unknown plan chunk');
  const duplicate = acceptedPlan();
  duplicate[0] = {...duplicate[0], chunks: [...duplicate[0].chunks, {...duplicate[0].chunks[1]}]};
  duplicate[1] = {...duplicate[1], chunks: 3};
  assert.equal(planTaskAdmission(duplicate, buildSpec).reason, 'plan chunk id is not unique');
});

test('initial dispatch exactly matches the accepted chunk and resolves same-plan dependencies', () => {
  const events = [...acceptedPlan(), prepareTask];
  assert.equal(planTaskAdmission(events, buildSpec).ok, true);
  for (const [field, value] of [
    ['profile', 'reviewer'],
    ['orders', 'different work'],
    ['owns', ['**']],
    ['deadline', 3000],
  ]) {
    assert.equal(planTaskAdmission(events, {...buildSpec, [field]: value}).reason, `plan chunk ${field} mismatch`);
  }
  assert.equal(planTaskAdmission(events, {...buildSpec, depends_on: []}).reason, 'plan chunk dependencies mismatch');
  const foreign = at(4, {...prepareTask, task: 'foreign', jobId: 'plan:p2:prepare', planId: 'p2'});
  assert.equal(planTaskAdmission([...events, foreign], {...buildSpec, depends_on: ['foreign']}).reason, 'plan chunk dependencies mismatch');
});

test('a chunk dispatch is unique, while retries and dependency replacements retain the stable job', () => {
  const events = [...acceptedPlan(), prepareTask, at(4, {...buildSpec, kind: 'task.submitted'})];
  assert.equal(planTaskAdmission(events, {...buildSpec, task: 'duplicate'}).reason, 'plan chunk already dispatched');

  const retry = {...buildSpec, task: 'build-retry', retryOf: 'build-task', replaces: 'build-task',
    profile: 'fallback', orders: 'recover build without repeating side effects'};
  assert.equal(planTaskAdmission(events, retry).ok, true);
  assert.equal(planTaskAdmission(events, {...retry, jobId: 'new-job'}).reason, 'plan retry job mismatch');
  assert.equal(planTaskAdmission(events, {...retry, owns: ['**']}).reason, 'plan retry owns mismatch');

  const forgedRoot = {...prepareTask, task: 'forged-root', jobId: 'wrong-job'};
  const forgedRetry = {...forgedRoot, seq: 4, task: 'forged-retry', retryOf: 'forged-root', replaces: 'forged-root'};
  assert.equal(planTaskAdmission([...acceptedPlan(), forgedRoot], forgedRetry).reason, 'plan retry predecessor is not admitted');

  const replacement = {...prepareTask, seq: 5, task: 'prepare-retry', retryOf: 'prepare-task', replaces: 'prepare-task',
    profile: 'fallback', orders: 'recover prepare'};
  assert.equal(planTaskAdmission([...acceptedPlan(), prepareTask, replacement], {...buildSpec, depends_on: ['prepare-retry']}).ok, true);
  const future = {...prepareTask, seq: 9, task: 'future'};
  assert.equal(planTaskAdmission([...acceptedPlan(), future], {...buildSpec, seq: 8, depends_on: ['future']}).reason,
    'plan chunk dependencies mismatch');
});

test('plan satisfaction sees only canonically admitted initial chunks and their retries', () => {
  const events = [
    ...acceptedPlan(),
    prepareTask,
    at(4, {...buildSpec, kind: 'task.submitted'}),
    at(5, {kind: 'task.submitted', task: 'forged', jobId: 'plan:p1:forged', planId: 'p1', chunkId: 'forged',
      profile: 'builder', orders: 'anything', owns: ['**'], depends_on: []}),
    at(6, {...buildSpec, kind: 'task.submitted', task: 'build-retry', retryOf: 'build-task', replaces: 'build-task'}),
  ];
  assert.deepEqual(admittedPlanDispatches(events, 'p1').map(row => row.task), ['prepare-task', 'build-task', 'build-retry']);
});
