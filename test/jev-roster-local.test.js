// Local models in Jev's roster. Found live: three quite different local models were all `cheapest`,
// because only the daemon's setup would ever describe them and `/jev roster` did not know they exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {jevCommand} from '../src/jev-command.js';
import {setupPrompt, readRosterNotes} from '../src/roster-notes.js';

const model = (id, context) => ({id, ref: `lmstudio/${id}`, type: 'llm', tools: true, ready: true, instances: [{id, context}], context});
const discover = async () => [{provider: 'local', backend: 'lmstudio', endpoint: 'lmstudio', models: [model('coder-30b-a3b', 32768), model('dense-27b', 262144)]}];
const answering = (text, calls = []) => async args => { calls.push(args); args.emit({kind: 'assistant', text}); args.emit({kind: 'result', text, success: true}); return {status: 'completed', code: 0}; };

test('the describing prompt shows what is already rated, so a new model is placed on the same scale and not only against its neighbours', () => {
  const prompt = setupPrompt([{key: 'lmstudio/dense-27b', adapter: 'opencode', model: 'dense-27b', endpoint: 'lmstudio'}], [], [['claude/opus', 'strongest'], ['claude/haiku', 'cheapest']]);
  assert.match(prompt, /^Already rated, for scale — place the models below on this same scale:\n  claude\/opus → strongest\n  claude\/haiku → cheapest$/m);
  assert.equal(setupPrompt([{key: 'claude/x', adapter: 'claude', model: 'x'}], []).includes('Already rated'), false);
});

test('/jev roster lists the local models beside the profiles, and refresh has the agent describe them', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-roster-local-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const settings = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', models: {}, profiles: {main: {adapter: 'claude'}}, jev: {enabled: true}};
  const calls = [];
  const answer = JSON.stringify({'lmstudio/coder-30b-a3b': {tier: 'cheapest', capabilities: 'Fast MoE coder; shallow reasoning.'}, 'lmstudio/dense-27b': {tier: 'mid', capabilities: 'Dense 27B: careful reader, slow.'}});
  const run = (line, extra = {}) => jevCommand(line.split(/\s+/).filter(Boolean), {root, cwd: root, settings, save: () => {}, env: {}, discover, run: answering(answer, calls), ...extra});

  const before = (await run('roster')).text.split('\n');
  assert.equal(before.includes('  lmstudio/coder-30b-a3b → local · loaded · 32k · tier cheapest · not described yet: unknown local model: single-file reading only'), true);
  assert.equal(before.at(-1), '2 models not described yet: bounce describes them when routing is on and the daemon starts, or on /jev roster refresh');

  const refreshed = (await run('roster refresh')).text.split('\n');
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(calls[0].promptFile ?? path.join(root, 'roster-setup', 'prompt.txt'), 'utf8'), /Already rated, for scale[\s\S]*- lmstudio\/dense-27b: a local model served through LM Studio/);
  assert.deepEqual(Object.fromEntries(Object.entries(readRosterNotes(root)).filter(([key]) => key.startsWith('lmstudio/')).map(([key, note]) => [key, note.tier])), {'lmstudio/coder-30b-a3b': 'cheapest', 'lmstudio/dense-27b': 'mid'});
  assert.equal(refreshed.includes('lmstudio/dense-27b → local · loaded · 256k · tier mid · Dense 27B: careful reader, slow. (claude)'), true);

  // local models off: they are not in the roster at all, and LM Studio is not asked
  settings.local = {enabled: false};
  let asked = 0;
  const off = (await run('roster', {discover: async () => { asked++; return []; }})).text;
  assert.deepEqual([off.includes('lmstudio/'), asked], [false, 0]);
});
