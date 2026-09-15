// Bounce owns what `npm run baseline` did by hand: a checkpoint captures the tree state (via
// gitSnapshot) plus a verified test/check result, so dispatch can refuse to launch a worker
// against a tree that has since drifted from the one the task was submitted under.
import {spawnSync} from 'node:child_process';
import {gitSnapshot} from './core.js';

export function defaultRunner(cmd, args, cwd, timeout) {
  const result = spawnSync(cmd, args, {cwd, encoding: 'utf8', timeout});
  return {status: result.status, stdout: result.stdout ?? ''};
}

// tests is only ever a complete {pass, total, fail} or null — never a partial object, since a
// truncated/failed run cannot be trusted to mean zero.
function parseTests(stdout) {
  const pass = stdout.match(/^# pass (\d+)/m);
  const total = stdout.match(/^# tests (\d+)/m);
  const fail = stdout.match(/^# fail (\d+)/m);
  if (!pass || !total || !fail) return null;
  return {pass: Number(pass[1]), total: Number(total[1]), fail: Number(fail[1])};
}

export async function takeCheckpoint({cwd, run = defaultRunner, git = gitSnapshot, timeout = 120000}) {
  const {head, status, diff} = git(cwd);
  let tests = null;
  try { tests = parseTests((await run('npm', ['test'], cwd, timeout)).stdout ?? ''); }
  catch { tests = null; }
  let check = null;
  try { check = (await run('npm', ['run', 'check'], cwd, timeout)).status === 0 ? 'ok' : 'fail'; }
  catch { check = null; }
  return {head, status, diff, tests, check};
}

// Pure: only head/status/diff decide tree identity. tests/check are informational and never
// compared — a checkpoint's own verified result stands even if a later re-check differs.
export function sameTree(a, b) {
  return a?.head === b?.head && a?.status === b?.status && a?.diff === b?.diff;
}
