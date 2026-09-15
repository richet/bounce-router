// The input lane is deliberately independent from terminal completion and command execution:
// callers classify before considering whether a main model turn is already busy.
export const commandCatalog = {
  immediate: ['provider', 'model', 'local', 'order', 'mode', 'note', 'btw', 'rename', 'sessions', 'skills', 'review', 'quota', 'retry', 'operation', 'stop', 'msg', 'agents', 'tasks', 'help', 'detach', 'details'],
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

export function inputDisposition(text, {busy}) {
  const input = classifyInput(text);
  const action = input.kind === 'prompt' || input.kind === 'turn'
    ? busy ? 'queue-turn' : 'run-turn'
    : 'run-command';
  return {...input, action};
}
