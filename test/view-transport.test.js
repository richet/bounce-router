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
