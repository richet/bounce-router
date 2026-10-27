// Reading a reviewer's verdict. An "unreadable" review was almost always bounce failing to read what the
// reviewer said, not a reviewer saying nothing (user, 2026-09-27: "it is usually a bounce issue, not a
// worker issue"). Found live: a verdict written as fenced or multi-line JSON, inline after prose, or as a
// plain "Verdict: PASS" line counted as no verdict, as did any review whose turn did not end `completed`.
// The verdict is read from whatever the reviewer wrote, whatever the turn status; only text with no
// verdict in it at all is unreadable, and that goes to the orchestrator with what the reviewer said.
const WORDS = [
  ['accept', /^(accept(ed)?|approve[ds]?|pass(ed)?|lgtm|ok(ay)?|ship( it)?|looks good)$/],
  ['rework', /^(rework|revise|fail(ed)?|changes? requested|request changes|needs? (work|changes)|not accepted)$/],
  ['reject', /^(reject(ed)?|block(ed)?)$/],
];
const normalize = word => {
  const key = String(word ?? '').trim().toLowerCase().replace(/[*_`"'.!]/g, '').replace(/\s+/g, ' ');
  return WORDS.find(([, pattern]) => pattern.test(key))?.[0] ?? null;
};

// Every balanced {...} in the text, innermost-last order does not matter: the last one with a verdict wins.
function jsonObjects(text) {
  const found = [];
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { try { found.push({at: start, value: JSON.parse(text.slice(start, i + 1))}); } catch {} break; }
    }
  }
  return found;
}

const LABELLED = /^[\s>*#_-]*(?:final\s+)?(?:verdict|decision|review\s+verdict)\s*[:：=-]\s*[*_`"]*\s*([A-Za-z][A-Za-z ]{0,24}?)\s*[*_`".!]*\s*$/i;
const FINDING = /^\s*[-*>]*\s*[*_`]*FINDING[*_`]*\s*[:：]\s*(.+?)[*_`]*\s*$/i;
// A line that is nothing but a verdict word ("PASS", "**FAIL**"): what reviewer agents are told to write. The word
// may close its own sentence and the line go on ("PASS. No must-fix issues.", "PASS; no must-fixes."): found live,
// both were read as no verdict and the task blocked.
const BARE = /^[\s>*#_`-]*([A-Za-z][A-Za-z ]{0,24}?)[*_`]*(?:[.!;][*_`]*)?\s*(?:[(—–:;-].*|(?<=[.!;][*_`]*\s+)\S.*)?$/;
const REASON_MAX = 6000;
const BLOCKING = /"severity"\s*:\s*"(blocker|major)"/i;

export function parseVerdict(status, text) {
  const raw = typeof text === 'string' ? text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim() : '';
  if (raw) {
    const objects = jsonObjects(raw).filter(({value}) => value && typeof value === 'object' && !Array.isArray(value));
    for (let i = objects.length - 1; i >= 0; i--) {
      const value = objects[i].value;
      const key = Object.keys(value).find(k => k.toLowerCase() === 'verdict');
      const verdict = key ? normalize(value[key]) ?? (typeof value[key] === 'string' ? value[key].trim().toLowerCase() : null) : null;
      if (verdict) return {...value, verdict};
    }
    const lines = raw.split('\n');
    const findings = lines.map(line => FINDING.exec(line)?.[1]?.trim()).filter(Boolean);
    // A verdict that sends the work back with no FINDING lines still says why, in prose: that text is its finding, so
    // the worker is told what to change (found live: a FAIL with two majors in prose reached the builder as an empty
    // "Rework round 1:", and it blocked itself).
    const sendsBack = verdict => verdict === 'rework' || verdict === 'reject';
    const withFindings = verdict => ({verdict, ...(findings.length ? {findings} : sendsBack(verdict) ? {findings: [raw.slice(-REASON_MAX)]} : {}), source: 'text'});
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = LABELLED.exec(lines[i]);
      const verdict = match && normalize(match[1]);
      if (verdict) return withFindings(verdict);
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const verdict = normalize(BARE.exec(lines[i])?.[1]);
      if (verdict) return withFindings(verdict);
    }
    // FINDING lines and no verdict: a blocker or major one sends the work back; minor ones alone do not.
    if (findings.length) return withFindings(findings.some(finding => BLOCKING.test(finding)) ? 'rework' : 'accept');
  }
  return {verdict: 'unreadable', status: status ?? null, excerpt: raw.slice(-1200)};
}
