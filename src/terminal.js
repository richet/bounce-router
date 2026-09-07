export const commands = [
  ['provider', 'Select default agent'], ['model', 'Select model'], ['order', 'Set fallback order'],
  ['mode', 'Set yolo or plan mode'], ['login', 'Sign in to an agent'], ['new', 'Start new session'],
  ['note', 'Save handoff note'], ['retry', 'Clear quota cooldowns'], ['restart', 'Validate and reload'],
  ['help', 'Show help'], ['quit', 'Exit localrouter'],
];
export function completions(input) {
  if (!/^\/\S*$/.test(input)) return [];
  return commands.filter(([name]) => name.startsWith(input.slice(1)));
}
// Update only changed rows. An unchanged frame produces no terminal writes.
export function frameDiff(previous, next) {
  let output = '';
  for (let i = 0; i < Math.max(previous.length, next.length); i++) {
    if (previous[i] !== next[i]) output += `\x1b[${i + 1};1H\x1b[2K${next[i] || ''}`;
  }
  return output;
}
