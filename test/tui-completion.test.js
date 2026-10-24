// Completion the way a modern prompt does it (docs/plans/interactive-polish.md step 5): slash commands match
// fuzzily, and `@` completes a path in the workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {completions, mentionAt} from '../src/terminal.js';
import {matchFiles, workspaceFiles} from '../src/tui/files.js';

test('slash commands match by prefix first, then by letters in order', () => {
  assert.deepEqual(completions('/con').map(([name]) => name).slice(0, 2), ['config', 'continue']);
  assert.equal(completions('/cfg')[0][0], 'config');
  assert.equal(completions('/sts')[0][0], 'stats');
  assert.deepEqual(completions('/zzz'), []);
  assert.deepEqual(completions('/config x'), [], 'an argument ends completion');
});

test('mentionAt finds the @word the caret is in, only at a word start', () => {
  assert.deepEqual(mentionAt('look at @src/tu', 15), {start: 8, end: 15, query: 'src/tu'});
  assert.deepEqual(mentionAt('@', 1), {start: 0, end: 1, query: ''});
  assert.equal(mentionAt('mail me@example.com', 19), null, 'an @ inside a word is not a mention');
  assert.equal(mentionAt('look at @src now', 16), null, 'the caret has left the mention');
});

test('matchFiles ranks a file-name start over a path match over scattered letters, shorter first', () => {
  const files = ['src/tui/selection.js', 'test/tui-selection.test.js', 'src/scheduler.js', 'docs/plans/selection-notes.md', 'src/core.js'];
  assert.deepEqual(matchFiles(files, 'sel').slice(0, 3), ['src/tui/selection.js', 'docs/plans/selection-notes.md', 'test/tui-selection.test.js']);
  assert.equal(matchFiles(files, 'tui/sel')[0], 'src/tui/selection.js');
  assert.equal(matchFiles(files, 'schjs')[0], 'src/scheduler.js', 'letters in order');
  assert.equal(matchFiles(files, '').length, 5);
});

test('workspaceFiles lists git\'s tracked and untracked files, not ignored ones; outside git it walks the folder', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-files-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  fs.mkdirSync(path.join(dir, 'src')); fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'src/a.js'), ''); fs.writeFileSync(path.join(dir, 'node_modules/x.js'), ''); fs.writeFileSync(path.join(dir, 'notes.md'), '');
  assert.deepEqual(workspaceFiles(dir, {fresh: true}).sort(), ['notes.md', 'src/a.js'], 'the walk skips node_modules');
  execFileSync('git', ['init', '-q'], {cwd: dir});
  fs.writeFileSync(path.join(dir, '.gitignore'), 'notes.md\nnode_modules\n');
  assert.deepEqual(workspaceFiles(dir, {fresh: true}).sort(), ['.gitignore', 'src/a.js']);
});
