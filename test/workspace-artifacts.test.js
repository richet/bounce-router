import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {createAttemptWorkspace, captureArtifact, integrateArtifact, advanceBaseline, reviewDiff} from '../src/workspace-artifacts.js';

// Matches src/workspace-artifacts.js's own hash(json(binding)) exactly, to build a legacy
// artifact's digest by hand (c, d below) without exporting the internal helpers.
const digestOf = binding => crypto.createHash('sha256').update(Buffer.from(JSON.stringify(binding))).digest('hex');

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

// owns is no longer enforced, so a change outside it is not a violation — only a real conflict
// (the checkout no longer matches what the copy started from) is ever refused. An orphan workspace
// that is never captured or integrated never touches the target either way. (Item b's scenario, two
// scheduler tasks whose owns overlap, is test/orchestration-contract.test.js's dedicated test below.)
test('overlapping edits to the same file conflict on the later integration; an unintegrated orphan workspace never modifies the target', () => {
  const {source, dir} = setup(test);
  write(source, 'x.txt', 'old'); write(source, 'outside.txt', 'old');
  const overlap = createAttemptWorkspace({cwd: source, dir, owns: ['x.txt'], attemptId: 'overlap'}); write(overlap.cwd, 'x.txt', 'worker'); write(source, 'x.txt', 'user');
  assert.equal(integrateArtifact({cwd: source, dir, artifact: captureArtifact(overlap)}).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(source, 'x.txt'), 'utf8'), 'user', 'the checkout keeps the content that was already there, not the refused change');
  const outside = createAttemptWorkspace({cwd: source, dir, owns: ['x.txt'], attemptId: 'outside'}); write(outside.cwd, 'outside.txt', 'now allowed');
  assert.equal(integrateArtifact({cwd: source, dir, artifact: captureArtifact(outside)}).status, 'integrated', 'owns is a hint: a change outside it integrates like any other');
  assert.equal(fs.readFileSync(path.join(source, 'outside.txt'), 'utf8'), 'now allowed');
  const orphan = createAttemptWorkspace({cwd: source, dir, owns: ['x.txt'], attemptId: 'orphan'}); write(orphan.cwd, 'x.txt', 'orphan');
  assert.equal(fs.readFileSync(path.join(source, 'x.txt'), 'utf8'), 'user', 'an orphan workspace that is never captured or integrated changes nothing');
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

test('artifact diff contains actual old and new code, preserves executable mode', () => {
  const {source, dir} = setup(test);
  write(source, 'src/a.js', 'export const oldValue = 1;\n'); write(source, 'other.js', 'old');
  fs.chmodSync(path.join(source, 'src/a.js'), 0o755);
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['src/*.js'], attemptId: 'diff'});
  write(workspace.cwd, 'src/a.js', 'export const newValue = 2;\n'); fs.chmodSync(path.join(workspace.cwd, 'src/a.js'), 0o755);
  const artifact = captureArtifact(workspace);
  assert.match(artifact.diff, /oldValue/); assert.match(artifact.diff, /newValue/);
  assert.equal(integrateArtifact({cwd: source, dir, artifact}).status, 'integrated');
  assert.equal(fs.statSync(path.join(source, 'src/a.js')).mode & 0o111, 0o111);
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

test('a copyRoot puts each working copy at <copyRoot>/<8 hex>, and its artifact still integrates', () => {
  const {source, dir} = setup(test);
  const copyRoot = path.join(path.dirname(dir), 'w');
  write(source, 'a.txt', 'old');
  const one = createAttemptWorkspace({cwd: source, dir, owns: ['a.txt'], attemptId: 'task-1', copyRoot});
  const two = createAttemptWorkspace({cwd: source, dir, owns: ['a.txt'], attemptId: 'task-2', copyRoot});
  assert.equal(path.dirname(one.cwd), copyRoot);
  assert.match(path.basename(one.cwd), /^[0-9a-f]{8}$/);
  assert.notEqual(one.cwd, two.cwd);
  write(one.cwd, 'a.txt', 'new');
  assert.equal(integrateArtifact({cwd: source, dir, artifact: captureArtifact(one)}).status, 'integrated');
  assert.equal(fs.readFileSync(path.join(source, 'a.txt'), 'utf8'), 'new');
  assert.throws(() => createAttemptWorkspace({cwd: source, dir, owns: ['**'], attemptId: 'inside', copyRoot: path.join(source, 'w')}), /outside source/);
});

// Found live (ACE 159f4746, task 92136dbf): the copy had no .git, so a worker that needed `git log` blocked
// with "not a git repository". Each copy now gets its own clone sharing the source's objects: git works in
// it, a commit there stays there, and only file changes are integrated.
test('a copy of a git checkout has its own git: history and status work, and its commits never reach the source', () => {
  const {source, dir} = setup(test);
  const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'}}).trim();
  git(source, 'init', '-q', '-b', 'main'); write(source, 'a.txt', 'one\n'); write(source, '.bounce/agents/builder.md', 'agent\n'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'First commit');
  write(source, 'a.txt', 'dirty\n');
  const sourceHead = git(source, 'rev-parse', 'HEAD');
  const copy = createAttemptWorkspace({cwd: source, dir, owns: ['**'], attemptId: 'git'});
  // Found live (ACE 36ecaacd, task 7bafef8e): with the user's uncommitted edits showing in `git status`, a
  // worker took them for its own out-of-scope changes and reverted them. The copy starts from a baseline
  // commit of the checkout as it was, so status is clean and `git diff` is only the worker's own work.
  assert.equal(git(copy.cwd, 'log', '--format=%s'), 'bounce: baseline of the checkout this copy was made from (its uncommitted changes included)\nFirst commit');
  assert.equal(git(copy.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(git(copy.cwd, 'status', '--porcelain'), '', 'nothing to see before the worker changes anything; the left-out .bounce is not "deleted"');
  assert.equal(git(copy.cwd, 'diff', '--name-only', 'HEAD~1', 'HEAD'), 'a.txt', 'the user\'s uncommitted edit is in the baseline, not in the worker\'s diff');
  assert.equal(git(copy.cwd, 'remote'), '', 'no remote to push back through');
  write(copy.cwd, 'b.txt', 'new\n'); git(copy.cwd, 'add', '.'); git(copy.cwd, 'commit', '-qm', 'Worker commit');
  assert.equal(git(source, 'rev-parse', 'HEAD'), sourceHead);
  assert.equal(git(source, 'status', '--porcelain'), 'M a.txt');
  const artifact = captureArtifact(copy);
  assert.deepEqual(artifact.changes.map(change => change.path), ['b.txt']);
  const plain = createAttemptWorkspace({cwd: path.join(source, '..', 'state'), dir: path.join(source, '..', 'other'), owns: ['**'], attemptId: 'plain'});
  assert.equal(fs.existsSync(path.join(plain.cwd, '.git')), false);
});

// Found live (ACE d1bc0206, task 99bd27ea): the text a review read was the first 4096 characters of
// the old file followed by the first 4096 of the new one. The worker's change sat past that point in
// two files of 33 KB and 40 KB: of 121 lines it added, the review was shown 1.
const longFile = change => Array.from({length: 400}, (_, index) => change(index + 1) ?? `export const line${index + 1} = ${index + 1};`).join('\n') + '\n';

test('the diff of a change deep in a long file is that change, with its line counts', () => {
  const {source, dir} = setup(test);
  write(source, 'src/long.js', longFile(() => null));
  write(source, 'src/gone.js', 'export const gone = 1;\nexport const also = 2;\n');
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['src/*.js'], attemptId: 'deep'});
  write(workspace.cwd, 'src/long.js', longFile(line => (line === 350 ? "export const line350 = 'changed';" : null)) + 'export const added = true;\n');
  write(workspace.cwd, 'src/new.js', 'export const fresh = 1;\n');
  fs.rmSync(path.join(workspace.cwd, 'src/gone.js'));

  const artifact = captureArtifact(workspace);

  assert.deepEqual(artifact.stats, {'src/gone.js': {added: 0, removed: 2}, 'src/long.js': {added: 2, removed: 1}, 'src/new.js': {added: 1, removed: 0}});
  const lines = artifact.diff.split('\n');
  // the shortest change first, so that a long one does not hide the others from a review
  assert.deepEqual(lines.filter(line => /^[+-]/.test(line)), [
    '--- /dev/null', '+++ b/src/new.js', '+export const fresh = 1;',
    '--- a/src/gone.js', '+++ /dev/null', '-export const gone = 1;', '-export const also = 2;',
    '--- a/src/long.js', '+++ b/src/long.js', '-export const line350 = 350;', "+export const line350 = 'changed';", '+export const added = true;',
  ]);
  assert.equal(lines.includes(' export const line349 = 349;'), true); // context around the change
  assert.equal(artifact.diff.includes('line10 = 10;'), false); // not the top of the file
  assert.equal(integrateArtifact({cwd: source, dir, artifact}).status, 'integrated');
});

// c: an artifact captured by the old code — a narrower owns, no violation — still integrates: its
// digest was computed over the same binding shape (owns and violations included, in this order),
// so it still verifies even though nothing here checks ownership any more. Built by hand rather
// than through captureArtifact, which never writes a real owns list or a violation any more.
test('c: an artifact captured by the old code, with a narrower owns and no violations, still integrates', () => {
  const {source, dir} = setup(test);
  write(source, 'src/a.js', 'old content\n');
  const before = fs.readFileSync(path.join(source, 'src/a.js'));
  const beforeState = {hash: crypto.createHash('sha256').update(before).digest('hex'), size: before.length, mode: fs.statSync(path.join(source, 'src/a.js')).mode & 0o777};
  const after = Buffer.from('new content\n');
  const afterState = {hash: crypto.createHash('sha256').update(after).digest('hex'), size: after.length, mode: beforeState.mode};
  const changes = [{path: 'src/a.js', kind: 'write', before: beforeState, after: afterState, data: after.toString('base64'), mode: afterState.mode}];
  const binding = {target: fs.realpathSync(source), attemptId: 'legacy-attempt', baselineHash: 'legacy-baseline', resultHash: 'legacy-result', owns: ['src/a.js'], changes, violations: [], unsupported: []};
  const digest = digestOf(binding);
  const artifact = {id: digest.slice(0, 32), digest, ...binding};
  const result = integrateArtifact({cwd: source, dir, artifact});
  assert.equal(result.status, 'integrated');
  assert.equal(fs.readFileSync(path.join(source, 'src/a.js'), 'utf8'), 'new content\n');
});

// d: an old artifact that DOES carry a violation (a change outside its owns that was never folded
// in) is not integrated — its capture was never complete, whatever owns means now.
test('d: an old artifact that carries a violation is refused with ownership_violation, not integrated', () => {
  const {source, dir} = setup(test);
  write(source, 'src/a.js', 'unchanged\n');
  const binding = {target: fs.realpathSync(source), attemptId: 'legacy-attempt-2', baselineHash: 'legacy-baseline', resultHash: 'legacy-result', owns: ['src/a.js'], changes: [], violations: ['other.js'], unsupported: []};
  const digest = digestOf(binding);
  const artifact = {id: digest.slice(0, 32), digest, ...binding};
  const result = integrateArtifact({cwd: source, dir, artifact});
  assert.deepEqual(result, {status: 'ownership_violation', paths: ['other.js']});
  assert.equal(fs.readFileSync(path.join(source, 'src/a.js'), 'utf8'), 'unchanged\n');
});

test('a file that changed in the checkout since the copy says its diff is only a preview', () => {
  const {source, dir} = setup(test);
  write(source, 'src/long.js', longFile(() => null));
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['src/*.js'], attemptId: 'moved'});
  write(workspace.cwd, 'src/long.js', longFile(line => (line === 350 ? 'export const line350 = 0;' : null)));
  write(source, 'src/long.js', 'the user rewrote it\n');

  const artifact = captureArtifact(workspace);

  assert.deepEqual(artifact.stats, {});
  assert.equal(artifact.diff.startsWith('--- a/src/long.js\n+++ b/src/long.js\n[bounce could not read this file as it was before the change, so this is not a diff: the first 4096 characters before (-) and after (+)]\n-export const line1 = 1;\n'), true);
});

// Found live (ACE e3bd01d5): 8 of 31 reviews were refused as too long, their diffs 75,000 to 750,000
// characters of test logs under evidence/. TypeSafe: "Accuracy falls as the state grows with content
// unrelated to the decision. Send only the fields the question needs."
test('what a review is sent leaves out evidence and logs, and names them', () => {
  const {source, dir} = setup(test);
  write(source, 'src/a.js', 'export const value = 1;\n');
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['**'], attemptId: 'review-text'});
  write(workspace.cwd, 'src/a.js', 'export const value = 2;\n');
  write(workspace.cwd, 'evidence/p6/final-gate/test-1.log', `${'ok line\n'.repeat(500)}`);
  write(workspace.cwd, 'evidence/p6/final-gate/report.md', 'VERDICT: PASS\n');
  write(workspace.cwd, 'build/logs/run.txt', 'started\n');
  write(workspace.cwd, 'docs/changelog.md', 'one line about logs and evidence\n');

  const artifact = captureArtifact(workspace);
  const shown = reviewDiff(artifact);

  assert.deepEqual(shown.split('\n').filter(line => /^(---|\+\+\+) /.test(line)), [
    '--- /dev/null', '+++ b/docs/changelog.md',
    '--- a/src/a.js', '+++ b/src/a.js',
  ]);
  assert.equal(shown.endsWith([
    '[Not shown: 3 files of evidence or logs the worker added or changed]',
    'build/logs/run.txt (+1 -0)',
    'evidence/p6/final-gate/report.md (+1 -0)',
    'evidence/p6/final-gate/test-1.log (+500 -0)',
  ].join('\n')), true, shown.slice(-400));
  assert.equal(shown.includes('ok line'), false);
  assert.equal(artifact.diff.includes('ok line'), true); // the artifact itself keeps everything
});

test('what a review is sent is the whole diff when nothing in it is evidence or a log', () => {
  const {source, dir} = setup(test);
  write(source, 'src/a.js', 'export const value = 1;\n');
  const workspace = createAttemptWorkspace({cwd: source, dir, owns: ['**'], attemptId: 'review-all'});
  write(workspace.cwd, 'src/a.js', 'export const value = 2;\n');
  const artifact = captureArtifact(workspace);
  assert.equal(reviewDiff(artifact), artifact.diff);
});
