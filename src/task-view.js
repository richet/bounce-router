// What a task is doing and what it has produced, in a screenful (docs/plans/bridge-interface.md).
// Found live: with no read verb, the orchestrator ran `tail -n 20` on its own journal and
// 143 KB of raw JSON went into the chat, the journal and its own next context packet. These views are the
// answer to that question, bounded by construction: capped lists with a count of the rest, cut text, and a
// POINTER to the journal rather than its contents. Pure — the same fold src/reducers.js gives the TUI.
import {tasks as taskStates} from './reducers.js';

export const FINDINGS_SHOWN = 10;
export const MILESTONES_SHOWN = 3;
const TITLE_MAX = 200, TEXT_MAX = 400, SUMMARY_MAX = 1200;

const cut = (value, max) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };
const minutes = ms => `${Math.round(ms / 60000)} min`;
const rowsOf = (events, task, kind) => events.filter(e => e.kind === kind && e.task === task);
const lastOf = (events, task, kind) => rowsOf(events, task, kind).at(-1) ?? null;

const findingLine = row => row.finding
  ? {severity: row.finding.severity ?? null, file: row.finding.file ?? null, line: row.finding.line ?? null, title: cut(row.finding.title ?? row.finding.description, TITLE_MAX)}
  : {severity: null, file: null, line: null, title: cut(String(row.text ?? '').replace(/^FINDING:\s*/, ''), TITLE_MAX)};

// One task: null when bounce never saw it (never an empty shape that reads as "nothing happened").
// `report: true` is the one deliberate way to the whole verdict. Found live: a 12 KB FAIL report
// was cut mid-word at SUMMARY_MAX and the orchestrator had no way to ask for the rest — and its orders forbid
// reading the journal, so nothing could reach it. The bounded summary stays exactly as it was, beside it.
export function taskView(events, task, {now = Date.now(), journal = null, report = false} = {}) {
  const state = taskStates(events)[task];
  if (!state) return null;
  const submitted = events.find(e => e.kind === 'task.submitted' && e.task === task);
  const started = events.find(e => e.kind === 'task.started' && e.task === task);
  const mine = events.filter(e => e.task === task);
  const findings = rowsOf(events, task, 'task.finding');
  const milestones = rowsOf(events, task, 'task.milestone').slice(-MILESTONES_SHOWN)
    .map(row => ({phase: cut(row.phase, 80), text: cut(row.text, TEXT_MAX), next: cut(row.next, 120)}));
  const terminal = [...mine].reverse().find(e => ['task.completed', 'task.failed', 'task.cancelled', 'task.deadline'].includes(e.kind));
  const verdict = lastOf(events, task, 'review.finished');
  const blocked = state.state === 'blocked' ? lastOf(events, task, 'task.blocked') : null;
  const leaseMs = submitted?.deadline ?? null;
  const seqs = mine.map(e => e.seq).filter(Number.isFinite);
  return {
    task, state: state.state, profile: state.profile ?? null, ai: started?.requested ?? null,
    orders: cut(submitted?.orders, TEXT_MAX),
    elapsed: started ? minutes(now - Date.parse(started.time)) : null,
    lease: leaseMs ? {renewals: rowsOf(events, task, 'task.lease.renewed').length, minutes: Math.round(leaseMs / 60000)} : null,
    rounds: state.rounds ?? 0,
    reviewer: lastOf(events, task, 'review.started')?.profile ?? null,
    verdict: verdict ? {verdict: verdict.verdict, stage: verdict.stage ?? null} : null,
    milestones,
    findings: {shown: findings.slice(-FINDINGS_SHOWN).map(findingLine), total: findings.length, more: Math.max(0, findings.length - FINDINGS_SHOWN)},
    summary: cut(terminal?.summary ?? terminal?.text ?? state.summary, SUMMARY_MAX) || null,
    // Whole and unreflowed when asked for: a verdict's last line is where it puts its conclusion.
    ...(report ? {report: (terminal?.summary ?? terminal?.text ?? state.summary ?? null)} : {}),
    reason: terminal?.reason ?? null,
    blocker: blocked ? cut(blocked.text, TEXT_MAX) : null,
    // The raw material, named — never carried. Whoever wants it reads it themselves.
    journal: journal ? {path: journal, task, fromSeq: seqs.length ? Math.min(...seqs) : null, toSeq: seqs.length ? Math.max(...seqs) : null} : null,
  };
}

const LIVE = new Set(['queued', 'running', 'waiting', 'reviewing', 'blocked', 'input_required']);

// Every task that is still live (or all of them), one line each, in the order they were submitted.
export function taskList(events, {now = Date.now(), all = false} = {}) {
  const states = taskStates(events);
  return events.filter(e => e.kind === 'task.submitted' && states[e.task])
    .map(e => e.task)
    .filter(task => all || LIVE.has(states[task].state))
    .map(task => {
      const started = events.find(e => e.kind === 'task.started' && e.task === task);
      const last = rowsOf(events, task, 'task.milestone').at(-1);
      return {task, state: states[task].state, profile: states[task].profile ?? null,
        elapsed: started ? minutes(now - Date.parse(started.time)) : null,
        doing: cut(last?.text, TITLE_MAX) || null,
        findings: rowsOf(events, task, 'task.finding').length};
    });
}
