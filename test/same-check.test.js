// The same check on the same tree runs once at a time on the machine: the later one waits and names the run it waits
// on. A different command, or a different tree, does not wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {createMachineSlots} from '../src/machine-slots.js';
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

test('a second identical check waits for the running one and says which run it waits on', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-same-check-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', args, {cwd: project, stdio: 'ignore'});
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n'); git('add', '.'); git('commit', '-qm', 'a');
  const session = new Session(project, {root: path.join(root, 'home')});
  const running = [];
  const checkRunner = ({command}) => new Promise(resolve => running.push({command, end: () => resolve({command, exit: 0, passed: true, output: 'ok', ms: 1})}));
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(() => [])}, requireFinalReport: true, gitHead: () => null, checkRunner,
    machineSlots: createMachineSlots({dir: path.join(root, 'machine')}), gatePollMs: 10,
    profiles: {analyst: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const spec = {parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'main', check: 'make e2e'};
  const first = scheduler.submit(spec).task;
  await waitFor(() => running.length === 1);
  const second = scheduler.submit({...spec, orders: 'gate again'}).task;
  const other = scheduler.submit({...spec, orders: 'unit', check: 'make unit'}).task;
  const waiting = await waitFor(() => session.events.find(e => e.kind === 'task.milestone' && e.task === second && e.waitingOn));
  assert.equal(waiting.waitingOn, first);
  assert.match(waiting.text, new RegExp(`same check already running on this tree: task ${first.slice(0, 8)} runs \`make e2e\``));
  await waitFor(() => running.length === 2);
  assert.deepEqual(running.map(run => run.command), ['make e2e', 'make unit']);
  running[0].end();
  await waitFor(() => scheduler.tasks()[first]?.state === 'accepted');
  await waitFor(() => running.length === 3);
  assert.equal(running[2].command, 'make e2e');
  running[1].end(); running[2].end();
  await waitFor(() => scheduler.tasks()[second]?.state === 'accepted' && scheduler.tasks()[other]?.state === 'accepted');
});
