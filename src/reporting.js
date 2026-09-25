// The worker reporting contract is intentionally narrower than the orchestration bus.  A
// report is data about the caller's already-bound attempt; it cannot address peers, submit work,
// or invent lifecycle rows.  Scheduler code owns the state transition after validation.
export const REPORT_OPS = new Set(['milestone', 'blocked', 'input_required', 'final']);
const TEXT_MAX = 16_000;
const EVIDENCE_MAX = 32;
const OUTCOMES = new Set(['completed', 'failed', 'blocked', 'input_required']);

// Shared vendor-facing shape; validateReport remains authoritative at the bus boundary.
export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    op: {type: 'string', enum: [...REPORT_OPS]},
    outcome: {type: 'string', enum: [...OUTCOMES]},
    ...Object.fromEntries(['phase', 'text', 'next', 'summary', 'remaining']
      .map(field => [field, {type: 'string', maxLength: TEXT_MAX}])),
    evidence: {type: 'array', maxItems: EVIDENCE_MAX,
      items: {type: 'string', maxLength: TEXT_MAX}},
  },
  required: ['op', 'phase', 'text', 'next'],
};

const text = value => typeof value === 'string' && value.length <= TEXT_MAX;

// What a completed report still owes. A worker saying nothing remains in words ("None.", "N/A") owes
// nothing; observed live, a PASS verdict was blocked as unfinished work for `remaining: "None."`.
const NOTHING_REMAINS = /^(?:none|n\/?a|nothing|-+|—)\.?$/i;
// …or leads with it and explains ("None — all three steps completed"); "None of the probes ran" still owes work.
const NOTHING_REMAINS_LEAD = /^(?:none|nothing|n\/?a)\s*[—–:;.-]/i;
export const remainingWork = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  return NOTHING_REMAINS.test(text) || NOTHING_REMAINS_LEAD.test(text) ? '' : text;
};

export function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'report';
  if (!REPORT_OPS.has(report.op)) return 'op (milestone, blocked, input_required or final)';
  // Named per field: a worker reads this off `bounce report`'s one-line error, and "content" sent
  // it hunting through the CLI for the schema (observed: minutes per task, and a nested bounce).
  for (const field of ['phase', 'text', 'next']) if (!text(report[field])) return `${field} (required string)`;
  if (report.evidence !== undefined && (!Array.isArray(report.evidence) || report.evidence.length > EVIDENCE_MAX || report.evidence.some(item => !text(item)))) return 'evidence';
  if (report.op === 'final') {
    // Observed live: one "final" for both fields, and a worker that had sent everything but `outcome`
    // gave up on the tool.
    if (!OUTCOMES.has(report.outcome)) return 'outcome (a final report needs completed, failed, blocked or input_required)';
    if (!text(report.summary)) return 'summary (required string for a final report)';
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
