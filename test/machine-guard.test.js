// The machine guard: no task starts while the disk is nearly full or the load is too high. Dispatch waits, says why
// where bounce-control status shows it, and resumes on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {orchestratorStatus, formatStatus} from '../src/control-status.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (fn, timeout = 4000) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const final = JSON.stringify({op: 'final', phase: 'x', text: 'done', next: 'none', evidence: [], outcome: 'completed', summary: 'done', remaining: ''});

const setup = (t, machine) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-machine-')));
  const session = new Session(root, {root: path.join(root, 'home')});
  const worker = fakeAdapter(() => [{kind: 'result', status: 'completed', text: final}]);
  const scheduler = createScheduler({session, adapters: {worker}, requireFinalReport: true, gitHead: () => null,
    machineGuard: {minFreeDiskGB: 30, maxLoadPerCore: 2}, machineState: () => ({...machine}), machinePollMs: 10,
    profiles: {analyst: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {session, scheduler, worker};
};

test('a nearly full disk pauses dispatch with the reason in status, and it resumes on its own', async t => {
  const machine = {freeDiskGB: 22.4, freeDiskPercent: 1, load: 1, cores: 8};
  const {session, scheduler, worker} = setup(t, machine);
  const {task} = scheduler.submit({parent: null, profile: 'analyst', orders: 'read it', deadline: null});
  const paused = await waitFor(() => session.events.find(e => e.kind === 'machine.paused'));
  assert.match(paused.text, /^Dispatch paused: disk 22 GB free \(limit 30 GB\)\. Work starts again on its own/);
  await waitFor(() => session.events.some(e => e.kind === 'task.milestone' && e.task === task && e.phase === 'machine'));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(worker.calls.launch, 0);
  assert.match(formatStatus(orchestratorStatus(session.events)), /Dispatch paused: disk 22 GB free \(limit 30 GB\)/);
  machine.freeDiskGB = 229;
  await waitFor(() => ['completed', 'accepted'].includes(scheduler.tasks()[task]?.state));
  assert.equal(worker.calls.launch, 1);
  assert.match(session.events.findLast(e => e.kind === 'machine.resumed').text, /^Dispatch resumed/);
  assert.doesNotMatch(formatStatus(orchestratorStatus(session.events)), /Dispatch paused/);
});

test('a load above the limit per core pauses dispatch; under it, work starts at once', async t => {
  const machine = {freeDiskGB: 229, freeDiskPercent: 12, load: 20, cores: 8};
  const {session, scheduler, worker} = setup(t, machine);
  scheduler.submit({parent: null, profile: 'analyst', orders: 'read it', deadline: null});
  const paused = await waitFor(() => session.events.find(e => e.kind === 'machine.paused'));
  assert.match(paused.text, /load 20\.0 on 8 cores \(limit 16\)/);
  assert.equal(worker.calls.launch, 0);
  machine.load = 3;
  await waitFor(() => worker.calls.launch === 1);
  const second = scheduler.submit({parent: null, profile: 'analyst', orders: 'read more', deadline: null}).task;
  await waitFor(() => worker.calls.launch === 2);
  assert.equal(session.events.some(e => e.task === second && e.phase === 'machine'), false);
});

test('the percent floor is an optional extra, off unless set', async t => {
  const machine = {freeDiskGB: 229, freeDiskPercent: 12, load: 1, cores: 8};
  const {session, scheduler, worker} = setup(t, machine);
  scheduler.submit({parent: null, profile: 'analyst', orders: 'read it', deadline: null});
  await waitFor(() => worker.calls.launch === 1);
  assert.equal(session.events.some(e => e.kind === 'machine.paused'), false);
});
