// LM Studio backend (CONTRACT.md §B2): OpenAI-compatible chat completions, streamed SSE.
// Wire shape per LM Studio's own docs; never exercised against a live server in tests — only
// the fake backend and this file's own shape unit test drive it, via an injected `fetchImpl`.

async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data:')) yield trimmed.slice(5).trim();
        }
      }
    }
  } finally { try { reader.releaseLock(); } catch { /* stream already closed */ } }
}

export function createLmStudioBackend({fetchImpl = globalThis.fetch, base = 'http://127.0.0.1:1234'} = {}) {
  return {
    name: 'lmstudio',

    async health() {
      try { const response = await fetchImpl(`${base}/v1/models`); return Boolean(response?.ok); } catch { return false; }
    },

    async *generate({model, messages, tools, signal}) {
      const response = await fetchImpl(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({model, messages, stream: true, ...(tools?.length ? {
          tools: tools.map(t => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.parameters}})),
        } : {})}),
        signal,
      });
      if (!response?.ok || !response.body) throw new Error(`lmstudio: HTTP ${response?.status ?? 'error'}`);
      const toolCalls = new Map(); // OpenAI streams tool-call argument fragments by index
      let text = '';
      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') break;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        const choice = payload.choices?.[0];
        if (choice?.delta?.content) { text += choice.delta.content; yield {kind: 'delta', text: choice.delta.content}; }
        for (const call of choice?.delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const existing = toolCalls.get(index) ?? {id: null, name: null, arguments: ''};
          if (call.id) existing.id = call.id;
          if (call.function?.name) existing.name = call.function.name;
          if (call.function?.arguments) existing.arguments += call.function.arguments;
          toolCalls.set(index, existing);
        }
        if (payload.usage) {
          const usage = {};
          if (Number.isInteger(payload.usage.prompt_tokens)) usage.input = payload.usage.prompt_tokens;
          if (Number.isInteger(payload.usage.completion_tokens)) usage.output = payload.usage.completion_tokens;
          yield {kind: 'usage', usage};
        }
        if (choice?.finish_reason === 'tool_calls') {
          for (const call of toolCalls.values()) {
            let args;
            try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = {raw: call.arguments}; }
            yield {kind: 'tool_call', id: call.id, name: call.name, arguments: args};
          }
          return;
        }
      }
      yield {kind: 'done', text};
    },
  };
}
