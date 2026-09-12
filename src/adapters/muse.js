const describe = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');

export default {
  name: 'muse',
  login: ['login'],
  invocation({model, mode, images = []}, promptFile) {
    const imageArgs = images.flatMap(image => ['--image', image.path]);
    const modelArgs = model ? ['--model', model] : [];
    return ['exec', '--json', '--prompt-file', promptFile, ...modelArgs, ...imageArgs,
      ...(mode === 'yolo' ? ['--yolo'] : ['--disable-write', '--disable-shell', '--approval-mode', 'never'])];
  },
  stdin: () => undefined,
  normalize(raw) {
    const events = [];
    const add = (kind, text, extra = {}) => events.push({kind, text: describe(text), ...extra});
    const model = raw.message?.model ?? raw.model ?? raw.payload?.model ?? raw.payload?.model_id;
    if (typeof model === 'string' && model.trim()) events.push({kind: 'model', model});
    const p = raw.payload ?? raw;
    const type = raw.payload_type ?? raw.type ?? '';
    if (type === 'run.output.delta') add('delta', p.text);
    if (type.startsWith('run.terminal.')) {
      const success = p.terminal === 'completed';
      if (!success) add('error', p.reason ?? p);
      add('result', p.text ?? p.reason ?? p.terminal, {success});
    }
    if (type === 'task.lifecycle.side_effect_intent') {
      // Model inference is internal chatter: run.output.delta carries the response,
      // so it leaves no transcript trace. A tool start becomes live progress (never
      // journaled), mirroring Codex command starts; the journaled record is the
      // tool.result below. The intent carries no arguments, so a bare operation
      // name as a Tool output block would say nothing the result does not.
      const operation = p.event?.operation ?? '';
      if (operation.startsWith('model.')) { /* internal, no event */ }
      else if (operation) add('progress', `Running · ${operation.replace(/^tool[:.]/, '') || operation}`);
    }
    // task.lifecycle.output chunks duplicate tool.result verbatim, so only the
    // assembled result is journaled. A failed tool call stays journaled content,
    // not a turn error: the agent may recover, as with Claude tool results.
    if (type === 'tool.result') {
      const name = p.correlation_facts?.tool_name;
      const text = typeof p.text === 'string' ? p.text : describe(p.text);
      add('tool', name ? `${name}\n${text}` : text);
    }
    if (type.endsWith('.failed') || type === 'error') add('error', p);
    // Captured for resume/checkpoint, only on lifecycle lines: run_id rides on every
    // streamed delta, so firing on those would journal one row per token.
    if (type === 'run.started' || type === 'run.model.configured' || type.startsWith('run.terminal.')) {
      const sessionId = p.session_id ?? p.thread_id ?? p.run_id;
      if (typeof sessionId === 'string' && sessionId) events.push({kind: 'peer.native', provider: 'muse', sessionId});
    }
    return events;
  },
  // resume:false means re-launch with a checkpoint, not native continuation, and
  // live:false means no verified mid-turn delivery — `serve` is unprobed here, so
  // the honest delivery tier is `queued`. See src/adapters/muse-live.js.
  capabilities: () => ({live: false, resume: false, modelPin: true, policies: ['yolo', 'plan'], quota: 'none'}),
  catalog: {
    args: ['serve'],
    requests: [
      {jsonrpc: '2.0', id: 1, method: 'initialize', params: {clientInfo: {name: 'bounce', version: '0.1.0'}}},
      {jsonrpc: '2.0', method: 'initialized'},
      {jsonrpc: '2.0', id: 2, method: 'model/list', params: {}},
    ],
    read(raw, out) {
      if (raw.id !== 2) return false;
      const result = raw.result ?? {};
      out.account = result.profileId ? `${result.providerId}/${result.profileId}` : result.providerId ?? null;
      out.models = (result.models ?? []).map(m => ({id: m.modelId, label: m.displayLabel || m.modelId, description: m.description || ''}));
      return true;
    },
  },
};
