// The worker reporting contract is intentionally narrower than the orchestration bus.  A
// report is data about the caller's already-bound attempt; it cannot address peers, submit work,
// or invent lifecycle rows.  Scheduler code owns the state transition after validation.
export const REPORT_OPS = new Set(['milestone', 'blocked', 'input_required', 'final']);
export const TEXT_MAX = 16_000;
export const EVIDENCE_MAX = 32;
export const OUTCOMES = new Set(['completed', 'failed', 'blocked', 'input_required']);

// A worker's outcome word missing the canonical set by a synonym, not a typo, is still a clear
// verdict — normalize case-insensitively before refusing it. Found live (session 159f4746, 2
// tasks): a near-miss outcome word was refused by `bounce_report`, and the worker never recovered
// its final report. Unknown words fall through unchanged, so validateReport still refuses them.
const OUTCOME_SYNONYMS = {
  success: 'completed', succeeded: 'completed', done: 'completed', complete: 'completed', finished: 'completed',
  error: 'failed', failure: 'failed', fail: 'failed',
  stuck: 'blocked', blocked_on_input: 'blocked',
  needs_input: 'input_required', waiting: 'input_required',
};
export function normalizeOutcome(outcome) {
  if (typeof outcome !== 'string') return outcome;
  const key = outcome.trim().toLowerCase();
  if (OUTCOMES.has(key)) return key;
  return OUTCOME_SYNONYMS[key] ?? outcome;
}

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
// …or scopes it ("None for the assigned scope.", found live on a finished sonnet task), unless the
// sentence then turns: "None for now, but the lint step still fails" still owes work.
const NOTHING_REMAINS_SCOPED = /^(?:none|nothing)\s+(?:for|in|within|left|remaining|outstanding|pending)\b/i;
const TURNS = /\b(?:but|except|however|still|yet|although)\b/i;
export const remainingWork = value => {
  const text = typeof value === 'string' ? value.trim() : '';
  const nothing = NOTHING_REMAINS.test(text) || NOTHING_REMAINS_LEAD.test(text) || (NOTHING_REMAINS_SCOPED.test(text) && !TURNS.test(text));
  return nothing ? '' : text;
};

export function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'report';
  if (!REPORT_OPS.has(report.op)) return 'op (milestone, blocked, input_required or final)';
  // Named per field: a worker reads this off `bounce report`'s one-line error, and "content" sent
  // it hunting through the CLI for the schema (observed: minutes per task, and a nested bounce).
  for (const field of ['phase', 'text', 'next']) if (!text(report[field])) return `${field} (required string)`;
  if (report.evidence !== undefined && (!Array.isArray(report.evidence) || report.evidence.length > EVIDENCE_MAX || report.evidence.some(item => !text(item)))) return 'evidence';
  if (report.op === 'final') {
    // Canonicalize in place: every caller (the report MCP tool, the bus's own report(), the
    // final-answer compatibility path) reads report.outcome straight off this same object after
    // validation, so a synonym must resolve here, once, not at each read site.
    if (typeof report.outcome === 'string') report.outcome = normalizeOutcome(report.outcome);
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
