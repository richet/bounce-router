// The inbox a detached orchestrated `bounce run` offers `bounce send` in place of a main service (src/run-inbox.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';
import {createRunInbox, pendingSends} from '../src/run-inbox.js';

function inbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-run-inbox-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const session = new Session(root, {root});
  return {session, inbox: createRunInbox({session})};
}

test('a sent message is queued with its sender, and leaves the queue once its turn starts', t => {
  const {session, inbox: box} = inbox(t);
  assert.deepEqual(box.state(), {state: 'idle', currentTurnId: null});
  const first = box.run({text: 'also fix the docs', via: 'send', caller: 'nirby control'});
  const second = box.run({text: 'then the tests', via: 'send'});
  assert.deepEqual([first.accepted, first.queued, second.accepted], [true, true, true]);
  assert.equal(box.state().state, 'queued');
  const queued = pendingSends(session.events);
  assert.deepEqual(queued.map(e => [e.requestId, e.text, e.via, e.caller]),
    [[first.requestId, 'also fix the docs', 'send', 'nirby control'], [second.requestId, 'then the tests', 'send', undefined]]);
  session.append({kind: 'main.started', requestId: first.requestId});
  assert.deepEqual(pendingSends(session.events).map(e => e.requestId), [second.requestId]);
});

test('the inbox refuses an empty message, one not marked as sent, and a bad sender label, journaling nothing', t => {
  const {session, inbox: box} = inbox(t);
  assert.equal(box.run({text: '  ', via: 'send'}).reason, 'empty_prompt');
  assert.equal(box.run({text: 'typed in a view'}).reason, 'invalid_via');
  assert.equal(box.run({text: 'x', via: 'mail'}).reason, 'invalid_via');
  assert.equal(box.run({text: 'x', via: 'send', caller: 'two\nlines'}).reason, 'invalid_caller');
  assert.equal(session.events.filter(e => e.kind === 'send.queued').length, 0);
});
