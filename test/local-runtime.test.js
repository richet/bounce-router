import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLocalRuntime, reconcileLocalRuntime} from '../src/local-runtime.js';

const root = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-local-runtime-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};

const profile = (extra = {}) => ({policy: 'write', mode: 'yolo', writePaths: ['src'], commands: ['node --version'], container: {image: 'node:22-alpine', workspaceMiB: 8, memoryMiB: 64, cpus: 1, pids: 32}, ...extra});

test('dependency setup is explicit and stale prepared images fail before creating containers', async t => {
  const cwd = root(t);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({dependencies: {chalk: '5.6.2'}}));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
  for (const labels of [{}, {'bounce.toolchain': 'local', 'bounce.packagehash': 'stale', 'bounce.lockhash': 'stale'}]) {
    let creates = 0;
    const docker = async ({args}) => {
      if (args[0] === 'image') return {code: 0, stdout: `sha256:approved|linux|arm64|${JSON.stringify(labels)}`};
      if (args[0] === 'create') creates++;
      return {code: 1, stderr: 'No such object'};
    };
    await assert.rejects(createLocalRuntime({docker}).prepare({cwd, dir: path.join(cwd, 'state'), profile: profile()}), error =>
      ['TOOLCHAIN_SETUP_REQUIRED', 'TOOLCHAIN_STALE'].includes(error.code) && error.terminationVerified === true);
    assert.equal(creates, 0);
  }
});

function dockerFixture({image = true, files = []} = {}) {
  const calls = [];
  const containers = new Map();
  let nextId = 0;
  let volume;
  const docker = async ({args, input}) => {
    calls.push({args, input});
    if (args[0] === 'image') return image ? {stdout: 'sha256:approved|linux|amd64\n'} : {code: 1, stderr: 'No such image'};
    if (args[0] === 'container') {
      const found = [...containers.values()].some(item => item.name === args.at(-1));
      return found ? {stdout: '{}'} : {code: 1, stderr: 'No such container'};
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (!volume) return {code: 1, stderr: 'No such volume'};
      return args.includes('--format') ? {stdout: `${volume.owner}\n`} : {stdout: '{}'};
    }
    if (args[0] === 'volume' && args[1] === 'create') {
      const owner = args.find(value => String(value).startsWith('bounce.owner='))?.split('=')[1];
      volume = {name: args.at(-1), owner}; return {stdout: `${args.at(-1)}\n`};
    }
    if (args[0] === 'volume' && args[1] === 'rm') { volume = undefined; return {stdout: `${args.at(-1)}\n`}; }
    if (args[0] === 'create') {
      const id = `container-${++nextId}`;
      containers.set(id, {id, name: args[args.indexOf('--name') + 1], owner: args.find(value => String(value).startsWith('bounce.owner='))?.split('=')[1], running: false});
      return {stdout: `${id}\n`};
    }
    if (args[0] === 'start') { containers.get(args[1]).running = true; return {stdout: `${args[1]}\n`}; }
    if (args[0] === 'stop' || args[0] === 'kill') { containers.get(args.at(-1)).running = false; return {stdout: `${args.at(-1)}\n`}; }
    if (args[0] === 'inspect') {
      const item = containers.get(args.at(-1));
      if (!item) return {code: 1, stderr: 'No such object'};
      if (!args.includes('--format')) return {stdout: '{}'};
      const suffix = args.some(value => String(value).includes('.Name')) ? `|/${item.name}` : '';
      return {stdout: `${item.owner}|${item.running}|${item.id}${suffix}\n`};
    }
    if (args[0] === 'ps') return {stdout: [...containers.values()].map(item => `${item.id}|${item.name}`).join('\n')};
    if (args[0] === 'exec') {
      const request = JSON.parse(input);
      if (request.op === 'collect') return {stdout: JSON.stringify({ok: true, files})};
      return {stdout: JSON.stringify({ok: true, result: request.op === 'read' ? 'hello' : ''})};
    }
    if (args[0] === 'rm') { containers.delete(args.at(-1)); return {stdout: `${args.at(-1)}\n`}; }
    return {stdout: ''};
  };
  return {docker, calls};
}

test('local runtime correction: writes an owner manifest before container creation', async t => {
  const cwd = root(t); const state = path.join(cwd, 'state');
  fs.mkdirSync(path.join(cwd, 'src'));
  let manifestAtCreate;
  const fixture = dockerFixture();
  const docker = async request => {
    if (request.args[0] === 'create' && !manifestAtCreate) manifestAtCreate = JSON.parse(fs.readFileSync(path.join(state, 'local-runtime.json'), 'utf8'));
    return fixture.docker(request);
  };
  const workspace = await createLocalRuntime({docker, id: () => 'manifest'}).prepare({cwd, dir: state, profile: profile()});
  assert.equal(manifestAtCreate.phase, 'creating-keeper');
  assert.match(manifestAtCreate.ownerToken, /^[0-9a-f-]{36}$/);
  assert.equal(manifestAtCreate.cwd, fs.realpathSync(cwd));
  await workspace.cancel();
});

test('local runtime correction: missing reconciliation manifest is a verified no-record result', async t => {
  const state = root(t);
  assert.deepEqual(await reconcileLocalRuntime({dir: state, docker: async () => { throw new Error('must not call Docker'); }}), {verified: true, found: false, reason: 'NO_RECORD'});
});

test('local runtime correction: reconciles live resources by manifest owner and preserves an artifact', async t => {
  const cwd = root(t); const state = path.join(cwd, 'state');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  const fixture = dockerFixture({files: [{path: 'src/owned.js', content: Buffer.from('partial\n').toString('base64'), mode: 0o644}]});
  await createLocalRuntime({docker: fixture.docker, id: () => 'orphan'}).prepare({cwd, dir: state, profile: profile()});
  const result = await reconcileLocalRuntime({dir: state, docker: fixture.docker});
  assert.equal(result.verified, true);
  assert.equal(fs.existsSync(result.artifact), true);
  t.after(() => fs.rmSync(path.dirname(result.artifact), {recursive: true, force: true}));
  assert.equal(fixture.calls.filter(call => call.args[0] === 'rm').every(call => call.args.at(-1).startsWith('container-')), true);
});

test('local runtime correction: create conflict never removes an unverified writer name', async t => {
  const cwd = root(t); fs.mkdirSync(path.join(cwd, 'src'));
  const fixture = dockerFixture(); let creates = 0; let caught;
  const docker = async request => {
    if (request.args[0] === 'create' && ++creates === 2) { fixture.calls.push({args: request.args, input: request.input}); return {code: 1, stderr: 'name conflict'}; }
    return fixture.docker(request);
  };
  await assert.rejects(createLocalRuntime({docker, id: () => 'conflict'}).prepare({cwd, dir: 'state', profile: profile()}), error => { caught = error; return error.code === 'CONTAINMENT_FAILED'; });
  assert.equal(caught.terminationVerified, true);
  assert.equal(caught.recovery.endsWith('/state/local-runtime.json'), true);
  assert.equal(fixture.calls.filter(call => call.args[0] === 'rm').some(call => call.args.at(-1) === 'bounce-conflict-writer'), false);
});

test('local runtime correction: cancel is idempotent after a failed finish', async t => {
  const cwd = root(t); fs.mkdirSync(path.join(cwd, 'src')); fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  fs.writeFileSync(path.join(cwd, 'read.txt'), 'before\n');
  const fixture = dockerFixture({files: [{path: 'read.txt', content: Buffer.from('changed\n').toString('base64'), mode: 0o644}]});
  const workspace = await createLocalRuntime({docker: fixture.docker, id: () => 'failed'}).prepare({cwd, dir: 'state', profile: profile({readPaths: ['.']})});
  let failure; await assert.rejects(workspace.finish({publish: true}), error => { failure = error; return error.code === 'SCOPE_VIOLATION'; });
  assert.equal(failure.terminationVerified, true);
  assert.deepEqual(await workspace.cancel(), await workspace.cancel());
});

test('local runtime: stops and verifies the writer before collecting through a read-only keeper', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  const {docker, calls} = dockerFixture({files: [{path: 'src/owned.js', content: Buffer.from('after\n').toString('base64')}]});
  const workspace = await createLocalRuntime({docker, id: () => 'seal'}).prepare({cwd, dir: 'attempt', profile: profile()});
  const result = await workspace.finish({publish: false});
  assert.equal(typeof result.artifact, 'string');
  t.after(() => fs.rmSync(path.dirname(result.artifact), {recursive: true, force: true}));

  const volume = calls.find(call => call.args[0] === 'volume' && call.args[1] === 'create');
  assert.ok(volume, 'creates a Docker-managed volume');
  const creates = calls.filter(call => call.args[0] === 'create');
  assert.equal(creates.length, 2, 'creates keeper and writer before starting either');
  assert.ok(creates[0].args.some(value => String(value).endsWith(',readonly')), 'keeper workspace mount is read-only');
  const stopIndex = calls.findIndex(call => call.args[0] === 'stop');
  const inspectIndex = calls.findIndex((call, index) => index > stopIndex && call.args[0] === 'inspect');
  const collectIndex = calls.findIndex((call, index) => index > inspectIndex && call.args[0] === 'exec');
  assert.ok(stopIndex >= 0 && inspectIndex > stopIndex && collectIndex > inspectIndex, 'collection happens only after verified stop');
});

test('local runtime: rejects a command-created edit outside write scope', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}\n');
  const files = [
    {path: 'src/owned.js', content: Buffer.from('after\n').toString('base64')},
    {path: 'package.json', content: Buffer.from('{"changed":true}\n').toString('base64')},
  ];
  const {docker} = dockerFixture({files});
  const workspace = await createLocalRuntime({docker, id: () => 'scope'}).prepare({cwd, dir: 'attempt', profile: profile()});
  let failure;
  await assert.rejects(workspace.finish({publish: true}), error => { failure = error; return error.code === 'SCOPE_VIOLATION' && typeof error.artifact === 'string'; });
  assert.equal(fs.existsSync(failure.artifact), true, 'preserves a bounded failure artifact');
  t.after(() => fs.rmSync(path.dirname(failure.artifact), {recursive: true, force: true}));
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'owned.js'), 'utf8'), 'before\n');
});

test('local runtime: reconciles registered resources when writer start fails', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  const fixture = dockerFixture();
  let starts = 0;
  const docker = async request => {
    if (request.args[0] === 'start' && ++starts === 2) {
      fixture.calls.push({args: request.args, input: request.input});
      return {code: 1, stderr: 'start failed'};
    }
    return fixture.docker(request);
  };
  await assert.rejects(createLocalRuntime({docker, id: () => 'crash'}).prepare({cwd, dir: 'attempt', profile: profile()}), error => error.code === 'CONTAINMENT_FAILED');
  assert.deepEqual(fixture.calls.filter(call => call.args[0] === 'rm').map(call => call.args.at(-1)), ['container-2', 'container-1']);
  assert.ok(fixture.calls.some(call => call.args[0] === 'volume' && call.args[1] === 'rm'));
});

test('local runtime: collector rejection still stops keeper and removes sealed resources', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  const fixture = dockerFixture();
  const docker = async request => {
    if (request.args[0] === 'exec' && JSON.parse(request.input).op === 'collect') {
      fixture.calls.push({args: request.args, input: request.input});
      return {stdout: JSON.stringify({ok: false, code: 'UNSAFE_LINK', message: 'hardlink rejected'})};
    }
    return fixture.docker(request);
  };
  const workspace = await createLocalRuntime({docker, id: () => 'unsafe'}).prepare({cwd, dir: 'attempt', profile: profile()});
  await assert.rejects(workspace.finish({publish: true}), error => error.code === 'UNSAFE_LINK');
  const stopped = fixture.calls.filter(call => call.args[0] === 'stop').map(call => call.args.at(-1));
  assert.deepEqual(stopped, ['container-2', 'container-1']);
  assert.ok(fixture.calls.some(call => call.args[0] === 'volume' && call.args[1] === 'rm'));
});

test('local runtime: publishes deletion of an owned file and reports it as a change', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'removed.js'), 'remove me\n');
  const {docker} = dockerFixture({files: []});
  const workspace = await createLocalRuntime({docker, id: () => 'delete'}).prepare({cwd, dir: 'attempt', profile: profile()});
  assert.deepEqual(await workspace.finish({publish: true}), {verified: true, changes: ['src/removed.js']});
  assert.equal(fs.existsSync(path.join(cwd, 'src', 'removed.js')), false);
});

test('local runtime: treats an owned mode change as a source change', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'script.js'), 'same\n', {mode: 0o644});
  const files = [{path: 'src/script.js', content: Buffer.from('same\n').toString('base64'), mode: 0o755}];
  const {docker} = dockerFixture({files});
  const workspace = await createLocalRuntime({docker, id: () => 'mode'}).prepare({cwd, dir: 'attempt', profile: profile()});
  assert.deepEqual(await workspace.finish({publish: true}), {verified: true, changes: ['src/script.js']});
  assert.equal(fs.statSync(path.join(cwd, 'src', 'script.js')).mode & 0o777, 0o755);
});

test('local runtime: snapshots only declared readable and writable roots and excludes secret files', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.mkdirSync(path.join(cwd, 'private'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'ok\n');
  fs.writeFileSync(path.join(cwd, 'private', 'hidden.txt'), 'hidden\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'TOKEN=secret\n');
  const {docker, calls} = dockerFixture();
  const workspace = await createLocalRuntime({docker, id: () => 'snapshot'}).prepare({cwd, dir: 'attempt', profile: profile({readPaths: ['src']} )});
  const init = calls.find(call => call.args[0] === 'exec');
  const names = JSON.parse(init.input).files.map(file => file.path);
  assert.deepEqual(names, ['src/owned.js']);
  await workspace.cancel();
});

test('local runtime: rejects hard-linked source files before Docker', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'same inode\n');
  fs.linkSync(path.join(cwd, 'src', 'owned.js'), path.join(cwd, 'src', 'alias.js'));
  const {docker, calls} = dockerFixture();
  await assert.rejects(createLocalRuntime({docker}).prepare({cwd, dir: 'attempt', profile: profile()}), error => error.code === 'UNSAFE_LINK');
  assert.equal(calls.length, 0);
});

test('local runtime: rejects an explicit nested read root whose parent is a symlink', async t => {
  const cwd = root(t); const outside = root(t);
  fs.mkdirSync(path.join(outside, 'nested'));
  fs.writeFileSync(path.join(outside, 'nested', 'secret.txt'), 'secret\n');
  fs.symlinkSync(outside, path.join(cwd, 'linked'));
  const {docker, calls} = dockerFixture();
  await assert.rejects(createLocalRuntime({docker}).prepare({cwd, dir: 'attempt', profile: profile({readPaths: ['linked/nested']})}), error => error.code === 'UNSAFE_LINK');
  assert.equal(calls.length, 0);
});

test('local runtime red: missing approved image fails setup without pulling or starting a container', async t => {
  const cwd = root(t);
  const {docker, calls} = dockerFixture({image: false});
  const runtime = createLocalRuntime({docker});
  await assert.rejects(runtime.prepare({cwd, dir: 'attempt', profile: profile()}), error => error.code === 'IMAGE_MISSING');
  assert.deepEqual(calls.map(call => call.args[0]), ['image']);
});

test('local runtime red: write workspace uses fixed hardened Docker flags and no live workspace bind', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'export const x = 1;\n');
  const {docker, calls} = dockerFixture();
  const workspace = await createLocalRuntime({docker, id: () => 'safe'}).prepare({cwd, dir: 'attempt', profile: profile()});
  const create = calls.find(call => call.args[0] === 'create' && call.args.includes('bounce-safe-writer')).args;
  assert.ok(create.includes('--network') && create.includes('none'));
  assert.ok(create.includes('--cap-drop') && create.includes('ALL'));
  assert.ok(create.includes('no-new-privileges') && create.includes('--read-only'));
  assert.ok(create.includes('--user') && create.includes('1000:1000'));
  assert.ok(create.includes('--tmpfs'));
  assert.equal(create.some(value => String(value).includes(`${cwd}:`)), false);
  await workspace.cancel();
});

test('local runtime red: publication validates termination, scope and baseline before applying owned result', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  const {docker} = dockerFixture({files: [{path: 'src/owned.js', content: Buffer.from('after\n').toString('base64')}]});
  const workspace = await createLocalRuntime({docker, id: () => 'safe'}).prepare({cwd, dir: 'attempt', profile: profile()});
  const result = await workspace.finish({publish: true});
  assert.deepEqual(result, {verified: true, changes: ['src/owned.js']});
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'owned.js'), 'utf8'), 'after\n');
});

test('local runtime red: concurrent host edit blocks publication without overwrite', async t => {
  const cwd = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  const {docker} = dockerFixture({files: [{path: 'src/owned.js', content: Buffer.from('after\n').toString('base64')}]});
  const workspace = await createLocalRuntime({docker, id: () => 'safe'}).prepare({cwd, dir: 'attempt', profile: profile()});
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'concurrent\n');
  await assert.rejects(workspace.finish({publish: true}), error => error.code === 'BASELINE_CONFLICT');
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'owned.js'), 'utf8'), 'concurrent\n');
});

test('local runtime: a host symlink swapped in after the snapshot blocks publication', async t => {
  const cwd = root(t); const outside = root(t);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  const {docker} = dockerFixture({files: [{path: 'src/owned.js', content: Buffer.from('after\n').toString('base64')}]});
  const workspace = await createLocalRuntime({docker, id: () => 'safe'}).prepare({cwd, dir: 'attempt', profile: profile()});
  fs.rmSync(path.join(cwd, 'src'), {recursive: true});
  fs.symlinkSync(outside, path.join(cwd, 'src'));
  await assert.rejects(workspace.finish({publish: true}), error => error.code === 'UNSAFE_LINK');
  assert.equal(fs.existsSync(path.join(outside, 'owned.js')), false);
});

test('local runtime red: read-only execution permits bounded reading but denies writes and commands before Docker', async t => {
  const cwd = root(t);
  fs.writeFileSync(path.join(cwd, 'readme.txt'), 'hello');
  const {docker, calls} = dockerFixture();
  const workspace = await createLocalRuntime({docker}).prepare({cwd, dir: 'attempt', profile: profile({policy: 'read-only', mode: 'plan', writePaths: []})});
  assert.equal(await workspace.execute({name: 'read_file', arguments: {path: 'readme.txt'}}), 'hello');
  await assert.rejects(workspace.execute({name: 'write_file', arguments: {path: 'readme.txt', content: 'no'}}), error => error.code === 'POLICY_DENIED');
  await assert.rejects(workspace.execute({name: 'run_command', arguments: {command: 'node --version'}}), error => error.code === 'POLICY_DENIED');
  assert.equal(calls.length, 0);
});
