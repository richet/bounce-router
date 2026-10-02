// Lessons: one line per correction, written by the orchestrator, read by every later worker of that job
// in this project (docs/plans/lessons-and-sweep.md §1; Daniel, 2026-10-01). Found live, the week before:
// evidence saved outside the working copy, checks that only looked for a file, a builder that thought
// itself to death — each a lesson the orchestrator had in hand when it corrected the work, and each one
// reached the agent files only through a person reading journals. The file is plain markdown in the
// project, append-only from here, edited or pruned by hand like any file.
import fs from 'node:fs';
import path from 'node:path';

export const LESSONS_FILE = cwd => path.join(cwd, '.bounce', 'LESSONS.md');
export const LESSON_TEXT_MAX = 300;
export const LESSONS_SHOWN_MAX = 40;
export const LESSONS_HEADING = 'Lessons from earlier sessions in this project:';
const FILE_HEAD = '# Lessons\n\nOne line per lesson, written by the orchestrator when it corrected a worker\'s work here; every later worker of that job reads them. Delete a line to withdraw it.\n\n';
// `- text <!-- agent · date · session -->`; a line a person wrote without the comment is for every job.
const LINE = /^-\s+(.*?)\s*(?:<!--\s*([^\s·]+)\s*·\s*(\S+)\s*·\s*(\S+)\s*-->)?\s*$/;

const normalize = text => String(text ?? '').trim().replace(/\s+/g, ' ');
// The same lesson said twice differs in case, spacing or a final period, not in substance.
const same = (a, b) => normalize(a).toLowerCase().replace(/[.!]+$/, '') === normalize(b).toLowerCase().replace(/[.!]+$/, '');

export function readLessons(cwd) {
  let text;
  try { text = fs.readFileSync(LESSONS_FILE(cwd), 'utf8'); } catch { return []; }
  const lessons = [];
  for (const raw of text.split('\n')) {
    const match = LINE.exec(raw.trim());
    if (!match || !match[1]) continue;
    lessons.push({agent: match[2] ?? 'all', text: match[1], date: match[3] ?? null, session: match[4] ?? null});
  }
  return lessons;
}

// {ok: true, lesson} or {ok: false, reason}: the reason is what the orchestrator is told, so it says
// what a lesson is instead of what a schema wants.
export function recordLesson(cwd, {agent, text} = {}, {agents = new Set(), date = new Date().toISOString().slice(0, 10), session = ''} = {}) {
  const line = normalize(text);
  if (!line) return {ok: false, reason: 'lesson needs text: one sentence, imperative'};
  if (/\n/.test(String(text ?? '').trim())) return {ok: false, reason: 'lesson text is one line'};
  if (line.length > LESSON_TEXT_MAX) return {ok: false, reason: `lesson text is over ${LESSON_TEXT_MAX} characters: one sentence, imperative`};
  const job = String(agent ?? 'all').trim();
  if (job !== 'all' && !agents.has(job)) return {ok: false, reason: `agent must be one of ${[...agents].sort().join(', ')}, or all`};
  if (readLessons(cwd).some(lesson => same(lesson.text, line))) return {ok: false, reason: 'duplicate: this lesson is already in .bounce/LESSONS.md'};
  const file = LESSONS_FILE(cwd);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (!fs.existsSync(file)) fs.writeFileSync(file, FILE_HEAD);
  const short = String(session).slice(0, 8);
  fs.appendFileSync(file, `- ${line} <!-- ${job} · ${date} · ${short} -->\n`);
  return {ok: true, lesson: {agent: job, text: line, date, session: short}};
}

// The lines a job reads (its own and `all`), newest last, capped; the orchestrator reads every line with
// its job in front. Empty string when there is nothing: the caller adds nothing to the prompt.
export function lessonsBlock(cwd, agent) {
  const all = readLessons(cwd);
  const orchestrator = agent === 'orchestrator';
  const mine = orchestrator ? all : all.filter(lesson => lesson.agent === 'all' || lesson.agent === agent);
  if (!mine.length) return '';
  const shown = mine.slice(-LESSONS_SHOWN_MAX);
  return [LESSONS_HEADING, ...shown.map(lesson => `- ${orchestrator ? `(${lesson.agent}) ` : ''}${lesson.text}`)].join('\n');
}
