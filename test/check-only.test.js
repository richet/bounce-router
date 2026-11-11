// A check-only task (submit with `at`): no worker turn, the check runs on that commit in a copy, and the task ends
// accepted or failed. It never goes through delivery, so it never ends blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';
import {fakeAdapter} from './helpers/fake-adapter.js';
import {createBus} from '../src/bus.js';
import {createOps} from '../src/bridge-ops.js';
import {createMcpServer} from '../src/mcp.js';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const setup = (t, {delivery = 'branch', worker: script = () => { throw new Error('a check-only task launched a worker'); }} = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-check-only-')));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@example.com'); git(project, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(project, 'version.txt'), 'one\n');
  git(project, 'add', '.'); git(project, 'commit', '-qm', 'one');
  const first = git(project, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(project, 'version.txt'), 'two\n');
  git(project, 'commit', '-qam', 'two');
  if (delivery) git(project, 'config', 'bounce.delivery', delivery);
  const session = new Session(project, {root: path.join(root, 'home')});
  const worker = fakeAdapter(script);
  const scheduler = createScheduler({session, adapters: {worker}, requireFinalReport: true, gitHead: () => null,
    profiles: {analyst: {adapter: 'worker', model: 'w', mode: 'yolo', fallback: [], policy: 'read'}}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  return {project, session, scheduler, worker, first};
};
const waitFor = async (fn, timeout = 5000) => {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const ended = (scheduler, task) => waitFor(() => ['accepted', 'failed', 'blocked'].includes(scheduler.tasks()[task]?.state) && scheduler.tasks()[task].state);

test('a passed check on a ref ends accepted, not delivery_detached, under branch delivery', async t => {
  const {session, scheduler, worker, first} = setup(t);
  const {task} = scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: first.slice(0, 7), check: 'grep -qx one version.txt'});
  assert.equal(await ended(scheduler, task), 'accepted');
  assert.equal(session.events.find(e => e.kind === 'task.submitted' && e.task === task).commit, first);
  const check = session.events.findLast(e => e.kind === 'task.check' && e.task === task);
  assert.equal(check.passed, true);
  assert.equal(check.head, first);
  assert.equal(worker.calls.launch, 0);
  assert.equal(session.events.some(e => e.task === task && ['task.blocked', 'task.integrated', 'policy.escalated'].includes(e.kind)), false);
});

test('a failed check ends failed with its output', async t => {
  const {session, scheduler} = setup(t);
  const {task} = scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'main', check: 'cat version.txt; exit 3'});
  assert.equal(await ended(scheduler, task), 'failed');
  const failed = session.events.findLast(e => e.kind === 'task.failed' && e.task === task);
  assert.equal(failed.reason, 'check_failed');
  assert.match(failed.text, /exit 3.*main[\s\S]*two/);
});

test('a ref that names no commit is refused at submit, before any copy or worker', t => {
  const {session, scheduler} = setup(t);
  assert.throws(() => scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'deadbee', check: 'true'}), /at \(deadbee names no commit in the checkout/);
  assert.throws(() => scheduler.submit({parent: null, profile: 'analyst', orders: 'gate', deadline: null, at: 'main'}), /check-only task needs a check/);
  assert.equal(session.events.some(e => e.kind === 'task.submitted'), false);
});

// The orchestrator submits through its MCP tools, which publish on the bus as `orchestrator`: the path a session
// really uses. A check-only submit with no orders, requires or agent must validate there and run with no worker.
const orchestratorMcp = async (t, {session, scheduler}) => {
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate, prepare: scheduler.prepare});
  t.after(() => bus.close());
  const grant = bus.grant({peer: 'orchestrator', canSubmit: true, tasks: []});
  const mcp = createMcpServer({ops: createOps({env: {BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file}}), views: {}});
  return async (name, args) => (await mcp.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args}})).result;
};

test('a check-only submit through the orchestrator\'s task_submit needs only at and check, and runs with no worker', async t => {
  const context = setup(t);
  const {session, scheduler, worker, first} = context;
  const call = await orchestratorMcp(t, context);
  const result = await call('task_submit', {task: 'gate1', parent: null, at: first.slice(0, 7), check: 'grep -qx one version.txt', checkTimeoutMinutes: 120});
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(await ended(scheduler, 'gate1'), 'accepted');
  const row = session.events.find(e => e.kind === 'task.submitted' && e.task === 'gate1');
  assert.equal(row.commit, first);
  assert.equal(row.checkTimeoutMinutes, 120);
  assert.equal(session.events.findLast(e => e.kind === 'task.accepted' && e.task === 'gate1').checkOnly, true);
  assert.equal(worker.calls.launch, 0);
  assert.equal(session.events.some(e => e.kind === 'task.corrected' && e.task === 'gate1' && e.text.startsWith('profile:')), false, 'no agent notice for a check-only task');
});

test('a check-only event through the orchestrator\'s raw submit runs the check itself, even with orders and requires given', async t => {
  const context = setup(t);
  const {session, scheduler, worker} = context;
  const call = await orchestratorMcp(t, context);
  const bare = await call('submit', {event: {kind: 'task.submitted', task: 'gate2', parent: null, at: 'main', check: 'cat version.txt; exit 3'}});
  assert.equal(bare.isError, undefined, JSON.stringify(bare));
  const withOrders = await call('submit', {event: {kind: 'task.submitted', task: 'gate3', parent: null, orders: 'check-only', requires: ['read', 'exec'], at: 'main', check: 'grep -qx two version.txt'}});
  assert.equal(withOrders.isError, undefined, JSON.stringify(withOrders));
  assert.equal(await ended(scheduler, 'gate2'), 'failed');
  assert.equal(session.events.findLast(e => e.kind === 'task.failed' && e.task === 'gate2').reason, 'check_failed');
  assert.equal(await ended(scheduler, 'gate3'), 'accepted');
  assert.equal(worker.calls.launch, 0);
});

test('through the orchestrator\'s submit, a ref that names no commit is refused and a peer-sent commit is ignored', async t => {
  const context = setup(t);
  const {session, scheduler, first} = context;
  const call = await orchestratorMcp(t, context);
  const refused = await call('task_submit', {task: 'gate4', parent: null, at: 'deadbee', check: 'true'});
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /at \(deadbee names no commit in the checkout/);
  const forged = await call('submit', {event: {kind: 'task.submitted', task: 'gate5', parent: null, profile: 'analyst', orders: 'look', requires: ['read'], commit: first}});
  assert.equal(forged.isError, undefined, JSON.stringify(forged));
  assert.equal(session.events.find(e => e.kind === 'task.submitted' && e.task === 'gate5').commit, undefined);
  assert.equal(session.events.some(e => e.kind === 'task.submitted' && e.task === 'gate4'), false);
});

test('a new task beside a held one of the same agent is accepted, and the reply says the held one still waits', async t => {
  const context = setup(t, {worker: () => new Promise(() => {})});
  const {session} = context;
  const call = await orchestratorMcp(t, context);
  session.append({kind: 'task.submitted', task: 'plan1', from: 'orchestrator', profile: 'analyst', orders: 'plan', requires: ['read']});
  session.append({kind: 'task.blocked', task: 'plan1', reason: 'worker_blocked', text: 'Blocked: outside my copy'});
  const fresh = await call('submit', {event: {kind: 'task.submitted', task: 'plan2', parent: null, profile: 'analyst', orders: 'plan again', requires: ['read']}});
  assert.equal(fresh.isError, undefined, JSON.stringify(fresh));
  assert.deepEqual(session.events.filter(e => e.kind === 'task.corrected' && e.task === 'plan2').map(e => e.text),
    ['held: plan1 (blocked) of the analyst agent still waits on you, and a new task does not close it: answer the worker, accept, send back or cancel, or name it in retryOf']);
  const retry = context.scheduler.prepare({kind: 'task.submitted', task: 'plan3', parent: null, from: 'orchestrator', profile: 'analyst', orders: 'plan again', requires: ['read'], retryOf: 'plan1'});
  assert.equal((retry.corrections ?? []).some(text => text.startsWith('held:')), false, 'retryOf names it');
});
