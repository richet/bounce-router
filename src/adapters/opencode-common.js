// What both OpenCode adapters share: the tools map a policy tier becomes, and the token mapping. Kept
// apart from opencode-live.js because the classic adapter (opencode.js) is loaded through providers.js,
// which the live adapters import — a direct import closed that cycle at load.

// The policy tier becomes the agent's tools map — the same ladder the vendor CLIs get as flags.
// A read-only or plan worker has no tool that can change anything; write/yolo edit and run
// commands in the real tree, exactly as a claude or codex yolo worker does.
export const READ_TOOLS = ['read', 'grep', 'glob'];
export const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'bash'];
// No todo list either: it gave a stuck model something to do forever instead of answering.
export const NEVER_TOOLS = ['todowrite', 'task', 'websearch', 'webfetch', 'skill', 'question', 'invalid'];
// A probe worker reads and runs commands (bash) but gets no editing tool; the sandbox in
// opencode-live.js makes sure bash cannot write the project either.
export function toolsFor(policy) {
  const writes = policy === 'write' || policy === 'yolo';
  return Object.fromEntries([...READ_TOOLS.map(tool => [tool, true]), ...WRITE_TOOLS.map(tool => [tool, writes || (policy === 'probe' && tool === 'bash')]), ...NEVER_TOOLS.map(tool => [tool, false])]);
}

// CONTRACT §5: {input, cache_read, cache_write, output}, integers only, absent keys absent.
export const mapUsage = raw => {
  const usage = {};
  if (Number.isInteger(raw?.input)) usage.input = raw.input;
  if (Number.isInteger(raw?.cache?.read)) usage.cache_read = raw.cache.read;
  if (Number.isInteger(raw?.cache?.write)) usage.cache_write = raw.cache.write;
  if (Number.isInteger(raw?.output)) usage.output = raw.output;
  return usage;
};
