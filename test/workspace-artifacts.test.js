import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAttemptWorkspace, captureArtifact, integrateArtifact, advanceBaseline} from '../src/workspace-artifacts.js';

const setup = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-artifacts-')); t.after(() => fs.rmSync(root, {recursive: true, force: true})); const source = path.join(root, 'source'); const dir = path.join(root, 'state'); fs.mkdirSync(source); fs.mkdirSync(dir); return {source, dir}; };
const write = (root, name, value) => { fs.mkdirSync(path.dirname(path.join(root, name)), {recursive: true}); fs.writeFileSync(path.join(root, name), value); };

test('concurrent disjoint workspaces retain dirty and untracked source files, and both artifacts integrate', () => {
  const {source, dir} = setup(test);
  write(source, 'a.txt', 'old-a'); write(source, 'b.txt', 'old-b'); write(source, 'dirty.txt', 'untracked');
  const a = createAttemptWorkspace({cwd: source, dir, owns: ['a.txt'], attemptId: 'a'});
  const b = createAttemptWorkspace({cwd: source, dir, owns: ['b.txt'], attemptId: 'b'});
  assert.equal(fs.readFileSync(path.join(a.cwd, 'dirty.txt'), 'utf8'), 'untracked');
  write(a.cwd, 'a.txt', 'new-a'); write(b.cwd, 'b.txt', 'new-b');
  assert.equal(integrateArtifact({cwd: source, dir, artifact: captureArtifact(a)}).status, 'integrated');
  assert.equal(integrateArtifact({cwd: source, dir, artifact: captureArtifact(b)}).status, 'integrated');
  assert.equal(fs.readFileSync(path.join(source, 'a.txt'), 'utf8'), 'new-a');
  assert.equal(fs.readFileSync(path.join(source, 'b.txt'), 'utf8'), 'new-b');
});

test('overlap, user edits, outside ownership, and orphan workspaces never modify the target', () => {
  const {source, dir} = setup(test);
  write(source, 'x.txt', 'old'); write(source, 'outside.txt', 'old');
  const overlap = createAttemptWorkspace({cwd: source, dir, owns: ['x.txt'], attemptId: 'overlap'}); write(overlap.cwd, 'x.txt', 'worker'); write(source, 'x.txt', 'user');
  assert.equal(integrateArtifact({cwd: source, dir, artifact: captureArtifact(overlap)}).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(source, 'x.txt'), 'utf8'), 'user');
  const outside = createAttemptWorkspace({cwd: source, dir, owns: ['x.txt'], attemptId: 'outside'}); write(outside.cwd, 'outside.txt', 'bad');
  assert.equal(integrateArtifact({cwd: source, dir, artifact: captureArtifact(outside)}).status, 'ownership_violation');
  assert.equal(fs.readFileSync(path.join(source, 'outside.txt'), 'utf8'), 'old');
  const orphan = createAttemptWorkspace({cwd: source, dir, owns: ['x.txt'], attemptId: 'orphan'}); write(orphan.cwd, 'x.txt', 'orphan');
  assert.equal(fs.readFileSync(path.join(source, 'x.txt'), 'utf8'), 'user');
});

test('replay resumes a partial integration and path traversal or symlinks are denied', () => {
  const {source, dir} = setup(test);
  write(source, 'one.txt', 'one'); write(source, 'two.txt', 'two');
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['one.txt', 'two.txt'], attemptId: 'retry'}); write(workspace.cwd, 'one.txt', 'ONE'); write(workspace.cwd, 'two.txt', 'TWO');
  const artifact = captureArtifact(workspace);
  // Simulate a process dying after the first atomic rename and before it can persist its progress.
  fs.writeFileSync(path.join(source, 'one.txt'), 'ONE');
  assert.equal(fs.readFileSync(path.join(source, 'one.txt'), 'utf8'), 'ONE');
  assert.equal(integrateArtifact({cwd: source, dir, artifact}).status, 'integrated');
  assert.equal(fs.readFileSync(path.join(source, 'two.txt'), 'utf8'), 'TWO');
  assert.throws(() => createAttemptWorkspace({cwd: source, dir, owns: ['../escape'], attemptId: 'bad'}), /invalid/);
  fs.symlinkSync(path.join(source, 'one.txt'), path.join(source, 'link.txt'));
  assert.throws(() => createAttemptWorkspace({cwd: source, dir, owns: ['one.txt'], attemptId: 'symlink'}), /symlink/);
});

test('binary deltas are explicit unsupported artifacts and malicious integration paths are denied', () => {
  const {source, dir} = setup(test);
  write(source, 'safe.txt', 'safe');
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['safe.txt'], attemptId: 'binary'});
  fs.writeFileSync(path.join(workspace.cwd, 'safe.txt'), Buffer.from([0, 1, 2]));
  const artifact = captureArtifact(workspace);
  assert.deepEqual(artifact.unsupported, [{path: 'safe.txt', reason: 'binary'}]);
  assert.equal(integrateArtifact({cwd: source, dir, artifact}).status, 'unsupported');
  assert.throws(() => integrateArtifact({cwd: source, dir, artifact: {...artifact, unsupported: [], violations: [], changes: [{path: '../escape', kind: 'write', before: null, after: {hash: 'x', size: 1}, data: 'eA=='}]}}), /artifact digest mismatch/);
});

test('artifact diff contains actual old and new code, preserves executable mode, and glob ownership denies nonmatching edits', () => {
  const {source, dir} = setup(test);
  write(source, 'src/a.js', 'export const oldValue = 1;\n'); write(source, 'other.js', 'old');
  fs.chmodSync(path.join(source, 'src/a.js'), 0o755);
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['src/*.js'], attemptId: 'diff'});
  write(workspace.cwd, 'src/a.js', 'export const newValue = 2;\n'); fs.chmodSync(path.join(workspace.cwd, 'src/a.js'), 0o755);
  const artifact = captureArtifact(workspace);
  assert.match(artifact.diff, /oldValue/); assert.match(artifact.diff, /newValue/);
  assert.equal(integrateArtifact({cwd: source, dir, artifact}).status, 'integrated');
  assert.equal(fs.statSync(path.join(source, 'src/a.js')).mode & 0o111, 0o111);
  const denied = createAttemptWorkspace({cwd: source, dir, owns: ['src/*.js'], attemptId: 'glob'}); write(denied.cwd, 'other.js', 'bad');
  assert.equal(captureArtifact(denied).violations[0], 'other.js');
  assert.throws(() => createAttemptWorkspace({cwd: source, dir, owns: [], attemptId: 'empty'}), /invalid owns/);
});

test('dependency copies and output placement cannot mutate or recurse into the source; large same-size changes are explicit', () => {
  const {source, dir} = setup(test);
  write(source, 'node_modules/pkg/index.js', 'source dependency'); write(source, 'large.txt', 'a'.repeat(4 * 1024 * 1024 + 1));
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['large.txt'], attemptId: 'deps'});
  write(workspace.cwd, 'node_modules/pkg/index.js', 'workspace dependency');
  assert.equal(fs.readFileSync(path.join(source, 'node_modules/pkg/index.js'), 'utf8'), 'source dependency');
  write(workspace.cwd, 'large.txt', 'b'.repeat(4 * 1024 * 1024 + 1));
  const artifact = captureArtifact(workspace);
  assert.deepEqual(artifact.unsupported, [{path: 'large.txt', reason: 'large'}]);
  assert.throws(() => createAttemptWorkspace({cwd: source, dir: source, owns: ['large.txt'], attemptId: 'recursive'}), /outside source/);
});

test('a workspace reused after its artifact integrates diffs against the integrated state, not the pre-integration baseline', () => {
  const {source, dir} = setup(test);
  write(source, 'x.js', 'old');
  let workspace = createAttemptWorkspace({cwd: source, dir, owns: ['x.js'], attemptId: 'a'});
  write(workspace.cwd, 'x.js', 'from-a');
  const artifactA = captureArtifact(workspace);
  assert.equal(integrateArtifact({cwd: source, dir, artifact: artifactA}).status, 'integrated');
  assert.equal(fs.readFileSync(path.join(source, 'x.js'), 'utf8'), 'from-a');

  // Same physical workspace, reused for a retryOf follow-up. Without advancing the baseline this
  // collides with the checkout state A itself just wrote (the observed 18648f89/8b02db16 bug).
  write(workspace.cwd, 'x.js', 'from-a-and-b');
  const staleArtifact = captureArtifact(workspace);
  assert.equal(integrateArtifact({cwd: source, dir, artifact: staleArtifact}).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(source, 'x.js'), 'utf8'), 'from-a');

  workspace = advanceBaseline(workspace, artifactA);
  const persisted = JSON.parse(fs.readFileSync(path.join(workspace.cwd, '.attempt-workspace.json'), 'utf8'));
  assert.equal(persisted.baseline['x.js'].preview, 'from-a');
  const artifactB = captureArtifact(workspace);
  assert.equal(integrateArtifact({cwd: source, dir, artifact: artifactB}).status, 'integrated');
  assert.equal(fs.readFileSync(path.join(source, 'x.js'), 'utf8'), 'from-a-and-b');
});

test('advanceBaseline does not mask a genuine concurrent edit made outside the reused workspace', () => {
  const {source, dir} = setup(test);
  write(source, 'y.js', 'old');
  let workspace = createAttemptWorkspace({cwd: source, dir, owns: ['y.js'], attemptId: 'a'});
  write(workspace.cwd, 'y.js', 'from-a');
  const artifactA = captureArtifact(workspace);
  assert.equal(integrateArtifact({cwd: source, dir, artifact: artifactA}).status, 'integrated');
  workspace = advanceBaseline(workspace, artifactA);

  // Someone else edits the checkout directly after A integrated, before B's follow-up lands.
  write(source, 'y.js', 'someone-else');

  write(workspace.cwd, 'y.js', 'from-b');
  const artifactB = captureArtifact(workspace);
  assert.equal(integrateArtifact({cwd: source, dir, artifact: artifactB}).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(source, 'y.js'), 'utf8'), 'someone-else');
});
