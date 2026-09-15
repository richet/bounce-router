import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createLocalRuntime, DEFAULT_LOCAL_IMAGE} from '../src/local-runtime.js';

// Explicit opt-in: this test starts a named Docker container only when the operator requests it.
test('live Docker: bounded shared tmpfs seals after writer stop and publishes owned changes', {skip: process.env.BOUNCE_LIVE_DOCKER === '1' ? false : 'set BOUNCE_LIVE_DOCKER=1 to run'}, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-local-runtime-live-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'owned.js'), 'before\n');
  const id = `live-${Date.now()}`;
  const childProgram = `setTimeout(() => require("fs").writeFileSync("src/late.js", "unsafe\\n"), 7000); process.send("ready");`;
  const parentProgram = `const child = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childProgram)}], {detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"]}); child.once("message", () => { console.log(child.pid); child.disconnect(); child.unref(); });`;
  const delayed = `node -e ${JSON.stringify(parentProgram)}`;
  const exitSeven = `node -e 'process.exit(7)'`;
  const workspace = await createLocalRuntime({id: () => id}).prepare({cwd, dir: id, profile: {policy: 'write', mode: 'yolo', readPaths: ['.'], writePaths: ['src'], commands: [delayed, exitSeven], container: {image: DEFAULT_LOCAL_IMAGE, workspaceMiB: 16, memoryMiB: 128, cpus: 1, pids: 32}, localOptions: {timeoutMs: 10000, maxOutputTokens: 2048}}});
  const inspect = JSON.parse(execFileSync('docker', ['inspect', `bounce-${id}-writer`], {encoding: 'utf8'}))[0];
  assert.equal(inspect.Config.User, '1000:1000');
  assert.equal(inspect.HostConfig.NetworkMode, 'none');
  assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspect.HostConfig.PidMode, '', 'default private PID namespace is retained');
  assert.equal(inspect.HostConfig.LogConfig.Type, 'none');
  assert.deepEqual(inspect.HostConfig.CapDrop, ['ALL']);
  assert.equal(inspect.Mounts.find(mount => mount.Destination === '/workspace').Type, 'volume');
  await assert.rejects(workspace.execute({name: 'run_command', arguments: {command: exitSeven}}), error => error.code === 'COMMAND_FAILED' && error.status === 7);
  await workspace.execute({name: 'write_file', arguments: {path: 'src/owned.js', content: 'after\n'}});
  const detachedPid = await workspace.execute({name: 'run_command', arguments: {command: delayed}});
  assert.match(detachedPid.trim(), /^\d+$/);
  assert.deepEqual(await workspace.finish({publish: true}), {verified: true, changes: ['src/owned.js']});
  assert.throws(() => execFileSync('docker', ['inspect', `bounce-${id}-writer`], {stdio: 'ignore'}));
  await new Promise(resolve => setTimeout(resolve, 7200));
  assert.equal(fs.readFileSync(path.join(cwd, 'src', 'owned.js'), 'utf8'), 'after\n');
  assert.equal(fs.existsSync(path.join(cwd, 'src', 'late.js')), false);
});
