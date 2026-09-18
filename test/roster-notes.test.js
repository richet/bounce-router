// src/roster-notes.js: the per-model notes Jev routing reads — read from config, the shipped
// catalog (src/model-catalog.js) or the cache, written once by a cloud agent's one-shot answer
// (runner stubbed, never a real CLI) for models bounce does not ship a note for, journaled
// either way, and surfaced by /jev roster. Fixture models are ids outside the catalog
// (haiku-next, gpt-7-nova) so the describe path still has something to describe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  NOTES_FILE, modelKey, readRosterNotes, writeRosterNotes, effectiveNotes, undescribedModels, setupAgent,
  setupPrompt, parseSetupAnswer, describeModels, createRosterSetup, rosterLines,
} from '../src/roster-notes.js';
import {createJevActivation, routingQuestions} from '../src/jev.js';
import {MODEL_CATALOG} from '../src/model-catalog.js';
import {jevCommand} from '../src/jev-command.js';
import {starterProfiles} from '../src/profiles.js';
import {Session} from '../src/core.js';

const tmpRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-roster-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return root;
};
const roster = () => ({
  main: {adapter: 'claude', model: 'opus', role: 'orchestrator', policy: 'write', mode: 'yolo', fallback: []},
  scout: {adapter: 'claude', model: 'haiku-next', role: 'analyst', policy: 'read-only', mode: 'yolo', fallback: []},
  build: {adapter: 'codex', model: 'gpt-7-nova', role: 'builder', policy: 'write', mode: 'yolo', fallback: [], tier: 'mid'},
  build2: {adapter: 'codex', model: 'gpt-7-nova', role: 'builder', policy: 'write', mode: 'yolo', fallback: []},
  own: {adapter: 'claude', model: 'sonnet', role: 'builder', policy: 'write', mode: 'yolo', fallback: [], tier: 'strongest', capabilities: 'Configured by hand.'},
  local: {adapter: 'local', model: '', endpoint: 'http://localhost:1234', role: 'builder', policy: 'write', mode: 'yolo', fallback: []},
  jev: {adapter: 'typesafe', model: '', role: 'critic', policy: 'read-only', mode: 'yolo', fallback: []},
});
// A runner that answers like a vendor CLI would: assistant text, then a successful result.
const answering = (text, calls = []) => async args => { calls.push(args); args.emit({kind: 'assistant', text}); args.emit({kind: 'result', text, success: true}); return {status: 'completed', code: 0}; };
const ANSWER = JSON.stringify({'claude/haiku-next': {tier: 'cheapest', capabilities: 'Fast and cheap;  weak at long multi-step edits.'}, 'codex/gpt-7-nova': {tier: 'mid', capabilities: 'Solid implementation.'}, 'local/auto': {tier: 'nonsense', capabilities: 'Unknown local model.'}});

test('config wins over the cache, the cache fills the rest, and only models nobody described are pending', t => {
  const root = tmpRoot(t);
  assert.deepEqual(readRosterNotes(root), {});
  assert.equal(modelKey(roster().local), 'local/auto');
  assert.equal(modelKey({adapter: 'claude', model: ''}), 'claude/default');
  assert.deepEqual(undescribedModels(roster()).map(m => m.key), ['claude/haiku-next', 'codex/gpt-7-nova', 'local/auto'], 'unique, in roster order, never the orchestrator or the reviewer');
  writeRosterNotes({'codex/gpt-7-nova': {tier: 'strongest', capabilities: 'From the cache.', by: 'claude/opus', at: '2026-09-18T00:00:00.000Z'}, junk: 'x'}, root);
  assert.equal(fs.statSync(path.join(root, NOTES_FILE)).mode & 0o777, 0o600);
  const cache = readRosterNotes(root);
  assert.deepEqual(Object.keys(cache), ['codex/gpt-7-nova']);
  const notes = effectiveNotes(roster(), cache);
  assert.deepEqual(Object.keys(notes), ['scout', 'build', 'build2', 'own', 'local']);
  assert.deepEqual(notes.build, {model: 'codex/gpt-7-nova', tier: 'mid', capabilities: 'From the cache.', source: 'claude/opus'}, 'the profile\'s own tier, the cache\'s sentence');
  assert.deepEqual(notes.build2, {model: 'codex/gpt-7-nova', tier: 'strongest', capabilities: 'From the cache.', source: 'claude/opus'});
  assert.deepEqual(notes.own, {model: 'claude/sonnet', tier: 'strongest', capabilities: 'Configured by hand.', source: 'config'});
  assert.deepEqual(notes.scout, {model: 'claude/haiku-next', tier: null, capabilities: null, source: null});
  assert.deepEqual(undescribedModels(roster(), cache).map(m => m.key), ['claude/haiku-next', 'local/auto']);
  assert.match(routingQuestions(roster(), notes).profile.criteria.build2, /tier strongest: .* · capabilities: From the cache\.$/);
  fs.writeFileSync(path.join(root, NOTES_FILE), '{broken');
  assert.deepEqual(readRosterNotes(root), {});
});

test('the describing agent is the orchestrator when it is a cloud agent, else the first cloud profile, else the provider order', () => {
  assert.deepEqual(setupAgent({profiles: roster(), orchestrator: 'main'}), {adapter: 'claude', model: 'opus'});
  const localMain = {...roster(), main: {...roster().main, adapter: 'local', model: 'auto'}};
  assert.deepEqual(setupAgent({profiles: localMain, orchestrator: 'main'}), {adapter: 'claude', model: 'haiku-next'});
  assert.deepEqual(setupAgent({profiles: {a: {adapter: 'local'}}, order: ['codex', 'claude'], models: {codex: 'gpt-7-nova'}}), {adapter: 'codex', model: 'gpt-7-nova'});
  assert.equal(setupAgent({profiles: {a: {adapter: 'local'}}, order: ['local']}), null);
});

test('the prompt lists every model with what the vendor says, asks for JSON only, and the answer is parsed tolerantly', () => {
  const models = undescribedModels(roster());
  const prompt = setupPrompt(models, [{provider: 'claude', models: [{id: 'haiku-next', description: 'Fastest, for simple tasks'}]}]);
  assert.match(prompt, /- claude\/haiku-next: the claude CLI, model "haiku-next" — the vendor describes it as: "Fastest, for simple tasks"/);
  assert.match(prompt, /- codex\/gpt-7-nova: the codex CLI, model "gpt-7-nova"\n/);
  assert.match(prompt, /- local\/auto: a local model served through LM Studio at http:\/\/localhost:1234, the model loaded at the time/);
  assert.match(prompt, /"cheapest" — locating files/);
  assert.match(prompt, /never at "cheapest" just because it is unfamiliar/);
  assert.match(prompt, /Do not use any tools/);
  assert.match(prompt, /ONLY a JSON object/);
  const parsed = parseSetupAnswer(`Sure, here you go:\n\`\`\`json\n${ANSWER}\n\`\`\`\nHope that helps.`, models);
  assert.deepEqual(parsed, {
    'claude/haiku-next': {tier: 'cheapest', capabilities: 'Fast and cheap; weak at long multi-step edits.'},
    'codex/gpt-7-nova': {tier: 'mid', capabilities: 'Solid implementation.'},
    'local/auto': {tier: 'mid', capabilities: 'Unknown local model.'},
  }, 'whitespace collapsed, an unknown tier reads as mid');
  assert.equal(parseSetupAnswer(JSON.stringify({'claude/haiku-next': {tier: 'mid', capabilities: 'x'.repeat(600)}, other: {tier: 'mid', capabilities: 'not asked'}}), models)['claude/haiku-next'].capabilities.length, 400);
  assert.throws(() => parseSetupAnswer('no json here', models), /no JSON object/);
  assert.throws(() => parseSetupAnswer('{not json}', models), /could not be parsed/);
  assert.throws(() => parseSetupAnswer('{"other": {"tier": "mid", "capabilities": "x"}}', models), /described none/);
  assert.throws(() => parseSetupAnswer('[1]', models), /no JSON object|other than an object/);
});

test('describeModels runs one read-only turn of the agent (no bus, prompt on stdin and in a 0600 file) and stamps the notes', async t => {
  const root = tmpRoot(t);
  const calls = [];
  const models = undescribedModels(roster());
  const written = await describeModels({models, agent: {adapter: 'claude', model: 'opus'}, root, executables: {claude: '/opt/claude'}, run: answering(ANSWER, calls), clock: () => Date.UTC(2026, 8, 18)});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude');
  assert.equal(calls[0].executable, '/opt/claude');
  assert.deepEqual(calls[0].args, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'opus', '--permission-mode', 'plan']);
  assert.equal(calls[0].cwd, path.join(root, 'roster-setup'));
  assert.match(calls[0].prompt, /- claude\/haiku-next/);
  assert.equal(fs.readFileSync(path.join(root, 'roster-setup', 'prompt.txt'), 'utf8'), calls[0].prompt);
  assert.equal(fs.statSync(path.join(root, 'roster-setup', 'prompt.txt')).mode & 0o777, 0o600);
  assert.deepEqual(written['claude/haiku-next'], {tier: 'cheapest', capabilities: 'Fast and cheap; weak at long multi-step edits.', by: 'claude/opus', at: '2026-09-18T00:00:00.000Z'});
  await assert.rejects(describeModels({models, agent: {adapter: 'codex', model: ''}, root, run: async () => ({status: 'missing'})}), /codex is not installed/);
  await assert.rejects(describeModels({models, agent: {adapter: 'codex', model: ''}, root, run: async () => ({status: 'failed'})}), /codex failed/);
  await assert.rejects(describeModels({models, agent: null, root, run: answering(ANSWER)}), /no signed-in cloud agent/);
  assert.deepEqual(await describeModels({models: [], agent: null, root}), {});
  // a hung agent is cut off at the timeout through the signal it was given
  await assert.rejects(describeModels({models, agent: {adapter: 'claude', model: ''}, root, timeoutMs: 20, run: ({signal}) => new Promise(resolve => signal.addEventListener('abort', () => resolve({status: 'cancelled'})))}), /did not answer within 0 s/);
});

test('the daemon setup describes only what is missing, once, journals jev.roster and rewrites the orders; a failure journals jev.skipped and is not retried unless forced', async t => {
  const root = tmpRoot(t);
  const session = new Session(root, {root});
  const calls = [];
  let changes = 0;
  const profiles = roster();
  const setup = createRosterSetup({root, profiles, session, agent: {adapter: 'claude', model: 'opus'}, run: answering(ANSWER, calls), catalogs: async () => { throw new Error('no catalog'); }, onChange: () => { changes++; }});
  assert.deepEqual(setup.notes().scout, {model: 'claude/haiku-next', tier: null, capabilities: null, source: null});
  const [first, second] = await Promise.all([setup.ensure(), setup.ensure()]);
  assert.equal(calls.length, 1, 'concurrent ensures share one run');
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), ['claude/haiku-next', 'codex/gpt-7-nova', 'local/auto']);
  assert.equal(changes, 1);
  const row = session.events.find(e => e.kind === 'jev.roster');
  assert.equal(row.by, 'claude/opus');
  assert.match(row.text, /^Jev roster: claude\/opus described claude\/haiku-next, codex\/gpt-7-nova, local\/auto · scout → cheapest, build → mid, build2 → mid, own → strongest, local → mid$/);
  assert.deepEqual(setup.notes().scout, {model: 'claude/haiku-next', tier: 'cheapest', capabilities: 'Fast and cheap; weak at long multi-step edits.', source: 'claude/opus'});
  assert.deepEqual(setup.notes().build, {model: 'codex/gpt-7-nova', tier: 'mid', capabilities: 'Solid implementation.', source: 'claude/opus'});
  assert.equal(await setup.ensure(), null, 'nothing left to describe');
  assert.equal(calls.length, 1);
  // forced: the cache is set aside and everything is described again
  await setup.ensure({force: true});
  assert.equal(calls.length, 2);

  const broken = createRosterSetup({root: tmpRoot(t), profiles, session, agent: {adapter: 'codex', model: ''}, run: async () => ({status: 'failed'})});
  assert.equal(await broken.ensure(), null);
  assert.equal(await broken.ensure(), null, 'not retried');
  const skipped = session.events.filter(e => e.kind === 'jev.skipped');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].text, /Jev roster notes not written · codex failed · routing sees adapter\/model\/role\/policy only; \/jev roster refresh retries/);
  assert.deepEqual(broken.notes().scout.capabilities, null);
  const noAgent = createRosterSetup({root: tmpRoot(t), profiles, session, agent: null});
  await noAgent.ensure();
  assert.match(session.events.at(-1).text, /no cloud agent in the roster or the provider order/);
});

test('a user control.jev row with routing on runs the setup; refresh: roster forces it', async t => {
  const root = tmpRoot(t);
  const session = new Session(root, {root});
  const runs = [];
  const close = createJevActivation({session, readSettings: () => ({enabled: true}), readKey: () => null, setup: options => { runs.push(options); return Promise.resolve(); }});
  session.append({kind: 'control.jev', from: 'user'});
  session.append({kind: 'control.jev', from: 'user', refresh: 'roster'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runs, [{force: false}, {force: true}]);
  close();
  const off = createJevActivation({session, readSettings: () => ({enabled: true, routing: false}), readKey: () => null, setup: () => { throw new Error('routing is off: never'); }});
  session.append({kind: 'control.jev', from: 'user'});
  await new Promise(resolve => setImmediate(resolve));
  off();
});

test('/jev roster lists what routing knows and who said it; refresh clears this roster\'s notes and, headless, describes again in place', async t => {
  const root = tmpRoot(t);
  // The roster is the validated view (shipped builders underneath the config's overlay); the
  // shipped builders other than `build` are dropped here so the listing stays two lines.
  const dropped = Object.fromEntries(Object.keys(starterProfiles()).filter(name => !['main', 'build'].includes(name)).map(name => [name, null]));
  const settings = {order: ['claude'], mode: 'yolo', operation: 'orchestrator', orchestrator: 'main', executables: {},
    profiles: {...dropped, main: {adapter: 'claude', model: 'opus'}, build: {adapter: 'codex', model: 'gpt-7-nova'}, scout: {adapter: 'claude', model: 'haiku-next', role: 'analyst', tier: 'cheapest', capabilities: 'By hand.'}}};
  const run = (line, extra = {}) => jevCommand(line.split(/\s+/).filter(Boolean), {root, settings, save: () => {}, env: {}, ...extra});
  const before = await run('roster');
  assert.equal(before.text, ['Jev roster · routing on', '  build → codex/gpt-7-nova · not described yet', '  scout → claude/haiku-next · tier cheapest · By hand. (config)', '1 model not described yet: bounce describes them when routing is on and the daemon starts, or on /jev roster refresh'].join('\n'));
  writeRosterNotes({'codex/gpt-7-nova': {tier: 'mid', capabilities: 'Cached.', by: 'claude/opus'}, 'claude/other': {tier: 'mid', capabilities: 'Another roster\'s.'}}, root);
  assert.match((await run('roster')).text, /build → codex\/gpt-7-nova · tier mid · Cached\. \(by claude\/opus\)\n  scout/);
  const calls = [];
  const refreshed = await run('roster refresh', {run: answering(ANSWER, calls)});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'claude', 'the orchestrator\'s own agent');
  assert.match(refreshed.text, /^Jev roster: claude\/opus described codex\/gpt-7-nova · build → mid, scout → cheapest\nbuild → codex\/gpt-7-nova · tier mid · Solid implementation\. \(by claude\/opus\)\nscout → claude\/haiku-next · tier cheapest · By hand\. \(config\)$/);
  assert.equal(readRosterNotes(root)['claude/other'].capabilities, 'Another roster\'s.', 'other rosters\' notes are kept');
  // the TUI clears and hands the description to the daemon
  const tui = await run('roster refresh', {interactive: true});
  assert.equal(tui.refresh, 'roster');
  assert.equal(Object.hasOwn(readRosterNotes(root), 'codex/gpt-7-nova'), false);
  await assert.rejects(run('roster bogus'), /Use \/jev roster, or \/jev roster refresh/);
  assert.match((await jevCommand(['roster'], {root, settings: {order: ['claude']}, env: {}})).text, /No worker roster/);
});

test('rosterLines reads plainly with nothing configured', () => {
  assert.deepEqual(rosterLines({}), ['No worker profiles to route between']);
  assert.deepEqual(rosterLines({a: {adapter: 'claude', model: 'haiku-next'}}), ['a → claude/haiku-next · not described yet']);
});

// The shipped catalog sits between config and the cache: a catalog model is never pending, never
// asked about, shows source `catalog`, and a stale cached answer for it is ignored — while a
// profile's own tier/capabilities still win.
test('the shipped catalog beats the cache and the agent, and config beats the catalog', async t => {
  const root = tmpRoot(t);
  const session = new Session(root, {root});
  const profiles = {
    main: {adapter: 'claude', model: '', role: 'orchestrator', policy: 'write', mode: 'yolo', fallback: []},
    build: {adapter: 'codex', model: 'gpt-6-astra', role: 'builder', policy: 'write', mode: 'yolo', fallback: []},
    scout: {adapter: 'claude', model: 'haiku', role: 'analyst', policy: 'read-only', mode: 'yolo', fallback: []},
    opus: {adapter: 'claude', model: '', role: 'builder', policy: 'write', mode: 'yolo', fallback: []},
    pinned: {adapter: 'claude', model: 'sonnet', role: 'builder', policy: 'write', mode: 'yolo', fallback: [], tier: 'strongest', capabilities: 'By hand.'},
    tiered: {adapter: 'codex', model: 'gpt-5.6-luna', role: 'builder', policy: 'write', mode: 'yolo', fallback: [], tier: 'mid'},
    unknown: {adapter: 'codex', model: 'gpt-7-nova', role: 'builder', policy: 'write', mode: 'yolo', fallback: []},
  };
  const stale = {'codex/gpt-6-astra': {tier: 'cheapest', capabilities: 'Stale cached answer.', by: 'claude/opus'}};
  const notes = effectiveNotes(profiles, stale);
  assert.deepEqual(notes.build, {model: 'codex/gpt-6-astra', ...MODEL_CATALOG['codex/gpt-6-astra'], source: 'catalog'}, 'the catalog, not the stale cache');
  assert.deepEqual(notes.scout, {model: 'claude/haiku', tier: 'cheapest', capabilities: MODEL_CATALOG['claude/haiku'].capabilities, source: 'catalog'});
  assert.deepEqual(notes.opus, {model: 'claude/default', ...MODEL_CATALOG['claude/default'], source: 'catalog'}, 'no model means the vendor default, which the catalog knows');
  assert.deepEqual(notes.pinned, {model: 'claude/sonnet', tier: 'strongest', capabilities: 'By hand.', source: 'config'});
  assert.deepEqual(notes.tiered, {model: 'codex/gpt-5.6-luna', tier: 'mid', capabilities: MODEL_CATALOG['codex/gpt-5.6-luna'].capabilities, source: 'catalog'}, 'the profile\'s own tier, the catalog\'s sentence');
  assert.deepEqual(notes.unknown, {model: 'codex/gpt-7-nova', tier: null, capabilities: null, source: null});
  assert.deepEqual(undescribedModels(profiles, stale).map(m => m.key), ['codex/gpt-7-nova'], 'only the model bounce does not know is pending');
  assert.match(rosterLines(profiles)[0], /^build → codex\/gpt-6-astra · tier strongest · GPT-6 Astra: .* \(catalog\)$/);
  assert.match(routingQuestions(profiles, notes).profile.criteria.scout, /tier cheapest: .* · capabilities: Haiku 4\.5: /);
  // a roster of catalog models only never spends an agent turn
  const calls = [];
  const {unknown, ...known} = profiles;
  const setup = createRosterSetup({root, profiles: known, session, agent: {adapter: 'claude', model: ''}, run: answering(ANSWER, calls)});
  assert.equal(await setup.ensure(), null);
  assert.equal(calls.length, 0);
  assert.equal(session.events.some(e => e.kind === 'jev.roster' || e.kind === 'jev.skipped'), false);
  assert.equal(setup.notes().build.source, 'catalog');
});
