import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createLocalSetupView, gatherLocalStatus, formatLocalStatus} from '../src/local-setup-view.js';

test('setup view takes answers independently and cancelling pending work blocks late save', async () => {
  let release, saves=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const view=createLocalSetupView({save:()=>{saves++;},run:async({ask,write,save})=>{
    const answer=await ask('Purpose?'); assert.equal(answer,'research');
    write('Discovering…'); await pending; write('late result');
    await save({}); return {saved:true};
  }});
  assert.equal(view.state.question,'Purpose?');
  assert.equal(view.answer('research'),true);
  await Promise.resolve();
  assert.equal(view.state.question,null);
  view.cancel(); release();
  await view.done;
  assert.equal(saves,0);
  assert.equal(view.state.active,false);
  assert.equal(view.state.lines.includes('late result'),false);
});

test('setup view supports blank defaults and bounds output without mutating active agents', async () => {
  const view=createLocalSetupView({run:async({ask,write})=>{
    assert.equal(await ask('Confirm?'),'');
    for(let i=0;i<100;i++)write(`line${i}`);
    return {saved:false};
  }});
  view.answer(''); await view.done;
  assert.ok(view.state.lines.length<=12);
  assert.equal(view.state.lines.at(-1),'line99');
});

// The local status view is shared by `bounce local` and the TUI's `/local` so the two cannot drift.
// It answers three questions: what the endpoint has, whether the OpenCode bridge works, and which
// local workers are configured.
const statusSettings = {operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', order: ['claude'], models: {},
  local: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234'}}},
  profiles: {main: {adapter: 'claude'}},
};
// Who is local is read off the agent files: an agent with a local AI in its chain.
const statusRoles = new Map([
  ['scout', {name: 'scout', description: 'Scouts.', policy: 'read-only', prompt: 's', source: 'user', models: ['lmstudio/auto']}],
  ['writer', {name: 'writer', description: 'Writes.', policy: 'write', prompt: 'w', source: 'user', models: ['lmstudio/bounce-coder', 'claude/default']}],
  ['cloudy', {name: 'cloudy', description: 'Cloud only.', policy: 'write', prompt: 'c', source: 'user', models: ['claude/default']}],
]);
const statusCatalogs = [{endpoint: 'lmstudio', models: [
  {id: 'loaded-one', ref: 'lmstudio/loaded-one', ready: true, tools: true, capabilitySource: 'server', context: 8192, instances: [{id: 'loaded-one', context: 8192}]},
  {id: 'on-disk', ref: 'lmstudio/on-disk', ready: false, tools: true, capabilitySource: 'server', context: 8192, instances: []},
]}];

test('local status lists the agents a local model may play, and offers the verify hint until the bridge is proven', async () => {
  const status = await gatherLocalStatus({settings: statusSettings, discover: async () => statusCatalogs, roles: statusRoles});
  assert.deepEqual(status.workers, [
    {name: 'scout', model: 'lmstudio/auto', policy: 'read-only'},
    {name: 'writer', model: 'lmstudio/bounce-coder', policy: 'write'},
  ], 'an agent only cloud AIs may play is not listed');
  assert.equal(status.bridge, undefined, 'the live turn is opt-in, never run by a plain status');

  const text = formatLocalStatus(status, {verifyHint: 'run /local verify', setupHint: 'run /local setup'}).join('\n');
  assert.match(text, /^  loaded-one · loaded · context 8192 · tools: true$/m, 'loaded models are listed by served identifier');
  assert.match(text, /lmstudio\/on-disk · downloaded/);
  assert.match(text, /run \/local verify/);
  assert.match(text, /^Agents a local model may play: scout \(lmstudio\/auto, read-only\), writer \(lmstudio\/bounce-coder, write\)$/m);
});

test('local status reports a verified bridge, and a failing one without claiming readiness', async () => {
  const ok = await gatherLocalStatus({settings: statusSettings, verify: true, model: 'loaded-one',
    discover: async () => statusCatalogs,
    bridge: async () => ({binary: '/fake/opencode', config: {ready: true}, worker: {ready: true}, model: 'loaded-one'})});
  assert.match(formatLocalStatus(ok, {}).join('\n'), /bridge verified · loaded-one replied/);

  const bad = await gatherLocalStatus({settings: statusSettings, verify: true, model: 'loaded-one',
    discover: async () => statusCatalogs,
    bridge: async () => ({binary: '/fake/opencode', config: {ready: true}, worker: {ready: false, reason: 'LM Studio unreachable'}})});
  assert.equal(bad.problem.stage, 'bridge');
  const text = formatLocalStatus(bad, {}).join('\n');
  assert.match(text, /NOT READY \(bridge\): OpenCode could not complete a turn with loaded-one: LM Studio unreachable/);
  assert.doesNotMatch(text, /verified/);
});

test('local status says what to run when nothing is configured yet', async () => {
  const status = await gatherLocalStatus({settings: statusSettings, discover: async () => statusCatalogs, roles: new Map([['cloudy', statusRoles.get('cloudy')]])});
  assert.match(formatLocalStatus(status, {setupHint: 'run /local setup'}).join('\n'),
    /^No agent has a local model yet — run \/local setup$/m);
});

test('local status names the first broken link with one next action, in the order things fail', async () => {
  // Nothing loaded but a tool-capable model is on disk: under the on-demand default that is NOT a
  // dead end — the first turn loads it (measured live at ~9s) — so it is a note, not a blocker.
  const unloaded = [{endpoint: 'lmstudio', models: [
    {ref: 'lmstudio/on-disk', ready: false, tools: true, capabilitySource: 'server'},
    {ref: 'lmstudio/embedder', ready: false, tools: false, capabilitySource: 'server'}]}];
  const loadable = await gatherLocalStatus({settings: statusSettings, discover: async () => unloaded, executables: {opencode: process.execPath}});
  assert.equal(loadable.problem, null);
  assert.match(loadable.note, /first turn loads one on demand/);
  let text = formatLocalStatus(loadable, {verifyHint: 'run /local verify'}).join('\n');
  assert.doesNotMatch(text, /NOT READY/);
  assert.match(text, /run \/local verify/, 'verify can pass, so it is offered');

  // The same catalog with the endpoint pinned loaded-only IS a dead end, and says how to fix it,
  // suggesting only the tool-capable candidates.
  const pinned = {...statusSettings, local: {endpoints: {lmstudio: {backend: 'lmstudio', url: 'http://127.0.0.1:1234', maxConcurrent: 1, loadPolicy: 'loaded-only'}}}};
  const noModel = await gatherLocalStatus({settings: pinned, discover: async () => unloaded});
  assert.equal(noModel.problem.stage, 'model');
  assert.match(noModel.problem.next, /loaded-only.*lms load <model>/);
  assert.match(noModel.problem.next, /Downloaded and tool-capable: on-disk\./, 'only tool-capable models are suggested');
  text = formatLocalStatus(noModel, {verifyHint: 'run /local verify'}).join('\n');
  assert.match(text, /^NOT READY \(model\):/);
  assert.doesNotMatch(text, /run \/local verify/, 'no point offering a bridge check that cannot pass');

  // Nothing tool-capable on disk at all: a dead end under any policy.
  const bare = await gatherLocalStatus({settings: statusSettings, discover: async () => [{endpoint: 'lmstudio', models: [unloaded[0].models[1]]}]});
  assert.equal(bare.problem.stage, 'model');
  assert.match(bare.problem.next, /Download a tool-capable model/);

  // Endpoint down beats everything.
  const down = await gatherLocalStatus({settings: statusSettings, discover: async () => [{endpoint: 'lmstudio', models: [], error: 'ECONNREFUSED'}]});
  assert.equal(down.problem.stage, 'lmstudio');
  assert.match(down.problem.text, /not reachable at http:\/\/127\.0\.0\.1:1234 \(ECONNREFUSED\)/);

  // A model is loaded but the binary is not there: an absolute override that does not exist is not "installed".
  const missing = await gatherLocalStatus({settings: statusSettings, discover: async () => statusCatalogs,
    executables: {opencode: '/nonexistent/opencode'}});
  assert.equal(missing.installed, false);
  assert.equal(missing.problem.stage, 'opencode');
  text = formatLocalStatus(missing, {verifyHint: 'run /local verify'}).join('\n');
  assert.match(text, /OpenCode: NOT INSTALLED/);
  assert.doesNotMatch(text, /run \/local verify/);

  // Everything present and nothing verified yet: no blocker, and the hint appears.
  const ok = await gatherLocalStatus({settings: statusSettings, discover: async () => statusCatalogs, executables: {opencode: process.execPath}});
  assert.equal(ok.problem, null);
  assert.match(formatLocalStatus(ok, {verifyHint: 'run /local verify'}).join('\n'), /run \/local verify/);
});

test('local status lists loaded models by the identifier they are served under, with their context', async () => {
  const aliased = [{endpoint: 'lmstudio', models: [
    {id: 'qwen3-coder-next', ref: 'lmstudio/qwen3-coder-next', ready: true, tools: true, capabilitySource: 'server', context: 65536,
      instances: [{id: 'bounce-coder', context: 32768}]},
    {ref: 'lmstudio/on-disk', ready: false, tools: true, capabilitySource: 'server'}]}];
  const status = await gatherLocalStatus({settings: statusSettings, discover: async () => aliased, executables: {opencode: process.execPath}});
  const text = formatLocalStatus(status, {}).join('\n');
  assert.match(text, /^  bounce-coder · loaded \(qwen3-coder-next\) · context 32768 · tools: true$/m, 'the pinnable identifier leads, the catalog model in parentheses');
  assert.match(text, /^  lmstudio\/on-disk · downloaded · tools: true \(server\)$/m);
});

test('local status shows each agent and who may play it, and reports a broken agent file', async () => {
  const roles = new Map([
    ['reviewer', {name: 'reviewer', policy: 'read-only', description: 'Reviews.', source: 'skill', prompt: 'r'}],
    ['builder', {name: 'builder', policy: 'write', description: 'Implements.', source: 'skill', prompt: 'b'}],
    ['broken', {name: 'broken', error: 'frontmatter needs a description'}],
  ]);
  const settings = {...statusSettings, operation: 'orchestrator', mode: 'yolo', orchestrator: 'main', order: ['claude'], models: {claude: 'sonnet'},
    profiles: {main: {adapter: 'claude'}}};
  const status = await gatherLocalStatus({settings, discover: async () => statusCatalogs, executables: {opencode: process.execPath}, roles});
  assert.deepEqual(status.roles, [
    {name: 'reviewer', policy: 'read-only', description: 'Reviews.', source: 'skill', backends: ['claude/sonnet', 'lmstudio/auto (via opencode)'], skipped: []},
    {name: 'builder', policy: 'write', description: 'Implements.', source: 'skill', backends: ['claude/sonnet', 'lmstudio/auto (via opencode)'], skipped: []},
    {name: 'broken', error: 'frontmatter needs a description', backends: [], skipped: []},
  ]);
  const text = formatLocalStatus(status, {}).join('\n');
  assert.match(text, /^  reviewer · read-only · skill · claude\/sonnet, lmstudio\/auto \(via opencode\)$/m);
  assert.match(text, /^  builder · write · skill · claude\/sonnet, lmstudio\/auto \(via opencode\)$/m);
  assert.match(text, /^  broken · INVALID: frontmatter needs a description$/m);
});
