// A worker's build output that the project ignores is not part of its work: the rest integrates, and what was left
// out is named where the orchestrator reads the task (found live: dist/ binaries refused a whole step).
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {taskView} from '../src/task-view.js';
import {fakeAdapter} from './helpers/fake-adapter.js';

test('a worker\'s ignored build output is left out, the rest integrates, and the task names what was left out', async t => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-ignored-')));
  t.after(() => fs.rmSync(base, {recursive: true, force: true}));
  const cwd = path.join(base, 'project');
  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.writeFileSync(path.join(cwd, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(cwd, 'src', 'cli.js'), 'old\n');
  const git = (...args) => execFileSync('git', args, {cwd, stdio: 'ignore'});
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  const session = new Session(cwd, {root: path.join(base, 'home')});
  const worker = {...fakeAdapter(({cwd: copy}) => {
    fs.writeFileSync(path.join(copy, 'src', 'cli.js'), 'new\n');
    fs.mkdirSync(path.join(copy, 'dist'));
    fs.writeFileSync(path.join(copy, 'dist', 'kb'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0]));
    return [{kind: 'result', status: 'completed', text: 'built the CLI'}];
  }), capabilities: () => ({commands: true})};
  const profiles = {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}};
  const scheduler = createScheduler({session, adapters: {worker}, profiles, gitHead: () => null});
  t.after(() => scheduler.close());
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'build the CLI', deadline: null, check: 'true'});
  const start = Date.now();
  while (!session.events.some(e => e.kind === 'task.integrated' && e.task === task) && !['blocked', 'failed'].includes(scheduler.tasks()[task]?.state) && Date.now() - start < 8000) await new Promise(resolve => setTimeout(resolve, 10));

  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'cli.js'), 'utf8'), 'new\n', JSON.stringify(session.events.filter(e => e.kind === 'task.blocked').map(e => e.text)));
  assert.equal(fs.existsSync(path.join(cwd, 'dist')), false);
  assert.deepEqual(taskView(session.events, task).artifact.leftOut, [{path: 'dist/kb', reason: 'binary'}]);
});
