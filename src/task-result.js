import {createHash} from 'node:crypto';
import {validateReport, remainingWork} from './reporting.js';

const reportOf = row => ({
  op: 'final',
  phase: row.phase,
  text: row.text,
  next: row.next,
  evidence: row.evidence,
  outcome: row.outcome,
  summary: row.summary,
  remaining: row.remaining,
});

// The worker's immutable candidate result is the latest valid task.reported row. Lifecycle rows
// that accept, reject or block its review never replace the work that was actually reported.
export function candidateResult(events, task) {
  const row = events.findLast(event => {
    if (event.kind !== 'task.reported' || event.task !== task) return false;
    const report = reportOf(event);
    return !validateReport(report) && !(report.outcome === 'completed' && remainingWork(report.remaining));
  });
  if (!row) return null;
  const report = reportOf(row);
  const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
  return {seq: row.seq ?? null, attempt: row.attempt ?? null, digest, outcome: row.outcome ?? null,
    summary: row.summary ?? null, report};
}

// Why a completed candidate is held at its review gate: the reviewer leaned rework, leaned accept,
// or gave no answer at all. Older journals only say it in the text.
export const REVIEW_GATE_REASONS = new Set(['review_not_accepted', 'review_uncertain', 'review_unavailable']);
export const isReviewGate = row => REVIEW_GATE_REASONS.has(row?.reason) || /^Required review unavailable/i.test(row?.text ?? '');
