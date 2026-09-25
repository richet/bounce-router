import {validateReport, remainingWork} from './reporting.js';

// The final report is the boundary between an untrusted worker answer and a task transition.
// Only a report that the ordinary reporting endpoint would accept can claim completion.
export const FINAL_REPORT_INSTRUCTION = 'Finish with one standalone JSON object (or a fenced JSON object) matching the bounce report final schema: {"op":"final","phase":"...","text":"...","next":"...","evidence":["..."],"outcome":"completed|failed|blocked|input_required","summary":"...","remaining":"..."}. phase, text, next, summary and remaining must each be strings of at most 16000 characters; next must be one string, not an array. evidence is optional and must contain at most 32 strings, each at most 16000 characters. outcome reflects only the assigned task: put future project work and findings in next or evidence; use remaining only for unfinished assigned obligations. If required assigned work is unfinished or your tools cannot perform it, use outcome blocked and describe it in remaining. Never clear remaining to make an unfinished assignment look completed. A completed outcome must have an empty remaining field.';

const jsonCandidates = text => {
  const source = String(text ?? '').trim();
  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim());
  return [source, ...fenced];
};

export function inspectFinalReport(textValue) {
  let diagnostic = 'missing_report';
  let rejected = null;
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
