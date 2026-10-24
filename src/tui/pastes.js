// A large paste is shown in the draft as one placeholder and sent in full (docs/plans/interactive-polish.md step 4):
// three hundred pasted lines would otherwise push the conversation off the screen while you type around them.
const LINES = 20;
const CHARS = 2000;
const TOKEN = /\[Pasted text #(\d+) · \d+ (?:lines|chars)\]/g;

export function collapsePaste(text, pastes) {
  const lines = text.replace(/\n$/, '').split('\n').length; // a trailing newline ends the last line, it is not one more
  if (lines <= LINES && text.length <= CHARS) return text;
  const id = pastes.size + 1;
  pastes.set(id, text);
  return lines > LINES ? `[Pasted text #${id} · ${lines} lines]` : `[Pasted text #${id} · ${text.length} chars]`;
}

export function expandPastes(input, pastes) {
  return input.replace(TOKEN, (token, id) => pastes.get(Number(id)) ?? token);
}
