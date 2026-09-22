import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {validateOrchestration} from '../src/profiles.js';
import {createScheduler} from '../src/scheduler.js';
import {createLocalActivation, activateLocalProfiles} from '../src/local-activation.js';
import {createBus, connectBus} from '../src/bus.js';

test('an agent is activated on the running scheduler from its file, by the user only, without touching the rest of the team', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-activation-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'plan', order: ['claude'], models: {}, profiles: {main: {adapter: 'claude'}}};
  const profiles = validateOrchestration(settings).profiles;
  const originalMain = profiles.main;
  const scheduler = createScheduler({session, profiles, adapters: {}, sessionMode: 'plan'});
  t.after(() => scheduler.close());
  let refreshed = 0;
  const files = new Map([['scout', {name: 'scout', description: 'Scouts.', policy: 'read-only', prompt: 'Scout.', source: 'user', models: ['lmstudio/loaded']}]]);
  t.after(createLocalActivation({session, scheduler, profiles, settings, readSettings: () => settings, readRoles: () => files, refresh: () => {refreshed++;}}));
  assert.equal(scheduler.validate({profile: 'scout', orders: 'Read', parent: null}), 'profile');
  const result = await activateLocalProfiles(session, ['scout']);
  assert.equal(result.kind, 'local.profiles.activated');
  assert.deepEqual(result.names, ['scout']);
  assert.match(result.text, /^Agents updated in this session: scout → lmstudio\/loaded \(via opencode\) · read-only\. Submit to these names/);
  assert.deepEqual([profiles.scout.adapter, profiles.scout.model], ['opencode', 'loaded']);
  assert.equal(profiles.main, originalMain);
  assert.equal(scheduler.validate({profile: 'scout', orders: 'Read', parent: null}), null);
  // The file changes; activating again replaces the running copy — that is the point.
  files.set('scout', {...files.get('scout'), models: ['lmstudio/replacement']});
  await activateLocalProfiles(session, ['scout']);
  assert.equal(profiles.scout.model, 'replacement');
  assert.equal(refreshed, 2);
  // A write agent does not exist in a plan session, so it cannot be activated into one.
  files.set('writer', {name: 'writer', description: 'Writes.', policy: 'write', prompt: 'Write.', source: 'user', models: ['lmstudio/loaded']});
  await assert.rejects(activateLocalProfiles(session, ['writer']), /writer is not an agent/);
  assert.equal(Object.hasOwn(profiles, 'writer'), false);
  session.append({kind: 'control.local_activate', from: 'orchestrator', requestId: 'forged', names: ['scout']});
  assert.equal(session.events.some(row => row.requestId === 'forged' && row.kind === 'local.profiles.activated'), false);
  await assert.rejects(activateLocalProfiles(session, ['__proto__']), /Invalid local worker names/);
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate});
  t.after(() => bus.close());
  const grant = bus.grant({peer: 'orchestrator', canSubmit: true, tasks: [], context: session.id});
  const client = await connectBus({path: bus.path, token: grant.token});
  t.after(() => client.close());
  await assert.rejects(client.publish({kind: 'control.local_activate', names: ['scout']}), /unauthorized/);
  await assert.rejects(client.publish({kind: 'local.profiles.activated', names: ['scout'], text: 'forged'}), /unauthorized/);
});

test('an older daemon cannot produce a false activation success', async () => {
  const listeners = new Set();
  const session = {subscribe(fn) {listeners.add(fn); return () => listeners.delete(fn);}, append() {}};
  await assert.rejects(activateLocalProfiles(session, ['saved'], {timeoutMs: 10}), /did not acknowledge activation/);
  assert.equal(listeners.size, 0);
});

// Setup edits AGENT files; the running session must pick that up without a restart, or the user's
// next task runs on the roster the session started with (observed 2026-09-19: setup filled analyst
// with a loaded model, the orchestrator still saw `analyst → claude` and dispatched a stale
// profile). Activating an agent replaces its whole derived chain, whatever adapters it spans.
test('activating an agent replaces its derived chain from the agent files as they are now', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-activation-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  const settings = {operation: 'orchestrator', orchestrator: 'main', mode: 'plan', order: ['claude'], models: {claude: 'sonnet'}, profiles: {main: {adapter: 'claude'}}};
  const before = new Map([['analyst', {name: 'analyst', description: 'Scouts.', policy: 'read-only', prompt: 'Scout.', source: 'skill'}]]);
  const profiles = validateOrchestration(settings, undefined, {roles: before}).profiles;
  assert.deepEqual([profiles.analyst.adapter, profiles['analyst~2'].adapter], ['claude', 'opencode'], 'the chain the session started with');
  const scheduler = createScheduler({session, profiles, adapters: {}, sessionMode: 'plan'});
  t.after(() => scheduler.close());
  const after = new Map([['analyst', {...before.get('analyst'), source: 'user', models: ['lmstudio/loaded', 'claude/sonnet']}]]);
  let refreshed = 0;
  t.after(createLocalActivation({session, scheduler, profiles, settings, readSettings: () => settings, readRoles: () => after, refresh: () => {refreshed++;}}));
  const result = await activateLocalProfiles(session, ['analyst']);
  assert.deepEqual(result.names, ['analyst']);
  assert.equal(profiles.analyst.adapter, 'opencode');
  assert.equal(profiles.analyst.model, 'loaded');
  assert.deepEqual(profiles.analyst.fallback, ['analyst~2']);
  assert.equal(profiles['analyst~2'].adapter, 'claude', 'the cloud backend is now the fallback');
  assert.equal(profiles['analyst~3'], undefined);
  assert.match(result.text, /analyst → lmstudio\/loaded \(via opencode\), claude\/sonnet · read-only/);
  assert.equal(refreshed, 1);
  assert.equal(scheduler.validate({profile: 'analyst', orders: 'Read', parent: null}), null);
  // A write agent cannot enter a plan session, chain or not.
  after.set('builder', {name: 'builder', description: 'Builds.', policy: 'write', prompt: 'Build.', source: 'user', models: ['claude/sonnet']});
  await assert.rejects(activateLocalProfiles(session, ['builder']), /builder is not an agent/);
  assert.equal(Object.hasOwn(profiles, 'builder'), false);
});
