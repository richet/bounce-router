// What both OpenCode adapters share: the tools map a policy tier becomes, the token mapping, and the
// 2.x config shape. Kept
// apart from opencode-live.js because the classic adapter (opencode.js) is loaded through providers.js,
// which the live adapters import — a direct import closed that cycle at load.

// The policy tier becomes the agent's tools map — the same ladder the vendor CLIs get as flags.
// A read-only or plan worker has no tool that can change anything; write/yolo edit and run
// commands in the real tree, exactly as a claude or codex yolo worker does.
export const READ_TOOLS = ['read', 'grep', 'glob'];
export const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'bash'];
// No todo list either: it gave a stuck model something to do forever instead of answering.
export const NEVER_TOOLS = ['todowrite', 'task', 'websearch', 'webfetch', 'skill', 'question', 'invalid'];
export function toolsFor(policy) {
  const writes = policy === 'write' || policy === 'yolo';
  return Object.fromEntries([...READ_TOOLS.map(tool => [tool, true]), ...WRITE_TOOLS.map(tool => [tool, writes]), ...NEVER_TOOLS.map(tool => [tool, false])]);
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

// opencode 2.x reads the 1.x config through a migration, but three things only its own shape says
// (2.0.29 source): its LM Studio plugin rediscovers a provider named lmstudio and replaces the models
// we declare (tools off unless the model says so), so it is removed; an MCP server defaults to code
// mode, which hides bounce_report inside a generic `execute` tool; and the output cap goes out as
// max_completion_tokens beside our max_tokens unless the provider names max_tokens as its field. So
// bounce builds one config (1.x shape, src/local-opencode-config.js and opencode-live.js start()) and this turns
// it into 2.x's: providers/settings/body, agents/system/steps/permissions, mcp.servers.
const NATIVE_PROVIDER = '@opencode/ai/providers/openai-compatible';
// 1.x tool → the 2.x permission it is governed by; a tool with no 2.x counterpart has no entry.
const ACTION = {read: 'read', grep: 'grep', glob: 'glob', write: 'edit', edit: 'edit', apply_patch: 'edit', bash: 'shell',
  task: 'subagent', websearch: 'websearch', webfetch: 'webfetch', skill: 'skill', question: 'question'};
// The 2.x tools each action hides, so a denied action leaves no tool of that kind (write and patch
// are checked as edit, and denying the names too keeps that true if a release splits them).
const ACTION_TOOLS = {edit: ['edit', 'write', 'patch']};
const rule = (action, effect) => ({action, resource: '*', effect});

export function nativeConfig(config = {}) {
  const native = {...(config.$schema ? {$schema: config.$schema} : {}),
    // Not the user's Claude Code setup (~/.claude, ~/.agents skills): 1.x was told so by env vars 2.x
    // no longer reads. Not the LM Studio discovery that would replace the models declared here.
    plugins: ['-opencode.provider.lmstudio', '-opencode.config.compatibility']};
  native.providers = Object.fromEntries(Object.entries(config.provider ?? {}).map(([id, provider]) => [id, {
    name: provider.name ?? id, package: NATIVE_PROVIDER, settings: {...(provider.options ?? {})},
    compatibility: {maxTokensField: 'max_tokens'},
    models: Object.fromEntries(Object.entries(provider.models ?? {}).map(([modelID, model]) => {
      // Every option is a field of the request body, verbatim, except the SDK's reasoningEffort,
      // which the body names reasoning_effort (src/local-opencode-config.js samplingOptions).
      const {reasoningEffort, ...fields} = model.options ?? {};
      const body = {...fields, ...(reasoningEffort !== undefined ? {reasoning_effort: reasoningEffort} : {})};
      return [modelID, {name: model.name ?? modelID, capabilities: {tools: true}, ...(model.limit ? {limit: model.limit} : {}),
        ...(Object.keys(body).length ? {body} : {})}];
    })),
  }]));
  native.permissions = Object.entries(config.permission ?? {}).map(([action, effect]) => rule(action, effect));
  native.mcp = {servers: Object.fromEntries(Object.entries(config.mcp ?? {}).map(([id, server]) => [id, {
    type: server.type, command: server.command, environment: server.environment ?? {}, disabled: server.enabled === false, codemode: false}]))};
  native.agents = Object.fromEntries(Object.entries(config.agent ?? {}).map(([id, agent]) => {
    const allowed = new Map();
    for (const [tool, on] of Object.entries(agent.tools ?? {})) {
      const action = ACTION[tool] ?? (tool.startsWith('bounce_') ? tool : null);
      if (action) allowed.set(action, (allowed.get(action) ?? false) || on);
    }
    // Only denials: everything is allowed by default, and an explicit allow would also override
    // opencode's own ask before a .env edit. Code mode (`execute`) is a second way into every tool;
    // a 1.x worker never had it.
    const permissions = [rule('execute', 'deny'), ...[...allowed].filter(([, on]) => !on)
      .flatMap(([action]) => (ACTION_TOOLS[action] ?? [action]).map(name => rule(name, 'deny')))];
    return [id, {description: agent.description, mode: agent.mode, ...(agent.prompt ? {system: agent.prompt} : {}),
      ...(agent.maxSteps ? {steps: agent.maxSteps} : {}), permissions}];
  }));
  return native;
}
