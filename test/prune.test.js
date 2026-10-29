// Nothing removes a worker's copy on its own any more: found live, a daemon starting after a reboot removed the copies
// of a session that had not resumed yet, a finished panel among them. `bounce prune` and /prune list every copy (the
// session and task it belongs to, when it was last used, whether its work reached the checkout) and remove only what
// the user picks; a copy whose task still runs in a live session is never removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {listCopies, copyTable, chooseCopies, removeCopies} from '../src/prune.js';

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-prune-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const copy = name => { fs.mkdirSync(path.join(root, 'w', name, 'src'), {recursive: true}); fs.writeFileSync(path.join(root, 'w', name, 'src', 'a.js'), 'x'); return path.join(root, 'w', name); };
  let seq = 0;
  const session = (id, rows, {pid = null} = {}) => {
    const dir = path.join(root, 'sessions', id);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), rows.map(row => JSON.stringify({id: String(++seq), seq, ...row})).join('\n') + '\n');
    if (pid) fs.writeFileSync(path.join(dir, 'daemon.json'), JSON.stringify({pid}));
  };
  return {root, copy, session};
}
const at = minute => `2026-10-29T05:${String(minute).padStart(2, '0')}:00.000Z`;
const lived = (task, cwd, ...rows) => [{kind: 'task.submitted', task, time: at(0), deadline: null}, {kind: 'task.started', task, attempt: 1, time: at(1)},
  {kind: 'task.workspace', task, cwd, time: at(1)}, ...rows];

test('the list says, for each copy, its session and task, when it was last used and whether its work was integrated', t => {
  const {root, copy, session} = home(t);
  const done = copy('aaaaaaa1'), cancelled = copy('bbbbbbb1'), running = copy('ccccccc1'); copy('ddddddd1');
  session('old', [...lived('t-done', done, {kind: 'task.integrated', task: 't-done', time: at(11)}, {kind: 'task.completed', task: 't-done', time: at(12)}),
    ...lived('t-cancel', cancelled, {kind: 'task.cancelled', task: 't-cancel', time: at(21)})]);
  session('live', lived('t-run', running), {pid: process.pid});
  const copies = listCopies({root});
  const by = name => copies.find(c => c.name === name);
  assert.deepEqual([by('aaaaaaa1').integrated, by('aaaaaaa1').state, by('aaaaaaa1').live, by('aaaaaaa1').session, by('aaaaaaa1').task], [true, 'completed', false, 'old', 't-done']);
  assert.deepEqual([by('bbbbbbb1').integrated, by('bbbbbbb1').state], [false, 'cancelled']);
  assert.deepEqual([by('ccccccc1').live, by('ccccccc1').state], [true, 'running']);
  assert.deepEqual([by('ddddddd1').session, by('ddddddd1').task], [null, null]);
  const table = copyTable(copies);
  assert.match(table, /aaaaaaa1 .* session old .* task t-done .* integrated/);
  assert.match(table, /bbbbbbb1 .* cancelled, not integrated/);
  assert.match(table, /ccccccc1 .* still running/);
  assert.match(table, /ddddddd1 .* no task found/);
  assert.match(table, /^1\. /);
});

test('the answer picks all, none, or the numbers given; a running task\'s copy is never picked', t => {
  const {root, copy, session} = home(t);
  const a = copy('aaaaaaa1'), b = copy('bbbbbbb1'); copy('ccccccc1');
  session('live', [...lived('t-run', a), ...lived('t-done', b, {kind: 'task.integrated', task: 't-done', time: at(30)}, {kind: 'task.completed', task: 't-done', time: at(31)})], {pid: process.pid});
  const copies = listCopies({root});
  const names = list => list.map(c => c.name).sort();
  assert.deepEqual(names(chooseCopies('y', copies)), ['bbbbbbb1', 'ccccccc1']);
  assert.deepEqual(chooseCopies('n', copies), []);
  assert.deepEqual(chooseCopies('', copies), [], 'no answer removes nothing');
  assert.deepEqual(names(chooseCopies('1-3', copies)), ['bbbbbbb1', 'ccccccc1']);
  assert.equal(chooseCopies('4', copies), null, 'a number off the list is not an answer');
  assert.equal(chooseCopies('maybe', copies), null);
});

test('removing takes only the chosen copies, never a running task\'s, and leaves journals alone', async t => {
  const {root, copy, session} = home(t);
  const a = copy('aaaaaaa1'); copy('bbbbbbb1'); copy('ccccccc1');
  session('live', lived('t-run', a), {pid: process.pid});
  const copies = listCopies({root});
  const {removed} = await removeCopies([...copies.filter(c => c.name === 'bbbbbbb1'), {...copies.find(c => c.name === 'aaaaaaa1')}]);
  assert.deepEqual(removed.map(c => c.name), ['bbbbbbb1']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'w')).sort(), ['aaaaaaa1', 'ccccccc1']);
  assert.equal(fs.existsSync(path.join(root, 'sessions', 'live', 'journal.jsonl')), true);
});
