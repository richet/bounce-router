import fs from 'node:fs/promises';
import path from 'node:path';
import {TEXT_MAX} from './live-common.js';
import {createLmStudioBackend} from './backends/lmstudio.js';
import {createOllamaBackend} from './backends/ollama.js';
import {createFakeBackend} from './backends/fake.js';

// The local adapter (docs/local-orchestration.md "Peers and adapters", `local` row): bounce owns
// the whole tool loop and injects deliveries at the tool boundary — there is no vendor CLI, so
// this is the one adapter with no executable and no child process. CONTRACT.md §B.

const READ_MAX = 200_000; // a file this large is truncated, never refused
const SEARCH_MAX_MATCHES = 200;
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules']);

const TOOLS = [
  {name: 'read_file', description: 'Read a file inside the working directory.', parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}},
  {name: 'search', description: 'Search files inside the working directory for a substring.', parameters: {type: 'object', properties: {query: {type: 'string'}, glob: {type: 'string'}}, required: ['query']}},
];

function backendUnavailable() {
  const error = new Error('backend_unavailable');
  error.code = 'backend_unavailable';
  return error;
}

// Resolves `relPath` against `cwd`; returns null (never throws) for anything that would
// escape `cwd` — a relative `..` climb or an absolute path substituted in by path.resolve.
function resolveWithinCwd(cwd, relPath) {
  const resolved = path.resolve(cwd, typeof relPath === 'string' ? relPath : '');
  const rel = path.relative(cwd, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return resolved;
}

async function readFileTool(cwd, args) {
  const target = resolveWithinCwd(cwd, args?.path);
  if (!target) return 'error: path escapes the working directory';
  try {
    const content = await fs.readFile(target, 'utf8');
    return content.length > READ_MAX ? `${content.slice(0, READ_MAX)}\n...(truncated)` : content;
  } catch (error) {
    return `error: ${error.code ?? error.message}`;
  }
}

// A small, dependency-free glob: '*' matches any run of characters, everything else is literal.
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

async function* walk(dir, cwd) {
  let entries;
  try { entries = await fs.readdir(dir, {withFileTypes: true}); } catch { return; }
  for (const entry of entries) {
    if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, cwd);
    else if (entry.isFile()) yield full;
  }
}

async function searchTool(cwd, args) {
  const query = typeof args?.query === 'string' ? args.query : '';
  if (!query) return 'error: search requires a query';
  const pattern = typeof args?.glob === 'string' && args.glob ? globToRegExp(args.glob) : null;
  const matches = [];
  for await (const file of walk(cwd, cwd)) {
    const rel = path.relative(cwd, file);
    if (pattern && !pattern.test(path.basename(rel))) continue;
    let content;
    try { content = await fs.readFile(file, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(query)) continue;
      matches.push(`${rel}:${i + 1}: ${lines[i]}`);
      if (matches.length >= SEARCH_MAX_MATCHES) break;
    }
    if (matches.length >= SEARCH_MAX_MATCHES) break;
  }
  return matches.length ? matches.join('\n') : 'no matches';
}

async function runTool(call, cwd) {
  try {
    if (call.name === 'read_file') return await readFileTool(cwd, call.arguments);
    if (call.name === 'search') return await searchTool(cwd, call.arguments);
    return `error: unknown tool ${call.name}`;
  } catch (error) {
    return `error: ${error.message}`;
  }
}

// A minimal push-based async iterator: the loop below pushes events as it produces them,
// the scheduler's consumeWorkerEvents pulls them via `for await`. No `return()` — a `break`
// leaves the stream open, matching the other live adapters' streaming handles.
function makeStream() {
  const ready = [], waiting = [];
  let ended = false;
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    next() {
      if (ready.length) return Promise.resolve({value: ready.shift(), done: false});
      if (ended) return Promise.resolve({value: undefined, done: true});
      return new Promise(resolve => waiting.push(resolve));
    },
  };
  return {
    iterator,
    push(event) {
      if (ended) return;
      const waiter = waiting.shift();
      waiter ? waiter({value: event, done: false}) : ready.push(event);
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiting.splice(0)) waiter({value: undefined, done: true});
    },
  };
}

function flushDeliverQueue(handle) {
  for (const text of handle.deliverQueue.splice(0)) handle.messages.push({role: 'user', content: text});
}

// One call to backend.generate(): assembles a tool call (if any) and forwards delta/usage
// events as they stream. `atBoundary` (set by the caller before this runs) flips false only
// once the backend actually starts producing again — a backend paused before its first item
// (the L4/concurrency tests' 'wait' control item) leaves the adapter "still at the boundary".
async function driveOnce(handle) {
  let text = '', toolCall = null, first = true;
  const stream = handle.backend.generate({
    model: handle.profile.model, messages: handle.messages, tools: handle.tools,
    signal: handle.controller.signal, script: handle.profile.script,
  });
  for await (const item of stream) {
    if (first) { handle.atBoundary = false; first = false; }
    if (item.kind === 'delta') { text += item.text; handle.stream.push({kind: 'activity', text: item.text}); }
    else if (item.kind === 'tool_call') toolCall = {id: item.id, name: item.name, arguments: item.arguments};
    else if (item.kind === 'usage') handle.stream.push({kind: 'usage', usage: item.usage});
    else if (item.kind === 'done') text = item.text ?? text;
  }
  return {toolCall, text};
}

async function runLoop(handle) {
  const {stream} = handle;
  try {
    for (;;) {
      let toolCall, text;
      try {
        ({toolCall, text} = await driveOnce(handle));
      } catch (error) {
        if (!handle.cancelled) {
          const message = error?.message ?? String(error);
          stream.push({kind: 'error', text: message});
          stream.push({kind: 'result', status: 'failed', text: message});
        }
        return;
      }
      if (toolCall) {
        const result = await runTool(toolCall, handle.cwd);
        handle.messages.push({role: 'assistant', tool_calls: [{id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments}]});
        handle.messages.push({role: 'tool', tool_call_id: toolCall.id, name: toolCall.name, content: result});
        if (typeof result === 'string' && result.startsWith('error:')) stream.push({kind: 'activity', text: result});
        flushDeliverQueue(handle);
        handle.atBoundary = true;
        continue;
      }
      stream.push({kind: 'result', status: 'completed', text});
      return;
    }
  } finally {
    handle.finished = true;
    stream.end();
    handle.resolveFinished();
  }
}

export function createLocalLive({backends: suppliedBackends, fetchImpl = globalThis.fetch, tools = TOOLS} = {}) {
  const backends = {
    lmstudio: createLmStudioBackend({fetchImpl}),
    ollama: createOllamaBackend({fetchImpl}),
    fake: createFakeBackend(),
    ...suppliedBackends,
  };
  let queue = Promise.resolve(); // concurrency 1 per adapter instance (CONTRACT.md §B3)

  function beginHandle({native, cwd, dir, messages}) {
    let resolveFinished;
    const finishedPromise = new Promise(resolve => { resolveFinished = resolve; });
    return {
      cwd, dir, tools, messages, native: native ?? null,
      controller: new AbortController(),
      stream: makeStream(),
      deliverQueue: [], atBoundary: false, finished: false, cancelled: false,
      finishedPromise, resolveFinished,
    };
  }

  async function start({profile = {}, native, cwd, dir, messages}) {
    const backend = backends[profile.backend];
    if (!backend) throw backendUnavailable();
    let healthy;
    try { healthy = await backend.health(); } catch { healthy = false; }
    if (!healthy) throw backendUnavailable();
    const handle = beginHandle({native, cwd, dir, messages});
    handle.backend = backend;
    handle.profile = profile;
    handle.events = handle.stream.iterator;
    queue = queue.then(() => runLoop(handle)).catch(() => {});
    return handle;
  }

  return {
    name: 'local',

    async launch({peer, profile = {}, orders = '', cwd, dir}) {
      return start({profile, native: peer?.native, cwd, dir, messages: [{role: 'user', content: orders}]});
    },

    events(handle) { return handle.events; },

    async deliver(handle, {text}) {
      const value = String(text);
      if (value.length > TEXT_MAX) return 'queued';
      if (handle.finished) return 'queued';
      if (handle.atBoundary) { handle.messages.push({role: 'user', content: value}); return 'live'; }
      handle.deliverQueue.push(value);
      return 'next-turn';
    },

    async resume({native, message = '', cwd, dir, profile = {}}) {
      return start({profile, native, cwd, dir, messages: [{role: 'user', content: message}]});
    },

    async cancel(handle) {
      handle.cancelled = true;
      handle.controller.abort();
      await handle.finishedPromise;
      return {verified: true};
    },

    capabilities: () => ({live: true, resume: true, modelPin: true, policies: ['yolo'], quota: 'stream'}),
  };
}
