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

// Shared by the queued-prompt tests below: spins up the same fake daemon/child pairing as the
// test above, but exposes `listeners`/`calls` so a test can drive an attached (daemon-started)
// turn directly and inspect what the view sends back through main.run.
async function harness(t, {run} = {}) {
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
  const main = {
    state: () => ({state: 'idle', currentTurnId: null}),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async run(params) {
      calls.push(['run', params]);
      const result = run ? await run(params) : {accepted: true, requestId: params.id};
      if (result.accepted !== false) for (const fn of listeners) fn({kind: 'main.started', requestId: params.id, turnId: `turn-${params.id}`});
      return result;
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
  return {session, listeners, calls, child, waitFor, output: () => output};
}

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
  await waitFor(() => session.events.some(row => row.kind === 'status' && row.text?.startsWith('Fallback order: codex (default) · the first agent is the orchestrator')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).order, ['codex']);
  // The sidebar is on by default at 120 columns, /sidebar hides it and the choice is saved.
  assert.match(output, /BOUNCE/);
  output = '';
  child.stdin.write('/sidebar\r');
  // An older frame may already be buffered in the pipe. Assert the completed frame
  // showing the command result, rather than every frame received since the input.
  const latestFrame = () => output.match(/\x1b\[\?2026h[\s\S]*?\x1b\[\?2026l/g)?.at(-1) ?? '';
  await waitFor(() => latestFrame().includes('Sidebar hidden'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'))).sidebar, false);
  assert.doesNotMatch(latestFrame(), /BOUNCE/);
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
  // A daemon fallback is the daemon's for that turn: the next turn is still sent on the chosen
  // orchestrator (the profile's adapter and model); the daemon skips it again while it cools down.
  // Sending the fallback provider back would silently move the orchestrator off what the user chose.
  const requestId = calls.find(([kind]) => kind === 'run')[1].id;
  const selected = session.append({kind: 'main.starting', provider: 'claude', model: 'fallback-opus', mode: 'plan', requestId, state: 'starting'});
  for (const fn of listeners) fn(selected);
  for (const fn of listeners) fn({kind: 'main.terminal', requestId, status: 'completed', state: 'idle'});
  running = false;
  child.stdin.write('/agents main\r');
  await waitFor(() => output.includes('Focused orchestrator pane'));
  child.stdin.write('next turn\r');
  await waitFor(() => calls.filter(([kind]) => kind === 'run').length === 2);
  assert.equal(calls.at(-1)[1].provider, 'codex');
  assert.equal(calls.at(-1)[1].model, '');

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

// Reproduces the bug from session 159f4746: the daemon wakes the orchestrator on its own
// (main.starting with no prior run() call from this view — see scheduleRender in src/cli.js),
// the user answers while that attached turn is running, and the answer was silently discarded
// (queued only in a TUI-side array that scheduleRender then drained — reaching submit()/
// router.run() from a session subscriber, which U5a forbids). It must instead go out immediately
// through the normal keyboard path; main-service.js is what queues it now, server-side.
test('a prompt typed during an attached (daemon-started) turn is sent immediately through the normal keyboard path', {timeout: 15000}, async t => {
  const {listeners, calls, child, waitFor, output} = await harness(t);

  // The daemon starts a turn this view never called run() for — main-service.js waking the
  // orchestrator on worker outcomes.
  for (const fn of listeners) fn({kind: 'main.starting', requestId: 'r1', provider: 'codex', model: '', mode: 'plan', state: 'starting', handoff: true});
  await waitFor(() => output().includes('Orchestrator woke on worker outcomes'));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 0, 'the attached turn was not started by this view');

  child.stdin.write('no\r');
  // Sent right away — no local queueing, no waiting for the attached turn to end.
  await waitFor(() => calls.some(([kind]) => kind === 'run'));
  const sent = calls.find(([kind]) => kind === 'run')[1];
  assert.equal(sent.text, 'no');
  await waitFor(() => output().includes('Queued · runs when the current turn ends'));

  // The attached (foreign) turn ends. This view's own reply is still queued server-side and has
  // not started yet, so the view must stay busy — not read as idle — and must not send it again.
  for (const fn of listeners) fn({kind: 'main.terminal', requestId: 'r1', status: 'completed', state: 'idle'});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1, 'no duplicate send when the foreign turn ends');

  // This view's own queued reply finally starts and completes.
  for (const fn of listeners) fn({kind: 'main.terminal', requestId: sent.id, status: 'completed', state: 'idle'});
  await waitFor(() => output().includes('Turn completed'));
});

// A second prompt typed while this view's own reply (queued behind the attached turn) is still in
// flight is not a new race to handle server-side — it is exactly the ordinary case of typing ahead
// during any other turn, so it queues locally and is drained once this view's own turn ends.
test('a second prompt typed while this view is already busy on its own queued reply queues locally, in order', {timeout: 15000}, async t => {
  const {listeners, calls, child, waitFor, output} = await harness(t);

  for (const fn of listeners) fn({kind: 'main.starting', requestId: 'r1', provider: 'codex', model: '', mode: 'plan', state: 'starting', handoff: true});
  await waitFor(() => output().includes('Orchestrator woke on worker outcomes'));

  child.stdin.write('no\r');
  await waitFor(() => calls.some(([kind]) => kind === 'run'));
  const first = calls.find(([kind]) => kind === 'run')[1];

  child.stdin.write('also this\r');
  await waitFor(() => output().includes('Queued · 1 turn waiting'));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1, 'the second prompt is not sent yet');

  // The attached (foreign) turn ends — still busy on this view's own reply.
  for (const fn of listeners) fn({kind: 'main.terminal', requestId: 'r1', status: 'completed', state: 'idle'});
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, 1);

  // This view's own reply finishes: the locally queued second prompt goes out next.
  for (const fn of listeners) fn({kind: 'main.terminal', requestId: first.id, status: 'completed', state: 'idle'});
  await waitFor(() => calls.filter(([kind]) => kind === 'run').length === 2);
  const second = calls.at(-1)[1];
  assert.equal(second.text, 'also this');
  for (const fn of listeners) fn({kind: 'main.terminal', requestId: second.id, status: 'completed', state: 'idle'});
  await waitFor(() => output().includes('Turn completed'));
});

// Up on an empty input, Claude-Code style: pulls this view's own still-queued prompt back into the
// input box for editing (withdraw() removes it from the daemon's queue) instead of recalling
// history; the withdrawn prompt then never starts once the attached turn it was queued behind ends.
test('Up on an empty input withdraws this view\'s own queued prompt for editing; it never runs once the attached turn ends', {timeout: 15000}, async t => {
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
  let attached = false, queuedItem = null;
  // A minimal stand-in for main-service.js: while `attached` (a foreign turn is current) a run()
  // is queued exactly like start() does — its `user` row journaled with queued:true right away, no
  // main.started — and withdraw() removes it and journals main.withdrawn, same contract as the
  // real service.
  const main = {
    state: () => ({state: 'idle', currentTurnId: null}),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async run(params) {
      calls.push(['run', params]);
      if (attached) {
        session.append({kind: 'user', text: params.text, queued: true, requestId: params.id});
        queuedItem = {id: params.id, text: params.text};
        return {accepted: true, queued: true, requestId: params.id};
      }
      for (const fn of listeners) fn({kind: 'main.started', requestId: params.id, turnId: `turn-${params.id}`});
      return {accepted: true, requestId: params.id};
    },
    async withdraw(params) {
      calls.push(['withdraw', params]);
      if (!queuedItem || queuedItem.id !== params.id) return {withdrawn: false, reason: 'not_queued'};
      const item = queuedItem; queuedItem = null;
      // The row lands after the reply — the order that lost under load: the queued send, settled by
      // this row, overwrote "Pulled back for editing" with "Turn withdrawn. Session saved.".
      setTimeout(() => session.append({kind: 'main.withdrawn', from: 'user', requestId: item.id, text: item.text}), 100);
      return {withdrawn: true, text: item.text};
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
  async function waitFor(check, step = check.toString()) {
    const started = Date.now();
    while (!check()) {
      if (Date.now() - started > 4000) throw new Error(`Timed out waiting for CLI evidence (${step}):\n${output.slice(-2500)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await waitFor(() => output.includes('Ready.'));

  // Nothing queued yet: Up on an empty input recalls the previous history entry exactly as before.
  child.stdin.write('earlier message\r');
  await waitFor(() => calls.some(([kind]) => kind === 'run'));
  for (const fn of listeners) fn({kind: 'main.terminal', requestId: calls.find(([kind]) => kind === 'run')[1].id, status: 'completed', state: 'idle'});
  await waitFor(() => output.includes('Turn completed'));
  child.stdin.write('\x1b[A');
  await waitFor(() => output.includes('earlier message') && !output.includes('Pulled back'));
  child.stdin.write('\x15'); // Ctrl+U clears the recalled input before the queued scenario below

  // A foreign (daemon-started) turn attaches; this view sends its own reply, which main-service
  // queues (no main.started for it) — matching the existing "sent immediately" test above.
  attached = true;
  for (const fn of listeners) fn({kind: 'main.starting', requestId: 'r1', provider: 'codex', model: '', mode: 'plan', state: 'starting', handoff: true});
  await waitFor(() => output.includes('Orchestrator woke on worker outcomes'));
  child.stdin.write('queued reply text\r');
  await waitFor(() => output.includes('Queued · runs when the current turn ends'));
  const queuedCallsBefore = calls.filter(([kind]) => kind === 'run').length;
  const sent = calls.filter(([kind]) => kind === 'run').at(-1)[1];

  // Up on the (now empty) input withdraws it: main.withdraw reaches the daemon, and the text
  // comes back into the input box.
  child.stdin.write('\x1b[A');
  await waitFor(() => calls.some(([kind]) => kind === 'withdraw'));
  assert.deepEqual(calls.find(([kind]) => kind === 'withdraw')[1], {id: sent.id});
  await waitFor(() => session.events.some(row => row.kind === 'main.withdrawn'));
  const withdrawnRow = session.events.findLast(row => row.kind === 'main.withdrawn');
  assert.equal(withdrawnRow.requestId, sent.id);
  assert.equal(withdrawnRow.text, 'queued reply text');
  await waitFor(() => output.includes('Pulled back for editing'));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.doesNotMatch(output, /Turn withdrawn/, 'the settled queued send must not replace the pulled-back notice');

  // The attached turn ends: the withdrawn prompt is not dispatched — no extra run() call.
  attached = false;
  for (const fn of listeners) fn({kind: 'main.terminal', requestId: 'r1', status: 'completed', state: 'idle'});
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls.filter(([kind]) => kind === 'run').length, queuedCallsBefore, 'the withdrawn prompt never ran once the current turn ended');

  // The pulled-back text really is sitting in the input box: resending it (Enter) sends it as a
  // fresh prompt with the same text.
  child.stdin.write('\r');
  await waitFor(() => calls.filter(([kind]) => kind === 'run').length === queuedCallsBefore + 1);
  assert.equal(calls.at(-1)[1].text, 'queued reply text');
});
