// What a session's orchestrator is doing, for someone outside its view (src/mcp-control.js `status`): its turn, its
// own state note, the live tasks with the AI on each, what waits for a decision, and its last answer. Pure: events
// in, view out, from the same folds the TUI and the orchestrator's own tools read. 2026-10-25: sending a
// message is not control without seeing what the session is doing.
import {taskList} from './task-view.js';
import {tasks as taskStates} from './reducers.js';

const ANSWER_MAX = 1200, BLOCKER_MAX = 300;
const cut = (text, max) => { const value = String(text ?? '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
// The answer keeps its lines: it is markdown (tables, lists) a reader reads as written.
const clip = (text, max) => { const value = String(text ?? '').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const minutesSince = (time, now) => (time ? Math.round((now - Date.parse(time)) / 60000) : null);

export function orchestratorStatus(events, {now = Date.now()} = {}) {
  const turn = events.findLast(e => ['main.started', 'main.terminal', 'main.blocked'].includes(e.kind));
  const state = turn?.kind === 'main.started' ? 'running' : turn?.kind === 'main.blocked' ? 'blocked' : 'idle';
  const orchestrator = {state, since: turn?.time ?? null, minutes: minutesSince(turn?.time, now), request: state === 'running' ? turn.requestId ?? null : null,
    ...(state === 'blocked' && turn.text ? {reason: cut(turn.text, BLOCKER_MAX)} : {})};
  const note = events.findLast(e => e.kind === 'state' && typeof e.text === 'string')?.text ?? null;
  const states = taskStates(events);
  const tasks = taskList(events, {now}).map(row => ({...row, ai: events.findLast(e => e.kind === 'task.started' && e.task === row.task)?.requested ?? null}));
  const blocked = tasks.filter(row => states[row.task]?.state === 'blocked').map(row => {
    const last = events.findLast(e => e.kind === 'task.blocked' && e.task === row.task);
    return {task: row.task, reason: last?.reason ?? null, text: cut(last?.text, BLOCKER_MAX) || null};
  });
  const answer = events.findLast(e => e.kind === 'assistant' && e.from === 'main' && !e.narration)?.text;
  return {orchestrator, note, tasks, blocked, lastAnswer: answer ? clip(answer, ANSWER_MAX) : null};
}

export function formatStatus(view) {
  const o = view.orchestrator;
  const head = o.state === 'running' ? `Orchestrator: running for ${o.minutes} min` : o.state === 'blocked' ? `Orchestrator: blocked${o.reason ? `: ${o.reason}` : ''}`
    : `Orchestrator: idle${o.minutes != null ? ` for ${o.minutes} min` : ''}`;
  const short = id => String(id).slice(0, 8);
  return [
    head,
    view.note ? `Its note: ${view.note}` : null,
    view.tasks.length ? `Tasks:\n${view.tasks.map(t => `  ${short(t.task)} · ${t.profile ?? '?'}${t.ai ? ` on ${t.ai}` : ''} · ${t.state}${t.elapsed ? ` · ${t.elapsed}` : ''}${t.doing ? ` · ${t.doing}` : ''}`).join('\n')}` : 'Tasks: none live',
    view.blocked.length ? `Waiting on a decision:\n${view.blocked.map(b => `  ${short(b.task)} · ${b.reason ?? 'blocked'}${b.text ? ` · ${b.text}` : ''}`).join('\n')}` : null,
    view.lastAnswer ? `Last answer:\n${view.lastAnswer}` : null,
  ].filter(Boolean).join('\n');
}
