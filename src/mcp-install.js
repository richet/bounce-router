// Registering bounce's MCP server in an agent's config, the way src/skills.js writes skill directories:
// bounce writes only its own entry, marks it as its own, never touches one it did not write, and can undo it.
// Text in, text out — the file is read and written by the caller (src/cli.js), so this stays testable.
export const MARKER = '# written by bounce (bounce mcp install)';
const HEADER = '[mcp_servers.bounce]';

export const codexEntry = command => `${MARKER}\n${HEADER}\ncommand = "${command}"\nargs = ["mcp-serve"]\n`;

// The span of an existing `[mcp_servers.bounce]` block: from its header (or the marker above it) to the next
// top-level `[`. Returns null when there is none.
function findEntry(text) {
  const lines = text.split('\n');
  const at = lines.findIndex(line => line.trim() === HEADER);
  if (at === -1) return null;
  const start = at > 0 && lines[at - 1].trim() === MARKER ? at - 1 : at;
  let end = at + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith('[')) end++;
  return {start, end, lines, ours: at > 0 && lines[at - 1].trim() === MARKER};
}

export function withCodexEntry(text, command) {
  const found = findEntry(text);
  if (found && !found.ours) return {changed: false, text, reason: 'left alone: not the entry bounce wrote'};
  const entry = codexEntry(command);
  if (!found) {
    const body = text.endsWith('\n') || text === '' ? text : `${text}\n`;
    return {changed: true, text: `${body}${body.endsWith('\n\n') || body === '' ? '' : '\n'}${entry}`};
  }
  // The entry ends in a newline of its own; rebuilding must not eat the file's.
  const kept = [...found.lines.slice(0, found.start), ...entry.replace(/\n$/, '').split('\n'), ...found.lines.slice(found.end)];
  const next = kept.join('\n').replace(/\n*$/, '\n');
  return next === text ? {changed: false, text} : {changed: true, text: next};
}

export function withoutCodexEntry(text) {
  const found = findEntry(text);
  if (!found) return {changed: false, text, reason: 'nothing bounce wrote'};
  if (!found.ours) return {changed: false, text, reason: 'left alone: not the entry bounce wrote'};
  const kept = [...found.lines.slice(0, found.start), ...found.lines.slice(found.end)];
  while (kept.length && kept.at(-1).trim() === '') kept.pop();
  return {changed: true, text: `${kept.join('\n')}\n`};
}
