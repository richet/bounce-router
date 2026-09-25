import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAttemptWorkspace, captureArtifact, integrateArtifact} from '../src/workspace-artifacts.js';

test('mode-only artifact applies executable permissions and preserves concurrent chmod', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-artifact-mode-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const cwd = path.join(root, 'source'), dir = path.join(root, 'state'); fs.mkdirSync(cwd);
  const file = path.join(cwd, 'script'); fs.writeFileSync(file, 'run', {mode: 0o644});
  const workspace = createAttemptWorkspace({cwd, dir, owns: ['script'], attemptId: 'mode'});
  fs.chmodSync(path.join(workspace.cwd, 'script'), 0o755);
  const artifact = captureArtifact(workspace);
  assert.equal(integrateArtifact({cwd, dir, artifact}).status, 'integrated');
  assert.equal(fs.statSync(file).mode & 0o777, 0o755);
  fs.chmodSync(file, 0o600);
  assert.equal(integrateArtifact({cwd, dir, artifact}).status, 'conflict');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('crash after target rename resumes from durable manifest without losing another file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-artifact-crash-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const cwd = path.join(root, 'source'), dir = path.join(root, 'state'); fs.mkdirSync(cwd);
  for (const file of ['a', 'b']) fs.writeFileSync(path.join(cwd, file), 'before');
  const workspace = createAttemptWorkspace({cwd, dir, owns: ['**'], attemptId: 'one'});
  for (const file of ['a', 'b']) fs.writeFileSync(path.join(workspace.cwd, file), 'after');
  const artifact = captureArtifact(workspace);
  const rename = fs.renameSync;
  let crashed = false;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (!crashed && to === path.join(fs.realpathSync(cwd), 'a')) { crashed = true; throw new Error('simulated crash after rename'); }
  };
  try { assert.throws(() => integrateArtifact({cwd, dir, artifact}), /simulated crash/); }
  finally { fs.renameSync = rename; }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'integrations', `${artifact.id}.json`), 'utf8'));
  assert.equal(manifest.status, 'prepared'); assert.deepEqual(manifest.applied, []);
  assert.deepEqual(['a', 'b'].map(file => fs.readFileSync(path.join(cwd, file), 'utf8')), ['after', 'before']);
  assert.equal(integrateArtifact({cwd, dir, artifact}).status, 'integrated');
  assert.deepEqual(['a', 'b'].map(file => fs.readFileSync(path.join(cwd, file), 'utf8')), ['after', 'after']);
});
