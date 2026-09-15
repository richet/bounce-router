// The worker reporting contract is intentionally narrower than the orchestration bus.  A
// report is data about the caller's already-bound attempt; it cannot address peers, submit work,
// or invent lifecycle rows.  Scheduler code owns the state transition after validation.
export const REPORT_OPS = new Set(['milestone', 'blocked', 'input_required', 'final']);
const TEXT_MAX = 16_000;
const EVIDENCE_MAX = 32;
const OUTCOMES = new Set(['completed', 'failed', 'blocked', 'input_required']);

const text = value => typeof value === 'string' && value.length <= TEXT_MAX;

export function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'report';
  if (!REPORT_OPS.has(report.op)) return 'op';
  if (!text(report.phase) || !text(report.text) || !text(report.next)) return 'content';
  if (report.evidence !== undefined && (!Array.isArray(report.evidence) || report.evidence.length > EVIDENCE_MAX || report.evidence.some(item => !text(item)))) return 'evidence';
  if (report.op === 'final') {
    if (!OUTCOMES.has(report.outcome) || !text(report.summary)) return 'final';
    if (report.remaining !== undefined && !text(report.remaining)) return 'remaining';
  }
  return null;
}

export function reportEvent({task, attempt, report, from, context}) {
  const base = {task, attempt, phase: report.phase, text: report.text, next: report.next,
    ...(report.evidence ? {evidence: [...report.evidence]} : {}), from, context};
  if (report.op === 'milestone') return {kind: 'task.milestone', ...base};
  if (report.op === 'blocked') return {kind: 'task.blocked', ...base};
  if (report.op === 'input_required') return {kind: 'task.input_required', ...base};
  return {kind: 'task.reported', outcome: report.outcome, summary: report.summary,
    ...(report.remaining !== undefined ? {remaining: report.remaining} : {}), ...base};
}
