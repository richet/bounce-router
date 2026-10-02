// docs/plans/lessons-and-sweep.md §1 (Daniel, 2026-10-01): a correction the orchestrator makes becomes
// one line in the project's .bounce/LESSONS.md, and every later worker of that job reads it. Every
// lesson of the week before (evidence inside the copy, checks that run the work, no thinking for the
// builder) reached the agent files only through a person reading journals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recordLesson, readLessons, lessonsBlock, LESSONS_FILE, LESSON_TEXT_MAX, LESSONS_SHOWN_MAX} from '../src/lessons.js';

const project = t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-lessons-')));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
const agents = new Set(['builder', 'analyst', 'reviewer']);
const when = {date: '2026-10-01', session: 'e3bd01d5-b809-49bc-b68c-10d8db2fb00d'};

test('a lesson lands once as one line of the project file, with its job, date and session in a comment', t => {
  const cwd = project(t);
  const first = recordLesson(cwd, {agent: 'builder', text: 'Evidence the orders ask for goes inside the working copy at the path they name.'}, {agents, ...when});
  assert.deepEqual(first, {ok: true, lesson: {agent: 'builder', text: 'Evidence the orders ask for goes inside the working copy at the path they name.', date: '2026-10-01', session: 'e3bd01d5'}});
  assert.equal(fs.readFileSync(LESSONS_FILE(cwd), 'utf8'),
    '# Lessons\n\nOne line per lesson, written by the orchestrator when it corrected a worker\'s work here; every later worker of that job reads them. Delete a line to withdraw it.\n\n'
    + '- Evidence the orders ask for goes inside the working copy at the path they name. <!-- builder · 2026-10-01 · e3bd01d5 -->\n');

  const again = recordLesson(cwd, {agent: 'all', text: '  evidence the orders ask for goes inside the working copy at the path they name  '}, {agents, ...when});
  assert.deepEqual(again, {ok: false, reason: 'duplicate: this lesson is already in .bounce/LESSONS.md'});
  assert.equal(readLessons(cwd).length, 1);
});

test('a lesson is one short imperative sentence for a job this project has, or for all of them', t => {
  const cwd = project(t);
  assert.deepEqual(recordLesson(cwd, {agent: 'builder', text: ''}, {agents, ...when}), {ok: false, reason: 'lesson needs text: one sentence, imperative'});
  assert.deepEqual(recordLesson(cwd, {agent: 'builder', text: 'x'.repeat(LESSON_TEXT_MAX + 1)}, {agents, ...when}), {ok: false, reason: `lesson text is over ${LESSON_TEXT_MAX} characters: one sentence, imperative`});
  assert.deepEqual(recordLesson(cwd, {agent: 'critic', text: 'Run the tests.'}, {agents, ...when}), {ok: false, reason: 'agent must be one of analyst, builder, reviewer, or all'});
  assert.deepEqual(recordLesson(cwd, {agent: 'builder', text: 'Line one.\nLine two.'}, {agents, ...when}), {ok: false, reason: 'lesson text is one line'});
  assert.equal(fs.existsSync(LESSONS_FILE(cwd)), false, 'nothing refused reaches the file');
});

test('a worker sees the lines for its job and for all, after a heading; another job does not see them', t => {
  const cwd = project(t);
  recordLesson(cwd, {agent: 'builder', text: 'Put evidence inside the working copy.'}, {agents, ...when});
  recordLesson(cwd, {agent: 'all', text: 'A check must run the work; a grep for a phrase passes on a false report.'}, {agents, ...when});
  recordLesson(cwd, {agent: 'reviewer', text: 'Say PASS or FAIL first.'}, {agents, ...when});
  assert.equal(lessonsBlock(cwd, 'builder'), [
    'Lessons from earlier sessions in this project:',
    '- Put evidence inside the working copy.',
    '- A check must run the work; a grep for a phrase passes on a false report.',
  ].join('\n'));
  assert.equal(lessonsBlock(cwd, 'analyst'), 'Lessons from earlier sessions in this project:\n- A check must run the work; a grep for a phrase passes on a false report.');
  // the orchestrator sees every line, with its job
  assert.equal(lessonsBlock(cwd, 'orchestrator'), [
    'Lessons from earlier sessions in this project:',
    '- (builder) Put evidence inside the working copy.',
    '- (all) A check must run the work; a grep for a phrase passes on a false report.',
    '- (reviewer) Say PASS or FAIL first.',
  ].join('\n'));
  assert.equal(lessonsBlock(project(t), 'builder'), '', 'no file, no block');
});

test('a hand-edited file is read as written: a deleted line is gone, a line without the comment is for all', t => {
  const cwd = project(t);
  fs.mkdirSync(path.join(cwd, '.bounce'), {recursive: true});
  fs.writeFileSync(LESSONS_FILE(cwd), '# Lessons\n\n- Kept by hand, no comment.\n- Shaped by bounce. <!-- builder · 2026-09-29 · d1bc0206 -->\nNot a list item, ignored.\n');
  assert.deepEqual(readLessons(cwd), [
    {agent: 'all', text: 'Kept by hand, no comment.', date: null, session: null},
    {agent: 'builder', text: 'Shaped by bounce.', date: '2026-09-29', session: 'd1bc0206'},
  ]);
  // the newest lines are the ones shown when there are more than the cap
  for (let n = 0; n < LESSONS_SHOWN_MAX + 5; n += 1) recordLesson(cwd, {agent: 'all', text: `Lesson number ${n}.`}, {agents, ...when});
  const shown = lessonsBlock(cwd, 'builder').split('\n').slice(1);
  assert.equal(shown.length, LESSONS_SHOWN_MAX);
  assert.equal(shown.at(-1), `- Lesson number ${LESSONS_SHOWN_MAX + 4}.`);
});
