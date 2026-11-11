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

// Found live, 2026-11-04: 241 old copies (215 GB) sat in ~/.bounce/w, because prune only ran in a terminal.
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

// Found live, 2026-11-05: a session left 20 copies holding intermediate states of one branch. A clean copy
// whose commit a later copy of the same session already contains, or that the checkout already has, holds nothing
// else: prune --ended takes it, from a running session too once its task ended, and the copy that holds more stays.
import {execFileSync} from 'node:child_process';
test('prune --ended takes a clean copy whose commit a later copy or the checkout contains, and keeps the one that holds more', t => {
  const {root, session} = home(t);
  const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'};
  const git = (cwd, ...args) => execFileSync('git', args, {cwd, env, encoding: 'utf8'}).trim();
  const checkout = path.join(root, 'checkout');
  fs.mkdirSync(checkout); fs.writeFileSync(path.join(checkout, 'a.js'), '1\n');
  git(checkout, 'init', '-q', '-b', 'main'); git(checkout, 'add', '.'); git(checkout, 'commit', '-qm', 'one');
  fs.mkdirSync(path.join(root, 'w'));
  const clone = name => { const dir = path.join(root, 'w', name); git(root, 'clone', '-q', checkout, dir); git(dir, 'checkout', '-qb', 'phase7'); return dir; };
  const commit = (dir, text) => { fs.writeFileSync(path.join(dir, 'a.js'), text); git(dir, 'commit', '-qam', text.trim()); };
  const first = clone('aaaaaaa2'); commit(first, 'round 1\n');
  const second = clone('bbbbbbb2'); git(second, 'fetch', '-q', first, 'phase7'); git(second, 'reset', '-q', '--hard', 'FETCH_HEAD'); commit(second, 'round 2\n');
  const dirty = clone('ccccccc2'); git(dirty, 'fetch', '-q', first, 'phase7'); git(dirty, 'reset', '-q', '--hard', 'FETCH_HEAD'); fs.writeFileSync(path.join(dirty, 'a.js'), 'unsaved\n');
  const nothing = clone('ddddddd2');
  const ended = (task, cwd, minute) => [...lived(task, cwd), {kind: 'task.cancelled', task, time: at(minute)}];
  session('live2', [{kind: 'session', cwd: checkout, time: at(0)}, ...ended('t1', first, 10), ...ended('t2', second, 20), ...ended('t3', dirty, 30), ...ended('t4', nothing, 40)], {pid: process.pid});
  const copies = listCopies({root});
  assert.deepEqual(Object.fromEntries(copies.map(c => [c.name, c.superseded])), {aaaaaaa2: 'bbbbbbb2', bbbbbbb2: null, ccccccc2: null, ddddddd2: 'the checkout'});
  const day = 86400000;
  assert.deepEqual(endedCopies(copies, {now: Date.now() + 8 * day, olderThanMs: 7 * day}).map(c => c.name).sort(), ['aaaaaaa2', 'ddddddd2']);
  assert.match(copyTable(copies), /aaaaaaa2 .* already in copy bbbbbbb2/);
});

// Found live, 2026-11-07: 331 copies filled the disk because prune only ran when asked. Each daemon now runs the
// --ended rule itself (pruneAfterDays, default 7), but only on copies whose work is elsewhere: integrated into the
// checkout, or held by a later copy or the checkout (superseded). A cancelled or failed task's copy, whose unfinished
// work is saved only there, and a copy no journal names stay for a person to prune. One daemon at a time, logged.
import {autoPrune} from '../src/prune.js';
test('autoPrune removes only ended copies whose work is elsewhere, one daemon at a time, and logs what it removed', async t => {
  const {root, copy, session} = home(t);
  const landed = copy('aaaaaaa4'), cancelled = copy('ccccccc4'), running = copy('bbbbbbb4'); copy('ddddddd4');
  session('old', [...lived('t-done', landed, {kind: 'task.integrated', task: 't-done', time: at(11)}, {kind: 'task.completed', task: 't-done', time: at(12)}),
    ...lived('t-cancel', cancelled, {kind: 'task.cancelled', task: 't-cancel', time: at(21)})]);
  session('live', lived('t-run', running), {pid: process.pid});
  const day = 86400000, now = Date.now() + 8 * day;
  assert.equal((await autoPrune({root, olderThanMs: 9 * day, now})).removed.length, 0, 'younger than the age: kept');
  fs.writeFileSync(path.join(root, 'prune.lock'), String(process.pid));
  assert.equal(await autoPrune({root, olderThanMs: 7 * day, now}), null, 'another daemon is pruning');
  fs.rmSync(path.join(root, 'prune.lock'));
  const result = await autoPrune({root, olderThanMs: 7 * day, now});
  assert.deepEqual(result.removed.map(c => c.name), ['aaaaaaa4']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'w')).sort(), ['bbbbbbb4', 'ccccccc4', 'ddddddd4'], 'unfinished work, a running task and an unknown copy stay');
  assert.equal(fs.existsSync(path.join(root, 'prune.lock')), false, 'the lock is released');
  const log = fs.readFileSync(path.join(root, 'prune.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(entry => [entry.removed, entry.kept]), [[[], 0], [['aaaaaaa4'], 2]]);
});

import {defaults, validateSettings} from '../src/core.js';
test('config.pruneAfterDays takes whole days from 0 (never) to 365', () => {
  const with_ = pruneAfterDays => () => validateSettings({...defaults(), pruneAfterDays});
  assert.doesNotThrow(with_(0)); assert.doesNotThrow(with_(3));
  for (const bad of [-1, 1.5, 366, '3']) assert.throws(with_(bad), {message: 'config.pruneAfterDays must be a whole number of days from 0 (never) to 365'});
});

test('removing a copy takes its stacks down first, and keeps the copy when that fails', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-prune-stacks-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const make = name => { const dir = path.join(root, name); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n'); return {name, dir, live: false}; };
  const good = make('good0001'), stuck = make('stuck001'), plain = {name: 'plain001', dir: path.join(root, 'plain001'), live: false};
  fs.mkdirSync(plain.dir);
  const asked = [];
  const stackDown = async dir => { asked.push(path.basename(dir)); return dir === stuck.dir ? {down: [], failed: [{name: 'stuck-stack', error: 'busy'}]} : {down: ['good-stack'], failed: []}; };
  const {removed, failed} = await removeCopies([good, stuck, plain], {stackDown});
  assert.deepEqual(asked, ['good0001', 'stuck001'], 'a copy with no compose file is not asked about');
  assert.deepEqual(removed.map(copy => [copy.name, copy.stacks ?? null]), [['good0001', ['good-stack']], ['plain001', null]]);
  assert.deepEqual(failed.map(({copy, error}) => [copy.name, error]), [['stuck001', 'its stack stuck-stack was not taken down (busy); the copy is kept: take it down there, then prune again']]);
  assert.equal(fs.existsSync(stuck.dir), true);
  assert.equal(fs.existsSync(good.dir), false);
});

test('stacks left behind: compose projects in the copies folder whose task is not running, including copies already gone', async () => {
  const {leftStacks} = await import('../src/prune.js');
  const root = '/home/u/.bounce';
  const copies = [{name: 'live0001', dir: `${root}/w/live0001`, live: true, task: 't-live'}, {name: 'done0001', dir: `${root}/w/done0001`, live: false, task: 't-done', state: 'accepted'}];
  const projects = [
    {name: 'running-task', status: 'running(2)', configFiles: [`${root}/w/live0001/docker-compose.yml`]},
    {name: 'ended-task', status: 'running(2)', configFiles: [`${root}/w/done0001/docker-compose.yml`]},
    {name: 'orphan', status: 'exited(2)', configFiles: [`${root}/w/gone0001/docker-compose.yml`]},
    {name: 'checkout', status: 'running(3)', configFiles: ['/home/u/project/docker-compose.yml']},
  ];
  assert.deepEqual(leftStacks({root, copies, projects}), [
    {name: 'ended-task', status: 'running(2)', copy: 'done0001', task: 't-done', state: 'accepted'},
    {name: 'orphan', status: 'exited(2)', copy: 'gone0001', task: null, state: 'copy removed'},
  ]);
});
