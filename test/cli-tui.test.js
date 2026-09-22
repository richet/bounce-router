import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {hostSession} from '../src/remote.js';
import http from 'node:http';

test('CLI commands and live steering work while the daemon main turn is held', {timeout: 15000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-tui-cli-'));
  let catalogResponse;
  const catalogServer = http.createServer((request, response) => {catalogResponse = response;});
  await new Promise(resolve => catalogServer.listen(0, '127.0.0.1', resolve));
  t.after(() => {catalogResponse?.end('{"models":[]}'); catalogServer.closeAllConnections(); catalogServer.close();});
  const settings = {
    operation: 'orchestrator', orchestrator: 'main', mode: 'plan', order: ['codex'], models: {},
    profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}},
    local: {endpoints: {lmstudio: {backend: 'lmstudio', url: `http://127.0.0.1:${catalogServer.address().port}`}}},
    executables: {codex: '/nonexistent/bounce-test-codex', claude: '/nonexistent/bounce-test-claude'},
    skills: {scope: 'user', autoSync: false},
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(settings));
  const session = new Session(root, {root});
  const listeners = new Set(), calls = [];
  let running = false;
  const main = {
    state: () => ({state: running ? 'running' : 'idle', currentTurnId: running ? 'held-turn' : null}),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async run(params) {
      calls.push(['run', params]); running = true;
      for (const fn of listeners) fn({kind: 'main.started', requestId: params.id, turnId: 'held-turn'});
      return {accepted: true, requestId: params.id};
    },
    async deliver(params) { calls.push(['deliver', params]); return {state: 'acknowledged', tier: 'live'}; },
    async cancel(params) { calls.push(['cancel', params]); return {accepted: true}; },
  };
  const child = fork(fileURLToPath(new URL('./helpers/tui-process.js', import.meta.url)), [], {
    env: {...process.env, BOUNCE_HOME: root, BOUNCE_SUPERVISED: '1', BOUNCE_REMOTE_SESSION: '1',
      BOUNCE_ROLE: 'orchestrator', BOUNCE_ORCHESTRATOR_PROFILE: JSON.stringify({adapter: 'codex', model: '', mode: 'plan'}),
      BOUNCE_NO_UPDATE_CHECK: '1', FORCE_COLOR: '1'},
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const hosted = hostSession({session, child, main});
  t.after(async () => {
    hosted.detach();
    if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('close', resolve)); }
    fs.rmSync(root, {recursive: true, force: true});
  });
  async function waitFor(check) {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > 4000) throw new Error(`Timed out waiting for CLI evidence:\n${output.slice(-2500)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await waitFor(() => output.includes('Ready.'));
  child.stdin.write('work\r');
  await waitFor(() => calls.some(([kind]) => kind === 'run'));
  child.stdin.write('/details on\r');
  await waitFor(() => output.includes('Details expanded'));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1);
  child.stdin.write('/details off\r');
  await waitFor(() => output.includes('Details folded'));
  assert.equal(calls.filter(([kind]) => kind === 'cancel').length, 0);
  // Bare /order reads the order in effect (narrowed to the orchestrator's adapter here) without saving.
  child.stdin.write('/order\r');
  await waitFor(() => session.events.some(row => row.kind === 'status' && row.text?.startsWith('Fallback order: codex (default) · orchestrator profile decides')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).order, ['codex']);
  // The sidebar is on by default at 120 columns, /sidebar hides it and the choice is saved.
  assert.match(output, /BOUNCE/);
  output = '';
  child.stdin.write('/sidebar\r');
  await waitFor(() => output.includes('Sidebar hidden'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).sidebar, false);
  assert.doesNotMatch(output, /BOUNCE/);
  child.stdin.write('/sidebar on\r');
  await waitFor(() => output.includes('Sidebar shown'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).sidebar, true);
  child.stdin.write('/btw urgent correction\r');
  await waitFor(() => calls.some(([kind]) => kind === 'deliver'));
  const delivery = calls.find(([kind]) => kind === 'deliver')[1];
  assert.equal(delivery.text, 'urgent correction');
  assert.equal(delivery.expectedTurnId, 'held-turn');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).orchestrator, 'main');
  child.stdin.write('/agents\r');
  await waitFor(() => output.includes('Agent workspace'));
  child.stdin.write('/help\r');
  await waitFor(() => session.events.some(row => row.kind === 'help' && row.text?.includes('Agents & models')));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1, 'commands never start a second model turn');
  assert.equal(running, true, 'commands completed before the held provider turn ended');
  session.append({kind: 'task.submitted', task: 'aaa', profile: 'build', orders: 'first'});
  session.append({kind: 'task.started', task: 'aaa', attempt: 1});
  session.append({kind: 'task.failed', task: 'aaa', reason: 'limited'});
  session.append({kind: 'task.submitted', task: 'bbb', profile: 'build', replaces: 'aaa', orders: 'replacement'});
  session.append({kind: 'task.started', task: 'bbb', attempt: 1});
  // IPC replay and terminal input are separate channels; wait for the view to receive the task.
  await waitFor(() => output.includes('build · bbb'));
  child.stdin.write('/agents bbb\r');
  await waitFor(() => output.includes('Focused bbb'));
  child.stdin.write('worker correction\r');
  await waitFor(() => session.events.some(row => row.kind === 'message' && row.to === 'worker:bbb' && row.text === 'worker correction'));
  child.stdin.write('unsent draft');
  await waitFor(() => output.includes('unsent draft'));
  session.append({kind: 'task.completed', task: 'bbb', summary: 'Done'});
  await waitFor(() => session.events.some(row => row.kind === 'note' && row.text?.includes('Unsent draft for worker:aaa')));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1, 'retired pane draft never becomes an orchestrator prompt');
  // A daemon fallback updates both the selected provider and the next turn's model.
  const requestId = calls.find(([kind]) => kind === 'run')[1].id;
  const selected = session.append({kind: 'main.starting', provider: 'claude', model: 'fallback-opus', mode: 'plan', requestId, state: 'starting'});
  for (const fn of listeners) fn(selected);
  for (const fn of listeners) fn({kind: 'main.terminal', requestId, status: 'completed', state: 'idle'});
  running = false;
  child.stdin.write('/agents main\r');
  await waitFor(() => output.includes('Focused orchestrator pane'));
  child.stdin.write('next turn\r');
  await waitFor(() => calls.filter(([kind]) => kind === 'run').length === 2);
  assert.equal(calls.at(-1)[1].provider, 'claude');
  assert.equal(calls.at(-1)[1].model, 'fallback-opus');

  // /operation to the other mode restarts the session into it — refused (and not saved) while a
  // worker still runs, then a restart request naming the mode and exit 75 once the tree is idle.
  const restarts = [];
  child.on('message', message => { if (message?.type === 'restart') restarts.push(message); });
  session.append({kind: 'task.submitted', task: 'ccc', profile: 'build', orders: 'still busy'});
  session.append({kind: 'task.started', task: 'ccc', attempt: 1});
  await waitFor(() => output.includes('build · running'));
  child.stdin.write('/operation classic\r');
  await waitFor(() => output.includes('Cannot switch to classic: 1 worker is still running'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).operation, 'orchestrator');
  assert.equal(restarts.length, 0);
  session.append({kind: 'task.completed', task: 'ccc', summary: 'Done'});
  await waitFor(() => !output.slice(-3000).includes('build · running'));
  const exited = new Promise(resolve => child.once('close', resolve));
  child.stdin.write('/operation classic\r');
  await waitFor(() => restarts.length === 1);
  assert.equal(restarts[0].state.operation, 'classic');
  assert.equal(restarts[0].state.id, session.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).operation, 'classic');
  assert.equal(await exited, 75);
  assert.ok(session.events.some(row => row.kind === 'status' && row.text === 'Operation: classic — saved; restarting this session into classic…'));
});
