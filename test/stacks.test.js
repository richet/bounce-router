// Stacks a worker started in its copy are taken down when its task ends, before prune removes the copy, and on
// request for copies already left behind. docker is never called here: each test passes its own runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {composeProjects, stacksUnder, stacksDown, mayHoldStack, takeDown, watchStacks, hasVolumes} from '../src/stacks.js';

const listing = JSON.stringify([
  {Name: 'copy-a', Status: 'running(2)', ConfigFiles: '/home/u/.bounce/w/aaaa1111/docker-compose.yml'},
  {Name: 'copy-a-extra', Status: 'exited(1)', ConfigFiles: '/home/u/.bounce/w/aaaa1111/infra/compose.yaml,/home/u/.bounce/w/aaaa1111/infra/compose.override.yaml'},
  {Name: 'sibling', Status: 'exited(2)', ConfigFiles: '/home/u/.bounce/w/aaaa11112/docker-compose.yml'},
  {Name: 'checkout', Status: 'running(3)', ConfigFiles: '/home/u/project/docker-compose.yml'},
]);

test('the stacks of a copy are the compose projects whose files are inside it, and nothing next to it', async () => {
  const projects = await composeProjects({run: async args => (assert.deepEqual(args, ['compose', 'ls', '--all', '--format', 'json']), {ok: true, stdout: listing})});
  assert.deepEqual(stacksUnder('/home/u/.bounce/w/aaaa1111', projects).map(p => p.name), ['copy-a', 'copy-a-extra']);
  assert.deepEqual(stacksUnder('/home/u/.bounce/w/aaaa1111/', projects).map(p => p.name), ['copy-a', 'copy-a-extra']);
});

test('no docker installed is no stacks; any other failure is an error', async () => {
  assert.deepEqual(await composeProjects({run: async () => ({ok: false, missing: true, error: 'spawn docker ENOENT'})}), []);
  await assert.rejects(composeProjects({run: async () => ({ok: false, error: 'Cannot connect to the Docker daemon'})}), /Cannot connect/);
});

test('each stack is taken down with its volumes and orphans, and a failure is reported per stack', async () => {
  const calls = [];
  const down = name => takeDown(name, {run: async args => { calls.push(args); return name === 'copy-a-extra' ? {ok: false, error: 'busy'} : {ok: true, stdout: ''}; }});
  const result = await stacksDown('/home/u/.bounce/w/aaaa1111', {list: async () => composeProjects({run: async () => ({ok: true, stdout: listing})}), down});
  assert.deepEqual(result, {down: ['copy-a'], failed: [{name: 'copy-a-extra', error: 'busy'}]});
  assert.deepEqual(calls, [['compose', '-p', 'copy-a', 'down', '--volumes', '--remove-orphans'], ['compose', '-p', 'copy-a-extra', 'down', '--volumes', '--remove-orphans']]);
});

test('a folder may hold a stack when a compose file sits at its top or one level down', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-stacks-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  assert.equal(mayHoldStack(dir), false);
  fs.mkdirSync(path.join(dir, 'infra'));
  fs.writeFileSync(path.join(dir, 'infra', 'compose.yaml'), 'services: {}\n');
  assert.equal(mayHoldStack(dir), true);
  fs.rmSync(path.join(dir, 'infra'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
  assert.equal(mayHoldStack(dir), true);
  assert.equal(mayHoldStack(path.join(dir, 'gone')), false);
});

test('when a task ends its copy\'s stacks are taken down, never the checkout\'s', async t => {
  const {Session} = await import('../src/core.js');
  const {createScheduler} = await import('../src/scheduler.js');
  const {fakeAdapter} = await import('./helpers/fake-adapter.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-stack-end-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'docker-compose.yml'), 'services: {}\n');
  const session = new Session(project, {root: path.join(root, 'home')});
  const asked = [];
  const report = JSON.stringify({op: 'final', phase: 'done', text: 'ok', next: '', evidence: [], outcome: 'completed', summary: 'ok', remaining: ''});
  const adapters = {worker: fakeAdapter(args => { fs.writeFileSync(path.join(args.cwd, 'x.txt'), 'x\n'); return [{kind: 'result', status: 'completed', text: report}]; })};
  const profiles = {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}};
  const scheduler = createScheduler({session, adapters, profiles, requireFinalReport: true, gitHead: () => null,
    stackDown: async dir => { asked.push(dir); return {down: ['copy-stack'], failed: []}; }});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'write x', owns: ['**'], deadline: null, check: 'test -f x.txt'});
  const start = Date.now();
  while (!session.events.some(e => e.kind === 'task.diagnostic' && e.task === task && e.reason === 'stacks_down')) {
    if (Date.now() - start > 3000) assert.fail(`no stacks_down row; state ${scheduler.tasks()[task]?.state}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const copy = session.events.findLast(e => e.kind === 'task.workspace' && e.task === task).cwd;
  assert.notEqual(copy, project);
  assert.deepEqual(asked, [copy]);
  assert.match(session.events.findLast(e => e.reason === 'stacks_down').text, /copy-stack/);
});

// A worker that ran its own plain `down` removed the containers, so `docker compose ls` no longer lists the project,
// and its volumes stayed. Found live: hundreds of volumes of finished copies.
test('a project watched while it ran is taken down at the copy\'s end when only its volumes are left', async () => {
  const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter(), killed: false, kill() { this.killed = true; }});
  child.stdout.setEncoding = () => {};
  const spawned = [];
  const watch = watchStacks({spawn: (cmd, args) => { spawned.push([cmd, ...args]); return child; }});
  assert.deepEqual(spawned, [['docker', 'events', '--filter', 'type=container', '--filter', 'event=create', '--format', '{{json .Actor.Attributes}}']]);
  const created = (project, files) => JSON.stringify({'com.docker.compose.project': project, 'com.docker.compose.project.config_files': files, name: `${project}-db-1`});
  child.stdout.emit('data', `${created('copy-a', '/home/u/.bounce/w/aaaa1111/docker-compose.yml,/home/u/.bounce/w/aaaa1111/.stack/override.yml')}\n${created('checkout', '/home/u/project/docker-compose.yml')}\nnot json\n{"name":"plain"}\n${created('copy-a-old', '/home/u/.bounce/w/aaaa1111/compose.yaml').slice(0, 20)}`);
  child.stdout.emit('data', `${created('copy-a-old', '/home/u/.bounce/w/aaaa1111/compose.yaml').slice(20)}\n`);
  assert.deepEqual(watch.projects().map(p => p.name), ['copy-a', 'checkout', 'copy-a-old']);
  const calls = [];
  const result = await stacksDown('/home/u/.bounce/w/aaaa1111', {list: async () => [], seen: watch.projects(),
    leftover: async name => name === 'copy-a', down: async name => (calls.push(name), {ok: true})});
  assert.deepEqual(result, {down: ['copy-a'], failed: []}, 'copy-a-old has no volumes left; the checkout is never touched');
  assert.deepEqual(calls, ['copy-a']);
  const both = await stacksDown('/home/u/.bounce/w/aaaa1111', {list: async () => [{name: 'copy-a', configFiles: ['/home/u/.bounce/w/aaaa1111/docker-compose.yml']}],
    seen: watch.projects(), leftover: async () => true, down: async () => ({ok: true})});
  assert.deepEqual(both.down, ['copy-a', 'copy-a-old'], 'a listed project is taken down once');
  watch.close();
  assert.equal(child.killed, true);
  assert.deepEqual(watchStacks({spawn: () => { throw new Error('spawn docker ENOENT'); }}).projects(), [], 'no docker is no watch');
});

test('a project holds volumes when docker lists any with its compose label', async () => {
  const asked = [];
  assert.equal(await hasVolumes('copy-a', {run: async args => (asked.push(args), {ok: true, stdout: 'copy-a_db_data\n'})}), true);
  assert.deepEqual(asked, [['volume', 'ls', '-q', '--filter', 'label=com.docker.compose.project=copy-a']]);
  assert.equal(await hasVolumes('copy-a', {run: async () => ({ok: true, stdout: '\n'})}), false);
  assert.equal(await hasVolumes('copy-a', {run: async () => ({ok: false, error: 'down'})}), false);
});

test('the scheduler passes the watched projects to the copy\'s teardown and stops the watch on close', async t => {
  const {Session} = await import('../src/core.js');
  const {createScheduler} = await import('../src/scheduler.js');
  const {fakeAdapter} = await import('./helpers/fake-adapter.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-stack-seen-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'docker-compose.yml'), 'services: {}\n');
  const session = new Session(project, {root: path.join(root, 'home')});
  const report = JSON.stringify({op: 'final', phase: 'done', text: 'ok', next: '', evidence: [], outcome: 'completed', summary: 'ok', remaining: ''});
  const adapters = {worker: fakeAdapter(args => { fs.writeFileSync(path.join(args.cwd, 'x.txt'), 'x\n'); return [{kind: 'result', status: 'completed', text: report}]; })};
  const profiles = {builder: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], role: 'builder', policy: 'write'}};
  const seen = [{name: 'copy-stack', configFiles: ['/elsewhere/compose.yml']}];
  let closed = 0;
  const passed = [];
  const scheduler = createScheduler({session, adapters, profiles, requireFinalReport: true, gitHead: () => null,
    stackWatch: {projects: () => seen, close: () => { closed++; }},
    stackDown: async (dir, options) => { passed.push(options?.seen); return {down: ['copy-stack'], failed: []}; }});
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const {task} = scheduler.submit({parent: null, profile: 'builder', orders: 'write x', owns: ['**'], deadline: null, check: 'test -f x.txt'});
  const start = Date.now();
  while (!session.events.some(e => e.kind === 'task.diagnostic' && e.task === task && e.reason === 'stacks_down')) {
    if (Date.now() - start > 3000) assert.fail(`no stacks_down row; state ${scheduler.tasks()[task]?.state}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(passed, [seen]);
  scheduler.close();
  assert.equal(closed, 1);
});
