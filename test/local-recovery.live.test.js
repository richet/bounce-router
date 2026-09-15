import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createLocalRuntime, reconcileLocalRuntime} from '../src/local-runtime.js';

test('live recovery discovers exact owned IDs and preserves unpublished changes', {skip: process.env.BOUNCE_LIVE_DOCKER !== '1', timeout: 60000}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-crash-recovery-'));
  const cwd = path.join(root, 'repo'), dir = path.join(root, 'state');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'value.js'), 'before\n');
  const runtime = await createLocalRuntime().prepare({cwd, dir, profile: {policy: 'write', mode: 'yolo', writePaths: ['value.js']}});
  let sealed = false;
  t.after(async () => {if (!sealed) await runtime.cancel(); await fs.rm(root, {recursive: true, force: true});});
  await runtime.execute({name: 'write_file', arguments: {path: 'value.js', content: 'partial\n'}});
  const record = JSON.parse(await fs.readFile(path.join(dir, 'local-runtime.json'), 'utf8'));
  assert.equal(record.phase, 'ready');
  // Simulate the create-success / manifest-update crash window: labels must recover IDs.
  record.resources.writerId = null;
  record.resources.keeperId = null;
  await fs.writeFile(path.join(dir, 'local-runtime.json'), JSON.stringify(record));
  const recovered = await reconcileLocalRuntime({dir});
  sealed = recovered.verified;
  assert.equal(recovered.verified, true);
  assert.ok(recovered.artifact);
  const artifact = JSON.parse(await fs.readFile(recovered.artifact, 'utf8'));
  assert.equal(Buffer.from(artifact.files.find(file => file.path === 'value.js').content, 'base64').toString(), 'partial\n');
  assert.equal(await fs.readFile(path.join(cwd, 'value.js'), 'utf8'), 'before\n');
  assert.equal((await reconcileLocalRuntime({dir})).verified, true);
});
