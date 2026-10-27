// Found live (session e3bd01d5, 2026-09-29): 27 of 36 checks the orchestrator wrote only tested that a
// file or a phrase exists, such as `test -s …/report.md && grep -q '^VERDICT: PASS' …/report.md`.
// The local builder passed them with false reports: 6 of its 8 accepted results under such a check
// were corrected afterwards, and none of its results under a check that runs the work.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {weakCheck, runCheck} from '../src/task-check.js';

test('a check that only looks for files or text is weak', () => {
  for (const command of [
    'test -s evidence/p6/report.md',
    'test -s evidence/p6/report.md && test -s evidence/p6/commands.log',
    "sh -n scripts/p6-git-acceptance.sh && /usr/bin/grep -q '^VERDICT: PASS' evidence/p6/acceptance/git/report.md",
    "rg -q '^Verdict: PASS$' evidence/report.md",
    '[ -f README.md ]',
    'cat README.md | grep -q bin/app',
    'ls evidence/p6 ; wc -l evidence/p6/report.md',
  ]) assert.equal(weakCheck(command), true, command);
});

test('a check that runs anything of the work is not weak', () => {
  for (const command of [
    '/private/tmp/app-deno/deno test -A tests/p6_fixture_pin_test.ts',
    'deno task test && deno task check && npm run lint',
    'APP_DENO=/private/tmp/app-deno/deno sh scripts/install-smoke.sh',
    'test -s evidence/report.md && sh scripts/p6-git-acceptance.sh',
    'PATH=/private/tmp/app-deno:$PATH deno task check',
    'grep new src/x.js || { echo "src/x.js does not say new"; exit 3; }',
    'npm test',
  ]) assert.equal(weakCheck(command), false, command);
});

test('the result of a weak check says so', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-weak-check-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  fs.writeFileSync(path.join(cwd, 'report.md'), 'VERDICT: PASS\n');

  const weak = await runCheck({command: "test -s report.md && grep -q '^VERDICT: PASS' report.md", cwd, env: process.env});
  const strong = await runCheck({command: 'sh -c "exit 0"', cwd, env: process.env});

  assert.deepEqual([weak.passed, weak.weak], [true, true]);
  assert.deepEqual([strong.passed, strong.weak ?? false], [true, false]);
});

// A check whose shell has exited but left a process outside its group holding stdout open (a daemon, a container
// runtime, anything started with setsid) ran nothing more, yet its pipes never closed: the check waited on them
// forever and the task said "Running the task's check" with no process behind it. The shell's exit ends the check.
test('a check ends when its shell exits, even while something it left behind holds its output open', {timeout: 8000}, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-check-orphan-'));
  const pidFile = path.join(cwd, 'orphan.pid');
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch {} fs.rmSync(cwd, {recursive: true, force: true}); });
  const orphan = `${JSON.stringify(process.execPath)} -e "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync('orphan.pid',String(c.pid));c.unref()"`;
  const started = Date.now();
  const result = await runCheck({command: `${orphan}; echo checked`, cwd, env: process.env, timeoutMs: 60_000});
  assert.equal(result.passed, true);
  assert.equal(result.exit, 0);
  assert.match(result.output, /checked/);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('a check past its time ends even when what holds its output is outside its group', {timeout: 8000}, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-check-orphan-'));
  const pidFile = path.join(cwd, 'orphan.pid');
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch {} fs.rmSync(cwd, {recursive: true, force: true}); });
  const orphan = `${JSON.stringify(process.execPath)} -e "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:['ignore',1,2]});require('fs').writeFileSync('orphan.pid',String(c.pid));c.unref()"`;
  const result = await runCheck({command: `${orphan}; sleep 30`, cwd, env: process.env, timeoutMs: 500});
  assert.equal(result.passed, false);
  assert.equal(result.timedOut, true);
});
