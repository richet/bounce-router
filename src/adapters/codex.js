import {toolText} from './transcript.js';

const describe = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');

export default {
  name: 'codex',
  login: ['login'],
  invocation({model, mode, images = []}) {
    const imageArgs = images.flatMap(image => ['--image', image.path]);
    const modelArgs = model ? ['--model', model] : [];
    return ['exec', '--json', '--skip-git-repo-check', ...modelArgs, ...imageArgs,
      ...(mode === 'yolo' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']), '-'];
  },
  stdin: prompt => prompt,
  normalize(message) {
    // `codex exec` names a row `type: 'turn.completed'`; the app-server peer sends the same
    // payload as a notification `method: 'turn/completed'`. One protocol, two spellings.
    const raw = message.type === undefined && typeof message.method === 'string' ? {...message.params, type: message.method.replace('/', '.')} : message;
    const events = [];
    const add = (kind, text, extra = {}) => events.push({kind, text: describe(text), ...extra});
    const model = raw.message?.model ?? raw.model ?? raw.payload?.model ?? raw.payload?.model_id;
    if (typeof model === 'string' && model.trim()) events.push({kind: 'model', model});
    // codex-cli 0.154's app-server names items in camelCase (`agentMessage`, `commandExecution`);
    // `codex exec --json` and older servers use snake_case. Normalise once so both read the same —
    // the assistant's answer was being dropped (result read "turn completed") on the camelCase server.
    const item = raw.item && typeof raw.item.type === 'string' ? {...raw.item, type: raw.item.type.replace(/[A-Z]/g, ch => `_${ch.toLowerCase()}`)} : raw.item;
    if (raw.type === 'item.completed' && item) {
      if (item.type === 'agent_message') add('assistant', item.text);
      else if (item.type === 'user_message') { /* the orders echoed back: not a tool row */ }
      else if (item.type === 'dynamic_tool_call') add('tool', `${item.tool ?? 'Tool'} · ${item.success === true ? 'accepted' : item.success === false ? 'rejected' : item.status ?? 'completed'}`);
      else if (item.type !== 'reasoning') add('tool', item.command ? toolText(item.command, item.aggregatedOutput ?? item.aggregated_output ?? '') : item);
    }
    if (raw.type === 'item.started' && item?.command) add('progress', `Running · ${describe(item.command).split('\n')[0]}`);
    if (raw.type === 'error' || raw.type === 'turn.failed') add('error', raw.error?.message ?? raw.message ?? raw.error ?? raw);
    if (raw.type === 'turn.completed') {
      add('usage', raw.usage, {usage: raw.usage});
      add('result', 'Turn completed', {success: true});
    }
    // Captured for resume (exec resume); reported once per thread/session start.
    if (raw.type === 'session.started' || raw.type === 'thread.started') {
      const sessionId = raw.thread_id ?? raw.session_id ?? raw.id;
      if (typeof sessionId === 'string' && sessionId) events.push({kind: 'peer.native', provider: 'codex', sessionId});
    }
    return events;
  },
  catalog: {
    args: ['app-server'],
    requests: [
      {id: 1, method: 'initialize', params: {clientInfo: {name: 'bounce', version: '0.1.0'}}},
      {method: 'initialized'},
      {id: 2, method: 'account/read', params: {}},
      {id: 3, method: 'model/list', params: {}},
    ],
    read(raw, out) {
      if (raw.id === 2) out.account = raw.result?.account?.email ?? null;
      if (raw.id === 3) out.models = (raw.result?.data ?? []).filter(m => !m.hidden)
        .map(m => ({id: m.id ?? m.model, label: m.displayName || m.id || m.model, description: m.description || ''}));
      return out.models !== undefined && out.account !== undefined;
    },
  },
};
