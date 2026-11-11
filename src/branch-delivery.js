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

// What every writer is told under branch delivery: its commits are the delivery. Orders that say not to commit (meant as
// "not on my branch") left every builder's copy dirty and every task refused as delivery_uncommitted (found live), so
// such orders are read the way the user meant them, and flagged for the orchestrator. Null outside branch delivery.
const FORBIDS_COMMIT = /\b(?:do\s+not|don'?t|never|no)\s+commit(?:s|ting)?\b|\buncommitted\b/i;
export function branchCommitNote(delivery, orders) {
  if (delivery !== 'branch') return null;
  const forbids = FORBIDS_COMMIT.test(String(orders ?? ''));
  const line = 'This project uses branch delivery: your work reaches the user only as commits. Commit your work on the branch checked out in your copy before you end (one plain line in the repo\'s commit style, no attribution), leave no uncommitted changes, and never push.'
    + (forbids ? ' Where your orders say not to commit, that means nothing on the user\'s own branches (main, master, the checkout\'s default, the branch they have checked out); commit in your copy.' : '');
  return {line, forbids};
}

const gitEnv = extra => ({...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), ...extra});

// The worker's own branch at its head, as the worker committed it. bounce commits nothing: a worker that left changes
// uncommitted, or no branch, is refused with an error identifier, and the copy is kept as it is.
export function deliverBranch({copy, checkout = null}) {
  const git = (...args) => execFileSync('git', args, {cwd: copy, env: gitEnv({}), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === 'HEAD') return {error: 'delivery_detached'};
  const dirty = execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {cwd: copy, env: gitEnv({}), encoding: 'utf8'})
    .split('\0').filter(Boolean).map(entry => entry.slice(3)).sort();
  if (dirty.length) return {error: 'delivery_uncommitted', paths: dirty};
  return {branch, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'), ...ignoredAdds(git, checkout)};
}

// Files the branch adds that the project's ignore rules match: committed with `git add -f`, they are not work the
// checkout wants (found live, 2026-11-05: 130 generated files under an ignored output folder rode in on a delivered branch).
function ignoredAdds(git, checkout) {
  if (!checkout) return {};
  try {
    const base = git('merge-base', 'HEAD', execFileSync('git', ['rev-parse', 'HEAD'], {cwd: checkout, env: gitEnv({}), encoding: 'utf8'}).trim());
    const added = git('diff', '--name-only', '--diff-filter=A', '-z', base, 'HEAD').split('\0').filter(Boolean);
    if (!added.length) return {};
    let ignored = '';
    try { ignored = execFileSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {cwd: checkout, env: gitEnv({}), input: added.join('\0'), encoding: 'utf8'}); }
    catch (error) { if (error.status !== 1) throw error; }
    const paths = ignored.split('\0').filter(Boolean);
    return paths.length ? {ignoredAdded: paths} : {};
  } catch { return {}; }
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
// can fetch it or continue there (found live, 2026-11-05: a builder hit the 60-minute limit with nothing
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
