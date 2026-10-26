// Which AI plays an `auto` agent: Jev describes the task (three yes/no questions about the orders), a rule turns the
// description into a tier, and the load decides between the tier's AIs in the agent's own list. Found 2026-10-26 in
// A live session: Jev answered the tier `mid` at 0.90–1.00 for 37 tasks, and the vendor then came from the provider order, so
// every one ran on claude/sonnet while codex sat at 1% of its week and the local qwen was idle. Asked by name, Jev
// leaned between sonnet and codex at 0.16–0.38 and flipped between identical asks: it has no way to tell peers apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import {AI_DESCRIPTION_QUESTIONS, tierFromDescription, pickAI, routeAgentAI, PROFILE_TIERS} from '../src/jev.js';
import {catalogNote, localTier} from '../src/model-catalog.js';
import {localCandidates} from '../src/local-models.js';
import {validateOrchestration} from '../src/profiles.js';
import {agentMetadata} from '../src/agents.js';

const noul = value => ({noul: value});
const describe = ({hardest = 0.2, small = 0.1, long = 0.2} = {}) => ({hardest: noul(hardest), small_fix: noul(small), long_context: noul(long)});

test('Jev is asked three narrow questions about the task, whatever the agent\'s list holds', () => {
  assert.deepEqual(Object.keys(AI_DESCRIPTION_QUESTIONS), ['hardest', 'small_fix', 'long_context']);
  assert.equal(Object.values(AI_DESCRIPTION_QUESTIONS).every(question => question.type === 'noul'), true);
});

// Thresholds from 30 past real tasks labelled by hand: 26 of 30 agree (all 21 mid, 4 of 5 cheapest, 1 of 4 strong).
test('the description becomes a tier: strongest at hardest 0.7, cheapest at small fix 0.6, else mid; never advisor', () => {
  assert.equal(tierFromDescription(describe({hardest: 0.73})).tier, 'strongest');
  assert.equal(tierFromDescription(describe({hardest: 0.69, small: 0.9})).tier, 'cheapest');
  assert.equal(tierFromDescription(describe({hardest: 0.69, small: 0.59})).tier, 'mid');
  assert.equal(tierFromDescription(describe({long: 0.5})).longContext, true);
  assert.equal(tierFromDescription(describe({long: 0.49})).longContext, false);
  assert.equal(tierFromDescription({}), null, 'no answers, no tier');
  assert.deepEqual(PROFILE_TIERS, ['cheapest', 'mid', 'strongest', 'advisor']);
});

// 2026-10-26: tiers go by model name, not version — terra is mid even as 5.6; sol is a peer of opus; Fable and
// Astra are advisors for very hard work, used sparingly; qwen3.8 is a peer of sonnet and terra, not pinned.
test('tiers go by model name: luna and haiku cheapest, terra and sonnet mid, sol and opus strongest, astra and fable advisor', () => {
  const tiers = ['claude/haiku', 'codex/gpt-6-luna', 'codex/gpt-5.6-luna', 'claude/sonnet', 'codex/gpt-5.6-terra', 'claude/opus', 'codex/gpt-6.1-sol', 'codex/gpt-6-sol', 'codex/gpt-5.6-sol', 'claude/claude-fable-5-1[1m]', 'codex/gpt-6-astra']
    .map(key => catalogNote(key)?.tier);
  assert.deepEqual(tiers, ['cheapest', 'cheapest', 'cheapest', 'mid', 'mid', 'strongest', 'strongest', 'strongest', 'strongest', 'advisor', 'advisor']);
  assert.equal(localTier('qwen3.8-27b-gsq-rco'), 'mid');
  assert.equal(localTier('some-small-model'), 'cheapest');
  const [qwen] = localCandidates([{endpoint: 'lmstudio', models: [{id: 'qwen3.8-27b-gsq-rco', ready: true}]}]);
  assert.equal(qwen.tier, 'mid');
  const [pinned] = localCandidates([{endpoint: 'lmstudio', models: [{id: 'qwen3.8-27b-gsq-rco', ready: true}]}], {'lmstudio/qwen3.8-27b-gsq-rco': {by: 'you', tier: 'cheapest'}});
  assert.equal(pinned.tier, 'cheapest', 'a hand pin still wins');
});

const builder = `---\nname: builder\ndescription: Writes the change.\npolicy: write\nmodels: [auto, lmstudio/qwen3.8-27b-gsq-rco, claude/sonnet, codex/gpt-5.6-terra, codex/gpt-6.1-sol]\n---\nYou are the builder.\n`;
const roles = new Map([['builder', {...agentMetadata(builder), source: 'user', file: '/x/builder.md'}]]);
const {profiles} = validateOrchestration({operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude', 'codex'], models: {}, local: {}, profiles: {main: {adapter: 'claude', model: 'opus'}}}, undefined, {roles});
const head = profiles.builder;
const qwen = {name: 'lmstudio/qwen3.8-27b-gsq-rco', endpoint: 'lmstudio', model: 'qwen3.8-27b-gsq-rco', loaded: true, tier: 'mid', context: 133120, capabilities: 'local'};
const now = Date.parse('2026-10-26T06:00:00Z');
const day = 86400000, hour = 3600000;
// Last night: claude's week resets in 4 days, codex's in 7.
const lastNight = {claude: {windows: [{label: '5h', percent: 7, resetsAt: now + 3 * hour}, {label: '7d', percent: 14, resetsAt: now + 4 * day}]}, codex: {windows: [{label: '7d', percent: 1, resetsAt: now + 7 * day}]}};
const load = (extra = {}) => ({quotas: lastNight, cooldowns: {}, localFree: () => true, now, ...extra});
const pick = (tier, extra = {}, description = {}) => pickAI({profiles, head, notes: {}, locals: [qwen], tier, longContext: false, ...description, ...load(extra)});

test('between peers, a free local model goes first: it has no window and costs nothing', () => {
  const picked = pick('mid');
  assert.equal(picked.ai, 'lmstudio/qwen3.8-27b-gsq-rco');
  assert.deepEqual(picked.local, {endpoint: 'lmstudio', model: 'qwen3.8-27b-gsq-rco'});
});

test('with the local slot taken, the cloud peer whose weekly window resets first plays it, then the one whose 5-hour does', () => {
  assert.equal(pick('mid', {localFree: () => false}).ai, 'claude_sonnet', 'claude\'s week resets in 4 days, codex\'s in 7');
  const codexSooner = {...lastNight, codex: {windows: [{label: '7d', percent: 1, resetsAt: now + 2 * day}]}};
  assert.equal(pick('mid', {localFree: () => false, quotas: codexSooner}).ai, 'codex_terra');
  const sameWeek = {claude: {windows: [{label: '5h', percent: 7, resetsAt: now + 4 * hour}, {label: '7d', percent: 14, resetsAt: now + 4 * day}]}, codex: {windows: [{label: '5h', percent: 50, resetsAt: now + hour}, {label: '7d', percent: 1, resetsAt: now + 4 * day}]}};
  assert.equal(pick('mid', {localFree: () => false, quotas: sameWeek}).ai, 'codex_terra', 'same week: codex\'s 5 hours reset first');
});

test('a vendor with a spent window or in cooldown is out; a vendor with no reading goes after the ones that have one', () => {
  const spent = {...lastNight, claude: {windows: [{label: '5h', percent: 100, resetsAt: now + hour}, {label: '7d', percent: 14, resetsAt: now + 4 * day}]}};
  const out = pick('mid', {localFree: () => false, quotas: spent});
  assert.equal(out.ai, 'codex_terra');
  assert.match(out.candidates.find(c => c.name === 'claude_sonnet').reason, /5h at 100%/);
  assert.equal(pick('mid', {localFree: () => false, cooldowns: {claude: now + hour}}).ai, 'codex_terra');
  assert.equal(pick('mid', {localFree: () => false, quotas: {codex: lastNight.codex}}).ai, 'codex_terra', 'claude has no reading');
  const ended = {claude: {windows: [{label: '7d', percent: 100, resetsAt: now - hour}]}, codex: lastNight.codex};
  assert.equal(pick('mid', {localFree: () => false, quotas: ended}).ai !== null, true, 'a window that ended since its reading is not spent');
});

test('orders that need a long context skip a local model whose window is small', () => {
  assert.equal(pick('mid', {}, {longContext: true}).ai, 'claude_sonnet');
});

test('a tier the list has no AI for steps up, then down, and never into advisor', () => {
  assert.equal(pick('cheapest', {localFree: () => false}).ai, 'claude_sonnet', 'no cheapest AI: up to mid');
  assert.equal(pick('strongest').ai, 'codex_61_sol');
  const advisorOnly = `---\nname: builder\ndescription: Writes.\npolicy: write\nmodels: [auto, codex/gpt-6-astra, claude/sonnet]\n---\nYou are the builder.\n`;
  const view = validateOrchestration({operation: 'orchestrator', orchestrator: 'main', mode: 'yolo', order: ['claude', 'codex'], models: {}, profiles: {main: {adapter: 'claude', model: 'opus'}}}, undefined, {roles: new Map([['builder', {...agentMetadata(advisorOnly), source: 'user', file: '/x/b.md'}]])});
  assert.equal(pickAI({profiles: view.profiles, head: view.profiles.builder, notes: {}, locals: [], tier: 'strongest', longContext: false, ...load()}).ai, 'claude_sonnet', 'strongest absent: down to mid, not up to astra');
});

test('routeAgentAI asks the description, keeps it in the decision, and picks by load', async () => {
  let asked;
  const ask = async request => { asked = request; return {answers: describe(), model: 'jev-1.13.0', latencyMs: 5}; };
  const decision = await routeAgentAI({orders: 'build step 3', profiles, head, settings: {enabled: true, routing: {enabled: true}}, ask, locals: [qwen], load: () => load({localFree: () => false})});
  assert.deepEqual(Object.keys(asked.questions), ['hardest', 'small_fix', 'long_context']);
  assert.deepEqual(asked.state, {orders: 'build step 3'});
  assert.equal(decision.ai, 'claude_sonnet');
  assert.equal(decision.tier, 'mid');
  assert.deepEqual(decision.description, {hardest: 0.2, small_fix: 0.1, long_context: 0.2});
  assert.equal(decision.candidates.some(c => c.name === 'lmstudio/qwen3.8-27b-gsq-rco' && /slot/.test(c.reason)), true);
});

// 2026-10-26: the orchestrator may set the tier when it knows more than the orders say (the work failed
// before, it touches security, it crosses modules); calibration showed Jev finds strongest work only 1 time in 4.
// The orchestrator names a tier, never an AI: the load still picks between the tier's peers.
test('a tier the orchestrator gives wins over Jev\'s, and still leaves the AI to the load', async () => {
  const ask = async () => ({answers: describe({long: 0.9}), model: 'jev-1.13.0', latencyMs: 5});
  const decision = await routeAgentAI({orders: 'build step 3', profiles, head, tier: 'strongest', settings: {enabled: true, routing: {enabled: true}}, ask, locals: [qwen], load: () => load()});
  assert.deepEqual([decision.ai, decision.tier, decision.tierBy], ['codex_61_sol', 'strongest', 'orchestrator']);
  assert.equal(decision.description.long_context, 0.9, 'Jev is still asked: its answers are kept beside the tier');
  const mid = await routeAgentAI({orders: 'x', profiles, head, settings: {enabled: true, routing: {enabled: true}}, ask, locals: [qwen], load: () => load()});
  assert.equal(mid.tierBy, 'jev');
  const down = async () => { throw Object.assign(new Error('down'), {code: 'timeout'}); };
  const without = await routeAgentAI({orders: 'x', profiles, head, tier: 'mid', settings: {enabled: true, routing: {enabled: true}}, ask: down, locals: [qwen], load: () => load()});
  assert.deepEqual([without.ai, without.tier, without.tierBy, without.description], ['lmstudio/qwen3.8-27b-gsq-rco', 'mid', 'orchestrator', null], 'Jev down: the orchestrator\'s tier is enough');
  const advisorList = await routeAgentAI({orders: 'x', profiles, head, tier: 'advisor', settings: {enabled: true, routing: {enabled: true}}, ask, locals: [qwen], load: () => load()});
  assert.equal(advisorList.ai, 'codex_61_sol', 'a list with no advisor steps down to strongest');
});
