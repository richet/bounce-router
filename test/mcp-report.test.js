import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createReportServer} from '../src/mcp-report.js';
import {createBus} from '../src/bus.js';
import {Session} from '../src/core.js';
import {probeSandbox} from '../src/adapters/opencode-live.js';

const valid = {op: 'final', phase: 'done', text: 'Checked the source.', next: '',
  evidence: ['src/a.js:1'], outcome: 'blocked', summary: 'One issue remains.', remaining: 'Review needed.'};
const grant = {BOUNCE_REPORT_BUS: '/tmp/report.sock', BOUNCE_REPORT_TOKEN_FILE: '/tmp/report.token'};
const call = (name, args) => ({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name, arguments: args}});

test('report MCP exposes one structured tool and no orchestration verbs', async () => {
  const server = createReportServer({env: grant});
  const listed = await server.handle({jsonrpc: '2.0', id: 1, method: 'tools/list'});
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['report']);
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ['op', 'phase', 'text', 'next']);
  assert.equal(listed.result.tools[0].inputSchema.properties.evidence.maxItems, 32);
  assert.equal(listed.result.tools[0].inputSchema.properties.summary.maxLength, 16000);
  const refused = await server.handle(call('task_submit', valid));
  assert.equal(refused.result.isError, true);
});

test('report MCP validates, binds the assigned task, and acknowledges only after the bus accepts', async () => {
  const calls = [];
  let accept;
  const server = createReportServer({env: grant, readFile: () => 'token\n',
    connect: async credentials => {
      calls.push(['connect', credentials]);
      return {tasks: ['t1'], report: report => new Promise(resolve => { calls.push(['report', report]); accept = resolve; }),
        close: async () => { calls.push(['close']); }};
    }, task: 't1'});
  const answer = server.handle(call('report', valid));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 2), [['connect', {path: grant.BOUNCE_REPORT_BUS, token: 'token'}], ['report', valid]]);
  assert.equal(accept instanceof Function, true);
  accept({kind: 'task.reported', task: 't1', attempt: 2, seq: 47});
  const response = await answer;
  assert.equal(response.result.isError, undefined);
  assert.match(response.result.content[0].text, /report accepted/);
  assert.deepEqual(calls.at(-1), ['close']);
});

test('report MCP rejects invalid or unauthorized calls without publishing', async () => {
  let connected = 0;
  const server = createReportServer({env: grant, readFile: () => 'token', task: 't1',
    connect: async () => { connected++; return {tasks: ['wrong'], close: async () => {}}; }});
  for (const report of [{...valid, next: ['wrong type']}, {...valid, evidence: Array(33).fill('too many')}]) {
    const answer = await server.handle(call('report', report));
    assert.equal(answer.result.isError, true);
  }
  assert.equal(connected, 0);
  assert.equal((await server.handle(call('report', valid))).result.isError, true);
  assert.equal(connected, 1);
});

test('report MCP closes a connection that arrives after its deadline', async () => {
  let connected;
  let closed = 0;
  const server = createReportServer({env: grant, readFile: () => 'token', task: 't1', timeoutMs: 10,
    connect: () => new Promise(resolve => {connected = resolve;})});
  const response = await server.handle(call('report', valid));
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /timed out/);
  connected({tasks: ['t1'], close: async () => {closed++;}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1);
});

test('report MCP refuses an absent grant before connecting', async () => {
  let connected = false;
  const server = createReportServer({env: {}, connect: async () => { connected = true; }});
  assert.equal((await server.handle(call('report', valid))).result.isError, true);
  assert.equal(connected, false);
});

test('sandboxed report MCP reaches only its assigned real bus and acknowledges the journaled row', async t => {
  if (process.platform !== 'darwin') return t.skip('macOS sandbox-exec only');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-report-mcp-'));
  const session = new Session(root, {root});
  const bus = await createBus({session, dir: session.dir, report: ({task, attempt, report}) =>
    session.append({kind: 'task.reported', task, attempt, ...report})});
  t.after(async () => { await bus.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const {file} = bus.grant({peer: 'worker:t1', tasks: ['t1'], context: session.id, report: {task: 't1', attempt: 1}});
  const script = fileURLToPath(new URL('../src/mcp-report.js', import.meta.url));
  const child = spawn('/usr/bin/sandbox-exec', ['-p', probeSandbox(root, os.homedir(), null, bus.path), process.execPath, script],
    {env: {...process.env, BOUNCE_REPORT_BUS: bus.path, BOUNCE_REPORT_TOKEN_FILE: file, BOUNCE_REPORT_TASK: 't1'}});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const response = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`report MCP timed out: ${stderr}`)), 5000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(buffer.slice(0, end)));
    });
    child.once('error', reject);
    child.once('exit', code => { if (buffer.indexOf('\n') < 0) reject(new Error(`report MCP exited ${code}: ${stderr}`)); });
  });
  child.stdin.write(JSON.stringify(call('report', valid)) + '\n');
  const answer = await response;
  child.stdin.end();
  assert.equal(answer.result.isError, undefined, JSON.stringify(answer));
  assert.equal(session.events.some(event => event.kind === 'task.reported' && event.task === 't1' && event.summary === valid.summary), true);
});
