import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Session} from '../src/core.js';

const setup = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-journal-commit-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return {root, session: new Session(root, {root})};
};

const envelope = events => JSON.stringify({kind: 'journal.commit', version: 2, id: 'commit-1', time: new Date().toISOString(), events}) + '\n';

test('commit persists one v2 envelope, expands on restart, and dedupes the whole commit by ref', t => {
  const {root, session} = setup(t);
  const seen = [];
  session.subscribe(row => seen.push({seq: row.seq, known: session.events.length}));
  const first = session.commit([{kind: 'decision', text: 'choose'}, {kind: 'action.requested', text: 'launch'}], {ref: 'decision:1'});
  assert.deepEqual(first.map(row => row.seq), [2, 3]);
  assert.equal(fs.readFileSync(session.file, 'utf8').trim().split('\n').length, 2, 'session row plus one batch envelope');
  assert.deepEqual(seen, [{seq: 2, known: 3}, {seq: 3, known: 3}], 'all logical rows exist before listeners observe the first');
  const duplicate = session.commit([{kind: 'decision', text: 'other'}], {ref: 'decision:1'});
  assert.equal(duplicate, first, 'the same command returns its complete prior commit');
  assert.equal(session.events.length, 3);
  const resumed = new Session(root, {root, id: session.id});
  assert.deepEqual(resumed.events.slice(-2).map(row => [row.kind, row.seq, row.ref]), [['decision', 2, undefined], ['action.requested', 3, undefined]]);
  assert.deepEqual(resumed.commit([{kind: 'ignored'}], {ref: 'decision:1'}).map(row => row.id), first.map(row => row.id));
});

test('commit listener reentrancy cannot reverse the logical sequence', t => {
  const {session} = setup(t);
  const seen = [];
  session.subscribe(row => {
    seen.push(row.seq);
    if (row.kind === 'decision') session.append({kind: 'nested'});
  });
  session.commit([{kind: 'decision'}, {kind: 'action.requested'}]);
  assert.deepEqual(seen, [2, 3, 4]);
  assert.deepEqual(session.events.map(row => row.seq), [1, 2, 3, 4]);
});

test('a truncated final batch is ignored and the next commit repairs only that tail', t => {
  const {root, session} = setup(t);
  fs.appendFileSync(session.file, '{"kind":"journal.commit","version":2,"events":[');
  const resumed = new Session(root, {root, id: session.id});
  assert.equal(resumed.events.length, 1);
  const rows = resumed.commit([{kind: 'action.requested'}]);
  assert.equal(rows[0].seq, 2);
  assert.equal(fs.readFileSync(session.file, 'utf8').includes('{"kind":"journal.commit","version":2,"events":['), false);
});

test('repair truncates a torn byte tail after a Unicode legacy row without corrupting it', t => {
  const {root, session} = setup(t);
  session.append({kind: 'note', text: 'snowman ☃'});
  fs.appendFileSync(session.file, '{"kind":"journal.commit","version":2,"events":[');
  const resumed = new Session(root, {root, id: session.id});
  resumed.commit([{kind: 'action.requested'}]);
  const restarted = new Session(root, {root, id: session.id});
  assert.equal(restarted.events.find(row => row.kind === 'note').text, 'snowman ☃');
  assert.equal(fs.readFileSync(restarted.file, 'utf8').includes('snowman ☃'), true);
});

test('commit rejects invalid logical rows before changing the journal', t => {
  const {session} = setup(t);
  const before = fs.readFileSync(session.file, 'utf8');
  for (const event of [{}, {kind: 'journal.commit'}, {kind: 'task.activity'}, {kind: 'decision', id: 3}, {kind: 'decision', time: 3}]) {
    assert.throws(() => session.commit([event]), /Invalid journal commit/);
    assert.equal(fs.readFileSync(session.file, 'utf8'), before);
  }
});

test('short synchronous writes are retried until the complete commit is fsynced', t => {
  const {root, session} = setup(t);
  const write = fs.writeSync;
  let first = true;
  fs.writeSync = (fd, data, offset, length) => {
    if (first) { first = false; return write(fd, data, offset, Math.min(length, 7)); }
    return write(fd, data, offset, length);
  };
  try { session.commit([{kind: 'decision', text: 'all bytes'}]); }
  finally { fs.writeSync = write; }
  const resumed = new Session(root, {root, id: session.id});
  assert.equal(resumed.events.at(-1).text, 'all bytes');
});

test('a failed append does not consume a sequence and an onEvent error does not skip subscribers', t => {
  const {session} = setup(t);
  const write = fs.writeSync;
  fs.writeSync = () => { throw new Error('disk full'); };
  try { assert.throws(() => session.append({kind: 'note'}), /disk full/); }
  finally { fs.writeSync = write; }
  const seen = [];
  session.onEvent = () => { throw new Error('display broke'); };
  session.subscribe(row => seen.push(row.seq));
  const row = session.append({kind: 'note', id: 'valid-legacy-id'});
  assert.equal(row.seq, 2);
  assert.equal(row.id, 'valid-legacy-id');
  assert.deepEqual(seen, [2]);
  assert.equal(session.subscriberErrors.at(-1).error.message, 'display broke');
});

test('a partial failed write fences this session and a restart truncates its torn commit tail', t => {
  const {root, session} = setup(t);
  const write = fs.writeSync;
  fs.writeSync = (fd, data, offset, length) => {
    write(fd, data, offset, Math.min(length, 7));
    throw new Error('disk failed after partial write');
  };
  try { assert.throws(() => session.commit([{kind: 'decision', text: 'never complete'}]), /disk failed after partial write/); }
  finally { fs.writeSync = write; }

  assert.throws(() => session.append({kind: 'note'}), /Journal writer is unusable/);
  const resumed = new Session(root, {root, id: session.id});
  assert.deepEqual(resumed.events.map(row => row.kind), ['session']);
  assert.equal(resumed.append({kind: 'note'}).seq, 2);
  assert.deepEqual(new Session(root, {root, id: session.id}).events.map(row => [row.kind, row.seq]), [['session', 1], ['note', 2]]);
});

test('an fsync failure after a complete row also fences this session until it is reconstructed', t => {
  const {root, session} = setup(t);
  const fsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw new Error('fsync failed'); };
  try { assert.throws(() => session.append({kind: 'note'}), /fsync failed/); }
  finally { fs.fsyncSync = fsync; }

  assert.throws(() => session.append({kind: 'second note'}), /Journal writer is unusable/);
  const resumed = new Session(root, {root, id: session.id});
  assert.deepEqual(resumed.events.map(row => [row.kind, row.seq]), [['session', 1], ['note', 2]]);
  assert.equal(resumed.append({kind: 'second note'}).seq, 3);
});

test('a malformed or unknown v2 commit before the final tail refuses the journal', t => {
  const {root, session} = setup(t);
  fs.appendFileSync(session.file, JSON.stringify({kind: 'journal.commit', version: 2, events: [{id: 'a', time: new Date().toISOString(), kind: 'decision', seq: 9, from: 'bounce', context: session.id}]}) + '\n');
  assert.throws(() => new Session(root, {root, id: session.id}), /Invalid journal commit/);
});

test('a complete unknown commit version is never treated as a torn tail', t => {
  const {root, session} = setup(t);
  fs.appendFileSync(session.file, JSON.stringify({kind: 'journal.commit', version: 3, events: []}) + '\n');
  assert.throws(() => new Session(root, {root, id: session.id}), /Unsupported journal commit version: 3/);
});
