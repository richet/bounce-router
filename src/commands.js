// The input lane is deliberately independent from terminal completion and command execution:
// callers classify before considering whether a main model turn is already busy.
export const commandCatalog = {
  immediate: ['provider', 'model', 'local', 'order', 'mode', 'note', 'btw', 'rename', 'sessions', 'skills', 'review', 'quota', 'retry', 'operation', 'stop', 'msg', 'agents', 'tasks', 'help', 'detach', 'details', 'sidebar'],
  turn: ['continue'],
  lifecycle: ['login', 'new', 'resume', 'update', 'restart', 'quit'],
};

const kinds = new Map(Object.entries(commandCatalog).flatMap(([kind, commands]) => commands.map(command => [command, kind])));

export function classifyInput(text) {
  if (!text.startsWith('/')) return {kind: 'prompt', text};
  const [rawCommand = '', ...parts] = text.slice(1).trim().split(/\s+/).filter(Boolean);
  const command = rawCommand.toLowerCase();
  const kind = kinds.get(command);
  return {kind: kind ?? 'immediate', command, parts, arg: parts.join(' '), ...(kind ? {} : {unknown: true})};
}

// `vendorCommand(name)` says whether an agent owns a /name bounce does not: such a line is a
// turn to expand (see vendor-commands.js), not a typo. bounce's own commands are matched first.
export function inputDisposition(text, {busy, vendorCommand = () => false}) {
  let input = classifyInput(text);
  if (input.unknown && vendorCommand(input.command)) input = {kind: 'prompt', text, vendor: input.command};
  const action = input.kind === 'prompt' || input.kind === 'turn'
    ? busy ? 'queue-turn' : 'run-turn'
    : 'run-command';
  return {...input, action};
}
