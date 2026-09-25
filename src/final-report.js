import {validateReport} from './reporting.js';

// The final report is the boundary between an untrusted worker answer and a task transition.
// Only a report that the ordinary reporting endpoint would accept can claim completion.
export const FINAL_REPORT_INSTRUCTION = 'Finish with one standalone JSON object (or a fenced JSON object) matching the bounce report final schema: {"op":"final","phase":"...","text":"...","next":"...","evidence":["..."],"outcome":"completed|failed|blocked|input_required","summary":"...","remaining":"..."}. A completed outcome must have an empty remaining field.';

const jsonCandidates = text => {
  const source = String(text ?? '').trim();
  const fenced = [...source.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim());
  return [source, ...fenced];
};

export function parseFinalReport(textValue) {
  for (const candidate of jsonCandidates(textValue)) {
    let value;
    try { value = JSON.parse(candidate); } catch { continue; }
    if (validateReport(value) || value.op !== 'final') continue;
    if (value.outcome === 'completed' && typeof value.remaining === 'string' && value.remaining.trim()) continue;
    return value;
  }
  return null;
}
