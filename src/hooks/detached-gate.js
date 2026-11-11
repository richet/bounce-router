#!/usr/bin/env node
// A Claude Code PreToolUse hook for the orchestrator: a gate or check started in the background (run_in_background,
// nohup, setsid, a trailing &) runs where bounce cannot see it, and nothing wakes the orchestrator when it ends.
// Found live: an integration gate run detached failed, and the orchestrator sat idle with it red until a person
// noticed. Such a command is refused with what to do instead; a gate in the foreground (an orchestrator that verifies
// itself) and every other command pass. Exit 2 is Claude Code's "block, and show stderr to the model".
import {fileURLToPath} from 'node:url';

const GATE = /(^|[\s;&|("'`])(\w[\w.-]*\s+run\s+([\w.=-]+\s+){0,3}[\w:.-]*(test|lint|e2e|check|spec|gate)|(npm|pnpm|bun)\s+(run\s+)?(test|lint|e2e|check|verify)\b|yarn\s+(run\s+)?(test|lint|e2e|check)\b|npx\s+(jest|vitest|playwright|mocha|cypress)\b|node\s+--test\b|(pytest|rspec|phpunit|tox)\b|bundle\s+exec\s+(rspec|rake\s+test)\b|go\s+test\b|cargo\s+(test|clippy)\b|make\s+(test|check|lint|e2e|ci|gate)\b|playwright\s+test\b|\S*(check|gate|e2e|integration|ci)[-\w]*\.sh\b)/i;
const DETACHED = /(^|[\s;&|(])(nohup|setsid|disown|systemd-run|daemonize)\b|(^|[\s;(])(tmux\s+new(-session)?\b.*\s-d\b|screen\s+-d)|(^|[^&>|])&(?![&>])/;  // a lone & (not &&, &>, 2>&1 or |&)

export const REFUSAL = 'bounce refused this: a gate or check started in the background runs outside bounce, so nobody sees it and nothing wakes you when it ends. Run it as a check-only task instead: submit with at (the branch or commit), check (this command) and checkTimeoutMinutes (up to 120). bounce runs it under the gate slots and wakes you with the result.';

export function detachedGate(input) {
  if (input?.tool_name !== 'Bash') return null;
  const command = String(input.tool_input?.command ?? '');
  if (!GATE.test(command)) return null;
  return input.tool_input?.run_in_background === true || DETACHED.test(command) ? REFUSAL : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let text = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { text += chunk; });
  process.stdin.on('end', () => {
    let input = null;
    try { input = JSON.parse(text); } catch { process.exit(0); }
    const refusal = detachedGate(input);
    if (!refusal) process.exit(0);
    process.stderr.write(refusal);
    process.exit(2);
  });
}
