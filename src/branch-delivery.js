// Branch delivery (docs/plans/branch-delivery.md): a checkout whose local git config says `bounce.delivery = branch`
// never has accepted work written into it. bounce reports the worker's own branch in its copy, and the user fetches
// it from there. The setting lives in .git/config so nothing about bounce is tracked in the project.
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
