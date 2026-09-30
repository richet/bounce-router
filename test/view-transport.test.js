import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createRemoteSession} from '../src/remote.js';
import {createViewServer, connectView} from '../src/view-transport.js';

test('authenticated view detaches and reattaches without cancelling or relaunching main', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-view-contract-'));
  const session = new Session(root, {root});
  let runs = 0, cancels = 0;
  const listeners = new Set();
  const main = {state: () => ({state: runs ? 'running' : 'idle', currentTurnId: 'turn', requestId: 'request'}),
    run: async () => { runs++; return {accepted: true}; }, cancel: async () => { cancels++; return {verified: true}; },
    deliver: async () => ({state: 'acknowledged'}), subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }};
  const server = await createViewServer({session, main, token: 'secret', onControl: () => {}});
  t.after(async () => { await server.close(); fs.rmSync(root, {recursive: true, force: true}); });
  await assert.rejects(connectView({path: server.path, token: 'wrong'}), /authentication/);
  const firstChannel = await connectView({path: server.path, token: 'secret'});
  const first = await createRemoteSession(firstChannel);
  assert.equal((await first.runMain({text: 'work'})).accepted, true);
  firstChannel.close();
  session.append({kind: 'assistant', text: 'Still working', from: 'main'});
  const secondChannel = await connectView({path: server.path, token: 'secret'});
  const second = await createRemoteSession(secondChannel);
  assert.equal(second.main.state, 'running');
  assert.equal(second.events.at(-1).text, 'Still working');
  assert.equal(runs, 1);
  assert.equal(cancels, 0);
  assert.equal((await second.deliverMain({text: 'correction'})).state, 'acknowledged');
  secondChannel.close();
});

test('closing a view flushes an explicit quit control before disconnecting', {timeout: 3000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-view-quit-'));
  const session = new Session(root, {root});
  let resolveQuit;
  const quit = new Promise(resolve => { resolveQuit = resolve; });
  const main = {state: () => ({state: 'idle'}), subscribe: () => () => {}};
  const server = await createViewServer({session, main, token: 'secret', onControl: resolveQuit});
  t.after(async () => { await server.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const channel = await connectView({path: server.path, token: 'secret'});
  channel.send({type: 'control', action: 'quit'});
  channel.close();
  assert.equal((await quit).action, 'quit');
});

// Found live (ACE d1bc0206): a daemon that died left bus.view behind; every resume then failed
// "Daemon did not become ready" because listen() hit EADDRINUSE on the dead socket.
test('a view server starts over the socket a dead daemon left behind', {timeout: 5000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-view-stale-'));
  const session = new Session(root, {root});
  const main = {state: () => ({state: 'idle'}), run: async () => ({accepted: true}), cancel: async () => ({verified: true}),
    deliver: async () => ({state: 'acknowledged'}), subscribe: () => () => {}};
  const first = await createViewServer({session, main, token: 'secret'});
  const socketPath = first.path;
  await first.close();
  // A listener killed outright never removes its socket file: exactly what a crashed daemon leaves.
  const {spawnSync} = await import('node:child_process');
  spawnSync(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`]);
  assert.equal(fs.existsSync(socketPath), true, 'the dead listener left its socket file');
  const server = await createViewServer({session, main, token: 'secret'});
  t.after(async () => { await server.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const channel = await connectView({path: server.path, token: 'secret'});
  channel.close();
});

// Found live (ACE d1bc0206): the session's replay was one 20.1 MB message and the view channel drops
// any message over 16 MB, so every attach hung with the TUI waiting for a session that never came.
test('a view attaches to a session whose history is larger than one channel message allows', {timeout: 60000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-view-large-'));
  const session = new Session(root, {root});
  // 18 MB in 180 rows: each append is fsynced, so fewer, larger rows keep this fast under a loaded suite.
  const filler = 'x'.repeat(100_000);
  for (let i = 0; i < 180; i++) session.append({kind: 'raw', provider: 'codex', text: `${i} ${filler}`});
  const main = {state: () => ({state: 'idle'}), run: async () => ({accepted: true}), cancel: async () => ({verified: true}),
    deliver: async () => ({state: 'acknowledged'}), subscribe: () => () => {}};
  const server = await createViewServer({session, main, token: 'secret'});
  t.after(async () => { await server.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const channel = await connectView({path: server.path, token: 'secret'});
  const remote = await createRemoteSession(channel);
  assert.equal(remote.events.length, session.events.length);
  assert.equal(remote.events.filter(e => e.kind === 'raw').at(-1).text.startsWith('179 '), true);
  channel.close();
});
