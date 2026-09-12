// Ollama backend (CONTRACT.md §B2): POST /api/chat, streamed newline-delimited JSON. Wire shape
// per Ollama's own docs; never exercised against a live server in tests — only the fake backend
// and this file's own shape unit test drive it, via an injected `fetchImpl`.

async function* ndjson(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let boundary;
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (line) yield line;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally { try { reader.releaseLock(); } catch { /* stream already closed */ } }
}

export function createOllamaBackend({fetchImpl = globalThis.fetch, base = 'http://127.0.0.1:11434'} = {}) {
  return {
    name: 'ollama',

    async health() {
      try { const response = await fetchImpl(`${base}/api/tags`); return Boolean(response?.ok); } catch { return false; }
    },

    async *generate({model, messages, tools, signal}) {
      const response = await fetchImpl(`${base}/api/chat`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({model, messages, stream: true, ...(tools?.length ? {
          tools: tools.map(t => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.parameters}})),
        } : {})}),
        signal,
      });
      if (!response?.ok || !response.body) throw new Error(`ollama: HTTP ${response?.status ?? 'error'}`);
      let text = '';
      for await (const line of ndjson(response.body)) {
        let payload;
        try { payload = JSON.parse(line); } catch { continue; }
        const content = payload.message?.content;
        if (content) { text += content; yield {kind: 'delta', text: content}; }
        for (const call of payload.message?.tool_calls ?? []) {
          yield {kind: 'tool_call', id: call.id ?? null, name: call.function?.name, arguments: call.function?.arguments ?? {}};
        }
        if (payload.done) {
          const usage = {};
          if (Number.isInteger(payload.prompt_eval_count)) usage.input = payload.prompt_eval_count;
          if (Number.isInteger(payload.eval_count)) usage.output = payload.eval_count;
          if (Object.keys(usage).length) yield {kind: 'usage', usage};
          yield {kind: 'done', text};
          return;
        }
      }
      yield {kind: 'done', text};
    },
  };
}
