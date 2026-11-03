// bounce bindings update: a newer release of a model an agent names is found by its name in what the vendor CLIs
// report, suggested, and with --save written into the bindings file in use, keeping its comments and order.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {bindingsCommand, bindingUpdates, bindingUpdatesNotice, modelVersion} from '../src/bindings.js';

const FILE = `# Who plays each agent.
agents:
  builder: [auto, qwen_builder, claude/sonnet, codex/gpt-5.6-terra, codex/gpt-6.1-sol]
  reviewer: [auto, qwen_reviewer, codex/gpt-6.1-terra, codex/gpt-5.6-terra]
  scout: [auto, claude/haiku, codex/gpt-6-luna]
`;
function dirs(t, {project = FILE, models = 'qwen_builder: lmstudio/qwen3.8-27b\nqwen_reviewer: lmstudio/qwen3.8-27b\n'} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-bindcmd-root-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-bindcmd-cwd-'));
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  fs.writeFileSync(path.join(root, 'models.yaml'), models);
  if (project !== null) { fs.mkdirSync(path.join(cwd, '.bounce')); fs.writeFileSync(path.join(cwd, '.bounce', 'bindings.yml'), project); }
  return {root, cwd, file: path.join(cwd, '.bounce', 'bindings.yml'), read: () => fs.readFileSync(path.join(cwd, '.bounce', 'bindings.yml'), 'utf8')};
}

const CATALOGS = [
  {provider: 'codex', models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(id => ({id}))},
  {provider: 'claude', models: ['default', 'opus', 'sonnet', 'haiku', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8'].map(id => ({id}))},
];

test('a model id is a family and a version; an alias with no version has none', () => {
  assert.deepEqual(modelVersion('gpt-5.6-terra'), {family: 'gpt-terra', version: [5, 6]});
  assert.deepEqual(modelVersion('gpt-6.1-terra'), {family: 'gpt-terra', version: [6, 1]});
  assert.deepEqual(modelVersion('claude-opus-4-8'), {family: 'claude-opus', version: [4, 8]});
  assert.deepEqual(modelVersion('claude-fable-5-1[1m]'), {family: 'claude-fable[1m]', version: [5, 1]});
  assert.equal(modelVersion('sonnet'), null);
  assert.equal(modelVersion('qwen3.8-27b'), null, 'a local build name is not read as a release');
});

test('update finds the newest release of the same family a CLI reports, never another family or tier', () => {
  const updates = bindingUpdates({
    builder: ['auto', 'qwen', 'claude/sonnet', 'codex/gpt-5.6-terra', 'codex/gpt-6.1-sol'],
    critic: ['claude/claude-opus-4-8', 'codex/gpt-5.6-luna'],
    local: ['lmstudio/qwen3.8-27b'],
  }, CATALOGS);
  assert.deepEqual(updates, [
    {agent: 'builder', from: 'codex/gpt-5.6-terra', to: 'codex/gpt-6.1-terra'},
    {agent: 'critic', from: 'claude/claude-opus-4-8', to: 'claude/claude-opus-5'},
    {agent: 'critic', from: 'codex/gpt-5.6-luna', to: 'codex/gpt-6-luna'},
  ]);
  assert.match(bindingUpdatesNotice(updates), /codex\/gpt-5\.6-terra → codex\/gpt-6\.1-terra, claude\/claude-opus-4-8 → claude\/claude-opus-5/);
  assert.equal(bindingUpdatesNotice([]), null);
});

test('update only lists; --save rewrites those entries in place, keeping the comments, and drops one already superseded', t => {
  const d = dirs(t);
  const before = d.read();
  const listed = bindingsCommand(['update'], {root: d.root, cwd: d.cwd, catalogs: CATALOGS});
  assert.equal(d.read(), before, 'nothing written without --save');
  assert.match(listed.text, /builder: codex\/gpt-5\.6-terra → codex\/gpt-6\.1-terra/);
  assert.match(listed.text, /--save applies them/);
  const saved = bindingsCommand(['update'], {root: d.root, cwd: d.cwd, catalogs: CATALOGS, save: true});
  assert.equal(saved.report.saved, true);
  assert.match(d.read(), /^# Who plays each agent\./);
  assert.match(d.read(), /builder: \[ auto, qwen_builder, claude\/sonnet, codex\/gpt-6\.1-terra, codex\/gpt-6\.1-sol \]/);
  assert.match(d.read(), /reviewer: \[ auto, qwen_reviewer, codex\/gpt-6\.1-terra \]/);
  assert.match(d.read(), /scout: \[ auto, claude\/haiku, codex\/gpt-6-luna \]/);
  assert.match(bindingsCommand(['update'], {root: d.root, cwd: d.cwd, catalogs: CATALOGS}).text, /its family's newest/);
});

test('update says which CLI it could not read; list shows the chains; no file in use is said plainly', t => {
  const d = dirs(t);
  const {text} = bindingsCommand(['update'], {root: d.root, cwd: d.cwd, catalogs: [{provider: 'codex', models: [], error: 'codex CLI not installed'}]});
  assert.match(text, /codex not checked: codex CLI not installed/);
  assert.match(bindingsCommand([], {root: d.root, cwd: d.cwd}).text, /bindings\.yml \(project\)\n  builder\s+auto, qwen_builder, claude\/sonnet/);
  const none = dirs(t, {project: null});
  assert.match(bindingsCommand(['update'], {root: none.root, cwd: none.cwd, catalogs: CATALOGS}).text, /No bindings\.yml in use/);
});
