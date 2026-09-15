import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {Session} from '../src/core.js';
import {hostSession, createRemoteSession} from '../src/remote.js';

const helperPath = fileURLToPath(new URL('./helpers/remote-child.js', import.meta.url));
const newSession = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-remote-')); return new Session(root, {root}); };

// A fully in-process fake parent for flush() tests: no real fork, no real hostSession —
// just enough of the {type:'session.*'} protocol to drive createRemoteSession directly.
// send() acks any append/publish asynchronously (a microtask later) unless told not to,
// so tests can control exactly whether a request settles before or after a disconnect.
function fakeParentChannel({autoAck = true} = {}) {
  const emitter = new EventEmitter();
  let seq = 0;
  return {
    send(msg) {
      if (!autoAck) return;
      if (msg.type === 'session.append' || msg.type === 'session.publish') {
        queueMicrotask(() => {
          const row = {...msg.event, time: new Date().toISOString(), from: 'bounce', context: 'ctx-1', seq: ++seq};
          emitter.emit('message', {type: msg.type === 'session.append' ? 'session.appended' : 'session.published', seq: msg.seq, row});
        });
      }
    },
    on: (...args) => emitter.on(...args),
    off: (...args) => emitter.off(...args),
    deliver: msg => emitter.emit('message', msg),
    disconnect: () => emitter.emit('disconnect'),
  };
}

async function attachFake(options) {
  const channel = fakeParentChannel(options);
  const promise = createRemoteSession(channel);
  channel.deliver({type: 'session.replay', id: 's1', dir: '/d', file: '/f', cwd: '/tmp', context: 's1', events: [], active: undefined});
  const remote = await promise;
  return {channel, remote};
}

function spawnChild() {
  const child = fork(helperPath, [], {stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
  child.setMaxListeners(200); // many short-lived per-call reply listeners (R7's burst) is expected, not a leak
  const ready = new Promise(resolve => {
    const onMessage = msg => { if (msg?.type === 'ready') { child.off('message', onMessage); resolve(msg); } };
    child.on('message', onMessage);
  });
  return {child, ready};
}

// Sends a {cmd, ...} message and resolves with the matching {type:'cmd.result', reqId, ...} reply.
let nextReqId = 1;
function call(child, msg) {
  const reqId = nextReqId++;
  return new Promise(resolve => {
    const onMessage = m => { if (m?.type === 'cmd.result' && m.reqId === reqId) { child.off('message', onMessage); resolve(m); } };
    child.on('message', onMessage);
    child.send({...msg, reqId});
  });
}

function countMessagesTo(child, predicate) {
  let count = 0;
  const onMessage = m => { if (predicate(m)) count++; };
  child.on('message', onMessage);
  return {stop: () => child.off('message', onMessage), count: () => count};
}

async function attach(session) {
  const {child, ready} = spawnChild();
  const host = hostSession({session, child});
  await ready;
  return {child, host};
}

test('Session.prototype surface is untouched by this task', () => {
  assert.deepEqual(Object.getOwnPropertyNames(Session.prototype), ['constructor', 'append', 'emit', 'subscribe', 'publish', 'lock']);
});

test('R1 replay: child gets id/context/cwd and the existing rows', async () => {
  const session = newSession();
  session.append({kind: 'note', text: 'one'});
  session.append({kind: 'note', text: 'two'});
  const {child, host} = await attach(session);
  const {snapshot} = await call(child, {cmd: 'snapshot'});
  assert.equal(snapshot.events.length, session.events.length);
  assert.equal(snapshot.id, session.id);
  assert.equal(snapshot.context, session.id);
  assert.equal(snapshot.cwd, session.cwd);
  host.detach(); child.kill();
});

test('R2 append round trip: provisional then settled in place, delivered once, journal has the row', async () => {
  const session = newSession();
  const {child, host} = await attach(session);
  const {provisionalFlag, provisionalJSON, settled} = await call(child, {cmd: 'appendAwaitSettle', event: {kind: 'note', text: 'n'}});
  assert.equal(provisionalFlag, true);
  assert.equal(provisionalJSON.includes('provisional'), false);
  assert.equal(settled.provisional, undefined);
  assert.equal(settled.seq, session.events.at(-1).seq);
  const {snapshot, deliveries} = await call(child, {cmd: 'snapshot'});
  const matches = snapshot.events.filter(e => e.id === settled.id);
  assert.equal(matches.length, 1);
  const matchingDeliveries = deliveries.filter(d => d.id === settled.id);
  assert.equal(matchingDeliveries.length, 1);
  assert.equal(matchingDeliveries[0].seq, settled.seq);
  const journalLines = fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean);
  assert.ok(journalLines.some(line => JSON.parse(line).id === settled.id));
  host.detach(); child.kill();
});

test('R3 worker rows flow down to the child once', async () => {
  const session = newSession();
  const {child, host} = await attach(session);
  // give the forwarder a moment to be wired before we append on the parent
  session.append({kind: 'task.milestone', task: 't1', from: 'worker:t1', text: 'm'});
  await new Promise(resolve => setTimeout(resolve, 100));
  const {snapshot, deliveries} = await call(child, {cmd: 'snapshot'});
  const matching = deliveries.filter(d => d.task === 't1');
  assert.equal(matching.length, 1);
  assert.equal(snapshot.events.at(-1).from, 'worker:t1');
  host.detach(); child.kill();
});

test('R4 live rows reach onEvent but never the journal or child.events', async () => {
  const session = newSession();
  const {child, host} = await attach(session);
  const before = fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).length;
  session.publish({kind: 'task.activity', text: 'tick'});
  await new Promise(resolve => setTimeout(resolve, 100));
  const {snapshot, deliveries} = await call(child, {cmd: 'snapshot'});
  const live = deliveries.filter(d => d.kind === 'task.activity');
  assert.equal(live.length, 1);
  assert.equal('seq' in live[0], false);
  assert.equal(snapshot.events.some(e => e.kind === 'task.activity'), false);
  const after = fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(after, before);
  host.detach(); child.kill();
});

test('R5 ref dedupe both ways', async () => {
  const session = newSession();
  const {child, host} = await attach(session);
  const tracker = countMessagesTo(child, m => m?.type === 'cmd.result');
  const first = await call(child, {cmd: 'appendAwaitSettle', event: {kind: 'note', ref: 'x', text: 'a'}});
  const second = await call(child, {cmd: 'append', event: {kind: 'note', ref: 'x', text: 'a-again'}});
  assert.equal(second.row.id, first.settled.id);
  tracker.stop();

  session.append({kind: 'note', ref: 'y', text: 'original'});
  const third = await call(child, {cmd: 'appendAwaitSettle', event: {kind: 'note', ref: 'y', text: 'from-child'}});
  assert.equal(third.settled.id, session.events.find(e => e.ref === 'y').id);
  host.detach(); child.kill();
});

test('R6 second replay resets child.events to the parent set', async () => {
  const session = newSession();
  session.append({kind: 'note', text: 'one'});
  const {child, host} = await attach(session);
  session.append({kind: 'note', text: 'two'});
  await new Promise(resolve => setTimeout(resolve, 100));
  host.detach();
  child.send({type: 'session.replay', id: session.id, dir: session.dir, file: session.file, cwd: session.cwd, context: session.context, events: session.events, active: session.active});
  const {snapshot} = await call(child, {cmd: 'snapshot'});
  assert.deepEqual(snapshot.events.map(e => e.id), session.events.map(e => e.id));
  child.kill();
});

test('R7 ordering under burst: 50 synchronous appends end up strictly increasing, delivered exactly once each', async () => {
  const session = newSession();
  const {child, host} = await attach(session);
  const replies = [];
  for (let i = 0; i < 50; i++) replies.push(call(child, {cmd: 'appendAwaitSettle', event: {kind: 'note', text: `n${i}`}}));
  const results = await Promise.all(replies);
  const seqs = results.map(r => r.settled.seq);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
  const parentLast50 = session.events.slice(-50).map(e => e.seq);
  assert.deepEqual(seqs, parentLast50);
  const {deliveries} = await call(child, {cmd: 'snapshot'});
  const ids = results.map(r => r.settled.id);
  const byId = new Map();
  for (const row of deliveries) byId.set(row.id, (byId.get(row.id) ?? 0) + 1);
  for (const id of ids) assert.equal(byId.get(id), 1);
  host.detach(); child.kill();
});

test('R8 lock is a no-op in the child: no throw, no lock file', async () => {
  const session = newSession();
  const {child, host} = await attach(session);
  const {ok} = await call(child, {cmd: 'lock'});
  assert.equal(ok, true);
  assert.equal(fs.existsSync(path.join(session.dir, 'lock')), false);
  host.detach(); child.kill();
});

test('onEvent delivers each journaled row exactly once, with the authoritative seq, and never leaks provisional in JSON', async () => {
  const session = newSession();
  const {child, host} = await attach(session);
  try {
    await call(child, {cmd: 'appendAwaitSettle', event: {kind: 'note', text: 'a'}});
    await call(child, {cmd: 'appendAwaitSettle', event: {kind: 'note', text: 'b'}});
    const {deliveries, snapshot} = await call(child, {cmd: 'snapshot'});
    const byId = new Map();
    for (const row of deliveries) byId.set(row.id, (byId.get(row.id) ?? 0) + 1);
    for (const count of byId.values()) assert.equal(count, 1);
    for (const row of deliveries) assert.equal(Number.isInteger(row.seq), true);
    const provisionalCandidate = snapshot.events.find(e => e.text === 'a');
    assert.equal(JSON.stringify(provisionalCandidate).includes('provisional'), false);
  } finally { host.detach(); child.kill(); }
});

test('R9 error path: a parent append that throws marks the child row with error, no throw', async () => {
  const session = newSession();
  const original = session.append.bind(session);
  let thrown = false;
  session.append = event => { if (!thrown) { thrown = true; throw new Error('boom'); } return original(event); };
  const {child, host} = await attach(session);
  const {settled} = await call(child, {cmd: 'appendAwaitSettle', event: {kind: 'note', text: 'will-error'}});
  assert.equal(settled.error, 'boom');
  host.detach(); child.kill();
});

test('flush() resolves once a burst is fully acknowledged: every row gets an integer seq and provisionalFlag is false', async () => {
  const {remote} = await attachFake();
  for (let i = 0; i < 50; i++) remote.append({kind: 'note', text: `n${i}`});
  await remote.flush();
  assert.equal(remote.events.length, 50);
  for (const row of remote.events) {
    assert.equal(Number.isInteger(row.seq), true);
    const provisionalFlag = row.provisional === true;
    assert.equal(provisionalFlag, false);
  }
});

test('flush() with nothing pending resolves within the same tick, before any macrotask', async () => {
  const {remote} = await attachFake();
  let flag = false;
  remote.flush().then(() => { flag = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(flag, true);
});

test('flush() rejects with code "closed" when the channel disconnects while a request is pending', async () => {
  const {channel, remote} = await attachFake({autoAck: false});
  remote.append({kind: 'note', text: 'never-acked'});
  const pending = remote.flush();
  channel.disconnect();
  await assert.rejects(pending, error => error.code === 'closed');
});

test('ref race: the broadcast of a ref collision arrives before our own ack — one row, delivered once', async () => {
  const {channel, remote} = await attachFake({autoAck: false});
  let sentSeq;
  channel.send = msg => { if (msg.type === 'session.append') sentSeq = msg.seq; };
  const deliveries = [];
  remote.subscribe(row => deliveries.push(row));

  // The child appends ref 'y' locally (provisional, own id) while a peer's append of
  // the same ref already landed at the parent under a different, pre-existing id.
  remote.append({kind: 'note', ref: 'y', text: 'from-child'});
  assert.equal(remote.events.length, 1);

  // That peer's row reaches us first, as an ordinary forward — before our own ack.
  const authoritative = {id: 'parent-row-y', ref: 'y', kind: 'note', text: 'original', time: new Date().toISOString(), from: 'bounce', context: 'ctx-1', seq: 1};
  channel.deliver({type: 'session.event', row: authoritative});
  assert.equal(remote.events.length, 2); // pushed as a foreign row: not yet known to be our own collision

  // Now our own ack arrives: the parent's ref dedupe returned that same pre-existing row.
  channel.deliver({type: 'session.appended', seq: sentSeq, row: authoritative});

  assert.equal(remote.events.length, 1);
  const withRefY = remote.events.filter(e => e.ref === 'y');
  assert.equal(withRefY.length, 1);
  assert.equal(withRefY[0].id, 'parent-row-y');
  const matchingDeliveries = deliveries.filter(d => d.id === 'parent-row-y');
  assert.equal(matchingDeliveries.length, 1);
});
