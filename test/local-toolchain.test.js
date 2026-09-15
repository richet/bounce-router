import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {inspectLocalToolchain, prepareLocalToolchain} from '../src/local-toolchain.js';

const workspace = t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-toolchain-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  return cwd;
};
const project = (cwd, {lock = true} = {}) => {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({engines: {node: '>=22'}, packageManager: 'npm@10.8.2'}));
  if (lock) fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, name: 'demo'}));
};
function dockerFixture({base = true, cache = null, buildId = 'sha256:prepared', nodeMajor = 22} = {}) {
  const calls = [];
  let builtLabels;
  const metadata = id => JSON.stringify({Id: id, Os: 'linux', Architecture: 'arm64', Size: 1234, RepoDigests: id === 'sha256:base' ? ['node@sha256:base'] : [], Config: {Labels: id === 'sha256:base' ? {} : (builtLabels ?? cache)}});
  const docker = async request => {
    calls.push(request);
    const {args} = request;
    if (args[0] === 'version') return {code: 0, stdout: 'ok'};
    if (args[0] === 'image' && args[1] === 'inspect') {
      const target = args.at(-1);
      if (target.startsWith('node:') || target === 'node@sha256:base' || target === 'custom-local-image') return base ? {code: 0, stdout: metadata('sha256:base')} : {code: 1, stderr: 'No such image'};
      if (target.startsWith('bounce-toolchain:')) return (cache || builtLabels) ? {code: 0, stdout: metadata(buildId)} : {code: 1, stderr: 'No such image'};
      return {code: 1, stderr: 'No such image'};
    }
    if (args[0] === 'run') return {code: 0, stdout: `${nodeMajor}.12.0\n`};
    if (args[0] === 'ps') return {code: 0, stdout: ''};
    if (args[0] === 'build') {
      builtLabels = Object.fromEntries([...args.filter((value, index) => args[index - 1] === '--label'), ...request.input.matchAll(/(bounce\.[a-z]+)=([^\s]+)/g)].map(value => Array.isArray(value) ? value.slice(1) : value.split('=')));
      return {code: 0, stdout: 'built'};
    }
    return {code: 1, stderr: 'unexpected'};
  };
  return {docker, calls};
}

test('inspection is read-only and diagnoses Docker/image/platform/runtime', async t => {
  const cwd = workspace(t); project(cwd);
  const {docker, calls} = dockerFixture({base: false});
  const result = await inspectLocalToolchain({cwd, docker});
  assert.equal(result.ready, false);
  assert.equal(result.docker.ready, true);
  assert.equal(result.image.reason, 'IMAGE_MISSING');
  assert.match(result.suggestion, /node:22-bookworm-slim/);
  assert.deepEqual(calls.map(call => call.args[0]), ['version', 'image']);
});

test('prepare never pulls and defaults build networking to none', async t => {
  const cwd = workspace(t); project(cwd);
  const {docker, calls} = dockerFixture();
  const result = await prepareLocalToolchain({cwd, docker});
  assert.equal(result.preparedImageId, 'sha256:prepared');
  const build = calls.find(call => call.args[0] === 'build');
  assert.ok(build.args.includes('--pull=false'));
  assert.ok(build.args.includes('--network=none'));
  assert.equal(calls.some(call => call.args[0] === 'pull'), false);
});

test('prepare cache identity changes with lock contents and stale cache labels are rebuilt', async t => {
  const cwd = workspace(t); project(cwd);
  const initial = dockerFixture({cache: {'bounce.toolchain': 'local', 'bounce.cachekey': 'stale'}});
  const first = await prepareLocalToolchain({cwd, docker: initial.docker});
  assert.equal(initial.calls.filter(call => call.args[0] === 'build').length, 1);
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({lockfileVersion: 3, name: 'changed'}));
  const second = dockerFixture();
  const next = await prepareLocalToolchain({cwd, docker: second.docker});
  assert.notEqual(first.cacheKey, next.cacheKey);
});

test('prepare rejects linked dependency inputs before Docker build', async t => {
  const cwd = workspace(t); project(cwd);
  fs.unlinkSync(path.join(cwd, 'package.json'));
  fs.symlinkSync('/tmp/not-package', path.join(cwd, 'package.json'));
  const fixture = dockerFixture();
  await assert.rejects(prepareLocalToolchain({cwd, docker: fixture.docker}), error => error.code === 'UNSAFE_INPUT');
  assert.equal(fixture.calls.some(call => call.args[0] === 'build'), false);
});

test('prepare bounds dependency inputs and its build context contains no protected or source files', async t => {
  const cwd = workspace(t); project(cwd);
  fs.writeFileSync(path.join(cwd, '.npmrc'), '//registry.example/:_authToken=secret');
  fs.writeFileSync(path.join(cwd, 'source.js'), 'do not copy this');
  const fixture = dockerFixture();
  const docker = async request => {
    if (request.args[0] === 'build') {
      assert.deepEqual(fs.readdirSync(request.args.at(-1)).sort(), ['Dockerfile', 'package-lock.json', 'package.json']);
    }
    return fixture.docker(request);
  };
  await prepareLocalToolchain({cwd, docker});
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(prepareLocalToolchain({cwd, docker: fixture.docker}), error => error.code === 'INPUT_TOO_LARGE');
  assert.equal(fixture.calls.filter(call => call.args[0] === 'build').length, 1);
});

test('prepare describes opted-in ordinary Docker build networking', async t => {
  const cwd = workspace(t); project(cwd);
  const {docker, calls} = dockerFixture();
  const result = await prepareLocalToolchain({cwd, docker, allowNetwork: true});
  assert.equal(result.network, 'docker-default');
  const build = calls.find(call => call.args[0] === 'build');
  assert.equal(build.args.includes('--network=none'), false);
});

test('prepare rejects an unsupported Node runtime and cache uses exact labels and immutable base ID', async t => {
  const cwd = workspace(t); project(cwd);
  const unsupported = dockerFixture({nodeMajor: 20});
  await assert.rejects(prepareLocalToolchain({cwd, image: 'custom-local-image', docker: unsupported.docker}), error => error.code === 'UNSUPPORTED_RUNTIME');
  const {docker, calls} = dockerFixture();
  await prepareLocalToolchain({cwd, docker});
  const build = calls.find(call => call.args[0] === 'build');
  assert.ok(build.args.includes('bounce.toolchain=local'));
  assert.ok(build.input.includes('FROM node@sha256:base'));
  assert.ok(build.input.includes('npm ci --ignore-scripts --no-audit --no-fund'));
  assert.ok(build.input.includes('USER node'));
});
