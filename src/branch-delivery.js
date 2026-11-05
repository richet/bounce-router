// Branch delivery (docs/plans/branch-delivery.md): a checkout whose local git config says `bounce.delivery = branch`
// never has accepted work written into it. bounce reports the worker's own branch in its copy, and the user fetches
// it from there. The setting lives in .git/config so nothing about bounce is tracked in the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const DELIVERIES = ['checkout', 'branch'];

// {delivery} or {error}. No setting means "checkout", the old behaviour.
export function readDelivery(cwd) {
  let value;
  try {
    value = execFileSync('git', ['config', '--get', 'bounce.delivery'], {cwd, env: gitEnv({}), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
  } catch (error) {
    if (error.status === 1) return {delivery: 'checkout'};
    return {error: `git config bounce.delivery cannot be read (exit ${error.status ?? error.code})`};
  }
  if (!DELIVERIES.includes(value)) return {error: `git config bounce.delivery is "checkout" or "branch", not ${JSON.stringify(value)}`};
  return {delivery: value};
}

const gitEnv = extra => ({...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), ...extra});

// The worker's own branch at its head, as the worker committed it. bounce commits nothing: a worker that left changes
// uncommitted, or no branch, is refused with an error identifier, and the copy is kept as it is.
export function deliverBranch({copy}) {
  const git = (...args) => execFileSync('git', args, {cwd: copy, env: gitEnv({}), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') return {error: 'delivery_detached'};
  const dirty = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {cwd: copy, env: gitEnv({}), encoding: 'utf8'})
    .split('\0').filter(Boolean).map(entry => entry.slice(3)).sort();
  if (dirty.length) return {error: 'delivery_uncommitted', paths: dirty};
  return {branch, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}')};
}

// True when the checkout already has the delivered commit (it was fetched or merged).
export function reachedCheckout({checkout, head}) {
  try {
    execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], {cwd: checkout, env: gitEnv({}), stdio: 'ignore'});
    return true;
  } catch { return false; }
}

// A task that ends unfinished (deadline, cancel) may leave uncommitted work in its copy. It is saved as a commit on
// refs/wip/<task8> in that copy, on top of its HEAD, without touching its branch, index or files, so a follow-up
// can fetch it or continue there (kb control, 2026-11-05, eb26873e: a builder hit the 60-minute limit with nothing
// committed). Null when the copy has nothing uncommitted.
export function saveWip({copy, task}) {
  const run = (args, env = {}) => execFileSync('git', args, {cwd: copy, env: gitEnv({GIT_AUTHOR_NAME: 'wip', GIT_AUTHOR_EMAIL: 'wip@localhost', GIT_COMMITTER_NAME: 'wip', GIT_COMMITTER_EMAIL: 'wip@localhost', ...env}), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const files = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {cwd: copy, env: gitEnv({}), encoding: 'utf8'}).split('\0').filter(Boolean).length;
  if (!files) return null;
  const index = path.join(os.tmpdir(), `wip-index-${process.pid}-${randomUUID()}`);
  try {
    const head = run(['rev-parse', '--verify', '-q', 'HEAD']);
    run(['read-tree', 'HEAD'], {GIT_INDEX_FILE: index});
    run(['add', '-A'], {GIT_INDEX_FILE: index});
    const tree = run(['write-tree'], {GIT_INDEX_FILE: index});
    const commit = run(['commit-tree', tree, '-p', head, '-m', `wip: unfinished work of task ${task.slice(0, 8)}`]);
    const ref = `refs/wip/${task.slice(0, 8)}`;
    run(['update-ref', ref, commit]);
    return {ref, commit, head, tree, files};
  } finally { fs.rmSync(index, {force: true}); }
}
