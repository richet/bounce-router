import {spawn as spawnProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {mapUsage} from './adapters/opencode-common.js';

// opencode 2.x's own server, private to one turn: workers start it so their report tool is connected before the
// turn's first step (opencode-live.js), and classic turns start it to hear the answer as it is written (below).
const SERVER_READY_MS = 30_000;

export async function serveForTurn({executable, cwd, env, spawn = spawnProcess, fetchImpl = fetch, readyMs = SERVER_READY_MS, mcpMs = 0}) {
  const password = randomUUID();
  const server = spawn(executable, ['serve', '--stdio', '--port', '0'], {cwd, env: {...env, OPENCODE_PASSWORD: password}, stdio: ['pipe', 'pipe', 'pipe']});
  server.stderr?.resume();
  server.stdin?.on('error', () => {});
  // The server lives until its stdin closes (and so dies with bounce); a server that ignores that is killed.
  const stop = () => {
    try { server.stdin?.end(); } catch {}
    const timer = setTimeout(() => { try { server.kill('SIGKILL'); } catch {} }, 3000);
    timer.unref?.(); server.once('exit', () => clearTimeout(timer));
  };
  try {
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`opencode serve gave no address within ${readyMs} ms`)), readyMs);
      server.once('error', error => { clearTimeout(timer); reject(error); });
      server.once('exit', code => { clearTimeout(timer); reject(new Error(`opencode serve exited ${code} before it was ready`)); });
      createInterface({input: server.stdout}).once('line', line => {
        clearTimeout(timer);
        try { resolve(JSON.parse(line).url); } catch { reject(new Error(`opencode serve printed ${line.slice(0, 200)} instead of its address`)); }
      });
    });
    // The first request boots this directory's location, which starts its MCP servers.
    const headers = {authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`};
    const started = Date.now();
    let state = 'pending';
    while (state === 'pending' && Date.now() - started < mcpMs) {
      const listed = await fetchImpl(`${url}/api/mcp?location[directory]=${encodeURIComponent(cwd)}`, {headers}).then(res => res.ok ? res.json() : null).catch(() => null);
      state = listed?.data?.find(item => item.name === 'bounce')?.status?.status ?? 'pending';
      if (state === 'pending') await new Promise(resolve => setTimeout(resolve, 100));
    }
    const notice = state === 'connected' ? null : `bounce_report was ${state} after ${Date.now() - started} ms: the turn runs without it`;
    return {url, password, stop, notice};
  } catch (error) {
    stop();
    throw Object.assign(new Error(`opencode server did not start: ${error.message}`), {code: 'backend_unavailable'});
  }
}

// The server's event stream: `data:` lines of server-sent events, each a JSON event.
export async function readEventStream(body, onEvent) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, {stream: true});
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      try { onEvent(JSON.parse(data)); } catch {}
    }
  }
}

// What a classic turn shows from the server (measured on 2.0.29 with a local model that thinks: 71 reasoning
// fragments over 7.5 s before the first word): the answer as `delta` rows, the thinking as a `Thinking · ~N tokens`
// counter (as claude's), and the finished text as the block's one `assistant` row.
const CHARS_PER_TOKEN = 4;
const THINKING_STEP = 25;
export function createServerRows() {
  let thinking = 0, shown = 0;
  return event => {
    const data = event?.data ?? {};
    if (event?.type === 'session.text.delta' && typeof data.delta === 'string' && data.delta) return [{kind: 'delta', text: data.delta}];
    if (event?.type === 'session.text.ended' && typeof data.text === 'string') return [{kind: 'assistant', text: data.text}];
    // run --server prints no step_finish: the step's tokens come from here (CONTRACT §5: thinking beside usage).
    if (event?.type === 'session.step.ended' && data.tokens) {
      const usage = mapUsage(data.tokens);
      if (!Object.keys(usage).length) return [];
      return [{kind: 'usage', text: JSON.stringify(usage), usage, ...(Number.isInteger(data.tokens.reasoning) && data.tokens.reasoning > 0 ? {thinking: data.tokens.reasoning} : {})}];
    }
    if (event?.type === 'session.reasoning.delta' && typeof data.delta === 'string') {
      thinking += data.delta.length;
      const tokens = Math.floor(thinking / CHARS_PER_TOKEN / THINKING_STEP) * THINKING_STEP;
      if (tokens > shown) { shown = tokens; return [{kind: 'progress', text: `Thinking · ~${tokens} tokens`}]; }
    }
    return [];
  };
}

// Listens to a turn's server and hands each row on. close() waits for the server to say the turn's execution ended
// (its last text can trail `opencode run`'s exit), at most `settleMs`, then stops listening.
export function listenToServer({url, password, cwd, emit, fetchImpl = fetch, settleMs = 2000}) {
  const controller = new AbortController();
  const rows = createServerRows();
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const headers = {authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`};
  const done = fetchImpl(`${url}/api/event?location[directory]=${encodeURIComponent(cwd)}`, {headers, signal: controller.signal})
    .then(response => response.ok && response.body ? readEventStream(response.body, event => {
      for (const row of rows(event)) emit(row);
      if (/^session\.execution\.(succeeded|failed|cancelled)$/.test(event?.type ?? '')) settle();
    }) : null)
    .catch(() => null)
    .finally(() => settle());
  return {
    async close() {
      await Promise.race([settled, new Promise(resolve => setTimeout(resolve, settleMs).unref?.())]);
      controller.abort();
      await done;
    },
  };
}
