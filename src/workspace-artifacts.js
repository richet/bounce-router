import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {ownedBy, validOwns} from './owned-paths.js';

const EXCLUDED = new Set(['.git', '.bounce', 'node_modules', '.attempt-workspace.json']);
const MAX_FILE = 4 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => { const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); try { const b = Buffer.allocUnsafe(256 * 1024); for (let n; (n = fs.readSync(fd, b, 0, b.length, null));) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); } return h.digest('hex'); };
const json = value => Buffer.from(JSON.stringify(value));

function safePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')) throw new Error('invalid path');
  const normalized = path.posix.normalize(value);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) throw new Error('invalid path');
  return normalized;
}

function ownsPath(owns, file) { return ownedBy(file, owns); }
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
          files[rel] = {hash: hash(data), size: data.length, mode: stat.mode & 0o777, binary: data.includes(0), preview: data.includes(0) ? null : data.toString('utf8').slice(0, 4096)};
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

export function createAttemptWorkspace({cwd, dir, owns, attemptId, disposable = false}) {
  const source = fs.realpathSync(cwd);
  const allowed = ownList(owns);
  const resolvedDir = fs.existsSync(dir) ? fs.realpathSync(dir) : path.resolve(dir);
  const outputRelative = path.relative(source, resolvedDir);
  if (outputRelative === '' || (!outputRelative.startsWith(`..${path.sep}`) && outputRelative !== '..' && !path.isAbsolute(outputRelative))) throw new Error('workspace dir must be outside source');
  if (typeof attemptId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(attemptId)) throw new Error('invalid attempt id');
  const workspace = path.join(dir, 'workspaces', `${attemptId}-${crypto.randomUUID()}`);
  copyTree(source, workspace);
  const baseline = manifest(workspace);
  const baselineHash = manifestHash(baseline);
  const result = {id: path.basename(workspace), attemptId, cwd: workspace, source, dir, owns: allowed, baseline, baselineHash, ...(disposable ? {disposable: true} : {})};
  atomicJSON(path.join(workspace, '.attempt-workspace.json'), {...result, cwd: undefined});
  return result;
}

export function captureArtifact(workspace) {
  const result = manifest(workspace.cwd);
  const paths = [...new Set([...Object.keys(workspace.baseline), ...Object.keys(result)])].sort();
  const changes = [], violations = [], unsupported = [], violationChanges = [];
  for (const file of paths) {
    const before = workspace.baseline[file] ?? null, after = result[file] ?? null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (!ownsPath(workspace.owns, file)) {
      violations.push(file);
      // A violation is not automatically unsafe (see extendOwnership): keep the full change
      // alongside the bare path so a caller who decides it is safe can promote it without a
      // second capture. Binary/large content has no readable diff either way, so it is left
      // out here exactly as the owned path below excludes it from `changes` — it stays a plain,
      // non-promotable violation.
      if (!(before?.unsupported || after?.unsupported || before?.binary || after?.binary)) {
        violationChanges.push(!after ? {path: file, kind: 'delete', before}
          : {path: file, kind: 'write', before, after, data: fs.readFileSync(safeJoin(workspace.cwd, file)).toString('base64'), mode: after.mode});
      }
      continue;
    }
    if (before?.unsupported || after?.unsupported || before?.binary || after?.binary) { unsupported.push({path: file, reason: before?.unsupported ?? after?.unsupported ?? 'binary'}); continue; }
    if (!after) changes.push({path: file, kind: 'delete', before});
    else changes.push({path: file, kind: 'write', before, after, data: fs.readFileSync(safeJoin(workspace.cwd, file)).toString('base64'), mode: after.mode});
  }
  const resultHash = manifestHash(result);
  const binding = {target: workspace.source, attemptId: workspace.attemptId, baselineHash: workspace.baselineHash, resultHash, owns: workspace.owns, changes, violations, unsupported};
  const digest = hash(json(binding));
  const id = digest.slice(0, 32);
  const show = value => value?.length > 4096 ? `${value.slice(0, 4096)}\n[… truncated …]` : (value ?? '');
  const artifact = {id, digest, ...binding, files: Object.keys(result).sort(), violationChanges,
    diff: changes.map(change => change.kind === 'delete' ? `--- a/${change.path}\n+++ /dev/null\n-${show(change.before?.preview)}` : `--- a/${change.path}\n+++ b/${change.path}\n-${show(change.before?.preview)}\n+${show(Buffer.from(change.data, 'base64').toString('utf8'))}`).join('\n')};
  atomicJSON(path.join(workspace.dir, 'artifacts', `${id}.json`), artifact);
  return artifact;
}

// A change outside `owns` is not automatically unsafe — only the whole-artifact refusal used to
// treat it that way (found live, ACE session 159f4746 task d59ce7f5: a green fix blocked on a
// two-line change to an unowned file, and a retryOf could not widen `owns` to recover). The
// caller (scheduler.js) decides which violation paths are safe to fold in — untouched in the real
// checkout since this attempt's baseline, and not claimed by any other active task — and promotes
// only those here. Promoting recomputes the digest/id (owns, changes and violations all changed)
// and re-persists the artifact under its new id so replay and the integrate action's file lookup
// see the extended version; the original capture is left on disk, untouched.
export function extendOwnership({artifact, dir, paths}) {
  const set = new Set(paths);
  if (!set.size) return artifact;
  const promoted = (artifact.violationChanges ?? []).filter(change => set.has(change.path));
  if (promoted.length !== set.size) throw new Error('unknown or unpromotable violation path');
  const changes = [...artifact.changes, ...promoted].sort((a, b) => a.path.localeCompare(b.path));
  const violations = artifact.violations.filter(p => !set.has(p));
  const violationChanges = (artifact.violationChanges ?? []).filter(change => !set.has(change.path));
  const owns = [...new Set([...artifact.owns, ...paths])];
  const binding = {target: artifact.target, attemptId: artifact.attemptId, baselineHash: artifact.baselineHash, resultHash: artifact.resultHash, owns, changes, violations, unsupported: artifact.unsupported};
  const digest = hash(json(binding));
  const id = digest.slice(0, 32);
  const show = value => value?.length > 4096 ? `${value.slice(0, 4096)}\n[… truncated …]` : (value ?? '');
  const extended = {...artifact, ...binding, id, digest, violationChanges,
    diff: changes.map(change => change.kind === 'delete' ? `--- a/${change.path}\n+++ /dev/null\n-${show(change.before?.preview)}` : `--- a/${change.path}\n+++ b/${change.path}\n-${show(change.before?.preview)}\n+${show(Buffer.from(change.data, 'base64').toString('utf8'))}`).join('\n')};
  atomicJSON(path.join(dir, 'artifacts', `${id}.json`), extended);
  return extended;
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
  if (artifact.violations?.length) return {status: 'ownership_violation', paths: artifact.violations};
  if (artifact.unsupported?.length) return {status: 'unsupported', paths: artifact.unsupported};
  const allowed = ownList(artifact.owns ?? []);
  if (artifact.changes.some(change => !change || !ownsPath(allowed, safePath(change.path)))) return {status: 'ownership_violation'};
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
