// A worker's copy lives while its session is open: /quit removes the closing session's copies, and a daemon starting
// removes those of every session that is not running, except the one it resumes. Found live: 165 copies (34 GB) had
// piled up across sessions, one holding a private export the checkout's ignored folder had carried into it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sweepCopies} from '../src/workspace-retention.js';

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-retention-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const copy = (name, ageMs = 60 * 60_000) => {
    const dir = path.join(root, 'w', name);
    fs.mkdirSync(path.join(dir, 'exports'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'exports', 'archive.tar'), 'private');
    const at = new Date(Date.now() - ageMs); fs.utimesSync(dir, at, at);
    return dir;
  };
  const session = (id, copies, {pid = null} = {}) => {
    const dir = path.join(root, 'sessions', id);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), copies.map(name => JSON.stringify({kind: 'task.workspace', cwd: path.join(root, 'w', name)})).join('\n') + '\n');
    if (pid) fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({pid}));
  };
  return {root, copy, session, left: () => fs.readdirSync(path.join(root, 'w')).sort()};
}

test('a daemon starting removes the copies of sessions that are not running, keeping the one it resumes and the running ones', async t => {
  const {root, copy, session, left} = home(t);
  for (const name of ['aaaaaaa1', 'aaaaaaa2', 'bbbbbbb1', 'ccccccc1', 'ddddddd1', 'eeeeeee1']) copy(name);
  copy('fffffff1', 60_000);
  session('old', ['aaaaaaa1', 'aaaaaaa2']);
  session('resumed', ['bbbbbbb1']);
  session('running', ['ccccccc1'], {pid: process.pid});
  const removed = await sweepCopies({root, keep: 'resumed'});
  assert.deepEqual(left(), ['bbbbbbb1', 'ccccccc1', 'fffffff1'], 'an unnamed copy made a moment ago may not be journaled yet');
  assert.equal(removed.length, 4);
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'old', 'journal.jsonl')), true, 'only copies go, never a journal');
});

test('/quit removes every copy the closing session names, fresh ones too, and never another running session\'s', async t => {
  const {root, copy, session, left} = home(t);
  copy('aaaaaaa1'); copy('aaaaaaa2', 1000); copy('ccccccc1');
  session('closing', ['aaaaaaa1', 'aaaaaaa2'], {pid: process.pid});
  session('other', ['ccccccc1'], {pid: process.pid});
  await sweepCopies({root, closing: 'closing'});
  assert.deepEqual(left(), ['ccccccc1']);
});

test('nothing to sweep is not an error', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-retention-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.deepEqual(await sweepCopies({root}), []);
});
