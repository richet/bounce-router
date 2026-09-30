// Found live (ACE d1bc0206): 11 of 23 first attempts named `build_claude` (Opus) directly, skipping the
// builder agent's own order (local, then Sonnet, then Opus), although the orders already said not to.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createScheduler} from '../src/scheduler.js';

const agent = {name: 'builder', description: 'builds', policy: 'write', prompt: 'build'};
const profiles = {
  builder: {derived: true, adapter: 'claude', model: 'sonnet', policy: 'write', role: 'builder', agent, fallback: ['builder~2']},
  'builder~2': {derived: true, adapter: 'claude', model: 'opus', policy: 'write', role: 'builder', agent, fallback: []},
  build_claude: {adapter: 'claude', model: 'opus[1m]', policy: 'write', fallback: []},
};

// Rewritten 2026-09-27: plans are advice and refusals became corrections. The named AI is corrected to the
// matching agent (with a note on the row), never refused; a plan chunk naming it is no longer refused either.
test('a first attempt from the orchestrator that names a cloud profile runs as the matching agent, with a correction note', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-named-profile-'));
  const session = new Session(root, {root});
  const scheduler = createScheduler({session, adapters: {claude: {launch: async () => ({}), async *events() {}, cancel: async () => ({verified: true})}}, profiles, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const base = {from: 'orchestrator', orders: 'wire the command', requires: ['read', 'write']};
  const corrected = scheduler.submit({...base, profile: 'build_claude'});
  assert.equal(corrected.profile, 'builder');
  assert.deepEqual(corrected.corrections, ['profile: build_claude is one AI; a first attempt runs as the builder agent, which tries its own AIs lightest first (name an AI only for a retry, or add userAsked: true when the user asked for it)']);
  assert.deepEqual(session.events.filter(e => e.kind === 'task.corrected').map(e => [e.task, e.text]), [[corrected.task, corrected.corrections[0]]]);
  assert.equal(scheduler.prepare({...base, profile: 'builder'}).profile, 'builder');
  assert.equal(scheduler.prepare({...base, profile: 'build_claude', userAsked: true}).profile, 'build_claude');
  assert.equal(scheduler.prepare({...base, profile: 'build_claude', from: 'user'}).profile, 'build_claude', 'the user may name any profile');
  assert.equal(scheduler.prepare({...base, profile: 'build_claude', retryOf: corrected.task}).profile, 'build_claude', 'a retry may name the next AI');
});

test('an unknown profile runs as the agent it names, and invalid owns entries are dropped, each with a note', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-named-profile-'));
  const session = new Session(root, {root});
  const scheduler = createScheduler({session, adapters: {claude: {launch: async () => ({}), async *events() {}, cancel: async () => ({verified: true})}}, profiles, watchdog: {interval: null}});
  t.after(() => { scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const row = scheduler.submit({from: 'orchestrator', orders: 'wire the command', requires: ['read', 'write'], profile: 'Builder-codex', owns: ['src/cli.js', '/etc/passwd', '../outside']});
  assert.deepEqual([row.profile, row.owns], ['builder', ['src/cli.js']]);
  assert.deepEqual(row.corrections, [
    'profile: "Builder-codex" is not a profile here; it runs as the builder agent',
    'owns: dropped ["/etc/passwd","../outside"] (owned paths are relative, inside the checkout, without ..); kept ["src/cli.js"]',
  ]);
  const none = scheduler.submit({from: 'orchestrator', orders: 'x', requires: ['read', 'write'], profile: 'builder', owns: ['/abs']});
  assert.equal(none.owns, undefined, 'no valid entry left: it owns what it changes');
  assert.throws(() => createScheduler({session: new Session(root, {root}), adapters: {}, profiles: {main: {adapter: 'claude', role: 'orchestrator'}}, watchdog: {interval: null}}).submit({from: 'orchestrator', orders: 'x', profile: 'nope'}),
    /malformed: profile: "nope" is not a profile or agent here; send one of \[\]/);
});

// The orchestrator reads a correction in the publish reply itself, not only in the journal.
test('a corrected submission over the bus carries its correction notes in the reply', async t => {
  const {createBus, connectBus} = await import('../src/bus.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-named-profile-'));
  const session = new Session(root, {root});
  const scheduler = createScheduler({session, adapters: {claude: {launch: async () => ({}), async *events() {}, cancel: async () => ({verified: true})}}, profiles, watchdog: {interval: null}});
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate, prepare: scheduler.prepare});
  t.after(async () => { await bus.close(); scheduler.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const client = await connectBus({path: bus.path, token: bus.grant({peer: 'orchestrator', canSubmit: true}).token});
  t.after(() => client.close());
  const row = await client.publish({kind: 'task.submitted', parent: null, profile: 'build_claude', orders: 'wire it', requires: ['read', 'write'], owns: ['../x']});
  assert.equal(row.profile, 'builder');
  assert.deepEqual(row.notes, [
    'profile: build_claude is one AI; a first attempt runs as the builder agent, which tries its own AIs lightest first (name an AI only for a retry, or add userAsked: true when the user asked for it)',
    'owns: dropped ["../x"] (owned paths are relative, inside the checkout, without ..); none remain, so it owns what it changes',
  ]);
});
