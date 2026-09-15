import fs from 'node:fs/promises';
import path from 'node:path';
import {TEXT_MAX} from './live-common.js';
import {createLmStudioBackend} from './backends/lmstudio.js';
import {createOllamaBackend} from './backends/ollama.js';
import {createFakeBackend} from './backends/fake.js';
import {validateReport} from '../reporting.js';

const CANCEL_MS = 30_000;
const HEALTH_MS = 10_000;
const HISTORY_FILE = 'local-live-history.json';
const MAX_DELIVERIES = 50;
const BASE_TOOLS = [
  {name: 'read_file', description: 'Read a workspace file.', parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}},
  {name: 'search', description: 'Search workspace files.', parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']}},
];
const WRITE_TOOLS = [
  {name: 'write_file', description: 'Write a granted workspace file.', parameters: {type: 'object', properties: {path: {type: 'string'}, content: {type: 'string'}}, required: ['path', 'content']}},
  {name: 'patch_file', description: 'Apply a guarded workspace patch.', parameters: {type: 'object', properties: {path: {type: 'string'}, old: {type: 'string'}, new: {type: 'string'}}, required: ['path', 'old', 'new']}},
  {name: 'run_command', description: 'Run a permitted workspace command.', parameters: {type: 'object', properties: {command: {type: 'string'}}, required: ['command']}},
];
const REPORT_TOOL = {name: 'bounce_report', description: 'Report progress with op=milestone. Finish with op=final, outcome=completed|failed|blocked|input_required and a summary. A valid final report ends this worker. Include only observed evidence, never inferred test results.', parameters: {type: 'object', properties: {op: {type: 'string', enum: ['milestone', 'blocked', 'input_required', 'final']}, outcome: {type: 'string', enum: ['completed', 'failed', 'blocked', 'input_required'], description: 'Required for final reports; success is not a valid value.'}, phase: {type: 'string'}, text: {type: 'string'}, next: {type: 'string'}, summary: {type: 'string', description: 'Required for final reports.'}, evidence: {type: 'array', items: {type: 'string'}}, remaining: {type: 'string'}}, required: ['op', 'phase', 'text', 'next']}};

const unavailable = () => Object.assign(new Error('backend_unavailable'), {code: 'backend_unavailable'});
const within = (cwd, value) => {
  const target = path.resolve(cwd, typeof value === 'string' ? value : '');
  const rel = path.relative(cwd, target);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : target;
};

function makeStream(max = 1_000) {
  const ready = [], waiting = [];
  let ended = false;
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    next() {
      if (ready.length) return Promise.resolve({value: ready.shift(), done: false});
      return ended ? Promise.resolve({done: true}) : new Promise(resolve => waiting.push(resolve));
    },
  };
  return {
    iterator,
    push(event) {
      if (ended) return;
      const waiter = waiting.shift();
      if (waiter) waiter({value: event, done: false});
      else if (ready.length < max || event.kind === 'result' || event.kind === 'error' || event.kind === 'native') {
        if (ready.length >= max) {
          const activity = ready.findIndex(item => item.kind === 'activity');
          if (activity >= 0) ready.splice(activity, 1);
          else ready.shift();
        }
        ready.push(event);
      }
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiting.splice(0)) waiter({done: true});
    },
  };
}

async function legacyTool(call, cwd) {
  // This is solely the fake-backend compatibility path. Production always has a runtime.
  if (call.name === 'read_file') {
    const target = within(cwd, call.arguments?.path);
    if (!target) return 'error: path escapes the working directory';
    try { return await fs.readFile(target, 'utf8'); } catch (error) { return `error: ${error.code ?? error.message}`; }
  }
  if (call.name === 'search') {
    const query = typeof call.arguments?.query === 'string' ? call.arguments.query : '';
    if (!query) return 'error: search requires a query';
    const matches = [];
    async function visit(dir) {
      for (const entry of await fs.readdir(dir, {withFileTypes: true})) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(target);
        if (!entry.isFile()) continue;
        let content;
        try { content = await fs.readFile(target, 'utf8'); } catch { continue; }
        for (const [line, value] of content.split('\n').entries()) {
          if (value.includes(query)) matches.push(`${path.relative(cwd, target)}:${line + 1}: ${value}`);
          if (matches.length >= 200) return;
        }
      }
    }
    await visit(cwd);
    return matches.join('\n') || 'no matches';
  }
  return `error: unknown tool ${call.name}`;
}

async function loadRuntime(factory, options) {
  if (factory) return factory(options);
  return (await import('../local-runtime.js')).createLocalRuntime(options);
}

async function boundedHealth(backend, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once: true});
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(backend.health({signal: controller.signal})).then(Boolean, () => false),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), HEALTH_MS); }),
    ]);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    signal?.removeEventListener('abort', abort);
  }
}

const historyPath = dir => path.join(dir, HISTORY_FILE);
async function loadHistory(dir, profile, native) {
  try {
    if (native?.sessionId !== historyPath(dir)) throw new Error('local resume checkpoint identity mismatch');
    const stat = await fs.lstat(historyPath(dir));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > (profile.localOptions?.maxContextBytes ?? 200000) + 4096) throw new Error('invalid local checkpoint');
    const value = JSON.parse(await fs.readFile(historyPath(dir), 'utf8'));
    if (value.model !== (profile.localResolved?.model ?? profile.model) || value.instance !== (profile.localResolved?.instance ?? null)) {
      throw Object.assign(new Error('local resume model mismatch'), {code: 'LOCAL_RESUME_MISMATCH'});
    }
    if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 1000 || value.messages.some(message => !['user', 'assistant', 'tool', 'system'].includes(message?.role))) throw new Error('invalid local conversation history');
    return value.messages;
  } catch (error) {
    if (error?.code === 'LOCAL_RESUME_MISMATCH') throw error;
    throw Object.assign(new Error(`Local continuation unavailable: ${error.message}`), {code: 'LOCAL_RESUME_UNAVAILABLE', terminationVerified: true});
  }
}
async function saveHistory(handle) {
  const messages = [...handle.messages];
  // Never split an assistant tool-call message from any of its tool results.  Refuse an
  // oversize checkpoint rather than persisting a conversation that cannot be resumed safely.
  if (Buffer.byteLength(JSON.stringify(messages)) > handle.maxContext) {
    throw Object.assign(new Error('local conversation checkpoint limit exceeded'), {code: 'LOCAL_CONTEXT_LIMIT'});
  }
  await fs.mkdir(handle.dir, {recursive: true});
  await fs.writeFile(historyPath(handle.dir), JSON.stringify({messages,
    model: handle.profile.localResolved?.model ?? handle.profile.model,
    instance: handle.profile.localResolved?.instance ?? null}), {mode: 0o600});
}

export function createLocalLive({backends: supplied = {}, fetchImpl = globalThis.fetch, runtimeFactory, report} = {}) {
  const backends = {
    lmstudio: createLmStudioBackend({fetchImpl}),
    ollama: createOllamaBackend({fetchImpl}),
    fake: createFakeBackend(),
    ...supplied,
  };

  async function start(args) {
    const {profile = {}, cwd, dir, signal} = args;
    args.onActivity?.({phase: 'connecting', text: 'Checking local inference endpoint'});
    const backend = profile.backend === 'lmstudio' && (profile.localResolved?.url || profile.apiKeyEnv)
      ? createLmStudioBackend({
        fetchImpl,
        base: profile.localResolved?.url ?? profile.url,
        apiKey: profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined,
        timeoutMs: profile.localOptions?.timeoutMs ?? 120000,
      })
      : backends[profile.backend];
    if (!backend || !await boundedHealth(backend, signal)) throw unavailable();

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort(); else signal?.addEventListener('abort', forwardAbort, {once: true});
    let resolveFinished;
    const handle = {
      ...args,
      backend,
      controller,
      stream: makeStream(),
      messages: args.messages,
      tools: toolSchemas(profile, args.report ?? report ?? profile.report?.report),
      report: args.report ?? report ?? profile.report?.report,
      deliveries: [],
      observedTools: [],
      commandEvidence: [],
      finalReport: null,
      reportRepairs: 0,
      steps: 0,
      cancelled: false,
      inferenceSettled: true,
      finished: false,
      maxContext: Number.isInteger(profile.localOptions?.maxContextBytes) ? profile.localOptions.maxContextBytes : 200_000,
      maxOutput: Number.isInteger(profile.localOptions?.maxOutputTokens) ? profile.localOptions.maxOutputTokens * 4 : 8_192,
      finishedPromise: new Promise(resolve => { resolveFinished = resolve; }),
      resolveFinished,
    };
    handle.events = handle.stream.iterator;
    if (profile.localResolved?.context) {
      handle.maxContext = Math.min(handle.maxContext,
        Math.max(1024, profile.localResolved.context - (profile.localOptions?.maxOutputTokens ?? 2048) - 1024));
    }
    if (profile.backend !== 'fake') {
      const runtime = await loadRuntime(runtimeFactory, {
        cwd, dir, profile, signal: controller.signal,
        onActivity: activity => handle.stream.push({kind: 'activity', text: typeof activity === 'object' ? String(activity.text ?? activity.stage ?? '') : String(activity)}),
      });
      handle.runtime = await runtime.prepare({
        cwd, dir, profile, signal: controller.signal,
        onActivity: activity => {
          const text = typeof activity === 'object' ? String(activity.text ?? activity.stage ?? '') : String(activity);
          handle.stream.push({kind: 'activity', text});
          args.onActivity?.({phase: 'workspace', text});
        },
      });
    }
    const timeout = Number.isFinite(profile.localOptions?.timeoutMs) ? profile.localOptions.timeoutMs : 120_000;
    handle.timer = setTimeout(() => controller.abort(new Error('local adapter deadline exceeded')), Math.max(1, timeout));
    void run(handle).finally(() => {
      clearTimeout(handle.timer);
      signal?.removeEventListener('abort', forwardAbort);
    });
    return handle;
  }

  function toolSchemas(profile, reporter) {
    const writable = profile.policy === 'write' && profile.mode === 'yolo';
    return [...BASE_TOOLS, ...(writable ? WRITE_TOOLS : []), ...(reporter ? [REPORT_TOOL] : [])];
  }

  async function execute(handle, call) {
    if (handle.cancelled || handle.controller.signal.aborted) throw new Error('cancelled');
    handle.observedTools.push({id: call.id, name: call.name});
    handle.stream.push({kind: 'tool', id: call.id, name: call.name, text: `Using ${call.name}`});
    if (call.name === 'bounce_report') {
      const invalid = validateReport(call.arguments);
      if (invalid || !handle.report) return `error: report rejected${invalid ? ` (${invalid})` : ''}. Use op=milestone|blocked|input_required|final; final requires outcome=completed|failed|blocked|input_required and summary. Every report requires string phase, text and next.`;
      if (call.arguments.op === 'final') {
        handle.finalReport = call.arguments;
        return 'report held until workspace publication succeeds';
      }
      if (handle.cancelled || handle.controller.signal.aborted) throw new Error('cancelled');
      await handle.report({task: handle.task, attempt: handle.attempt, context: handle.context, report: call.arguments});
      return 'report accepted';
    }
    try {
      const result = handle.runtime
        ? await handle.runtime.execute({name: call.name, arguments: call.arguments}, {signal: handle.controller.signal})
        : await legacyTool(call, handle.cwd);
      if (call.name === 'run_command') handle.commandEvidence.push(`Supervisor observed: ${call.arguments.command} exit=0`);
      return typeof result === 'string' ? result : String(result);
    } catch (error) {
      if (call.name === 'run_command' && error.status !== undefined) handle.commandEvidence.push(`Supervisor observed: ${call.arguments.command} exit=${error.status}`);
      if (['COMMAND_FAILED', 'PATCH_PRECONDITION', 'PATH_DENIED', 'POLICY_DENIED', 'COMMAND_DENIED', 'INVALID_TOOL', 'OUTPUT_LIMIT'].includes(error.code)) {
        return `error: ${error.code}${error.status !== undefined ? ` exit=${error.status}` : ''}\n${error.result ?? error.message}`.slice(0, 16000);
      }
      throw error;
    }
  }

  async function turn(handle) {
    if (Buffer.byteLength(JSON.stringify(handle.messages)) > handle.maxContext) throw new Error('local adapter context limit exceeded');
    handle.inferenceSettled = false;
    handle.stream.push({kind: 'activity', text: 'Waiting for model response'});
    let text = '';
    const calls = [];
    handle.atBoundary = true;
    try {
      for await (const event of handle.backend.generate({
        model: handle.profile.localResolved?.instance ?? handle.profile.localResolved?.model ?? handle.profile.model,
        messages: handle.messages,
        tools: handle.tools,
        maxTokens: handle.profile.localOptions?.maxOutputTokens,
        signal: handle.controller.signal,
        script: handle.profile.script,
      })) {
        handle.atBoundary = false;
        if (event.kind === 'delta') {
          text += event.text;
          if (Buffer.byteLength(text) > handle.maxOutput) throw new Error('local adapter output limit exceeded');
          handle.stream.push({kind: 'activity', text: event.text});
        } else if (event.kind === 'usage') handle.stream.push(event);
        else if (event.kind === 'tool_call') {
          if (Buffer.byteLength(JSON.stringify(event.arguments)) > handle.maxContext) throw new Error('local adapter tool arguments limit exceeded');
          calls.push(event);
        } else if (event.kind === 'done') {
          text = event.text ?? text;
          if (Buffer.byteLength(text) > handle.maxOutput) throw new Error('local adapter output limit exceeded');
        }
      }
      handle.inferenceSettled = true;
      return {text, calls};
    } catch (error) {
      // Client abort/EOF is not a server acknowledgement. Keep capacity quarantined.
      if (error?.inferenceVerified === true) handle.inferenceSettled = true;
      throw error;
    }
  }

  function flushDeliveries(handle) {
    for (const text of handle.deliveries.splice(0)) handle.messages.push({role: 'user', content: text});
  }

  async function processCalls(handle, calls) {
    const maxSteps = Number.isInteger(handle.profile.localOptions?.maxSteps) ? handle.profile.localOptions.maxSteps : 32;
    if (handle.steps + calls.length > maxSteps) throw new Error('local adapter tool step limit exceeded');
    const toolCalls = calls.map(call => ({
      id: call.id,
      type: 'function',
      function: {name: call.name, arguments: JSON.stringify(call.arguments)},
    }));
    handle.messages.push({role: 'assistant', tool_calls: toolCalls});
    for (const call of calls) {
      if (handle.cancelled) return;
      const result = handle.finalReport ? 'error: final report already submitted; further tools revoked' : await execute(handle, call);
      handle.messages.push({role: 'tool', tool_call_id: call.id, name: call.name, content: result});
      handle.steps++;
      if (result.startsWith('error:')) handle.stream.push({kind: 'activity', text: result});
    }
    flushDeliveries(handle);
    await saveHistory(handle);
  }

  async function finalize(handle, text) {
    if (handle.report && !handle.finalReport && handle.reportRepairs++ < 1) {
      handle.messages.push({role: 'user', content: 'Return the required final report now using bounce_report. Do not do more work.'});
      return false;
    }
    const publish = !handle.report || handle.finalReport?.outcome === 'completed';
    if (handle.cancelled || handle.controller.signal.aborted) return true;
    const publication = handle.runtime ? await handle.runtime.finish({publish}) : {verified: true, changes: []};
    if (publication?.verified !== true) throw new Error('workspace finish unverified');
    if (handle.report && !handle.finalReport) throw Object.assign(new Error('missing final report'), {code: 'INCOMPLETE_REPORT'});
    if (handle.finalReport) {
      if (handle.cancelled || handle.controller.signal.aborted) return true;
      const observed = [`Supervisor ${publish ? 'published' : 'preserved unpublished changes'}: ${((publication.changes ?? []).join(', ') || 'no changed paths').slice(0, 14000)}`, ...handle.commandEvidence];
      if (publication.artifact) observed.push(`Supervisor preserved partial workspace: ${publication.artifact}`);
      const report = {...handle.finalReport, evidence: [...observed, ...(handle.finalReport.evidence ?? []).map(item => `Worker reported: ${item}`)].slice(0, 32)};
      await handle.report({task: handle.task, attempt: handle.attempt, context: handle.context, report});
    }
    await saveHistory(handle);
    handle.stream.push({kind: 'result', status: 'completed', text});
    return true;
  }

  async function run(handle) {
    try {
      for (;;) {
        const {text, calls} = await turn(handle);
        if (handle.cancelled) return;
        if (calls.length) {
          await processCalls(handle, calls);
          if (handle.finalReport && await finalize(handle, handle.finalReport.summary)) return;
          continue;
        }
        if (await finalize(handle, text)) return;
      }
    } catch (error) {
      if (!handle.cancelled) {
        const text = `${error?.message ?? String(error)}${error.artifact ? `; partial workspace: ${error.artifact}` : ''}`;
        handle.stream.push({kind: 'error', text, code: error?.code, artifact: error.artifact});
        handle.stream.push({kind: 'result', status: 'failed', text, code: error?.code, artifact: error.artifact});
      }
    } finally {
      handle.finished = true;
      handle.stream.end();
      handle.resolveFinished();
    }
  }

  return {
    name: 'local',
    async launch(args) {
      const handle = await start({...args, messages: [{role: 'user', content: args.orders}]});
      handle.stream.push({kind: 'native', provider: 'local', sessionId: historyPath(args.dir)});
      return handle;
    },
    events: handle => handle.events,
    async deliver(handle, {text}) {
      const value = String(text);
      if (value.length > TEXT_MAX || handle.finished || handle.cancelled || handle.deliveries.length >= MAX_DELIVERIES) return 'queued';
      handle.deliveries.push(value);
      return handle.atBoundary ? 'live' : 'next-turn';
    },
    async resume(args) {
      const history = await loadHistory(args.dir, args.profile ?? {}, args.native);
      const messages = [...history, {role: 'user', content: args.message ?? ''}];
      const handle = await start({...args, messages});
      handle.stream.push({kind: 'native', provider: 'local', sessionId: historyPath(args.dir)});
      return handle;
    },
    async cancel(handle) {
      handle.cancelled = true;
      handle.controller.abort();
      const stopped = handle.runtime ? Promise.resolve(handle.runtime.cancel()).catch(() => ({verified: false})) : Promise.resolve({verified: true});
      let timeout;
      const result = await Promise.race([
        Promise.all([handle.finishedPromise, stopped]).then(([, value]) => value),
        new Promise(resolve => { timeout = setTimeout(() => resolve({verified: false}), CANCEL_MS); }),
      ]);
      clearTimeout(timeout);
      return {verified: result?.verified === true && handle.inferenceSettled, ...(result?.artifact ? {artifact: result.artifact} : {})};
    },
    capabilities: () => ({live: true, resume: true, modelPin: true, policies: ['yolo'], executionPolicies: ['read-only', 'plan', 'write'], quota: 'stream'}),
  };
}
