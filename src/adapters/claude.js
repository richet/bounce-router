const describe = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
// Tool results arrive as content blocks; show their text rather than a JSON dump.
const foregroundTasks = new Set();
const contentText = value => Array.isArray(value)
  ? value.map(part => part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : describe(part)).join('\n')
  : describe(value);

export default {
  name: 'claude',
  login: ['auth', 'login'],
  invocation({model, mode, images = []}) {
    const imageArgs = images.length ? ['--input-format', 'stream-json'] : [];
    const modelArgs = model ? ['--model', model] : [];
    return ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs, ...imageArgs,
      ...(mode === 'yolo' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'plan'])];
  },
  stdin: prompt => prompt,
  normalize(raw) {
    const events = [];
    const add = (kind, text, extra = {}) => events.push({kind, text: describe(text), ...extra});
    const model = raw.message?.model ?? raw.model ?? raw.payload?.model ?? raw.payload?.model_id;
    if (typeof model === 'string' && model.trim()) events.push({kind: 'model', model});
    if (raw.type === 'assistant') for (const block of raw.message?.content ?? []) {
      if (block.type === 'text') add('assistant', block.text);
      if (block.type === 'tool_use') add('tool', `${block.name}: ${describe(block.input)}`);
    }
    if (raw.type === 'user') for (const block of raw.message?.content ?? []) {
      if (block.type === 'tool_result') add('tool', contentText(block.content));
    }
    if (raw.type === 'result') {
      if (raw.is_error) add('error', raw.errors ?? raw.result ?? raw.subtype);
      add('usage', raw.usage ?? {}, {usage: raw.usage});
      add('result', raw.result ?? raw.subtype, {success: !raw.is_error});
    }
    if (raw.type === 'rate_limit_event' && raw.rate_limit_info?.status === 'rejected') add('error', 'usage limit: ' + describe(raw.rate_limit_info));
    // Claude reports thinking token counts every few tokens. They are live progress,
    // not transcript: journaling them buries the conversation in "Activity" blocks.
    if (raw.type === 'system') {
      if (raw.subtype === 'thinking_tokens') add('progress', `Thinking · ~${raw.estimated_tokens ?? 0} tokens`);
      else if (raw.subtype === 'init') add('progress', `Ready · ${(raw.tools ?? []).length} tools`);
      else if (raw.subtype === 'task_started') {
        const foreground = raw.task_type === 'local_bash' && !raw.is_backgrounded && typeof raw.task_id === 'string';
        if (foreground) foregroundTasks.add(raw.task_id);
        add(foreground ? 'progress' : 'status', `Task started · ${describe(raw.description ?? raw.task_id ?? '')}`);
      } else if (raw.subtype === 'task_notification') {
        const foreground = foregroundTasks.delete(raw.task_id);
        add(foreground ? 'progress' : 'status', `Task ${describe(raw.status ?? 'update')} · ${describe(raw.summary ?? raw.task_id ?? '')}`);
      }
      else add('status', raw.subtype ?? 'system');
    }
    if (raw.type === 'tool_progress') add('progress', `${describe(raw.tool_name ?? 'Tool')} · ${raw.elapsed_time_seconds ?? 0}s`);
    // Captured for resume (--resume <session_id>). claude carries session_id on EVERY
    // message, so this only fires on init/result — never per assistant/tool line.
    if ((raw.type === 'system' && raw.subtype === 'init') || raw.type === 'result') {
      if (typeof raw.session_id === 'string' && raw.session_id) events.push({kind: 'peer.native', provider: 'claude', sessionId: raw.session_id});
    }
    return events;
  },
  catalog: {
    args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    requests: [{type: 'control_request', request_id: 'bounce-models', request: {subtype: 'initialize'}}],
    read(raw, out) {
      if (raw.type !== 'control_response' || raw.response?.request_id !== 'bounce-models') return false;
      const result = raw.response.response ?? {};
      out.account = result.account?.email ?? null;
      out.models = (result.models ?? []).map(m => ({id: m.value, label: m.displayName || m.value, description: m.description || m.resolvedModel || ''}));
      return true;
    },
  },
};
