// Found live (ACE e3bd01d5, 2026-09-29): 27 of 36 checks the orchestrator wrote only tested that a
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
    'cat README.md | grep -q bin/ace',
    'ls evidence/p6 ; wc -l evidence/p6/report.md',
  ]) assert.equal(weakCheck(command), true, command);
});

test('a check that runs anything of the work is not weak', () => {
  for (const command of [
    '/private/tmp/ace-deno/deno test -A tests/p6_fixture_pin_test.ts',
    'deno task test && deno task check && npm run lint',
    'ACE_DENO=/private/tmp/ace-deno/deno sh scripts/install-smoke.sh',
    'test -s evidence/report.md && sh scripts/p6-git-acceptance.sh',
    'PATH=/private/tmp/ace-deno:$PATH deno task check',
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
