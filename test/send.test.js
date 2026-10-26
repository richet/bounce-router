// `bounce send`: a message to a running session's orchestrator from outside its view, as if typed there, marked so
// the journal and the TUI say it was sent. 2026-10-25: a Claude Code session watching a run needs to steer
// the orchestrator the way he does from the TUI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createMainService} from '../src/main-service.js';
import {createViewServer, connectView} from '../src/view-transport.js';
import {createFormatter} from '../src/format.js';
import {sendToOrchestrator} from '../src/send.js';

function fixture(t, {answer = 'pong', hold = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-send-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const pending = [];
  const adapter = {
    async launch() { return {turnId: 'vendor-turn'}; },
    async resume() { return {turnId: 'next-turn'}; },
    async *events() {
      yield {kind: 'native', provider: 'claude', sessionId: 'native-thread'};
      if (hold) yield await new Promise(resolve => pending.push(resolve));
      yield {kind: 'assistant', text: answer};
      yield {kind: 'result', status: 'completed', text: answer};
    },
    async deliver() { return 'live'; },
    async cancel() { pending.shift()?.({kind: 'result', status: 'interrupted'}); return {verified: true}; },
  };
  const main = createMainService({session, adapters: {claude: adapter}, profile: {adapter: 'claude', mode: 'yolo'}, settings: {executables: {}}, brief: 'Orders'});
  t.after(() => main.close());
  return {session, main, release: () => pending.shift()?.({kind: 'status', text: 'go on'})};
}

async function viewOf(t, f) {
  const server = await createViewServer({session: f.session, main: f.main, token: 'secret'});
  t.after(() => server.close());
  return connectView({path: server.path, token: 'secret'});
}

test('a sent message is a user turn marked via send; an unknown via is refused', async t => {
  const f = fixture(t);
  const sent = await sendToOrchestrator(await viewOf(t, f), 'run the review again');
  assert.equal(sent.accepted, true);
  const user = f.session.events.findLast(e => e.kind === 'user');
  assert.deepEqual([user.text, user.via], ['run the review again', 'send']);
  assert.equal(f.main.run({text: 'x', via: 'mail'}).reason, 'invalid_via');
});

test('with wait, send returns when the turn ends, with the orchestrator\'s answer', async t => {
  const f = fixture(t, {answer: 'Reviewing waves 1 to 3 on sonnet now.'});
  const sent = await sendToOrchestrator(await viewOf(t, f), 'review the three waves', {wait: true});
  assert.deepEqual({accepted: sent.accepted, status: sent.status, answer: sent.answer}, {accepted: true, status: 'completed', answer: 'Reviewing waves 1 to 3 on sonnet now.'});
});

test('a message sent while the orchestrator is busy is queued as typed ones are, marked via send, and its wait covers its own turn', async t => {
  const f = fixture(t, {hold: true});
  f.main.run({id: 'first', text: 'keep going'});
  await new Promise(resolve => setTimeout(resolve, 20));
  const waiting = sendToOrchestrator(await viewOf(t, f), 'stop after this wave', {wait: true});
  await new Promise(resolve => setTimeout(resolve, 20));
  const queued = f.session.events.findLast(e => e.kind === 'user');
  assert.deepEqual([queued.text, queued.queued, queued.via], ['stop after this wave', true, 'send']);
  f.release();
  setTimeout(() => f.release(), 50);
  const sent = await waiting;
  assert.equal(sent.queued, true);
  assert.equal(sent.status, 'completed');
  assert.notEqual(sent.requestId, 'first');
});

test('the TUI shows a sent message as the user\'s, marked as sent', () => {
  const {event} = createFormatter({color: false, compact: true});
  assert.deepEqual(event({kind: 'user', text: 'review the waves', via: 'send'}, 80), ['> review the waves', '  ⎿  via bounce send', '']);
  assert.deepEqual(event({kind: 'user', text: 'review the waves'}, 80), ['> review the waves', '']);
});

// The same, as MCP tools for an agent outside bounce (2026-10-25: "que tu puedas enviarle mensajes como si
// fuera yo"). A separate server from the agents' own, so no orchestrator or worker is handed a way to speak as the user.
test('control MCP: send, then answer, reach the live session the way bounce send does', async t => {
  const {createControlServer} = await import('../src/mcp-control.js');
  const f = fixture(t, {answer: 'On it.'});
  const server = await createViewServer({session: f.session, main: f.main, token: 'secret'});
  t.after(() => server.close());
  const control = createControlServer({
    sessions: () => [{id: f.session.id, name: 'webapp', cwd: '/w/webapp', live: true, operation: 'orchestrator'}],
    connect: id => { assert.equal(id, f.session.id); return connectView({path: server.path, token: 'secret'}); },
  });
  const call = async (name, args) => (await control.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})).result;
  assert.deepEqual((await control.handle({jsonrpc: '2.0', id: 1, method: 'tools/list'})).result.tools.map(tool => tool.name), ['sessions', 'status', 'tasks', 'task', 'send', 'answer']);
  assert.match((await call('sessions', {})).content[0].text, /webapp/);
  const sent = await call('send', {message: 'review the three waves', wait_seconds: 10});
  assert.equal(sent.structuredContent.status, 'completed');
  assert.equal(sent.structuredContent.answer, 'On it.');
  assert.equal(f.session.events.findLast(e => e.kind === 'user').via, 'send');
  const again = await call('answer', {request: sent.structuredContent.requestId});
  assert.deepEqual([again.structuredContent.status, again.structuredContent.answer], ['completed', 'On it.']);
  assert.equal((await call('answer', {request: 'nope'})).structuredContent.status, 'unknown');
});

test('control MCP: with several live sessions, send names them instead of guessing', async () => {
  const {createControlServer} = await import('../src/mcp-control.js');
  const control = createControlServer({sessions: () => [{id: 'aaaa1111', name: 'webapp', cwd: '/w/webapp', live: true}, {id: 'bbbb2222', name: 'api', cwd: '/w/api', live: true}], connect: () => { throw new Error('never'); }});
  const result = (await control.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'send', arguments: {message: 'hi'}}})).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /2 live sessions.*aaaa1111 \(webapp\).*bbbb2222 \(api\)/);
});

// Reading, beside sending (2026-10-25: "de otra manera no se podra controlar de forma efectiva"): what the
// orchestrator is doing, its own note, the live tasks with the AI on each, what waits for a decision, its last answer.
const at = (minute, row) => ({time: `2026-10-25T10:${String(minute).padStart(2, '0')}:00.000Z`, ...row});
const journal = [
  at(0, {kind: 'user', text: 'do step 14b', via: 'send', seq: 1}),
  at(0, {kind: 'main.started', requestId: 'r1', seq: 2}),
  at(1, {kind: 'state', from: 'orchestrator', text: 'Step 14b: builder on it; then the checklist review.', seq: 3}),
  at(1, {kind: 'task.submitted', task: 'build-1', profile: 'builder', orders: 'refactor data access', seq: 4}),
  at(2, {kind: 'task.started', task: 'build-1', attempt: 1, requested: 'sonnet', seq: 5}),
  at(3, {kind: 'task.milestone', task: 'build-1', phase: 'edit', text: 'moving users to data/users.ts', seq: 6}),
  at(3, {kind: 'task.submitted', task: 'review-1', profile: 'reviewer', orders: 'review 13', seq: 7}),
  at(4, {kind: 'task.started', task: 'review-1', attempt: 1, requested: 'qwen3.8-27b', seq: 8}),
  at(5, {kind: 'task.blocked', task: 'review-1', reason: 'review_unreadable', text: 'The review ended without a verdict bounce could read.', seq: 9}),
  at(6, {kind: 'assistant', from: 'main', text: 'Builder is moving users; I will wait on it.', seq: 10}),
];

test('status: the orchestrator\'s turn, its note, live tasks with their AI, what is blocked, its last answer', async () => {
  const {orchestratorStatus, formatStatus} = await import('../src/control-status.js');
  const view = orchestratorStatus(journal, {now: Date.parse('2026-10-25T10:10:00.000Z')});
  assert.deepEqual(view.orchestrator, {state: 'running', since: '2026-10-25T10:00:00.000Z', minutes: 10, request: 'r1'});
  assert.equal(view.note, 'Step 14b: builder on it; then the checklist review.');
  assert.deepEqual(view.tasks.map(t => [t.task, t.profile, t.ai, t.state]), [['build-1', 'builder', 'sonnet', 'running'], ['review-1', 'reviewer', 'qwen3.8-27b', 'blocked']]);
  assert.deepEqual(view.blocked, [{task: 'review-1', reason: 'review_unreadable', text: 'The review ended without a verdict bounce could read.'}]);
  assert.equal(view.lastAnswer, 'Builder is moving users; I will wait on it.');
  const text = formatStatus(view);
  assert.match(text, /^Orchestrator: running for 10 min/);
  assert.match(text, /build-1 · builder on sonnet · running · 8 min · moving users to data\/users\.ts/);
  assert.match(text, /Waiting on a decision:\n  review-1 · review_unreadable · The review ended/);
  const idle = orchestratorStatus([...journal, at(7, {kind: 'main.terminal', requestId: 'r1', status: 'completed', seq: 11})], {now: Date.parse('2026-10-25T10:10:00.000Z')});
  assert.deepEqual([idle.orchestrator.state, idle.orchestrator.since], ['idle', '2026-10-25T10:07:00.000Z']);
});

test('control MCP: status, tasks and task read the session\'s journal', async () => {
  const {createControlServer} = await import('../src/mcp-control.js');
  const control = createControlServer({sessions: () => [{id: 'aaaa1111', name: 'webapp', cwd: '/w/webapp', live: true}], connect: () => { throw new Error('reads never connect'); }, events: id => { assert.equal(id, 'aaaa1111'); return journal; }});
  const call = async (name, args) => (await control.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})).result;
  assert.deepEqual((await control.handle({jsonrpc: '2.0', id: 1, method: 'tools/list'})).result.tools.map(tool => tool.name), ['sessions', 'status', 'tasks', 'task', 'send', 'answer']);
  assert.match((await call('status', {})).content[0].text, /^Orchestrator: running/);
  assert.deepEqual((await call('tasks', {})).structuredContent.tasks.map(t => t.task), ['build-1', 'review-1']);
  const one = await call('task', {task: 'review'});
  assert.equal(one.structuredContent.task, 'review-1');
  assert.equal((await call('task', {task: 'build-1', full: true})).structuredContent.fullOrders, 'refactor data access');
  assert.equal((await call('task', {task: 'nope'})).isError, true);
});
