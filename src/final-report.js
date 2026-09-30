import {validateReport, remainingWork, normalizeOutcome, OUTCOMES, TEXT_MAX, EVIDENCE_MAX} from './reporting.js';

// The final report is the boundary between an untrusted worker answer and a task transition.
// Only a report that the ordinary reporting endpoint would accept can claim completion.
export const FINAL_REPORT_INSTRUCTION = 'Finish with one standalone JSON object (or a fenced JSON object) matching the bounce report final schema: {"op":"final","phase":"...","text":"...","next":"...","evidence":["..."],"outcome":"completed|failed|blocked|input_required","summary":"...","remaining":"..."}. phase, text, next, summary and remaining must each be strings of at most 16000 characters; next must be one string, not an array. evidence is optional and must contain at most 32 strings, each at most 16000 characters. outcome reflects only the assigned task: put future project work and findings in next or evidence; use remaining only for unfinished assigned obligations. If required assigned work is unfinished or your tools cannot perform it, use outcome blocked and describe it in remaining. Never clear remaining to make an unfinished assignment look completed. A completed outcome must have an empty remaining field.';

const jsonCandidates = text => {
  const source = String(text ?? '').trim();
  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim());
  return [source, ...fenced];
};

// Some local models (qwen via OpenCode, ACE session d1bc0206) write their report tool call as
// text in the chat template's own markup instead of calling the tool:
// `<parameter=summary>\n…\n</parameter>` pairs inside `<function=…>` / `<tool_call>` tags, often
// with the opening cut off. The pairs are the report the worker meant to send.
const PSEUDO_PARAMETER = /<parameter=([A-Za-z_]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
const TOOL_MARKUP = /<\/?(?:parameter(?:=[A-Za-z_]+)?|function(?:=[A-Za-z_.-]+)?|tool_call)>/g;

function pseudoToolCall(text) {
  const fields = {};
  for (const [, name, value] of String(text ?? '').matchAll(PSEUDO_PARAMETER)) fields[name] = value.trim();
  if (!Object.keys(fields).length) return null;
  if (typeof fields.evidence === 'string') {
    try { const parsed = JSON.parse(fields.evidence); fields.evidence = Array.isArray(parsed) ? parsed : [fields.evidence]; }
    catch { fields.evidence = fields.evidence ? [fields.evidence] : []; }
  }
  if (typeof fields.outcome === 'string') fields.outcome = normalizeOutcome(fields.outcome);
  return {op: 'final', ...fields};
}

// The answer as prose: tool-call markup a model wrote as text removed, so a summary or status line
// is read from what it said rather than from `</parameter>`.
export const withoutToolMarkup = text => String(text ?? '').replace(TOOL_MARKUP, '').replace(/\n{3,}/g, '\n\n').trim();

export function inspectFinalReport(textValue) {
  let diagnostic = 'missing_report';
  let rejected = null;
  const pseudo = pseudoToolCall(textValue);
  if (pseudo) {
    const problem = validateReport(pseudo);
    if (!problem) return pseudo.outcome === 'completed' && remainingWork(pseudo.remaining) ? {report: pseudo, diagnostic: 'report_incomplete'} : {report: pseudo, diagnostic: null};
    diagnostic = `malformed_report: ${problem}`;
    rejected = pseudo;
  }
  for (const candidate of jsonCandidates(textValue)) {
    let value;
    try { value = JSON.parse(candidate); } catch (error) {
      // A JSON-shaped final answer is evidence of report intent. Keep the parser's concrete
      // failure so a missing bracket is not presented as if the worker produced no report.
      if (candidate.startsWith('{')) diagnostic = `malformed_json: ${error.message}`;
      continue;
    }
    if (Array.isArray(value?.next) && value.next.every(item => typeof item === 'string')) value = {...value, next: value.next.join('\n')};
    if (Array.isArray(value?.evidence) && value.evidence.length > 32 && value.evidence.every(item => typeof item === 'string')) {
      value = {...value, evidence: [...value.evidence.slice(0, 31), value.evidence.slice(31).join('\n')]};
    }
    const problem = validateReport(value);
    if (problem || value.op !== 'final') { diagnostic = `malformed_report: ${problem ?? 'op'}`; rejected = value; continue; }
    if (value.outcome === 'completed' && remainingWork(value.remaining)) {
      return {report: value, diagnostic: 'report_incomplete'};
    }
    return {report: value, diagnostic: null};
  }
  return {report: rejected, diagnostic};
}

export function parseFinalReport(textValue) {
  const result = inspectFinalReport(textValue);
  return result.diagnostic ? null : result.report;
}

// A model does the assigned work far more reliably than it operates its own report tool
// (observed live, session 159f4746: 7 of 19 tasks ended `task.report.invalid missing_report`
// with a complete, usable prose answer already sitting in task.output, then lost it to a report
// repair that timed out or was unavailable). The worker's own final answer is the source of
// truth whenever no valid structured report survived parsing — synthesize a final report from it,
// merging in whatever valid fields a malformed `bounce_report` call already carried, instead of
// spending a repair turn asking the model to do the one thing it just failed to do. Only a
// literally empty answer (nothing at all to synthesize from) still needs a turn back to the
// worker, and it asks in plain words this time (see requestPlainAnswer in scheduler.js).
const firstBlock = text => text.split(/\n\s*\n/)[0] ?? '';

// Only an explicit status decides: a line that starts with the status word ("Blocked: …", "**BLOCKED: …**"),
// a labelled status line ("Verdict: FAIL", "Status: failed"), or a ❌ mark on it. A word inside ordinary
// prose ("the new tests fail as expected", "the fence blocked my first write") must not turn finished work
// into failed/blocked — the synthesized outcome drives what happens next; the review judges the rest.
const statusLine = word => new RegExp(`^[\\s>*#_-]*(?:${word})\\s*[*_]*\\s*[:：—–]|^[\\s>*#_-]*(?:status|outcome|verdict|result)\\s*[:：]\\s*[*_]*\\s*(?:${word})\\b|❌\\s*(?:${word})\\b`, 'im');
const BLOCKED_STATUS = statusLine('blocked');
const FAILED_STATUS = statusLine('failed|fail');

// For a worker whose job is a verdict (a reviewer), FAIL is its result, not its status: the review
// succeeded. Found live (ACE e3bd01d5, 2026-09-30): a review ending "**FAIL** — 3 blockers" was
// journaled as the reviewer having failed. "Blocked:" about the reviewing itself still counts.
function synthesizedOutcome(text, {verdict = false} = {}) {
  if (BLOCKED_STATUS.test(text)) return {outcome: 'blocked', rule: 'status_blocked'};
  if (!verdict && FAILED_STATUS.test(text)) return {outcome: 'failed', rule: 'status_failed'};
  return {outcome: 'completed', rule: 'default_completed'};
}

const HEADING = /^#{1,6}\s*(.+?)\s*$/;

const REMAINING_HEADING = /^(?:remaining|next|not\s+done)\b/i;
const LABEL = /^[*_]*[^.!?]{1,60}:[*_]*$/; // a short line that ends in a colon, bold or not

// The first markdown heading's own text, else the first non-blank paragraph, trimmed and bounded. A
// heading that only names what is left ("Remaining") is a section of the answer, not its summary.
function synthesizedSummary(text) {
  for (const line of text.split('\n')) {
    const match = HEADING.exec(line.trim());
    if (match && !REMAINING_HEADING.test(match[1])) return match[1].slice(0, TEXT_MAX);
  }
  // An opening that is only a label ("**What I did:**") says nothing: what follows it does.
  const lines = text.trim().split('\n').map(line => line.trim());
  const said = lines.findIndex(line => line && !LABEL.test(line));
  const from = said === -1 ? 0 : said;
  const until = lines.findIndex((line, index) => index > from && !line);
  return lines.slice(from, until === -1 ? undefined : until).join('\n').slice(0, TEXT_MAX);
}

// The body of a "Remaining" / "Next" / "Not done" heading, if the worker's answer has one; '' otherwise.
function synthesizedRemaining(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => { const match = HEADING.exec(line.trim()); return match && REMAINING_HEADING.test(match[1]); });
  if (start === -1) return '';
  const end = lines.slice(start + 1).findIndex(line => HEADING.test(line.trim()));
  return lines.slice(start + 1, end === -1 ? undefined : start + 1 + end).join('\n').trim().slice(0, TEXT_MAX);
}

// A field wins from the candidate (a malformed bounce_report call) only when it is itself valid
// by the ordinary report schema; otherwise it falls back to what synthesis reads off the answer.
// `sources` names, per field, which one actually supplied it — the audience is the
// `task.report.synthesized` journal row, not this function's caller.
function fieldFrom(candidateValue, fallbackValue, isValid) {
  return isValid(candidateValue) ? {value: candidateValue, from: 'worker'} : {value: fallbackValue, from: 'answer'};
}

const validText = value => typeof value === 'string' && value.length <= TEXT_MAX;
const validNonEmptyText = value => validText(value) && value.trim().length > 0;
const validEvidence = value => Array.isArray(value) && value.length <= EVIDENCE_MAX && value.every(item => validText(item));

// `answer` is the worker's raw final-turn text (never empty — the caller only reaches here once
// it has confirmed that). `candidate` is the parsed-but-rejected report object from a malformed
// `bounce_report` call, or null when none exists (missing_report, or unparseable JSON).
export function synthesizeReport(answer, candidate = null, {verdict = false} = {}) {
  const text = withoutToolMarkup(answer);
  const fallback = synthesizedOutcome(text, {verdict});

  const candidateOutcome = typeof candidate?.outcome === 'string' ? normalizeOutcome(candidate.outcome) : candidate?.outcome;
  const outcome = fieldFrom(candidateOutcome, fallback.outcome, value => OUTCOMES.has(value));
  const phase = fieldFrom(candidate?.phase, 'synthesized', validNonEmptyText);
  const summary = fieldFrom(candidate?.summary, synthesizedSummary(text), validNonEmptyText);
  const remaining = fieldFrom(candidate?.remaining, synthesizedRemaining(text), validText);
  const next = fieldFrom(candidate?.next, remaining.value, validText);
  const evidence = fieldFrom(candidate?.evidence, [], validEvidence);

  return {
    report: {
      op: 'final', phase: phase.value, text: text.slice(0, TEXT_MAX), next: next.value,
      evidence: evidence.value, outcome: outcome.value, summary: summary.value, remaining: remaining.value,
      synthesized: true,
    },
    rule: fallback.rule,
    sources: {outcome: outcome.from, phase: phase.from, summary: summary.from, remaining: remaining.from, next: next.from, evidence: evidence.from},
  };
}

const FILE_LIST_MAX = 5;

const lineCount = text => (text == null || text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);

// The lines that changed, as the artifact counted them from its diff (workspace-artifacts.js). An
// artifact without counts (an older one, or a file whose earlier content could not be read) falls
// back to whole-file lines: the new file's, and those of the old file's preview.
function statLine(change, stat) {
  if (stat) return change.kind === 'delete' ? `${change.path}: -${stat.removed}` : `${change.path}: +${stat.added} -${stat.removed}`;
  if (change.kind === 'delete') return `${change.path}: -${lineCount(change.before?.preview)}`;
  const removed = change.before ? lineCount(change.before.preview) : 0;
  const added = lineCount(Buffer.from(change.data, 'base64').toString('utf8'));
  return `${change.path}: +${added} -${removed}`;
}

// The worker's turn ended with no text at all, but its isolated workspace captured real changes —
// those changes ARE its answer (docs: the caller only reaches this once it has confirmed both: no
// answer text, and artifact.changes.length >= 1). No prose to draw a summary or an outcome word
// from here, unlike synthesizeReport above, so the outcome is always `completed` and the summary
// names what changed instead of paraphrasing what the worker said.
export function synthesizeReportFromChanges(artifact) {
  const paths = artifact.changes.map(change => change.path);
  const shown = paths.slice(0, FILE_LIST_MAX);
  const list = paths.length > shown.length ? `${shown.join(', ')}, and ${paths.length - shown.length} more` : shown.join(', ');
  const summary = `No summary from the worker; it changed ${paths.length} file(s): ${list}`.slice(0, TEXT_MAX);
  const text = artifact.changes.map(change => statLine(change, artifact.stats?.[change.path])).join('\n').slice(0, TEXT_MAX);
  return {
    report: {
      op: 'final', phase: 'synthesized', text, next: '', evidence: [], outcome: 'completed',
      summary, remaining: '', synthesized: true,
    },
    rule: 'from_changes',
  };
}
