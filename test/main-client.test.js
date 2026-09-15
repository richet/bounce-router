import test from 'node:test';
import assert from 'node:assert/strict';
import {createMainClient} from '../src/main-client.js';

function fixture() {
  const listeners = new Set(), calls = [];
  const session = {
    active: 'codex', mainState: {state: 'idle', turnId: null},
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async runMain(args) { calls.push(['run', args]); return {accepted: true, requestId: args.id}; },
    async deliverMain(args) { calls.push(['deliver', args]); return {state: 'acknowledged', tier: 'live'}; },
    async cancelMain(args) { calls.push(['cancel', args]); return {accepted: true}; },
  };
  return {session, calls, listeners, emit(event) { for (const fn of listeners) fn(event); }};
}

test('main client starts over IPC and waits on its own terminal event while steering remains independent', async () => {
  const f = fixture();
  const client = createMainClient(f.session, {order: ['codex'], models: {codex: 'test-model'}, mode: 'plan'});
  const completion = client.run('work');
  const request = f.calls[0][1];
  assert.equal(request.text, 'work');
  assert.equal(request.model, 'test-model');
  assert.equal(request.mode, 'plan');
  f.session.mainState = {state: 'running', turnId: 'turn-1'};
  assert.deepEqual(await client.deliver('clarify'), {state: 'acknowledged', tier: 'live'});
  assert.equal(f.calls[1][1].expectedTurnId, 'turn-1');
  f.emit({kind: 'main.terminal', requestId: 'someone-else', status: 'failed'});
  f.emit({kind: 'main.terminal', requestId: request.id, status: 'completed'});
  assert.equal(await completion, 'completed');
  assert.equal(f.listeners.size, 0);
});

test('main client catches terminal-before-ack race and sends cancellation only for its request', async () => {
  const f = fixture();
  f.session.runMain = async args => {
    f.calls.push(['run', args]);
    f.emit({kind: 'main.terminal', requestId: args.id, status: 'interrupted'});
    return {accepted: true};
  };
  const client = createMainClient(f.session, {order: ['codex'], models: {}, mode: 'plan'});
  assert.equal(await client.run('work'), 'cancelled');
  assert.equal(f.listeners.size, 0);
});

test('main client snapshots configuration and rejects refused or disconnected runs', async () => {
  const f = fixture(), settings = {order: ['codex'], models: {codex: 'm1'}, mode: 'plan'};
  const client = createMainClient(f.session, settings);
  const completion = client.run('work');
  client.select('claude'); settings.models.codex = 'm2';
  assert.equal(f.calls[0][1].provider, 'codex');
  assert.equal(f.calls[0][1].model, 'm1');
  f.emit({kind: 'main.disconnected', text: 'daemon disconnected'});
  await assert.rejects(completion, /daemon disconnected/);
  f.session.runMain = async () => ({accepted: false, reason: 'busy'});
  await assert.rejects(client.run('more'), /busy/);
  assert.equal(f.listeners.size, 0);
});
