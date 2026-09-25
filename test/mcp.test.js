// The MCP transport (docs/plans/bridge-interface.md): the second skin over src/bridge-ops.js, so the
// orchestrator calls typed tools instead of shelling `bounce publish` and reading its own journal with
// `tail | jq`. It holds no policy: every call goes to a verb, every result is that verb's answer.
// Researched first (2026-09-22): no client we serve consumes MCP resource subscriptions — Codex pulls
// resources through callable tools and skipped subscribe, Claude Code only refreshes its catalog — so this
// is tools only, and `wait` returns "not yet" well inside the clients' ~60 s tool-call timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMcpServer, WAIT_SECONDS_MAX} from '../src/mcp.js';

const view = {task: 'land', state: 'reviewing', profile: 'integrator', findings: {shown: [], total: 0, more: 0}, milestones: [], summary: null, journal: {path: '/x/journal.jsonl', task: 'land', fromSeq: 1, toSeq: 9}};
const server = (over = {}) => createMcpServer({
  ops: {
    submit: async event => ({ok: true, row: {kind: event.kind, task: 't1', seq: 4}}),
    wait: async (match, {timeout}) => ({ok: true, row: timeout > 1000 ? {kind: match.kind, task: 't1'} : null, timedOut: timeout <= 1000}),
    report: async payload => ({ok: true, row: {kind: 'task.milestone', phase: payload.phase}}),
    state: async text => ({ok: true, row: {kind: 'state', seq: 9, text}}),
    ...over.ops,
  },
  views: {taskView: () => view, taskList: () => [{task: 'land', state: 'reviewing', profile: 'integrator', elapsed: '9 min', doing: 'suite green', findings: 0}], ...over.views},
  version: '0.3.0',
});

const call = (s, name, args) => s.handle({jsonrpc: '2.0', id: 7, method: 'tools/call', params: {name, arguments: args}});

test('M1 it is an MCP server: initialize, then the bridge verbs as tools', async () => {
  const s = server();
  const init = await s.handle({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}}});
  assert.equal(init.result.serverInfo.name, 'bounce');
  assert.equal(init.result.serverInfo.version, '0.3.0');
  assert.deepEqual(init.result.capabilities, {tools: {}});
  assert.equal(await s.handle({jsonrpc: '2.0', method: 'notifications/initialized'}), null, 'a notification is answered with nothing');
  const list = await s.handle({jsonrpc: '2.0', id: 2, method: 'tools/list'});
  assert.deepEqual(list.result.tools.map(tool => tool.name).sort(), ['campaign_block', 'campaign_complete', 'campaign_extend', 'campaign_get', 'campaign_pause', 'campaign_resume', 'campaign_start', 'plan_wait', 'report', 'state', 'submit', 'task_get', 'task_submit', 'tasks_list', 'wait']);
  const submit = list.result.tools.find(tool => tool.name === 'submit');
  assert.equal(submit.inputSchema.required.includes('event'), true);
  assert.match(submit.description, /task\.submitted|plan\.submitted/);
  const taskSubmit = list.result.tools.find(tool => tool.name === 'task_submit');
  assert.equal(taskSubmit.inputSchema.required.includes('requires'), true);
  assert.deepEqual(taskSubmit.inputSchema.properties.requires.items.enum, ['read', 'exec', 'write']);
});

test('M7 campaign commands and plan waits carry typed identities', async () => {
  const submitted = [];
  const s = server({ops: {
    submit: async event => { submitted.push(event); return {ok: true, row: {kind: event.kind, campaignId: event.campaignId ?? 'new-campaign', seq: 8}}; },
    wait: async match => ({ok: true, row: {kind: 'plan.rejected', plan: match.plan, phase: 'implement', seq: 9}}),
  }, views: {campaign: id => id === 'c1' ? {id, state: 'active', remaining: ['review']} : null}});
  const started = await call(s, 'campaign_start', {objective: 'land reliability', required: ['tests'], campaignId: 'c1'});
  assert.equal(started.result.structuredContent.kind, 'campaign.start');
  assert.deepEqual(submitted.at(-1), {kind: 'campaign.start', campaignId: 'c1', objective: 'land reliability', required: ['tests'], reason: undefined});
  const got = await call(s, 'campaign_get', {campaignId: 'c1'});
  assert.deepEqual(got.result.structuredContent, {id: 'c1', state: 'active', remaining: ['review']});
  const waited = await call(s, 'plan_wait', {plan: 'p1', seconds: 1, afterSeq: 4});
  assert.deepEqual(waited.result.structuredContent, {waiting: false, row: {kind: 'plan.rejected', plan: 'p1', phase: 'implement', seq: 9}});
  await call(s, 'task_submit', {profile: 'builder', orders: 'fix', requires: ['read', 'exec'], jobId: 'j1', retryOf: 'older', campaignId: 'c1', gate: 'bridge', planId: 'p1', chunkId: 'ch1'});
  assert.deepEqual(submitted.at(-1), {kind: 'task.submitted', task: undefined, profile: 'builder', orders: 'fix', requires: ['read', 'exec'], parent: null, jobId: 'j1', retryOf: 'older', campaignId: 'c1', gate: 'bridge', planId: 'p1', chunkId: 'ch1'});
  await call(s, 'task_submit', {profile: 'builder', orders: 'legacy'});
  assert.equal(submitted.at(-1).requires, undefined);
});

test('M2 a tool call is a verb call, and the answer is structured, not text to parse', async () => {
  const s = server();
  const submitted = await call(s, 'submit', {event: {kind: 'task.submitted', profile: 'builder', orders: 'x'}});
  assert.deepEqual(submitted.result.structuredContent, {kind: 'task.submitted', task: 't1', seq: 4});
  assert.equal(submitted.result.content[0].type, 'text');
  assert.equal(submitted.result.isError, undefined);
  const got = await call(s, 'task_get', {task: 'land'});
  assert.deepEqual(got.result.structuredContent, view);
  assert.match(got.result.content[0].text, /^land · reviewing/);
  const listed = await call(s, 'tasks_list', {});
  assert.equal(listed.result.structuredContent.length, 1);
  const reported = await call(s, 'report', {report: {op: 'milestone', phase: 'read', text: 'x', next: 'y'}});
  assert.equal(reported.result.structuredContent.phase, 'read');
  // its own memory, written through the same interface: one living note, each call replacing the last
  const state = await call(s, 'state', {text: 'Phase two: locking review failed twice at the ceiling; moving it to codex.'});
  assert.equal(state.result.structuredContent.kind, 'state');
  assert.match(state.result.content[0].text, /replaces your last note/);
  assert.equal((await call(s, 'state', {text: '  '})).result.isError, true);
});

test('M3 wait answers inside the client\'s tool timeout: it says "not yet" instead of hanging', async () => {
  const s = server();
  const asked = [];
  const timed = createMcpServer({ops: {wait: async (match, options) => { asked.push(options.timeout); return {ok: true, row: null, timedOut: true}; }}, views: {}, version: '0'});
  const answer = await call(timed, 'wait', {match: {kind: 'task.completed'}, seconds: 600});
  assert.equal(asked[0], WAIT_SECONDS_MAX * 1000, `clamped to ${WAIT_SECONDS_MAX} s, not the 600 asked for`);
  assert.deepEqual(answer.result.structuredContent, {waiting: true, row: null});
  assert.match(answer.result.content[0].text, /not yet/i);
  const landed = await call(s, 'wait', {match: {kind: 'task.completed'}, seconds: 30});
  assert.deepEqual(landed.result.structuredContent, {waiting: false, row: {kind: 'task.completed', task: 't1'}});
});

test('M4 a refusal is the verb\'s refusal, and an unknown tool is an error, never a crash', async () => {
  const refusing = createMcpServer({ops: {submit: async () => ({ok: false, reason: 'not the granted peer', code: -32001})}, views: {}, version: '0'});
  const refused = await call(refusing, 'submit', {event: {kind: 'task.submitted'}});
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /not the granted peer/);
  const unknown = await call(server(), 'nope', {});
  assert.equal(unknown.result.isError, true);
  const bad = await server().handle({jsonrpc: '2.0', id: 9, method: 'no/such/method'});
  assert.equal(bad.error.code, -32601);
  const missing = await call(server(), 'task_get', {});
  assert.equal(missing.result.isError, true, 'a missing argument is refused, not passed through');
});

test('M5 a huge task still answers in a screenful: the view is what bounds it', async () => {
  const big = {...view, findings: {shown: Array.from({length: 10}, (_, i) => ({severity: 'major', file: `src/f${i}.ts`, line: i, title: `finding ${i}`})), total: 200, more: 190}};
  const s = server({views: {taskView: () => big}});
  const got = await call(s, 'task_get', {task: 'land'});
  assert.equal(JSON.stringify(got.result).length < 4000, true, `answer is ${JSON.stringify(got.result).length} characters`);
  assert.match(got.result.content[0].text, /190 more/);
});

// The other half of the same gap (live): the orchestrator called `task_get`, got the cut summary, and
// had no option to ask for the rest. `full: true` is that option — the bounded view stays the default so a
// listing never floods a turn, and one deliberate call returns the verdict whole.
test('M6 task_get can be asked for the whole report, and says so in its schema', async () => {
  const long = `## FINAL REVIEW REPORT\n**Outcome: FAIL**\n${'detail '.repeat(900)}END`;
  const asked = [];
  const s = createMcpServer({ops: {}, version: '0', views: {
    taskView: (task, options = {}) => { asked.push(options); return {...view, summary: 'cut at twelve hundred…', ...(options.report ? {report: long} : {})}; },
  }});
  const bounded = await call(s, 'task_get', {task: 'land'});
  assert.deepEqual(asked.at(-1), {report: false}, 'the default asks for the bounded view');
  assert.equal('report' in bounded.result.structuredContent, false);

  const whole = await call(s, 'task_get', {task: 'land', full: true});
  assert.deepEqual(asked.at(-1), {report: true});
  assert.equal(whole.result.structuredContent.report, long, 'the verdict arrives whole');
  assert.match(whole.result.content[0].text, /END$/, 'and the text rendering carries it too, not the cut summary');

  const tool = s.tools.find(t => t.name === 'task_get');
  assert.equal('full' in tool.inputSchema.properties, true, 'a caller can only use what the schema names');
  assert.match(tool.inputSchema.properties.full.description ?? '', /report|verdict/i);
});

test('task_submit preserves the admitted plan constraints', async () => {
  let submitted;
  const s = server({ops: {submit: async event => {submitted = event; return {ok: true, row: event};}}});
  const constraints = {requires: ['read', 'exec'], owns: ['src/a.js'], depends_on: ['earlier'], deadline: 60000, review: {completion: 'critic'}, steps: 'node --test', risk: 'logic', size: {lines: 1, probes: 1, minutes: 1}, checkpoint: {head: 'abc'}};
  await call(s, 'task_submit', {profile: 'builder', orders: 'verify', ...constraints});
  for (const [key, value] of Object.entries(constraints)) assert.deepEqual(submitted[key], value, key);
});

// Found reviewing the in-place build: task_submit neither declared nor forwarded inPlace, so an
// orchestrator on MCP could never ask for an in-place task.
test('task_submit declares and forwards inPlace', async () => {
  let submitted;
  const s = server({ops: {submit: async event => {submitted = event; return {ok: true, row: event};}}});
  const list = await s.handle({jsonrpc: '2.0', id: 1, method: 'tools/list'});
  const schema = list.result.tools.find(tool => tool.name === 'task_submit').inputSchema.properties.inPlace;
  assert.deepEqual(schema.properties, {authorizedBy: {type: 'number'}});
  assert.equal(schema.required, undefined, 'omitting authorizedBy cites the latest user message');
  await call(s, 'task_submit', {profile: 'builder', orders: 'commit it', requires: ['read', 'exec', 'write'], inPlace: {authorizedBy: 42}});
  assert.deepEqual(submitted.inPlace, {authorizedBy: 42});
});
