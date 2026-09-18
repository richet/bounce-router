import './helpers/env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('real CLI previews a local builder and saves only with explicit --save', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-local-setup-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'config.json');
  const settings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {main: {adapter: 'claude'}}};
  await fs.writeFile(file, JSON.stringify(settings));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const args = [cli, 'local', 'profile', 'local_build', JSON.stringify({policy: 'write', writePaths: ['src'], commands: ['node --test']})];
  const env = {...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1'};
  const preview = await promisify(execFile)(process.execPath, args, {env, timeout: 10000});
  assert.match(preview.stdout, /Preview only/);
  assert.match(preview.stdout, /"image": "node:22-alpine"/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), settings);
  const saved = await promisify(execFile)(process.execPath, [...args, '--save'], {env, timeout: 10000});
  assert.match(saved.stdout, /Saved.*running sessions were not changed/);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).profiles.local_build.policy, 'write');
  assert.deepEqual((await fs.readdir(root)).sort(), ['config.json']);
});
