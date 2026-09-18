import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {connectView} from '../src/view-transport.js';
import {createRemoteSession} from '../src/remote.js';
import {activateLocalProfiles} from '../src/local-activation.js';

test('real daemon keeps a held main turn across view detach, then steers and explicitly quits', {timeout: 12000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-persistent-contract-'));
  const fake = fileURLToPath(new URL('./helpers/fake-codex-app-server.js', import.meta.url));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({operation: 'orchestrator', orchestrator: 'main', order: ['codex'], models: {}, mode: 'plan',
    profiles: {main: {adapter: 'codex'}, build: {adapter: 'codex'}}, executables: {codex: fake}, skills: {autoSync: false}}));
  const session = new Session(root, {root});
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--resume', session.id, '--cwd', root], {
    env: {...process.env, BOUNCE_HOME: root, BOUNCE_VIEW_DAEMON: '1', BOUNCE_DETACHED: '1', BOUNCE_NO_UPDATE_CHECK: '1', FAKE_DELAY_MS: '8000'}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const ended = new Promise(resolve => child.once('close', resolve));
  let channel;
  t.after(async () => { channel?.close(); if (child.exitCode === null) child.kill('SIGTERM'); await ended; fs.rmSync(root, {recursive: true, force: true}); });
  const deadline = Date.now() + 5000;
  let info;
  while (Date.now() < deadline) {
    try { info = JSON.parse(fs.readFileSync(path.join(session.dir, 'daemon.json'), 'utf8')); } catch {}
    if (info?.view) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(typeof info?.view, 'string', output);
  const credentials = {path: info.view, token: fs.readFileSync(info.userToken, 'utf8').trim()};
  channel = await connectView(credentials);
  const first = await createRemoteSession(channel);
  const started = new Promise(resolve => { const stop = first.subscribe(row => { if (row.kind === 'main.started') { stop(); resolve(row); } }); });
  assert.equal((await first.runMain({id: 'request', text: 'work', provider: 'codex', mode: 'plan'})).accepted, true);
  const turn = await started;
  channel.close();
  channel = await connectView(credentials);
  const second = await createRemoteSession(channel);
  assert.equal(second.main.state, 'running');
  assert.equal(second.main.currentTurnId, turn.turnId);
  assert.equal(second.events.filter(row => row.kind === 'main.started').length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
  saved.profiles.local_read = {adapter: 'local', policy: 'read-only', model: 'test-local-model'};
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(saved));
  const activated = await activateLocalProfiles(second, ['local_read']);
  assert.deepEqual(activated.names, ['local_read']);
  assert.match(fs.readFileSync(path.join(session.dir, 'orchestrator', 'ORDERS.md'), 'utf8'), /local_read → local\/test-local-model/);
  assert.equal(second.main.currentTurnId, turn.turnId);
  assert.equal(second.events.filter(row => row.kind === 'main.started').length, 1);
  assert.equal((await second.deliverMain({text: 'correction', expectedTurnId: turn.turnId})).state, 'acknowledged');
  assert.equal((await second.cancelMain({id: 'request'})).verified, true);
  channel.send({type: 'control', action: 'quit'});
  assert.equal(await ended, 0, output);
});
