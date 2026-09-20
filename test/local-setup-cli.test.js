import './helpers/env.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// `bounce local profile` created config-level local workers. There is one roster now — agent files —
// so the command is gone, and says where to go instead of silently doing nothing.
test('real CLI: bounce local profile is gone and points at bounce agents; nothing is written', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-local-setup-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const settings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', profiles: {main: {adapter: 'claude'}}};
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(settings));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const result = await new Promise(resolve => execFile(process.execPath, [cli, 'local', 'profile', 'local_build', '{}', '--save'],
    {env: {...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1'}, timeout: 10000}, (error, stdout, stderr) => resolve({code: error?.code ?? 0, stdout, stderr})));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Use bounce local \[--verify\] or bounce local setup; agents are managed with bounce agents/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'config.json'), 'utf8')), settings);
  assert.deepEqual((await fs.readdir(root)).sort(), ['config.json']);
});
