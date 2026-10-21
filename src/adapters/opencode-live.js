import {fileURLToPath} from 'node:url';
import {spawn as spawnProcess} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {resolveExecutable} from '../executable.js';
import {spawnLive, vendorEnv, verifiedCancel, appendPending, readPending, takePending, TEXT_MAX, SPEAKER, classifyText, createAnswer, concludeAsk, reportGrant, peerTask} from './live-common.js';
import {outputTail} from '../command-output.js';
import {opencodeVersion, VERIFIED} from '../opencode-version.js';

// The OpenCode peer, driven the way claude and codex are: one `opencode run` process per turn, in
// the user's own tree. The prompt goes in on stdin, JSON event lines come out on stdout, the
// process exiting is the turn ending, killing it is cancelling it, and `-s <session>` continues it.
// Bounce's only local-specific work is configuration: which model, and how OpenCode reaches it
// (`profile.opencodeConfig`, built by src/local-opencode-config.js).
//
// Measured against opencode 1.18.31 (docs/plans/local-design-v2.md §1): `run --format json` exits by
// itself; every line carries `sessionID`; `step_finish` carries the tokens; and with nobody to
// answer, a permission ask (e.g. a path outside --dir) is REJECTED by opencode itself — so there is
// no server, port, password, SSE stream, permission responder, poll, deadline or reap here.
//
// opencode 2.x (read from the 2.0.29 source, then run live) keeps that shape — one `run` per turn,
// the same event names and token fields, stdin, OPENCODE_CONFIG_CONTENT — but `run` talks to a server:
// `--standalone` makes it a private one that inherits this env and ends with the turn (without it,
// `run` attaches to the user's shared background service, which never sees our config). There is no
// --dir (the directory is $PWD, which wins over the spawn cwd) and no --pure. Its config has its own
// shape (nativeConfig below) and its tools other names: bash is shell, task is subagent.
const RUN_ARGS = ['run', '--pure', '--format', 'json'];
const RUN_ARGS_V2 = ['run', '--standalone', '--format', 'json'];
// 2.x lists an MCP server's tools only once it has connected ("reads report what is connected now",
// 2.0.29 core/src/mcp/index.ts), and a turn's first step does not wait for it: observed live, every
// worker's first request went out without bounce_report, and an analyst that saw no report tool on
// step one wrote its own client for the report socket. So a worker with a report grant gets a server
// bounce starts itself (`serve --stdio`, what --standalone runs), and its turn starts only once the
// server says bounce is no longer pending — or after MCP_READY_MS, when it runs without the tool.
const SERVER_READY_MS = 30_000;
const MCP_READY_MS = 20_000;
const DEFAULT_AGENT = 'bounce-worker';
const DEFAULT_STEPS = 30;
// Observed live on a 4B and a 27B model alike: a worker that cannot do what it was asked re-reads
// the same file (or rewrites the same todo list) until the step cap, minutes of inference later.
// The same call with the same input this many times, with nothing changed in between, is a loop.
const REPEAT_LIMIT = 4;
const COMMAND_MAX = 1000;
// Traced live (qwen3.6-35b-a3b as reviewer): it read the diff and every file a review needs, then
// repeated one identical glob 26 times and never wrote a verdict. The reading was done; the stopping
// was not. So a worker the guard stops AFTER it has read something gets one more turn on the same
// session with every tool off and a two-step cap: state your conclusion from what you have. An
// answer is the task's result (still reviewed like any other); silence leaves the failure as it was.
const CONCLUDE_STEPS = 2;
// Why a turn ended with nothing from the worker. One path, one prompt (docs/plans/answer-contract.md).
const CAP_PROMPT = concludeAsk('your step budget is spent');
const CONCLUDE_PROMPT = concludeAsk('you repeated the same call with nothing new');
const SILENT_PROMPT = concludeAsk('your turn ended without an answer');
const READS = new Set(['read', 'grep']); // listing files (glob) is not reading material
const CHANGES = new Set(['write', 'edit', 'apply_patch', 'bash', 'patch', 'shell']);
const SHELL = new Set(['bash', 'shell']);
// Observed live (qwen3-coder-30b-a3b via LM Studio): the model answers, but every step is reported as
// finishing for `tool-calls` even when it called none, so opencode keeps looping on empty steps until
// the step cap. A step with no tool call and no new text is empty; this many in a row ends the turn —
// as the answer it already gave, or as no progress if it never gave one.
const EMPTY_STEP_LIMIT = 2;
// `run --format json` prints nothing while a step generates. Measured (review-quality benchmark,
// 2026-09-22): one 27B step ran past 6 minutes writing its review, and a silence watchdog killed a
// working model. While a step is open the adapter says so every HEARTBEAT_MS; after STEP_BEAT_CAP_MS on
// one step it stops, so a step that never ends still goes silent and the watchdog still catches it.
const HEARTBEAT_MS = 30_000;
const STEP_BEAT_CAP_MS = 15 * 60_000;
// A conclusion turn (tools off, CONCLUDE_STEPS-capped, asked once for the worker's answer) has no
// step-time bound of its own: a reasoning model can spend minutes generating on a single step,
// still within its 2-step cap (observed live, session d1bc0206: 6.5 minutes producing nothing).
// CONCLUDE_TIMEOUT_MS bounds the whole conclusion turn by wall clock; past it the turn is cancelled
// and treated exactly like a conclusion that said nothing.
const CONCLUDE_TIMEOUT_MS = 90_000;
const BEAT = Symbol('beat');

// toolsFor and mapUsage live in opencode-common.js (shared with the classic adapter) and are re-exported.
export {toolsFor, mapUsage} from './opencode-common.js';
import {toolsFor, mapUsage, READ_TOOLS, WRITE_TOOLS, NEVER_TOOLS} from './opencode-common.js';

// Everything this adapter takes on faith from the opencode binary, in one place and per major, so a
// test can hold the installed binary to it (test/opencode-contract.test.js). Verified against the
// versions in src/opencode-version.js — another version has not been checked, and the test says so
// rather than letting it run unexamined.
export const CONTRACT = {
  versions: VERIFIED,
  literals: {
    1: ['run [message..]', 'raw JSON events', 'agent to use', 'session id to continue', 'directory to run in',
      'run without external plugins', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
      'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT',
      'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'step_start', 'step_finish', 'tool_use', 'auto-rejecting', 'maxSteps', 'external_directory',
      ...WRITE_TOOLS.filter(tool => tool.length > 4), ...NEVER_TOOLS.filter(tool => tool.length > 6)],
    2: ['Run with a private server instead of the background service', 'Session ID to continue', 'Agent to use', 'Output format',
      'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'step_start', 'step_finish', 'tool_use', 'auto-rejecting',
      'external_directory', 'maxTokensField', 'codemode', 'reasoningEffort', 'permissions', '@opencode/ai/providers/openai-compatible',
      'opencode.provider.lmstudio', 'opencode.config.compatibility', 'subagent', 'websearch', 'webfetch'],
  },
};

// opencode 2.x reads the 1.x config through a migration, but three things only its own shape says
// (2.0.29 source): its LM Studio plugin rediscovers a provider named lmstudio and replaces the models
// we declare (tools off unless the model says so), so it is removed; an MCP server defaults to code
// mode, which hides bounce_report inside a generic `execute` tool; and the output cap goes out as
// max_completion_tokens beside our max_tokens unless the provider names max_tokens as its field. So
// bounce builds one config (1.x shape, src/local-opencode-config.js and start() below) and this turns
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

const effectiveTier = (profile = {}) =>
  profile.policy === 'read-only' ? 'read-only' : profile.mode === 'plan' ? 'plan' : profile.policy === 'write' ? 'write' : 'yolo';


// A local model needs no vendor credential, so none reaches it: opencode would otherwise pick up
// ANTHROPIC_API_KEY & co. from the environment and could route a "local" worker to a paid API.
const CREDENTIAL = /(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET|_SECRET_KEY)$|^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|GROQ|MISTRAL|OPENROUTER|XAI|DEEPSEEK)_/;
export const scrubCredentials = (env, keep = []) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => keep.includes(key) || !CREDENTIAL.test(key)));

async function serveForTurn({executable, cwd, env, spawn = spawnProcess, fetchImpl = fetch, readyMs = SERVER_READY_MS, mcpMs = MCP_READY_MS}) {
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

export function createOpencodeLive({kill = process.kill, spawn, heartbeatMs = HEARTBEAT_MS, stepBeatCapMs = STEP_BEAT_CAP_MS, concludeTimeoutMs = CONCLUDE_TIMEOUT_MS, versionOf = opencodeVersion, fetchImpl = fetch, mcpReadyMs = MCP_READY_MS} = {}) {
  const pendingPath = dir => `${dir}/pending.jsonl`;

  const start = async ({peer, profile = {}, session = null, stdin, cwd, dir, conclude = false}) => {
    const executable = resolveExecutable('opencode', profile.executables?.opencode);
    const agent = profile.agent ?? {};
    const name = agent.name ?? DEFAULT_AGENT;
    // The worker IS its agent: the agent file's prompt and step cap, and the tier's tools. Defined
    // for every worker, because `run` takes its tools from the agent, not from the prompt.
    // Any worker may reach a path outside --dir, as a cloud worker may: without this opencode
    // auto-rejects the first such path and ENDS the turn. Observed live for a write worker (a gate
    // script under /private/tmp) and then twice for a READ-ONLY reviewer sent to read evidence there.
    // What a worker can DO outside is still its tools: a read-only one has none that write or run.
    const outside = {permission: {...(profile.opencodeConfig?.permission ?? {}), external_directory: 'allow'}};
    const grant = reportGrant(profile, peer);
    const reportTool = grant ? {bounce_report: true} : {};
    const config = {...(profile.opencodeConfig ?? {}), ...outside,
      // Only the assigned report endpoint is present, even if an inherited local config names
      // other MCP servers. OpenCode calls this one `bounce_report`.
      mcp: grant ? {bounce: {type: 'local', command: [process.execPath, fileURLToPath(new URL('../mcp-report.js', import.meta.url))],
        enabled: true, environment: {...grant, BOUNCE_REPORT_TASK: peerTask(peer)}}} : {},
      agent: {...(profile.opencodeConfig?.agent ?? {}), [name]: {
      description: agent.description ?? 'A bounce worker.', mode: 'primary',
      ...(agent.prompt ? {prompt: agent.prompt} : {}), maxSteps: conclude ? CONCLUDE_STEPS : agent.maxSteps ?? DEFAULT_STEPS,
      tools: {...(conclude ? Object.fromEntries(Object.keys(toolsFor(effectiveTier(profile))).map(tool => [tool, false])) : toolsFor(effectiveTier(profile))), ...reportTool}}}};
    const model = profile.providerID && profile.model ? ['-m', `${profile.providerID}/${profile.model}`] : [];
    // A binary whose version cannot be read is driven as 1.x: if it is not there at all, the spawn
    // below reports it missing, as it always has.
    const v2 = (versionOf(executable).major ?? 1) >= 2;
    const keep = profile.apiKeyEnv ? [profile.apiKeyEnv] : [];
    const env = {...scrubCredentials(vendorEnv(process.env, profile.orchestratorEnv), keep),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(v2 ? nativeConfig(config) : config), OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      // opencode otherwise loads the USER'S Claude Code setup into the worker: ~/.claude/CLAUDE.md as
      // prompt and ~/.claude/skills. Observed live on two different models: a CLAUDE.md that says
      // "rules: @~/.claude/WORKFLOW.md" sent the worker to read a file outside the project, opencode
      // rejected it and ended the turn. A worker's instructions are its agent file and its orders.
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      // 2.x runs where $PWD says, not where it was spawned: an inherited PWD would be bounce's own.
      ...(v2 ? {PWD: cwd} : {})};
    // On 2.x a turn with a report tool waits for it on a server of its own (serveForTurn); any other
    // 2.x turn needs nothing to be ready first, so --standalone starts and stops its server for it.
    const served = v2 && grant ? await serveForTurn({executable, cwd, env, ...(spawn ? {spawn} : {}), fetchImpl, mcpMs: mcpReadyMs}) : null;
    const args = !v2 ? [...RUN_ARGS, '--agent', name, ...model, '--dir', cwd, ...(session ? ['-s', session] : [])]
      : [...(served ? ['run', '--server', served.url, '--format', 'json'] : RUN_ARGS_V2), '--agent', name, ...model, ...(session ? ['-s', session] : [])];
    // A write worker has the same freedom as a Claude or Codex one (user, 2026-09-27: "there's no
    // difference between any").
    const live = spawnLive({executable, args, cwd, env: served ? {...env, OPENCODE_PASSWORD: served.password} : env, stdin, ...(spawn ? {spawn} : {})});
    // The turn ending, however it ends (exit, kill, failure to spawn), ends its server.
    if (served) { live.child.once('close', served.stop); live.child.once('error', served.stop); }
    return {live, child: live.child, pid: live.child.pid, args, dir, cwd, sessionId: session, tools: config.agent[name].tools, agent: name, peer, profile, conclude,
      ...(served?.notice ? {notice: served.notice} : {})};
  };

  return {
    name: 'opencode',

    async launch({peer, profile, orders = '', cwd, dir}) {
      return await start({peer, profile, stdin: String(orders), cwd, dir});
    },

    async resume({peer, profile, native = {}, message = '', cwd, dir}) {
      const texts = takePending(pendingPath(dir));
      return await start({peer, profile, session: native?.sessionId ?? null, stdin: [...texts, String(message)].join('\n'), cwd, dir});
    },

    // Never throws: every terminal condition of the process becomes an event and ends the stream.
    async *events(handle) {
      if (handle.notice) yield {kind: 'diagnostic', text: handle.notice};
      let announced = false, lastError = null, tail = '', refused = null;
      const answer = createAnswer();
      const repeats = new Map();
      let stepActed = false, emptySteps = 0, concluded = false, reads = 0, stalled = false, capped = false, stepsDone = 0;
      // Found live (session 43387649): at maxSteps opencode ends the turn with no notice in the stream, so the
      // finished-step count against the turn's own budget is what says the cap was hit.
      const stepBudget = handle.conclude ? null : handle.profile?.agent?.maxSteps ?? DEFAULT_STEPS;
      // `stepActed` is per step and resets at every step boundary; `didWork` never resets — it answers
      // "did this worker do anything at all", which is what decides whether there is an answer worth asking for.
      let didWork = false, reportedFinal = false;
      const plain = text => String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/^[!\s]+/, '').trim();
      let stepOpenedAt = null, pending = null;
      const source = handle.live.events[Symbol.asyncIterator]();
      try { for (;;) {
        pending ??= source.next();
        let timer = null;
        const beating = stepOpenedAt !== null && Date.now() - stepOpenedAt < stepBeatCapMs;
        const next = beating ? await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(BEAT), heartbeatMs); })]) : await pending;
        clearTimeout(timer);
        if (next === BEAT) { yield {kind: 'activity', text: `generating · step open ${Math.round((Date.now() - stepOpenedAt) / 1000)} s`}; continue; }
        pending = null;
        if (next.done) break;
        const event = next.value;
        if (event.kind === 'diagnostic') {
          const text = plain(event.text);
          tail = `${tail}\n${text}`.slice(-2000);
          // Observed live: with nobody to answer, opencode rejects a permission ask itself and ENDS
          // the turn. That is the reason the worker has no answer, so it is the reason we report.
          if (/auto-rejecting/i.test(text)) refused = text;
          yield {kind: 'diagnostic', text};
          continue;
        }
        if (event.kind === 'error') { yield {kind: 'error', code: event.code, text: event.text}; return; }
        if (event.kind === 'exit') {
          if (stepBudget && stepsDone >= stepBudget) capped = true;
          // Exit IS the turn ending. A clean exit with text is the worker's answer; anything else is
          // a failure of the runtime rather than of the task, so the next AI in the chain may try.
          // Bounce asked for the conclusion (conclude() below: a lease ended), or the loop guard stopped a
          // worker that had read something. Either way the same session is asked once, tools off.
          // A clean turn that did work and said nothing after its last tool call has no answer — and that
          // is itself the reason to ask for one. Found live: both local-worker failures were
          // this shape, 6 and 14 minutes of work thrown away without the question ever being put.
          const unanswered = event.code === 0 && answer.value === null && didWork;
          const ask = reportedFinal ? null : handle.concludeWith ?? (capped ? CAP_PROMPT : stalled && reads > 0 ? CONCLUDE_PROMPT : unanswered ? SILENT_PROMPT : null);
          if (ask !== null && !handle.conclude && handle.sessionId) {
            const reason = handle.concludeWith !== undefined ? 'watchdog'
              : capped ? 'step_cap' : stalled ? 'repeated_tools' : 'missing_answer';
            const text = handle.concludeWith !== undefined ? `asked, tools off, for its conclusion: ${ask}`
              : capped ? 'opencode stopped at its step cap; asked once, tools off, for its answer'
              : unanswered && !stalled ? 'the turn ended without an answer; asked once, tools off, for it'
              : `stalled after reading ${reads} file${reads === 1 ? '' : 's'}; asked once, tools off, for its conclusion`;
            yield {kind: 'diagnostic', text, reason, phase: 'conclusion', toolsDisabled: true};
            const again = await start({peer: handle.peer, profile: handle.profile, session: handle.sessionId, stdin: ask, cwd: handle.cwd, dir: handle.dir, conclude: true});
            handle.child = again.child; handle.pid = again.pid; // cancel() must reach the turn that is running now
            let concludedAnswer = null;
            const boundTimer = setTimeout(() => { void verifiedCancel(again.child, {kill}); }, concludeTimeoutMs);
            try {
              for await (const e of this.events(again)) { if (e.kind === 'result') { concludedAnswer = e.status === 'completed' ? e.text : null; break; } if (e.kind !== 'result') yield e; }
            } finally { clearTimeout(boundTimer); }
            if (concludedAnswer !== null) { yield {kind: 'diagnostic', text: 'the conclusion turn answered: that answer is the result'}; yield {kind: 'result', status: 'completed', text: concludedAnswer}; return; }
            yield {kind: 'diagnostic', text: 'the conclusion turn gave no answer'};
            if (capped && !lastError) lastError = 'step cap reached without an answer';
          }
          if ((event.code === 0 || concluded) && answer.spoken !== null && !lastError && answer.value === null) lastError = 'no answer: the worker said nothing after its last tool call';
          if (event.code === 0 && reportedFinal) yield {kind: 'result', status: 'completed', text: answer.value ?? 'Final report submitted via bounce_report'};
          else if ((event.code === 0 || concluded) && answer.value !== null && !lastError) yield {kind: 'result', status: 'completed', text: answer.value};
          else yield {kind: 'result', status: 'failed', recoverable: true,
            text: lastError ?? (event.code === 0 ? (refused ? `opencode stopped the turn: ${refused}` : 'opencode finished without an answer') : `opencode exited ${event.signal ?? event.code}: ${tail.trim().split('\n').at(-1) ?? ''}`.trim())};
          return;
        }
        let raw;
        try { raw = JSON.parse(event.text); } catch { yield {kind: 'status', text: event.text}; continue; }
        if (!announced && typeof raw.sessionID === 'string') {
          announced = true; handle.sessionId = raw.sessionID;
          yield {kind: 'native', provider: 'opencode', sessionId: raw.sessionID};
        }
        const part = raw.part ?? {};
        if (raw.type === 'text' && typeof part.text === 'string') {
          // The answer is the last text that SAYS something. Observed live: a model wrote its whole
          // report and then one more step holding only a closing code fence, and that fence became
          // the task's result. Text with no letter or digit is shown, never taken as the answer.
          if (part.text.trim()) {
            const {speaker, text} = classifyText('opencode', part.text);
            if (speaker === SPEAKER.runtime) { capped = /step/i.test(text) || capped; stepActed = true; yield {kind: 'diagnostic', text: `opencode: ${text}`}; continue; }
            answer.said(speaker, text);
            stepActed = true; didWork = true;
            yield {kind: 'assistant', speaker, text};
          }
        } else if (raw.type === 'tool_use') {
          const status = part.state?.status ?? '';
          stepActed = true;
          // A finished call names its target, so bounce can tell new work from repeated work at a lease end.
          const input = part.state?.input ?? {};
          const target = input.filePath ?? input.path ?? input.pattern ?? input.command ?? JSON.stringify(input);
          if (part.tool === 'bounce_report' && status === 'completed' && input.op === 'final'
            && /\breport accepted \(seq \d+\)/.test(typeof part.state?.output === 'string' ? part.state.output : JSON.stringify(part.state?.output ?? ''))) reportedFinal = true;
          yield {kind: 'activity', text: `${part.tool ?? 'tool'} ${status}`.trim(),
            ...(status === 'completed' || status === 'error' ? {call: `${part.tool ?? 'tool'} ${target}`.slice(0, 300), change: CHANGES.has(part.tool)} : {})};
          // A finished shell command, as bounce saw it: what ran, how it ended, the end of what it printed.
          // It is the evidence of a report bounce has to write itself (src/scheduler.js observedEvidence).
          if (SHELL.has(part.tool) && (status === 'completed' || status === 'error') && typeof input.command === 'string') {
            yield {kind: 'command', command: input.command.slice(0, COMMAND_MAX), exit: Number.isInteger(part.state?.metadata?.exit) ? part.state.metadata.exit : null,
              output: outputTail(part.state?.output ?? part.state?.error ?? '')};
          }
          // An answer is text said AFTER the worker's last tool call. Observed live: a worker's opening
          // sentence ("I'll execute this systematically…"), six silent minutes of tool work, then the turn
          // ended — and that opener became the task's completion. It was a plan, not an answer.
          // An acknowledged report is the worker speaking, not working: observed live (9b02e5ce), a
          // conclusion turn posted its result only as an accepted milestone and was failed "without an
          // answer". A refused report said nothing and counts as a tool call like any other.
          const reportOutput = typeof part.state?.output === 'string' ? part.state.output : JSON.stringify(part.state?.output ?? '');
          if (part.tool === 'bounce_report' && status === 'completed' && /\breport accepted \(seq \d+\)/.test(reportOutput)) {
            answer.said(SPEAKER.worker, [input.summary, input.text].filter(value => typeof value === 'string' && value.trim()).join('\n\n'));
            didWork = true;
          } else if (status === 'completed' || status === 'error') { answer.tooled(); didWork = true; }
          if (status === 'completed' && READS.has(part.tool)) reads++;
          if (status === 'completed' && CHANGES.has(part.tool)) repeats.clear(); // the world changed: re-reading is legitimate
          else if (status === 'completed' || status === 'error') {
            const call = `${part.tool} ${JSON.stringify(part.state?.input ?? {})}`.slice(0, 300);
            repeats.set(call, (repeats.get(call) ?? 0) + 1);
            if (repeats.get(call) >= REPEAT_LIMIT && !lastError) {
              lastError = `no progress: ${call} repeated ${REPEAT_LIMIT} times with nothing changed in between`;
              stalled = true;
              yield {kind: 'diagnostic', text: lastError};
              void verifiedCancel(handle.child, {kill}); // our own child: the exit below reports it
            }
          }
          if (status === 'error') yield {kind: 'diagnostic', text: `${part.tool ?? 'tool'}: ${String(part.state?.error ?? part.state?.output ?? 'failed').slice(0, 500)}`};
        } else if (raw.type === 'step_finish') {
          stepOpenedAt = null;
          stepsDone += 1;
          const usage = mapUsage(part.tokens);
          if (Object.keys(usage).length) yield {kind: 'usage', usage};
          emptySteps = stepActed ? 0 : emptySteps + 1;
          stepActed = false;
          if (emptySteps >= EMPTY_STEP_LIMIT && !concluded && !lastError) {
            if (answer.value !== null) concluded = true; // it already answered: that answer is the result
            else lastError = `no progress: ${EMPTY_STEP_LIMIT} empty steps and no answer`;
            yield {kind: 'diagnostic', text: concluded ? `ended the turn after ${EMPTY_STEP_LIMIT} empty steps; the worker had already answered` : lastError};
            void verifiedCancel(handle.child, {kill});
          }
        } else if (raw.type === 'step_start') {
          stepOpenedAt = Date.now();
          yield {kind: 'activity', text: ''};
        } else if (raw.type === 'error') {
          lastError = String(raw.error?.data?.message ?? raw.error?.message ?? raw.error?.name ?? 'opencode error').slice(0, 1000);
          yield {kind: 'diagnostic', text: lastError};
        }
      } } finally { void source.return?.(); } // as for-await did: the process stream is closed on every exit
    },

    // `run` has no steer verb: a message for a running worker waits for the turn to end and rides
    // in on the next one, exactly like a claude worker whose messaging socket is not up.
    async deliver(handle, {text} = {}) {
      const coerced = String(text);
      if (coerced.length > TEXT_MAX) return 'queued';
      if (handle.live.exited() && !handle.sessionId) return 'queued';
      return appendPending(pendingPath(handle.dir), coerced) ? 'next-turn' : 'queued';
    },

    async cancel(handle) {
      return verifiedCancel(handle.child, {kill});
    },

    // Bounce's request for the final answer (a lease ended: ceiling, no progress, stuck). `run` has no
    // steer verb, so the running turn is stopped and events() asks the same session, tools off, with
    // this prompt; its answer is the result.
    async conclude(handle, {prompt = CONCLUDE_PROMPT} = {}) {
      handle.concludeWith = String(prompt);
      return verifiedCancel(handle.child, {kill});
    },

    capabilities() {
      // commands: every shell command the worker runs is passed on (a `command` event).
      return {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], executionPolicies: ['read-only', 'plan', 'write', 'yolo'], quota: 'stream', commands: true};
    },

    pending: dir => readPending(pendingPath(dir)),
  };
}
