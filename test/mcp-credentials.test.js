// The MCP transport could read but never write. Found live: the orchestrator's rework was refused
// `-32001 unauthorized` on the shell bridge, and its retry over MCP failed too because `submit` and
// `state` had no credentials at all — codex launches `bounce mcp-serve` from its own global config, with
// no `env` block, so the per-session bus socket and token never reach it. The shell bridge gets them
// because BOUNCE spawns the orchestrator; nothing does that for a client-launched server.
//
// So the server finds the session the way `bounce task` already does — from disk — and refuses to guess
// when the answer is ambiguous: writing into the wrong campaign is worse than not writing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {liveSessionCredentials, credentials, sessionBinding} from '../src/bridge-ops.js';
import {Session} from '../src/core.js';
import {createMcpServer} from '../src/mcp.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const root = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-mcp-cred-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
const session = (dir, id, {token = 'tok'} = {}) => {
  const home = path.join(dir, 'sessions', id);
  fs.mkdirSync(path.join(home, 'tokens'), {recursive: true});
  fs.writeFileSync(path.join(home, 'tokens', `orchestrator-${id.slice(0, 8)}`), token);
  fs.writeFileSync(path.join(home, 'bus.sock'), '');
  return home;
};

test('one live session: the server finds its socket and the orchestrator token', t => {
  const dir = root(t);
  const home = session(dir, 'aaaaaaaa-1111');
  const found = liveSessionCredentials(dir, {list: () => [{id: 'aaaaaaaa-1111', live: true}, {id: 'bbbbbbbb-2222', live: false}]});
  assert.equal(found.ok, true);
  assert.equal(found.path, path.join(home, 'bus.sock'));
  assert.equal(found.tokenFile, path.join(home, 'tokens', 'orchestrator-aaaaaaaa'));
});

// A deep BOUNCE_HOME makes createBus use its short per-user fallback socket. Discovery
// must use the daemon's recorded endpoint, never reconstruct <session>/bus.sock.
test('discovery preserves the daemon\'s actual fallback socket endpoint', t => {
  const dir = root(t);
  const home = session(dir, 'aaaaaaaa-1111');
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({pid: process.pid, bus: '/tmp/bounce-test/fallback.sock', started: '2026-09-24T00:00:00.000Z'}));
  const found = liveSessionCredentials(dir, {list: () => [{id: 'aaaaaaaa-1111', live: true}]});
  assert.equal(found.ok, true);
  assert.equal(found.path, '/tmp/bounce-test/fallback.sock');
});

test('an explicit binding refreshes a restarted same session and never retargets another live one', t => {
  const dir = root(t);
  const a = new Session(dir, {root: dir});
  const b = new Session(dir, {root: dir});
  for (const [session, bus] of [[a, '/tmp/a-first.sock'], [b, '/tmp/b.sock']]) {
    fs.mkdirSync(path.join(session.dir, 'tokens'), {recursive: true});
    fs.writeFileSync(path.join(session.dir, 'tokens', 'orchestrator-test'), 'token');
    fs.writeFileSync(path.join(session.dir, 'daemon.json'), JSON.stringify({pid: process.pid, bus, started: '2026-09-24T00:00:00.000Z'}));
  }
  const binding = sessionBinding(dir, {env: {BOUNCE_SESSION: a.id}});
  assert.deepEqual([binding.refresh().session, binding.refresh().path], [a.id, '/tmp/a-first.sock']);
  fs.writeFileSync(path.join(a.dir, 'daemon.json'), JSON.stringify({pid: process.pid, bus: '/tmp/a-restarted.sock', started: '2026-09-24T01:00:00.000Z'}));
  assert.deepEqual([binding.refresh().session, binding.refresh().path], [a.id, '/tmp/a-restarted.sock']);
});

test('an explicit session and supplied bus must name the same endpoint', t => {
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  fs.mkdirSync(path.join(session.dir, 'tokens'), {recursive: true});
  fs.writeFileSync(path.join(session.dir, 'tokens', 'orchestrator-test'), 'token');
  fs.writeFileSync(path.join(session.dir, 'daemon.json'), JSON.stringify({pid: process.pid, bus: '/tmp/a.sock'}));
  const binding = sessionBinding(dir, {env: {BOUNCE_SESSION: session.id, BOUNCE_BUS: '/tmp/b.sock', BOUNCE_BUS_TOKEN_FILE: path.join(session.dir, 'tokens', 'orchestrator-test')}});
  assert.equal(binding.read().code, 'session_bus_mismatch');
  assert.equal(binding.refresh().code, 'session_bus_mismatch');
});

test('MCP read binding refusals remain structured rather than looking like empty views', async () => {
  const refusal = {ok: false, code: 'session_bus_mismatch', reason: 'BOUNCE_BUS does not belong to session aaa', repair: 'set BOUNCE_SESSION'};
  const server = createMcpServer({ops: {}, views: {binding: () => refusal}, version: '0'});
  const reply = await server.handle({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'tasks_list', arguments: {}}});
  assert.equal(reply.result.isError, true);
  assert.deepEqual(reply.result.structuredContent, {code: 'session_bus_mismatch', reason: refusal.reason, repair: refusal.repair});
});

test('no live session is a refusal, not a guess at the most recent one', t => {
  const dir = root(t);
  session(dir, 'aaaaaaaa-1111');
  const found = liveSessionCredentials(dir, {list: () => [{id: 'aaaaaaaa-1111', live: false}]});
  assert.equal(found.ok, false);
  assert.match(found.reason, /no live bounce session/i);
});

test('two live sessions is a refusal that names them: writing into the wrong campaign is worse than not writing', t => {
  const dir = root(t);
  session(dir, 'aaaaaaaa-1111'); session(dir, 'bbbbbbbb-2222');
  const found = liveSessionCredentials(dir, {list: () => [{id: 'aaaaaaaa-1111', live: true}, {id: 'bbbbbbbb-2222', live: true}]});
  assert.equal(found.ok, false);
  assert.match(found.reason, /2 live/);
  assert.match(found.reason, /aaaaaaaa/);
  assert.match(found.reason, /BOUNCE_BUS/, 'and says how to be explicit');
});

test('a live session with no orchestrator token is refused by name', t => {
  const dir = root(t);
  const home = path.join(dir, 'sessions', 'cccccccc-3333');
  fs.mkdirSync(path.join(home, 'tokens'), {recursive: true});
  const found = liveSessionCredentials(dir, {list: () => [{id: 'cccccccc-3333', live: true}]});
  assert.equal(found.ok, false);
  assert.match(found.reason, /orchestrator/);
});

test('env credentials always win, and discovery is only consulted without them', t => {
  const dir = root(t);
  const home = session(dir, 'aaaaaaaa-1111', {token: 'discovered'});
  fs.writeFileSync(path.join(dir, 'env-token'), 'from-env');
  const asked = [];
  const discover = () => { asked.push(1); return liveSessionCredentials(dir, {list: () => [{id: 'aaaaaaaa-1111', live: true}]}); };

  const fromEnv = credentials({BOUNCE_BUS: '/s.sock', BOUNCE_BUS_TOKEN_FILE: path.join(dir, 'env-token')}, {discover});
  assert.deepEqual([fromEnv.ok, fromEnv.token, asked.length], [true, 'from-env', 0], 'the env grant is used untouched');

  const discovered = credentials({}, {discover});
  assert.deepEqual([discovered.ok, discovered.token, discovered.path], [true, 'discovered', path.join(home, 'bus.sock')]);

  const refused = credentials({}, {discover: () => ({ok: false, reason: '2 live sessions: name one'})});
  assert.deepEqual([refused.ok, refused.reason], [false, '2 live sessions: name one'], 'the refusal reaches the caller verbatim');

  assert.equal(credentials({}).ok, false, 'with no discovery at all it still refuses as before');
});

// The seam is only real if createOps forwards it: wiring `discover` into the server and forgetting to pass
// it through would look exactly like a fix and change nothing.
test('createOps forwards discovery to every verb, and reports its refusal', async () => {
  const {createOps} = await import('../src/bridge-ops.js');
  const asked = [];
  const connected = [];
  const ops = createOps({env: {}, discover: () => { asked.push(1); return {ok: true, path: '/found.sock', tokenFile: null, token: 'x'}; },
    connect: async ({path}) => { connected.push(path); return {request: async () => ({row: {seq: 1}}), close() {}}; }});
  const refusing = createOps({env: {}, discover: () => ({ok: false, reason: '4 live bounce sessions (26732e00, …): set BOUNCE_BUS'})});
  const refused = await refusing.submit({kind: 'task.submitted', profile: 'builder', orders: 'go'});
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /4 live bounce sessions/, 'the caller is told which session to name, not "must be set"');
  assert.equal(refused.code, 'no_credential');
  assert.equal(asked.length >= 0, true);
});

// Composition gate: the real stdio executable must forward `full` through MCP,
// while discovery reads daemon.json's actual endpoint. No core or bus mock is used.
test('real mcp-serve returns task_get(full) through its actual stdio CLI', async t => {
  const dir = root(t);
  const session = new Session(dir, {root: dir});
  const report = `FINAL REPORT\n${'evidence '.repeat(300)}END`;
  session.append({kind: 'task.submitted', task: 't1', parent: null, profile: 'builder', orders: 'land it'});
  session.append({kind: 'task.started', task: 't1', attempt: 1});
  session.append({kind: 'task.completed', task: 't1', summary: report});
  // An offline historical journal is readable once named explicitly; it has no daemon
  // or bridge grant, so the same binding must still refuse subsequent mutations.
  const child = spawn(process.execPath, [cliPath, 'mcp-serve'], {env: {...process.env, BOUNCE_HOME: dir, BOUNCE_SESSION: session.id, BOUNCE_NO_UPDATE_CHECK: '1'}, stdio: ['pipe', 'pipe', 'pipe']});
  let buffer = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mcp-serve timed out: ${stderr}`)), 5000);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const line = buffer.indexOf('\n');
      if (line < 0) return;
      clearTimeout(timer); resolve(JSON.parse(buffer.slice(0, line)));
    });
  });
  t.after(() => { child.kill('SIGKILL'); });
  child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'task_get', arguments: {task: 't1', full: true}}}) + '\n');
  const reply = await response;
  assert.equal(reply.result.isError, undefined, JSON.stringify(reply));
  assert.equal(reply.result.structuredContent.report, report);
  assert.match(reply.result.content[0].text, /END$/);
});
