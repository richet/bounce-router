import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
  backspace, deleteForward, deleteWordBackward, deleteWordForward, insertText,
  moveCursor, moveLineEnd, moveLineStart, moveVertical, moveWord,
} from '../src/tui/editor.js';

test('editor inserts and deletes at the UTF-16 cursor without splitting graphemes', () => {
  assert.deepEqual(insertText('ac', 1, 'b'), {input: 'abc', cursor: 2});
  assert.deepEqual(insertText('a👍🏽b', 2, 'x'), {input: 'ax👍🏽b', cursor: 2});
  assert.deepEqual(backspace('a👍🏽b', 5), {input: 'ab', cursor: 1});
  assert.deepEqual(deleteForward('a👍🏽b', 1), {input: 'ab', cursor: 1});
});

test('editor cursor movement is grapheme-safe and stays within the input', () => {
  assert.equal(moveCursor('a👍🏽b', 1, 'right'), 5);
  assert.equal(moveCursor('a👍🏽b', 5, 'left'), 1);
  assert.equal(moveCursor('abc', -10, 'left'), 0);
  assert.equal(moveCursor('abc', 99, 'right'), 3);
});

test('editor provides line and word navigation and deletion', () => {
  assert.equal(moveLineStart('one\ntwo', 6), 4);
  assert.equal(moveLineEnd('one\ntwo', 4), 7);
  assert.equal(moveWord('one, two', 0, 'right'), 3);
  assert.equal(moveWord('one, two', 8, 'left'), 5);
  assert.deepEqual(deleteWordBackward('one, two', 8), {input: 'one, ', cursor: 5});
  assert.deepEqual(deleteWordForward('one, two', 0), {input: ', two', cursor: 0});
});

test('editor moves a multiline caret vertically without changing the draft', () => {
  const input = 'alpha\nxy\nlonger';
  assert.deepEqual(moveVertical(input, 4, 'down'), {cursor: 8, column: 4});
  assert.deepEqual(moveVertical(input, 8, 'down', 4), {cursor: 13, column: 4});
  assert.deepEqual(moveVertical(input, 13, 'up', 4), {cursor: 8, column: 4});
  assert.equal(input, 'alpha\nxy\nlonger');
});

test('the live CLI routes normal keys and bracketed paste through the cursor editor', {timeout: 10000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-cursor-cli-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    order: ['codex'], mode: 'plan', models: {}, executables: {codex: path.join(root, 'missing-codex')}, contextChars: 48000,
    cooldownMinutes: 30, skills: {scope: 'project', autoSync: false},
  }));
  const child = fork(fileURLToPath(new URL('./helpers/tui-process.js', import.meta.url)), [], {
    cwd: root,
    env: {...process.env, BOUNCE_HOME: root, BOUNCE_SUPERVISED: '1', BOUNCE_NO_UPDATE_CHECK: '1', FORCE_COLOR: '0'},
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGKILL');
    if (child.exitCode === null) await new Promise(resolve => child.once('close', resolve));
    fs.rmSync(root, {recursive: true, force: true});
  });
  const waitFor = async check => {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > 4000) throw new Error(`Timed out waiting for CLI output:\n${output.slice(-2000)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  await waitFor(() => output.includes('Ready.'));
  child.stdin.write('ac\x1b[D\x1b[200~b\x1b[201~');
  await waitFor(() => output.includes('abc'));
});
