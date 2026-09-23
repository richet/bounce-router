// A tool's output belongs in the transcript in the shape a person can read: the command, the head of what
// it printed, and a count of the rest. Found live (2026-09-22): the orchestrator tailed its own journal and
// 143 KB of raw JSON went into the chat, the journal and its own next context packet.
export const TOOL_OUTPUT_MAX = 4000;
export function toolText(command, output, {max = TOOL_OUTPUT_MAX} = {}) {
  const head = command ? `${command}\n` : '';
  const body = String(output ?? '');
  if (body.length <= max) return `${head}${body}`;
  const rest = body.slice(max);
  return `${head}${body.slice(0, max)}\n… +${rest.split('\n').length} more lines (${Math.round(rest.length / 1024)} KB) not shown`;
}
