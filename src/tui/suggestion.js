// The main worker's stated next step, turned into a prompt the user could send. Claude Code
// fashion: it is prefilled dim in the input, Tab accepts it, typing replaces it, and it is never
// sent on its own. Only a single, concrete next action qualifies — an open question is for the user
// to answer, a numbered list is a plan, not a prompt.
const MAX = 300;
const LEAD = /(?:^|\n|[.!]\s+)\s*(?:\*\*)?(?:next(?: step| agent| action)?|then|to continue|recommended next step)(?:\*\*)?\s*:\s*(?:\*\*)?\s*([^\n]+)/i;
const OFFER = /(?:^|\n)\s*(?:should i|do you want me to|shall i|want me to|would you like me to)\s+([^\n?]+)\?/i;
const clean = text => String(text ?? '').replace(/\*\*/g, '').replace(/[`]/g, '').replace(/\s+/g, ' ').trim();
const capitalise = text => text ? text[0].toUpperCase() + text.slice(1) : text;

export function suggestionFrom(answer) {
  const text = String(answer ?? '');
  if (!text.trim()) return null;
  // a numbered or bulleted list right after "next" is a plan, not one action
  if (/next(?: steps?)?\s*:\s*\n\s*(?:\d+[.)]|[-*])/i.test(text)) return null;
  const lead = LEAD.exec(text);
  let step = lead ? clean(lead[1]) : null;
  if (!step) {
    const offer = OFFER.exec(text);
    if (offer) step = clean(offer[1]);
  }
  if (!step) return null;
  step = step.replace(/^(?:i(?:'ll| will| would| can)|we(?:'ll| will| can))\s+/i, '');
  if (step.length < 8 || step.length > MAX) return null;
  if (/\?$/.test(step) || /^(which|what|where|how|why|who)\b/i.test(step)) return null; // an open question
  return capitalise(step);
}
