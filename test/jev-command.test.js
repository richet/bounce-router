// The /jev (and `bounce jev`) command surface: parsing, the config.json shape it writes, the
// key that never lands there, and the live test call against a stubbed fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {jevCommand, JEV_HELP} from '../src/jev-command.js';
import {readJevKey} from '../src/jev.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-jev-cmd-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const file = path.join(root, 'config.json');
  // An orchestrator config whose overlay names only `build`; the rest of the roster is shipped.
  const settings = {operation: 'orchestrator', order: ['claude'], mode: 'yolo', profiles: {main: {adapter: 'claude'}, build: {adapter: 'codex'}}};
  const saves = [];
  const save = () => { saves.push(structuredClone(settings)); fs.writeFileSync(file, JSON.stringify(settings)); };
  const run = (line, extra = {}) => jevCommand(line.split(/\s+/).filter(Boolean), {root, settings, save, env: {}, ...extra});
  return {root, file, settings, saves, run};
};
const okResponse = body => ({ok: true, status: 200, headers: {get: () => null}, json: async () => body, text: async () => JSON.stringify(body)});

test('status reads disabled/no key by default and help explains why the model is pinned', async t => {
  const {run, saves} = setup(t);
  const status = await run('');
  assert.match(status.text, /^Jev \(TypeSafe\): disabled · no key · model jev-1\.13\.0 · review on · routing on · confidence 0\.8$/);
  assert.equal(status.changed, false);
  assert.equal((await run('help')).text, JEV_HELP);
  assert.match(JEV_HELP, /avoid jev-latest — an alias moves between releases/);
  assert.equal(saves.length, 0);
  await assert.rejects(run('bogus'), /Unknown \/jev subcommand bogus/);
});

test('switches and settings are parsed, saved under config.jev, and reported back; the key never lands in config.json', async t => {
  const {run, settings, file, root} = setup(t);
  assert.match((await run('on')).text, /enabled · no key .* · no key: \/jev key <KEY> or set TYPESAFE_API_KEY/);
  assert.deepEqual(settings.jev, {enabled: true, model: 'jev-1.13.0', review: true, routing: true, confidence: 0.8}, 'on means everything Jev does');
  await run('review off');
  assert.equal(settings.jev.review, false);
  await run('routing off');
  assert.equal(settings.jev.routing, false);
  await run('routing on');
  await run('routing default build');
  await run('confidence 0.65');
  const model = await run('model jev-latest');
  assert.match(model.text, /note: jev-latest is an alias that moves between releases/);
  assert.deepEqual(settings.jev, {enabled: true, model: 'jev-latest', review: false, routing: {enabled: true, default: 'build'}, confidence: 0.65});
  await run('model jev-1.13.0');
  await run('routing default none');
  assert.deepEqual(settings.jev.routing, true);
  assert.match((await run('routing local on')).text, /routing on \(local first\)/);
  assert.deepEqual(settings.jev.routing, {enabled: true, default: null, preferLocal: true});
  await run('routing local off');
  assert.deepEqual(settings.jev.routing, true);
  await assert.rejects(run('routing local maybe'), /Use \/jev routing local on\|off/);
  await assert.rejects(run('review maybe'), /Use \/jev review on\|off/);
  await assert.rejects(run('routing default nope'), /Unknown profile nope/);
  await assert.rejects(run('confidence 2'), /between 0 and 1/);
  await assert.rejects(run('model'), /Use \/jev model ID/);
  assert.match((await run('off')).text, /disabled/);

  const stored = await run('key ts-secret-KEY-1234');
  assert.match(stored.text, /TypeSafe key stored \(…1234\)/);
  assert.equal(stored.text.includes('ts-secret-KEY-1234'), false);
  assert.equal(stored.changed, false);
  assert.deepEqual(readJevKey({root, env: {}}), {key: 'ts-secret-KEY-1234', source: 'file'});
  assert.equal(fs.statSync(path.join(root, 'secrets.json')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes('ts-secret-KEY-1234'), false);
  assert.equal(JSON.stringify(settings).includes('ts-secret-KEY-1234'), false);
  assert.match((await run('')).text, /key …1234 \(file\)/);
  assert.match((await run('', {env: {TYPESAFE_API_KEY: 'env-key-zzzz'}})).text, /key …zzzz \(env\)/);
  assert.match((await run('key clear')).text, /Stored TypeSafe key removed/);
  assert.equal(readJevKey({root, env: {}}), null);
  assert.match((await run('key clear')).text, /No stored TypeSafe key/);
});

// The routing default is checked against the validated roster, not the raw `profiles` block:
// a shipped builder the config never names is routable, one the overlay dropped is not, and a
// classic config has no roster to route to at all.
test('/jev routing default accepts a shipped profile the config never names and refuses a dropped one', async t => {
  const {run, settings, saves} = setup(t);
  const ok = await run('routing default claude_haiku');
  assert.equal(ok.changed, true);
  assert.deepEqual(settings.jev.routing, {enabled: true, default: 'claude_haiku'});
  assert.deepEqual(Object.keys(saves.at(-1).profiles), ['main', 'build'], 'the shipped roster is never copied into config.json');
  settings.profiles.claude_haiku = null;
  await assert.rejects(run('routing default claude_haiku'), /Unknown profile claude_haiku; choose a worker profile from \/jev roster or none/);
  await assert.rejects(run('routing default codex_nope'), /Unknown profile codex_nope/);
  await run('routing default none');
  delete settings.operation;
  await assert.rejects(run('routing default claude_haiku'), /No worker roster: routing needs operation "orchestrator"/);
  assert.equal((await run('routing default none')).changed, true, 'none never needs a roster');
});

test('/jev key with no value opens the masked prompt in the TUI and is an error headless', async t => {
  const {run} = setup(t);
  const prompt = await run('key', {interactive: true});
  assert.equal(prompt.prompt, 'key');
  assert.match(prompt.text, /Paste the TypeSafe API key/);
  await assert.rejects(run('key'), /Use bounce jev key <KEY>, or set TYPESAFE_API_KEY/);
});

test('/jev test makes one live noul call and prints latency and the answer, or the error', async t => {
  const {run} = setup(t);
  await run('key k-test-0001');
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({url, options}); return okResponse({model: 'jev-1.13.0', answers: {is_test: {type: 'noul', noul: 0.987}}, usage: {input_tokens: 31, output_tokens: 1}}); };
  const ok = await run('test', {fetchImpl});
  assert.match(ok.text, /^Jev test ok · \d+ ms · jev-1\.13\.0 · "Is this a test\?" → 0\.987 · 31 in \/ 1 out tokens$/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.authorization, 'Bearer k-test-0001');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.questions, {is_test: {type: 'noul', instructions: 'Is this a test?'}});
  assert.equal(body.model, 'jev-1.13.0');
  const failed = await run('test', {fetchImpl: async () => ({ok: false, status: 401, headers: {get: () => null}, json: async () => ({}), text: async () => 'invalid key'})});
  assert.match(failed.text, /^Jev test failed · http_401 · TypeSafe HTTP 401: invalid key$/);
  await run('key clear');
  assert.match((await run('test', {fetchImpl})).text, /Jev test failed · missing_key/);
});
