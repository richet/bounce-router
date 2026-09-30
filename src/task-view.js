// What a task is doing and what it has produced, in a screenful (docs/plans/bridge-interface.md).
// Found live: with no read verb, the orchestrator ran `tail -n 20` on its own journal and
// 143 KB of raw JSON went into the chat, the journal and its own next context packet. These views are the
// answer to that question, bounded by construction: capped lists with a count of the rest, cut text, and a
// POINTER to the journal rather than its contents. Pure — the same fold src/reducers.js gives the TUI.
import {tasks as taskStates, attemptLease} from './reducers.js';
import {candidateResult, isReviewGate} from './task-result.js';

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

function gateView(events, task, candidate) {
  const mine = events.filter(event => event.task === task);
  const scoped = candidate ? mine.filter(event => {
    if (event.candidateSeq != null && event.candidateSeq !== candidate.seq) return false;
    return !Number.isFinite(candidate.seq) || !Number.isFinite(event.seq) || event.seq > candidate.seq;
  }) : mine;
  const dedicated = scoped.findLast(event => event.kind === 'review.blocked');
  const ordinary = scoped.filter(event => event.kind === 'review.finished'
    || event.kind === 'task.blocked' && isReviewGate(event)).at(-1);
  const gate = ordinary?.kind === 'task.blocked' && dedicated ? dedicated
    : !dedicated || ordinary && Number(ordinary.seq ?? -1) > Number(dedicated.seq ?? -1) ? ordinary : dedicated;
  if (!gate) return null;
  const started = scoped.filter(event => event.kind === 'review.started'
    && (gate.seq == null || event.seq == null || event.seq <= gate.seq)).at(-1);
  const jev = scoped.filter(event => event.kind === 'jev.verdict'
    && (started?.seq == null || event.seq == null || event.seq >= started.seq)
    && (gate.seq == null || event.seq == null || event.seq <= gate.seq)).at(-1);
  const blocked = gate.kind === 'review.blocked' || gate.kind === 'task.blocked';
  return {
    state: blocked ? 'blocked' : gate.verdict ?? jev?.verdict ?? 'unavailable',
    reason: gate.reason ?? jev?.reason ?? (blocked || gate.verdict === 'unavailable' || gate.verdict === 'unreadable' ? gate.text ?? null : null),
    confidence: Number.isFinite(jev?.confidence) ? jev.confidence : Number.isFinite(gate.confidence) ? gate.confidence : null,
    choice: jev?.choice ?? gate.choice ?? null,
    fired: Array.isArray(jev?.fired) ? jev.fired.slice(0, 32).map(value => cut(value, TITLE_MAX)) : Array.isArray(gate.fired) ? gate.fired.slice(0, 32).map(value => cut(value, TITLE_MAX)) : [],
    candidateSeq: gate.candidateSeq ?? (candidate && (gate.seq == null || candidate.seq == null || gate.seq > candidate.seq) ? candidate.seq : null),
  };
}

function currentReview(events, task, candidate, kind) {
  const mine = events.filter(event => event.task === task && event.kind === kind);
  if (!candidate) return mine.at(-1) ?? null;
  return mine.filter(event => (event.candidateSeq == null || event.candidateSeq === candidate.seq)
    && (!Number.isFinite(candidate.seq) || !Number.isFinite(event.seq) || event.seq > candidate.seq)).at(-1) ?? null;
}

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
  const terminal = [...mine].reverse().find(e => ['task.accepted', 'task.rejected', 'task.completed', 'task.failed', 'task.cancelled', 'task.deadline', 'task.blocked'].includes(e.kind));
  const result = candidateResult(events, task);
  const verdict = currentReview(events, task, result, 'review.finished');
  const blocked = state.state === 'blocked' ? lastOf(events, task, 'task.blocked') : null;
  const leaseRow = attemptLease(events, task, {defaultDeadlineMs: submitted?.deadline ?? 3600000, ceilingMs: submitted?.deadline ?? 3600000, stage: 'turn'});
  const artifact = lastOf(events, task, 'task.artifact');
  const integrated = lastOf(events, task, 'task.integrated');
  const invalid = lastOf(events, task, 'task.report.invalid');
  const output = invalid?.outputSeq == null
    ? lastOf(events, task, 'task.output')
    : mine.find(event => event.kind === 'task.output' && event.seq === invalid.outputSeq) ?? lastOf(events, task, 'task.output');
  const reviewGate = gateView(events, task, result);
  const seqs = mine.map(e => e.seq).filter(Number.isFinite);
  // §8 (docs/plans/in-place-tasks.md): the task ran in the real checkout, so the view names
  // what consent authorized that — the cited user message (first 80 chars) and Jev's verdict
  // when there was one, exactly as bounce shows any other decision.
  const inPlaceRow = submitted?.inPlace ? submitted : null;
  const jevDecided = lastOf(events, task, 'jev.decided');
  const jevSkipped = lastOf(events, task, 'jev.skipped');
  const inPlace = inPlaceRow ? {
    authorizedBy: inPlaceRow.inPlace.authorizedBy,
    message: cut(events.find(e => e.kind === 'user' && e.seq === inPlaceRow.inPlace.authorizedBy)?.text, 80),
    jev: jevDecided ? {verdict: jevDecided.verdict, confidence: jevDecided.confidence ?? null}
      : jevSkipped ? {verdict: 'skipped', reason: jevSkipped.reason ?? null} : null,
  } : null;
  return {
    task, state: state.state, profile: state.profile ?? null, ai: started?.requested ?? null,
    orders: cut(submitted?.orders, TEXT_MAX),
    inPlace,
    elapsed: started ? minutes(now - Date.parse(started.time)) : null,
    lease: leaseRow ? {renewals: leaseRow.renewals, minutes: Math.round(leaseRow.leaseMs / 60000)} : null,
    rounds: state.rounds ?? 0,
    reviewer: currentReview(events, task, result, 'review.started')?.profile ?? null,
    verdict: verdict ? {verdict: verdict.verdict, stage: verdict.stage ?? null} : null,
    advice: terminal?.kind === 'task.accepted' ? terminal.advice ?? null : null,
    candidate: result ? {seq: result.seq, attempt: result.attempt, digest: result.digest, outcome: result.outcome, summary: cut(result.summary, SUMMARY_MAX) || null} : null,
    reviewGate,
    milestones,
    findings: {shown: findings.slice(-FINDINGS_SHOWN).map(findingLine), total: findings.length, more: Math.max(0, findings.length - FINDINGS_SHOWN)},
    summary: cut(terminal?.summary ?? terminal?.text ?? state.summary, SUMMARY_MAX) || null,
    // Whole and unreflowed when asked for: a verdict's last line is where it puts its conclusion.
    ...(report ? {
      report: result ? JSON.stringify(result.report) : (terminal?.summary ?? terminal?.text ?? state.summary ?? null),
      candidateReport: result?.report ?? null,
      rawOutput: output?.text ?? null,
      ...(invalid ? {invalidReport: {
        ...(invalid.outputSeq != null ? {outputSeq: invalid.outputSeq} : {}),
        diagnostic: invalid.diagnostic ?? null,
        report: invalid.report ?? null,
      }} : {}),
    } : {}),
    reportDiagnostic: invalid ? cut(invalid.diagnostic, TEXT_MAX) || null : null,
    output: output ? {
      seq: output.seq ?? null,
      attempt: output.attempt ?? null,
      chars: output.chars ?? String(output.text ?? '').length,
      digest: output.digest ?? null,
      status: output.status ?? null,
    } : null,
    reason: terminal?.reason ?? null,
    blocker: blocked ? cut(blocked.text, TEXT_MAX) : null,
    artifact: lastOf(events, task, 'artifact.captured')?.artifact ?? (artifact ? {id: artifact.artifactId, digest: artifact.digest, resultHash: artifact.resultHash} : null),
    integration: lastOf(events, task, 'artifact.integrated')?.status ?? (integrated ? 'integrated' : null),
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
