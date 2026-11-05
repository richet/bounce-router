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

// Nirby control session, 2026-11-04: 241 old copies (215 GB) sat in ~/.bounce/w, because prune only ran in a terminal.
// `bounce prune --ended --older-than D` picks, without asking, the copies of sessions that are not running whose task
// ended (or that no journal names), unused for D; it lists them, and removes them only with --yes. A copy of a running
// session stays even when its task ended: a cancelled task can still be accepted and land from its copy.
import {endedCopies, parseAge} from '../src/prune.js';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('prune --ended --older-than picks ended copies of sessions not running, unused that long; --yes removes them', t => {
  const {root, copy, session} = home(t);
  const done = copy('aaaaaaa1'), cancelled = copy('bbbbbbb1'), endedLive = copy('ccccccc1'), running = copy('eeeeeee1'); copy('ddddddd1');
  session('old', [...lived('t-done', done, {kind: 'task.integrated', task: 't-done', time: at(11)}, {kind: 'task.completed', task: 't-done', time: at(12)}),
    ...lived('t-cancel', cancelled, {kind: 'task.cancelled', task: 't-cancel', time: at(21)})]);
  session('live', [...lived('t-ended', endedLive, {kind: 'task.cancelled', task: 't-ended', time: at(31)}), ...lived('t-run', running)], {pid: process.pid});
  const copies = listCopies({root});
  const day = 86400000;
  assert.deepEqual(endedCopies(copies, {now: Date.now() + 8 * day, olderThanMs: 7 * day}).map(c => c.name).sort(), ['aaaaaaa1', 'bbbbbbb1', 'ddddddd1']);
  assert.deepEqual(endedCopies(copies, {now: Date.now() + day, olderThanMs: 7 * day}), [], 'used within the week: kept');
  assert.deepEqual([parseAge('7d'), parseAge('12h'), parseAge('30m'), parseAge('0m'), parseAge('soon'), parseAge('')], [7 * day, 12 * 3600000, 30 * 60000, 0, null, null]);
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const bounce = (...args) => spawnSync(process.execPath, [cli, 'prune', ...args], {env: {...process.env, BOUNCE_HOME: root, BOUNCE_NO_UPDATE_CHECK: '1'}, encoding: 'utf8', timeout: 15000});
  const dry = bounce('--ended', '--older-than', '0m');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /aaaaaaa1 .* integrated/);
  assert.equal(dry.stdout.includes('ccccccc1') || dry.stdout.includes('eeeeeee1'), false, 'the running session\'s copies are not listed');
  assert.match(dry.stdout, /\n3 copies would be removed\. Add --yes to remove them\.\n$/);
  assert.equal(fs.existsSync(done), true, 'nothing removed without --yes');
  const removed = bounce('--ended', '--older-than', '0m', '--yes');
  assert.match(removed.stdout, /\nRemoved 3 copies\.\n$/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'w')).sort(), ['ccccccc1', 'eeeeeee1']);
  const bad = bounce('--ended', '--older-than', 'soon');
  assert.deepEqual([bad.status, bad.stderr.trim()], [1, 'bounce: --older-than takes an age like 7d, 12h or 30m']);
});
