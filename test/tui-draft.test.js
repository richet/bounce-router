// The prompt editor behaves the way fingers trained on a shell and on Claude Code expect
// (docs/ARCHITECTURE.md § TUI): kill and yank, undo, a history that outlives the session and can be
// searched, and a large paste that does not flood the draft.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {killLineEnd, killWordBackward, createUndo} from '../src/tui/editor.js';
import {createPromptHistory} from '../src/prompt-history.js';
import {collapsePaste, expandPastes} from '../src/tui/pastes.js';

test('Ctrl+K kills to the end of the line, Ctrl+W the word before the caret; each says what it took', () => {
  assert.deepEqual(killLineEnd('git commit -m wip\nnext', 4), {input: 'git \nnext', cursor: 4, killed: 'commit -m wip'});
  assert.deepEqual(killLineEnd('abc\ndef', 3), {input: 'abcdef', cursor: 3, killed: '\n'}, 'at a line end it joins the next line');
  assert.deepEqual(killWordBackward('run npm test', 12), {input: 'run npm ', cursor: 8, killed: 'test'});
  assert.deepEqual(killWordBackward('run npm test  ', 14), {input: 'run npm ', cursor: 8, killed: 'test  '});
});

test('undo walks back through drafts, newest first, and keeps no duplicate of an unchanged draft', () => {
  const undo = createUndo(3);
  undo.push({input: 'a', cursor: 1}); undo.push({input: 'a', cursor: 1}); undo.push({input: 'ab', cursor: 2});
  undo.push({input: 'abc', cursor: 3}); undo.push({input: 'abcd', cursor: 4});
  assert.deepEqual(undo.pop(), {input: 'abcd', cursor: 4});
  assert.deepEqual(undo.pop(), {input: 'abc', cursor: 3});
  assert.deepEqual(undo.pop(), {input: 'ab', cursor: 2});
  assert.equal(undo.pop(), null, 'capped at 3');
});

test('prompt history is kept per workspace across sessions, newest last, without duplicates or space-led prompts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-history-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const first = createPromptHistory({root, cwd: '/work/a', limit: 3});
  for (const prompt of ['one', 'two', ' secret token', 'two', 'three', 'four']) first.add(prompt);
  assert.deepEqual(first.entries(), ['two', 'three', 'four'], 'deduplicated, space-led prompt not kept, capped at 3');
  assert.deepEqual(createPromptHistory({root, cwd: '/work/a', limit: 3}).entries(), ['two', 'three', 'four'], 'a new session reads it back');
  assert.deepEqual(createPromptHistory({root, cwd: '/work/b'}).entries(), [], 'another workspace has its own');
  assert.deepEqual(first.search('t'), ['three', 'two'], 'Ctrl+R matches newest first');
  assert.deepEqual(first.search('ou'), ['four']);
});

test('a large paste is shown as one placeholder and sent in full', () => {
  const pastes = new Map();
  assert.equal(collapsePaste('short paste', pastes), 'short paste', 'a small paste goes in as typed');
  const big = Array.from({length: 312}, (_, n) => `line ${n}`).join('\n');
  const token = collapsePaste(big, pastes);
  assert.equal(token, '[Pasted text #1 · 312 lines]');
  assert.equal(collapsePaste('x'.repeat(2500), pastes), '[Pasted text #2 · 2500 chars]');
  assert.equal(expandPastes(`look at ${token} please`, pastes), `look at ${big} please`);
  assert.equal(expandPastes('[Pasted text #9 · 3 lines]', pastes), '[Pasted text #9 · 3 lines]', 'an unknown placeholder is left as typed');
});

// Found in the real-console pass 2026-10-21: a copied 40-line file ends in a newline, and the placeholder said 41.
test('a pasted block that ends in a newline counts the lines it has, not one more', () => {
  const pastes = new Map();
  assert.equal(collapsePaste(`${Array.from({length: 40}, (_, n) => n + 1).join('\n')}\n`, pastes), '[Pasted text #1 · 40 lines]');
});
