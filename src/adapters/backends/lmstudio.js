// Strict, bounded LM Studio OpenAI-compatible SSE transport.
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 1_000_000;
const MAX_FRAMES = 2_000;
const MAX_CALLS = 64;
const MAX_FIELD = 64_000;

const protocol = message => Object.assign(new Error(`lmstudio: ${message}`), {code: 'LMSTUDIO_PROTOCOL'});

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, {once: true});
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function requestScope(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  const timer = setTimeout(() => controller.abort(new Error('LM Studio request timed out')), timeoutMs);
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

async function* sseData(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frames = 0;
  const abort = () => reader.cancel(signal.reason).catch(() => {});
  signal?.addEventListener('abort', abort, {once: true});
  try {
    for (;;) {
      const {value, done} = await abortable(reader.read(), signal);
      if (done) break;
      // A CR at the end of a chunk is retained until the following byte arrives.
      buffer += decoder.decode(value, {stream: true});
      if (buffer.length > MAX_BUFFER) throw protocol('SSE buffer limit exceeded');
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const separator = buffer.match(/^([\s\S]*?)(\r?\n\r?\n)/);
        const frame = separator[1];
        buffer = buffer.slice(separator[0].length);
        if (++frames > MAX_FRAMES) throw protocol('SSE frame limit exceeded');
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) throw protocol('premature EOF in SSE frame');
  } finally {
    signal?.removeEventListener('abort', abort);
    try { reader.cancel().catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

function headers(apiKey) {
  return apiKey ? {authorization: `Bearer ${apiKey}`} : {};
}

export function createLmStudioBackend({fetchImpl = globalThis.fetch, base = 'http://127.0.0.1:1234', apiKey, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  const endpoint = base.replace(/\/$/, '');
  const auth = headers(apiKey);

  async function fetchWithScope(url, options, scope) {
    const pending = Promise.resolve(fetchImpl(url, {...options, redirect: 'manual', signal: scope.signal}));
    pending.then(response => {if (scope.signal.aborted) response?.body?.cancel().catch(() => {});}, () => {});
    return abortable(pending, scope.signal);
  }

  return {
    name: 'lmstudio',

    async health({signal} = {}) {
      const scope = requestScope(signal, timeoutMs);
      try {
        const response = await fetchWithScope(`${endpoint}/v1/models`, {method: 'GET', headers: auth}, scope);
        return Boolean(response?.ok);
      } catch {
        return false;
      } finally {
        scope.close();
      }
    },

    async *generate({model, messages, tools, maxTokens, signal}) {
      const scope = requestScope(signal, timeoutMs);
      let serverFinished = false;
      try {
        const response = await fetchWithScope(`${endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: {'content-type': 'application/json', ...auth},
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            ...(Number.isInteger(maxTokens) ? {max_tokens: maxTokens} : {}),
            ...(tools?.length ? {tools: tools.map(tool => ({
              type: 'function',
              function: {name: tool.name, description: tool.description, parameters: tool.parameters},
            }))} : {}),
          }),
        }, scope);
        if (!response?.ok || !response.body) throw Object.assign(new Error(`lmstudio: HTTP ${response?.status ?? 'error'}`), {code: 'LMSTUDIO_HTTP', inferenceVerified: response?.status >= 400 && response?.status < 500});

        const calls = new Map();
        let text = '';
        let terminal = false;
        for await (const data of sseData(response.body, scope.signal)) {
          if (data === '[DONE]') {
            serverFinished = true;
            terminal = true;
            break;
          }
          let payload;
          try { payload = JSON.parse(data); } catch { throw protocol('invalid SSE JSON'); }
          const choice = payload.choices?.[0];
          const content = choice?.delta?.content;
          if (typeof content === 'string') {
            text += content;
            if (text.length > MAX_BUFFER) throw protocol('text limit exceeded');
            yield {kind: 'delta', text: content};
          }
          for (const fragment of choice?.delta?.tool_calls ?? []) {
            if (!Number.isInteger(fragment.index) || fragment.index < 0) throw protocol('tool call has no valid index');
            if (!calls.has(fragment.index) && calls.size >= MAX_CALLS) throw protocol('tool call limit exceeded');
            const call = calls.get(fragment.index) ?? {id: '', name: '', arguments: ''};
            if (fragment.id) call.id = fragment.id;
            if (fragment.function?.name) call.name = fragment.function.name;
            if (typeof fragment.function?.arguments === 'string') call.arguments += fragment.function.arguments;
            if (call.id.length > MAX_FIELD || call.name.length > MAX_FIELD || call.arguments.length > MAX_FIELD) throw protocol('tool call field limit exceeded');
            calls.set(fragment.index, call);
          }
          if (payload.usage) {
            const usage = {};
            if (Number.isInteger(payload.usage.prompt_tokens)) usage.input = payload.usage.prompt_tokens;
            if (Number.isInteger(payload.usage.completion_tokens)) usage.output = payload.usage.completion_tokens;
            if (Object.keys(usage).length) yield {kind: 'usage', usage};
          }
          if (choice?.finish_reason) {
            serverFinished = true;
            if (choice.finish_reason !== 'tool_calls' && choice.finish_reason !== 'stop') throw protocol(`terminal finish_reason ${choice.finish_reason}`);
            if (choice.finish_reason === 'tool_calls') {
              if (!calls.size) throw protocol('tool_calls finish without calls');
              for (const call of [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value)) {
                if (!call.id || !call.name) throw protocol('incomplete tool call');
                let arguments_;
                try { arguments_ = JSON.parse(call.arguments || '{}'); } catch { throw protocol(`malformed arguments for ${call.id}`); }
                if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) throw protocol(`invalid arguments for ${call.id}`);
                yield {kind: 'tool_call', id: call.id, name: call.name, arguments: arguments_};
              }
              return;
            }
            terminal = true;
          }
        }
        if (!terminal) throw protocol('premature EOF before terminal event');
        if (calls.size) throw protocol('incomplete tool calls at terminal event');
        yield {kind: 'done', text};
      } catch (error) {
        if (serverFinished) error.inferenceVerified = true;
        throw error;
      } finally {
        scope.close();
      }
    },
  };
}
