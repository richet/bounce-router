// What a worker writes outside its copy while its attempt runs is seen (src/outside-writes.js). Nirby control session,
// 2026-11-04: a builder linked a file into /opt/homebrew/bin. Workers run with the vendor's sandbox off, so bounce
// cannot block it; it watches the directories on PATH and names what appeared as a finding of the task.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {handoffBlock} from '../src/main-service.js';
import {watchedDirs} from '../src/outside-writes.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

const waitFor = async (check, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('timed out');
};
const report = summary => JSON.stringify({op: 'final', phase: 'complete', text: summary, next: '', evidence: [], outcome: 'completed', summary, remaining: ''});

function setup(t, {worker, outsideDirs}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-outside-')));
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(project, 'src'), {recursive: true});
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'already-there'), 'x');
  fs.writeFileSync(path.join(project, 'src/x.js'), 'export const state = "old";\n');
  const session = new Session(project, {root: path.join(root, 'home')});
  const profiles = {
    builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'},
    analyst: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'analyst', policy: 'read-only'},
  };
  const scheduler = createScheduler({session, adapters: {worker: fakeAdapter(args => worker(args, bin))}, profiles, requireFinalReport: true, gitHead: () => null,
    outsideDirs: outsideDirs ?? [bin]});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {session, scheduler, bin};
}

test('a link a worker puts in a PATH directory while it runs is a finding of its task, said to the orchestrator; an untouched run has none', async t => {
  const {session, scheduler, bin} = setup(t, {worker: (args, dir) => {
    fs.writeFileSync(path.join(args.cwd, 'src/x.js'), 'export const state = "new";\n');
    if (args.orders.includes('link')) fs.symlinkSync(path.join(args.cwd, 'src/x.js'), path.join(dir, 'x-tool'));
    return [{kind: 'result', status: 'completed', text: report('state is now "new"')}];
  }});
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js and link it', owns: ['src/x.js'], deadline: null});
  await waitFor(() => ['completed', 'accepted', 'blocked', 'failed'].includes(scheduler.tasks()[task]?.state));
  const copy = fs.realpathSync(session.events.findLast(e => e.kind === 'task.artifact' && e.task === task).cwd);
  const findings = session.events.filter(e => e.kind === 'task.finding' && e.task === task);
  assert.deepEqual(findings.map(e => [e.source, e.paths]), [['outside_write', [path.join(bin, 'x-tool')]]]);
  assert.equal(findings[0].text, `FINDING: Written outside the working copy while this attempt ran: ${path.join(bin, 'x-tool')} added (a link to ${path.join(copy, 'src/x.js')}, inside this task's working copy). Check whether the worker did it, and undo it if it should not stay.`);
  const ended = session.events.findLast(e => ['task.completed', 'task.accepted'].includes(e.kind) && e.task === task);
  assert.match(handoffBlock(session, [ended]), new RegExp(`\\n  outside the working copy: ${path.join(bin, 'x-tool').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} added`));

  const clean = scheduler.submit({parent: null, profile: 'builder', orders: 'Make state "new" in src/x.js', owns: ['src/x.js'], deadline: null});
  await waitFor(() => ['completed', 'accepted', 'blocked', 'failed'].includes(scheduler.tasks()[clean.task]?.state));
  assert.equal(session.events.some(e => e.kind === 'task.finding' && e.task === clean.task), false, 'nothing new outside: no finding');
});

test('the watched directories are PATH\'s absolute, existing ones, without the temp dir, the copies or the checkout', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.bounce-outside-test-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const dir of ['bin', 'w/abc/node_modules/.bin', 'project/bin']) fs.mkdirSync(path.join(root, dir), {recursive: true});
  const PATH = [path.join(root, 'bin'), 'relative/bin', path.join(root, 'missing'), path.join(root, 'w/abc/node_modules/.bin'), path.join(root, 'project/bin'),
    os.tmpdir(), path.join(root, 'bin')].join(path.delimiter);
  assert.deepEqual(watchedDirs({PATH, exclude: [path.join(root, 'w'), path.join(root, 'project')]}), [path.join(root, 'bin')]);
});
