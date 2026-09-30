import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validOwns} from './owned-paths.js';

const EXCLUDED = new Set(['.git', '.bounce', 'node_modules', '.attempt-workspace.json']);
const MAX_FILE = 4 * 1024 * 1024;
const PREVIEW_MAX = 4096; // what the baseline keeps of a file's text
const DIFF_FILE_MAX = 40_000; // one file's share of the text a review reads
const NOT_SHOWN_MAX = 40; // names of evidence and log files listed to a review
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => { const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); try { const b = Buffer.allocUnsafe(256 * 1024); for (let n; (n = fs.readSync(fd, b, 0, b.length, null));) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); } return h.digest('hex'); };
const json = value => Buffer.from(JSON.stringify(value));

function safePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) throw new Error('invalid path');
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error('invalid path');
  return normalized;
}

function ownList(owns) {
  if (!validOwns(owns) || owns.length === 0) throw new Error('invalid owns');
  return [...new Set(owns.map(safePath))];
}
function safeJoin(root, rel) {
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('path escapes root');
  return target;
}
function assertNoSymlink(root, rel) {
  let cursor = root;
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`symlink denied: ${rel}`);
  }
}
function manifest(root) {
  const files = {};
  const visit = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (EXCLUDED.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`symlink denied: ${rel}`);
      if (stat.isDirectory()) visit(full, rel);
      else if (stat.isFile()) {
        if (stat.size > MAX_FILE) files[rel] = {hash: fileHash(full), size: stat.size, mode: stat.mode & 0o777, unsupported: 'large'};
        else {
          const data = fs.readFileSync(full);
          files[rel] = {hash: hash(data), size: data.length, mode: stat.mode & 0o777, binary: data.includes(0), preview: data.includes(0) ? null : data.toString('utf8').slice(0, PREVIEW_MAX)};
        }
      }
    }
  };
  visit(root);
  return files;
}
const manifestHash = files => hash(json(files));
function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600); try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, file); const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

function copyTree(source, target) {
  fs.mkdirSync(target, {recursive: true, mode: 0o700});
  for (const entry of fs.readdirSync(source, {withFileTypes: true})) {
    if (entry.name === 'node_modules') { fs.cpSync(path.join(source, entry.name), path.join(target, entry.name), {recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE}); continue; }
    if (EXCLUDED.has(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) throw new Error(`symlink denied: ${entry.name}`);
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile()) fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}

// The real path of a directory that may not exist yet: its nearest existing ancestor resolved
// (macOS /var is /private/var), the missing tail appended.
function realAncestor(dir) {
  const resolved = path.resolve(dir);
  if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  const parent = path.dirname(resolved);
  return parent === resolved ? resolved : path.join(realAncestor(parent), path.basename(resolved));
}

// The copy gets its own git: a clone sharing the source's objects (no duplicated history, about a second),
// on the source's branch, with a baseline commit of the checkout as copied (see below). It has no remote, so nothing a worker does in git can reach the source, and
// .git is outside every manifest, so only file changes are ever integrated. A source that is not a git
// checkout, or a clone that fails, leaves the copy without git as before.
function giveGit(source, copy) {
  if (!fs.existsSync(path.join(source, '.git'))) return;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (cwd, ...args) => execFileSync('git', args, {cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  const staging = path.join(copy, `.git-clone-${crypto.randomUUID()}`);
  try {
    const head = git(source, 'rev-parse', '--verify', '-q', 'HEAD');
    let branch = '';
    try { branch = git(source, 'symbolic-ref', '--short', '-q', 'HEAD'); } catch {}
    git(copy, 'clone', '--shared', '--no-checkout', '--quiet', source, staging);
    fs.renameSync(path.join(staging, '.git'), path.join(copy, '.git'));
    git(copy, 'remote', 'remove', 'origin');
    if (branch) git(copy, 'update-ref', `refs/heads/${branch}`, head), git(copy, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
    else git(copy, 'update-ref', '--no-deref', 'HEAD', head);
    git(copy, 'reset', '--quiet');
    // What the copy leaves out on purpose (.bounce) would otherwise read as deleted in every `git status`.
    const omitted = execFileSync('git', ['ls-files', '-z', '--', '.bounce', ':(glob)**/.bounce/**'], {cwd: copy, env, stdio: ['ignore', 'pipe', 'ignore']});
    if (omitted.length) execFileSync('git', ['update-index', '--skip-worktree', '-z', '--stdin'], {cwd: copy, env, input: omitted, stdio: ['pipe', 'ignore', 'ignore']});
    fs.mkdirSync(path.join(copy, '.git', 'info'), {recursive: true});
    fs.appendFileSync(path.join(copy, '.git', 'info', 'exclude'), '\n/.attempt-workspace.json\n');
    // The checkout as the copy got it — the user's uncommitted edits included — becomes a baseline
    // commit, so `git status` starts clean and `git diff` is only the worker's own work. Found live (ACE
    // 36ecaacd, task 7bafef8e): a worker read the user's uncommitted edits as its own out-of-scope
    // changes and reverted them. Local identity, no hooks, no signing: the commit never leaves the copy.
    git(copy, 'add', '-A');
    git(copy, '-c', 'user.name=bounce', '-c', 'user.email=bounce@localhost', '-c', 'commit.gpgsign=false',
      'commit', '-q', '--no-verify', '--allow-empty', '-m', 'bounce: baseline of the checkout this copy was made from (its uncommitted changes included)');
  } catch {
    fs.rmSync(path.join(copy, '.git'), {recursive: true, force: true});
  } finally {
    fs.rmSync(staging, {recursive: true, force: true});
  }
}

function shortCopyDir(root) {
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  for (;;) {
    const dir = path.join(root, crypto.randomBytes(4).toString('hex'));
    try { fs.mkdirSync(dir, {mode: 0o700}); return dir; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}

// `copyRoot` puts the working copy at a short path of its own (<copyRoot>/<8 hex>) instead of under
// `dir`. Found live (ACE d1bc0206): a local model typing the default ~200-character path, three
// UUIDs deep, garbled it (`de83` for `dee3`, a doubled segment) and spent its steps on "File not found".
export function createAttemptWorkspace({cwd, dir, owns, attemptId, disposable = false, copyRoot}) {
  const source = fs.realpathSync(cwd);
  const allowed = ownList(owns);
  const resolvedDir = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
  const outputRelative = path.relative(source, resolvedDir);
  if (outputRelative === '' || (!outputRelative.startsWith(`..${path.sep}`) && outputRelative !== '..' && !path.isAbsolute(outputRelative))) throw new Error('workspace dir must be outside source');
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(attemptId)) throw new Error('invalid attempt id');
  if (copyRoot && !path.relative(source, realAncestor(copyRoot)).startsWith('..')) throw new Error('workspace dir must be outside source');
  const workspace = copyRoot ? shortCopyDir(copyRoot) : path.join(dir, 'workspaces', `${attemptId}-${crypto.randomUUID()}`);
  copyTree(source, workspace);
  giveGit(source, workspace);
  const baseline = manifest(workspace);
  const baselineHash = manifestHash(baseline);
  const result = {id: path.basename(workspace), attemptId, cwd: workspace, source, dir, owns: allowed, baseline, baselineHash, ...(disposable ? {disposable: true} : {})};
  atomicJSON(path.join(workspace, '.attempt-workspace.json'), {...result, cwd: undefined});
  return result;
}

const clipped = (value, max) => (value?.length > max ? `${value.slice(0, max)}\n[… truncated …]` : (value ?? ''));

// The file as it was before the worker changed it. The baseline keeps a hash and the first 4096
// characters only, so the content is read from the checkout the copy was made from, and used only
// while its hash is still the baseline's.
function contentBefore(source, change) {
  try {
    const data = fs.readFileSync(safeJoin(source, change.path));
    return hash(data) === change.before.hash ? data : null;
  } catch {
    return null;
  }
}

// The hunks of a line diff between two contents (null: no such file), made by git from two scratch
// files; null when no line differs or git could not do it.
function lineDiff(before, after) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-diff-'));
  try {
    const sides = [['before', before], ['after', after]].map(([name, data]) => {
      if (data === null) return '/dev/null';
      const file = path.join(scratch, name);
      fs.writeFileSync(file, data);
      return file;
    });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const result = spawnSync('git', ['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', '--', ...sides],
      {cwd: scratch, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']});
    const start = result.status === 1 && typeof result.stdout === 'string' ? result.stdout.indexOf('\n@@ ') : -1;
    return start < 0 ? null : result.stdout.slice(start + 1).replace(/\n$/, '');
  } catch {
    return null;
  } finally {
    fs.rmSync(scratch, {recursive: true, force: true});
  }
}

// What a review reads of one change: its real line diff. Found live (ACE d1bc0206, task 99bd27ea):
// this was the first 4096 characters of the old file and then of the new one, so a change past that
// point was never shown — of 121 lines a worker added to files of 33 KB and 40 KB, the review saw 1.
// A file whose earlier content cannot be read any more gets those previews, and says so.
function describeChange(source, change) {
  const removed = change.kind === 'delete';
  const header = `--- ${change.before ? `a/${change.path}` : '/dev/null'}\n+++ ${removed ? '/dev/null' : `b/${change.path}`}`;
  const after = removed ? null : Buffer.from(change.data, 'base64');
  const before = change.before ? contentBefore(source, change) : null;
  if (change.before && before === null) {
    const note = `[bounce could not read this file as it was before the change, so this is not a diff: the first ${PREVIEW_MAX} characters before (-) and after (+)]`;
    const sides = [`-${clipped(change.before.preview, PREVIEW_MAX)}`, ...(removed ? [] : [`+${clipped(after.toString('utf8'), PREVIEW_MAX)}`])];
    return {text: [header, note, ...sides].join('\n'), stat: null};
  }
  const hunks = lineDiff(before, after);
  if (hunks === null) return {text: `${header}\n[no line differs; the file's mode or an empty file changed]`, stat: {added: 0, removed: 0}};
  const marks = hunks.split('\n').map(line => line[0]);
  return {text: `${header}\n${clipped(hunks, DIFF_FILE_MAX)}`,
    stat: {added: marks.filter(mark => mark === '+').length, removed: marks.filter(mark => mark === '-').length}};
}

function describeChanges(source, changes) {
  const described = changes.map(change => ({path: change.path, ...describeChange(source, change)}));
  // The shortest change first: a review reads a bounded length of this text, and found live (ACE
  // e3bd01d5) long test logs under evidence/ came before, and hid, the source changes under src/.
  const shortestFirst = [...described].sort((left, right) => left.text.length - right.text.length || left.path.localeCompare(right.path));
  return {
    diff: shortestFirst.map(item => item.text).join('\n'),
    stats: Object.fromEntries(described.filter(item => item.stat).map(item => [item.path, item.stat])),
  };
}

// Evidence and logs a worker saved: a folder named evidence, log or logs anywhere in the path, or a
// file ending in .log.
const isEvidence = file => /(^|\/)(evidence|logs?)\//i.test(file) || /\.log$/i.test(file);

// An artifact's text, one piece per changed file. The pieces are found by their own header, and only
// a header naming a file the artifact changed counts, so a line of content cannot start a piece.
function diffParts(artifact) {
  const paths = new Set(artifact.changes.map(change => change.path));
  const header = /^--- (?:a\/(.+)|\/dev\/null)\n\+\+\+ (?:b\/(.+)|\/dev\/null)$/gm;
  const starts = [];
  for (const match of String(artifact.diff ?? '').matchAll(header)) {
    const file = match[1] ?? match[2];
    if (file && paths.has(file)) starts.push({file, at: match.index});
  }
  return starts.map((start, index) => ({
    path: start.file,
    text: artifact.diff.slice(start.at, index + 1 < starts.length ? starts[index + 1].at : undefined).replace(/\n$/, ''),
  }));
}

// What a review is sent: the changes without the evidence and logs the worker saved, which are named
// instead. Found live (ACE e3bd01d5): test logs made a review 75,000 to 750,000 characters long, the
// service refused 8 of 31, and a reviewer reads less well the more it is given that the decision
// does not need.
export function reviewDiff(artifact) {
  const parts = diffParts(artifact);
  const left = parts.filter(part => isEvidence(part.path));
  if (!left.length) return String(artifact.diff ?? '');
  const counted = file => {
    const stat = artifact.stats?.[file];
    return stat ? `${file} (+${stat.added} -${stat.removed})` : file;
  };
  const names = left.map(part => part.path).sort();
  const note = [`[Not shown: ${names.length} file${names.length === 1 ? '' : 's'} of evidence or logs the worker added or changed]`,
    ...names.slice(0, NOT_SHOWN_MAX).map(counted),
    ...(names.length > NOT_SHOWN_MAX ? [`and ${names.length - NOT_SHOWN_MAX} more`] : [])];
  return [...parts.filter(part => !isEvidence(part.path)).map(part => part.text), ...note].join('\n');
}

export function captureArtifact(workspace) {
  const result = manifest(workspace.cwd);
  const paths = [...new Set([...Object.keys(workspace.baseline), ...Object.keys(result)])].sort();
  const changes = [], unsupported = [];
  for (const file of paths) {
    const before = workspace.baseline[file] ?? null, after = result[file] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before?.unsupported || after?.unsupported || before?.binary || after?.binary) { unsupported.push({path: file, reason: before?.unsupported ?? after?.unsupported ?? 'binary'}); continue; }
    if (!after) changes.push({path: file, kind: 'delete', before});
    else changes.push({path: file, kind: 'write', before, after, data: fs.readFileSync(safeJoin(workspace.cwd, file)).toString('base64'), mode: after.mode});
  }
  const resultHash = manifestHash(result);
  // owns is a hint, not a fence (2026-09-29): every workspace owns everything, so nothing here is
  // ever a violation. `owns` and `violations` stay in the digest binding, in this exact order, so an
  // artifact captured by the old code (a narrower owns, a real violation) still verifies its digest —
  // see integrateArtifact, which still refuses to integrate one that carries a violation.
  const binding = {target: workspace.source, attemptId: workspace.attemptId, baselineHash: workspace.baselineHash, resultHash, owns: workspace.owns, changes, violations: [], unsupported};
  const digest = hash(json(binding));
  const id = digest.slice(0, 32);
  const artifact = {id, digest, ...binding, files: Object.keys(result).sort(), ...describeChanges(workspace.source, changes)};
  atomicJSON(path.join(workspace.dir, 'artifacts', `${id}.json`), artifact);
  return artifact;
}

export function targetState(root, change) {
  assertNoSymlink(root, change.path);
  const full = safeJoin(root, change.path);
  if (!fs.existsSync(full)) return null;
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) throw new Error(`unsupported target path: ${change.path}`);
  const data = fs.readFileSync(full);
  return {hash: hash(data), size: data.length, mode: stat.mode & 0o777};
}
export function matches(state, expected) { return state === null ? expected === null : expected !== null && state.hash === expected.hash && state.size === expected.size && state.mode === expected.mode; }
function writeAtomic(root, change) {
  const full = safeJoin(root, change.path); assertNoSymlink(root, change.path);
  if (change.kind === 'delete') { fs.rmSync(full, {force: true}); const parent = fs.openSync(path.dirname(full), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } return; }
  assertNoSymlink(root, path.posix.dirname(change.path));
  fs.mkdirSync(path.dirname(full), {recursive: true, mode: 0o700}); assertNoSymlink(root, change.path);
  const temp = `${full}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'w', change.mode ?? 0o600); try { fs.writeFileSync(fd, Buffer.from(change.data, 'base64')); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(temp, full); fs.chmodSync(full, change.mode ?? 0o600); const parent = fs.openSync(path.dirname(full), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

// A reused workspace (a retryOf attempt after its predecessor's artifact was already integrated)
// must diff against what's actually in the checkout now, not the pre-integration baseline it was
// copied from — otherwise its own unrelated edits collide with the checkout's own prior integration.
// Advance only the paths that were just integrated; a genuine concurrent edit of an untouched path
// still shows up against the recorded baseline for that path.
export function advanceBaseline(workspace, artifact) {
  const baseline = {...workspace.baseline};
  for (const change of artifact.changes) {
    if (change.kind === 'delete') delete baseline[change.path];
    else baseline[change.path] = change.after;
  }
  const baselineHash = manifestHash(baseline);
  const updated = {...workspace, baseline, baselineHash};
  atomicJSON(path.join(workspace.cwd, '.attempt-workspace.json'), {...updated, cwd: undefined});
  return updated;
}

export function integrateArtifact({cwd, artifact, dir}) {
  const root = fs.realpathSync(cwd);
  if (!artifact || !Array.isArray(artifact.changes)) throw new Error('invalid artifact');
  const binding = {target: artifact.target, attemptId: artifact.attemptId, baselineHash: artifact.baselineHash, resultHash: artifact.resultHash, owns: artifact.owns, changes: artifact.changes, violations: artifact.violations, unsupported: artifact.unsupported};
  if (typeof artifact.digest !== 'string' || artifact.id !== artifact.digest.slice(0, 32) || artifact.digest !== hash(json(binding))) throw new Error('artifact digest mismatch');
  if (artifact.target !== root) throw new Error('artifact target mismatch');
  // owns is no longer enforced (2026-09-29): a new artifact always owns everything, so this never
  // fires for one. An artifact captured by the old code can still carry a real violation — a change
  // outside its owns that was never folded in — and that artifact was never complete, so it is still
  // refused rather than integrated with a piece of its own capture missing.
  if (artifact.violations?.length) return {status: 'ownership_violation', paths: artifact.violations};
  if (artifact.unsupported?.length) return {status: 'unsupported', paths: artifact.unsupported};
  const recordFile = path.join(dir, 'integrations', `${artifact.id}.json`);
  const record = readJSON(recordFile) ?? {
    id: artifact.id, attemptId: artifact.attemptId, baselineHash: artifact.baselineHash,
    resultHash: artifact.resultHash, status: 'prepared', applied: [],
    manifest: artifact.changes.map(change => ({path: change.path, kind: change.kind, before: change.before, after: change.after})),
  };
  const applied = new Set(record.applied);
  for (const change of artifact.changes) {
    const state = targetState(root, change);
    const desired = change.kind === 'delete' ? null : change.after;
    if (matches(state, desired)) { applied.add(change.path); continue; }
    if (!matches(state, change.before)) return {status: 'conflict', path: change.path};
  }
  record.status = 'prepared'; record.applied = [...applied]; atomicJSON(recordFile, record);
  for (const change of artifact.changes) {
    if (applied.has(change.path)) continue;
    // Recheck after persisting the manifest, immediately before touching this path.
    // Another process may have edited it since the batch preflight.
    if (!matches(targetState(root, change), change.before)) return {status: 'conflict', path: change.path};
    writeAtomic(root, change); applied.add(change.path);
    record.applied = [...applied]; atomicJSON(recordFile, record);
  }
  record.status = 'integrated'; record.applied = [...applied]; atomicJSON(recordFile, record);
  return {status: 'integrated', id: artifact.id};
}
