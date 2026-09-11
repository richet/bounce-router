import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session, LIVE_KINDS} from '../src/core.js';
const setup = () => {const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-journal-')); return {root, session: new Session(root, {root})};};

test('seq is monotonic and continues after resume', () => {
  const {root, session} = setup();
  const a = session.append({kind: 'note', text: 'first'});
  const b = session.append({kind: 'note', text: 'second'});
  assert.equal(a.seq, 2); // 1 is the constructor's own 'session' row
  assert.equal(b.seq, 3);
  const resumed = new Session(root, {root, id: session.id});
  assert.equal(resumed.append({kind: 'note', text: 'third'}).seq, 4);
});

test('from defaults by kind, provider, and fallback, and keeps an explicit override', () => {
  const {session} = setup();
  assert.equal(session.append({kind: 'user', text: 'hi'}).from, 'user');
  assert.equal(session.append({kind: 'route', provider: 'claude', text: 'x'}).from, 'main');
  assert.equal(session.append({kind: 'note', text: 'y'}).from, 'bounce');
  assert.equal(session.append({kind: 'note', text: 'z', from: 'worker:parse'}).from, 'worker:parse');
});

test('context defaults to the session id', () => {
  const {session} = setup();
  assert.equal(session.append({kind: 'note', text: 'ctx'}).context, session.id);
  assert.equal(session.context, session.id);
});

test('ref dedupes: same row returned, no new file line written, onEvent not refired', () => {
  const {session} = setup();
  let calls = 0;
  session.onEvent = () => calls++;
  const before = fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).length;
  const first = session.append({kind: 'note', text: 'a', ref: 'submit-1'});
  const afterFirst = fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).length;
  assert.equal(afterFirst, before + 1);
  assert.equal(calls, 1);
  const second = session.append({kind: 'note', text: 'b', ref: 'submit-1'});
  assert.equal(second.id, first.id);
  assert.equal(fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).length, afterFirst);
  assert.equal(calls, 1);
});

test('publish of a live kind reaches onEvent with the right from/context, no seq, and never touches the file', () => {
  const {session} = setup();
  const seen = [];
  session.onEvent = e => seen.push(e);
  const before = fs.readFileSync(session.file, 'utf8');
  const row = session.publish({kind: 'task.activity', text: 'working', provider: 'claude'});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, 'task.activity');
  assert.equal(row.from, 'main');
  assert.equal(row.context, session.id);
  assert.equal('seq' in row, false);
  assert.equal(fs.readFileSync(session.file, 'utf8'), before);
});

test('publish of a non-live kind lands in the journal file with a seq', () => {
  const {session} = setup();
  const before = fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).length;
  const row = session.publish({kind: 'note', text: 'journaled'});
  assert.equal(row.seq, before + 1);
  assert.equal(fs.readFileSync(session.file, 'utf8').split('\n').filter(Boolean).length, before + 1);
});

test('LIVE_KINDS is exactly the four live kinds', () => {
  assert.deepEqual([...LIVE_KINDS].sort(), ['progress', 'task.activity', 'tool.finished', 'tool.started']);
});

test('legacy journal rows without seq/from/context load, and the next append gets the right seq', () => {
  const {root, session} = setup();
  fs.appendFileSync(session.file, JSON.stringify({id: 'legacy-1', time: new Date().toISOString(), kind: 'note', text: 'old'}) + '\n');
  const resumed = new Session(root, {root, id: session.id});
  assert.equal(resumed.events.at(-1).seq, undefined);
  assert.equal(resumed.events.at(-1).from, undefined);
  assert.equal(resumed.append({kind: 'note', text: 'new'}).seq, 3);
});
