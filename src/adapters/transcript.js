// A tool's output belongs in the transcript in the shape a person can read: the command, the head of what
// it printed, and a count of the rest. Found live (2026-09-22): the orchestrator tailed its own journal and
// 143 KB of raw JSON went into the chat, the journal and its own next context packet.
export const TOOL_OUTPUT_MAX = 4000;
// A command is as unbounded as its output was: found live on screen — `bounce publish --event '{…}'` printed
// a task's whole escaped-JSON orders, twice (once starting, once finishing). The head and tail are what say
// what ran; the middle of a 3 KB argument says nothing a person or a model needs.
export const COMMAND_MAX = 200;

// The orchestrator dispatches by shelling `bounce publish --event '<json>'`. Cutting that in the middle
// still leaves escaped JSON on screen, so a bounce call is folded to what it is: the kind, and whose job it
// is. The orders themselves are in the journal, in the worker's pane and in `bounce task <id>`.
// The event is NOT parsed as JSON: a real orchestrator line is quoted inconsistently across shell
// contexts — `{\"kind\":…` at the head and `…,"depends_on":[]}` at the tail of the same command — so
// JSON.parse fails whether or not it is unescaped first. Two fields are all the row needs, and reading
// them tolerates either quoting.
const field = (line, name) => line.match(new RegExp(`\\\\?"${name}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`))?.[1] ?? null;
function bounceEvent(line) {
  if (!/bounce\s+publish\b/.test(line)) return null;
  const kind = field(line, 'kind');
  if (!kind) return null;
  const who = field(line, 'profile') ?? field(line, 'to') ?? field(line, 'task');
  return ['bounce publish', kind, who].filter(Boolean).join(' · ');
}

export function commandLine(command, {max = COMMAND_MAX} = {}) {
  const line = String(command ?? '').split('\n')[0].trim();
  const folded = bounceEvent(line);
  if (folded) return folded;
  if (line.length <= max) return line;
  const head = Math.floor((max - 3) * 0.7), tail = max - 3 - head;
  return `${line.slice(0, head)}…${line.slice(-tail)}`;
}
export function toolText(command, output, {max = TOOL_OUTPUT_MAX} = {}) {
  const body = String(output ?? '');
  const head = command ? `${commandLine(command)}${body ? '\n' : ''}` : '';
  if (body.length <= max) return `${head}${body}`;
  const rest = body.slice(max);
  return `${head}${body.slice(0, max)}\n… +${rest.split('\n').length} more lines (${Math.round(rest.length / 1024)} KB) not shown`;
}
