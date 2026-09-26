import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveExecutable} from '../executable.js';
import {spawnLive, vendorEnv, verifiedCancel, appendPending, readPending, takePending, TEXT_MAX, SPEAKER, classifyText, createAnswer, concludeAsk, reportGrant, peerTask} from './live-common.js';

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
const RUN_ARGS = ['run', '--pure', '--format', 'json'];
const DEFAULT_AGENT = 'bounce-worker';
const DEFAULT_STEPS = 30;
// Observed live on a 4B and a 27B model alike: a worker that cannot do what it was asked re-reads
// the same file (or rewrites the same todo list) until the step cap, minutes of inference later.
// The same call with the same input this many times, with nothing changed in between, is a loop.
const REPEAT_LIMIT = 4;
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
const CHANGES = new Set(['write', 'edit', 'apply_patch', 'bash']);
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
const BEAT = Symbol('beat');

// The policy tier becomes the agent's tools map — the same ladder the vendor CLIs get as flags.
// A read-only or plan worker has no tool that can change anything; write/yolo edit and run
// commands in the real tree, exactly as a claude or codex yolo worker does.
const READ_TOOLS = ['read', 'grep', 'glob'];
const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'bash'];
// No todo list either: it gave a stuck model something to do forever instead of answering.
const NEVER_TOOLS = ['todowrite', 'task', 'websearch', 'webfetch', 'skill', 'question', 'invalid'];
// A probe worker reads and runs commands (bash) but gets no editing tool; the sandbox below makes
// sure bash cannot write the project either.
export function toolsFor(policy) {
  const writes = policy === 'write' || policy === 'yolo';
  return Object.fromEntries([...READ_TOOLS.map(tool => [tool, true]), ...WRITE_TOOLS.map(tool => [tool, writes || (policy === 'probe' && tool === 'bash')]), ...NEVER_TOOLS.map(tool => [tool, false])]);
}

// The OS-level fence for a probe worker (docs/plans/probing-reviewer.md): macOS sandbox-exec around the
// whole opencode process. Writes are refused everywhere except the temp dirs and opencode's own state,
// and refused in the project even when it sits under a temp dir (the last matching rule wins). The
// network reaches only localhost: the model endpoint and opencode's own in-process server. A Unix
// socket (Docker's) is not a network address and stays refused.
// The fence for a write worker in an isolated copy: everything it does is allowed except writing the
// original checkout the copy was made from, so a path back into it fails instead of bypassing review.
export function writeFenceSandbox(source) {
  return `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(fs.realpathSync(source))}))`;
}

// Resolves the real Docker socket path a probe worker's sandbox may allow-list. `DOCKER_HOST`
// wins when it names a Unix socket (a non-default daemon, e.g. a per-project context); otherwise
// the conventional `/var/run/docker.sock` is tried, resolved through whatever it actually is (on
// OrbStack, a symlink into `~/.orbstack/run/docker.sock`) — the sandbox rule must name the real
// path, exactly as it already does for the report bus socket below. Returns null when neither
// exists, so a `docker` task on a host with no daemon socket fails at connection time, not here.
export function resolveDockerSocket(env = process.env) {
  const host = typeof env.DOCKER_HOST === 'string' && env.DOCKER_HOST.startsWith('unix://') ? env.DOCKER_HOST.slice('unix://'.length) : null;
  for (const candidate of [host, '/var/run/docker.sock'].filter(Boolean)) {
    try { return fs.realpathSync(candidate); } catch { /* try the next candidate */ }
  }
  return null;
}

export function probeSandbox(cwd, home = os.homedir(), probeSource = null, reportSocket = null, dockerSocket = null) {
  const q = p => JSON.stringify(String(p));
  const isolated = fs.realpathSync(cwd);
  const source = probeSource === null ? null : fs.realpathSync(probeSource);
  // macOS resolves /tmp to /private/tmp before evaluating a Unix-socket literal.
  const resolveSocket = value => value === null ? null : (() => {
    try { return fs.realpathSync(value); }
    catch { return path.join(fs.realpathSync(path.dirname(value)), path.basename(value)); }
  })();
  const socket = resolveSocket(reportSocket);
  const docker = resolveSocket(dockerSocket);
  if (source && (source === isolated || source.startsWith(`${isolated}${path.sep}`) || isolated.startsWith(`${source}${path.sep}`))) throw new Error('probeSource must be separate from cwd');
  const writable = ['/private/tmp', '/private/var/folders', `${home}/.local/share/opencode`, `${home}/.local/state/opencode`, `${home}/.cache/opencode`, `${home}/.config/opencode`, ...(source ? [isolated] : [])];
  return ['(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* ${writable.map(p => `(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd") (regex #"^/dev/tty") (regex #"^/dev/ptmx"))`,
    `(deny file-write* (subpath ${q(source ?? isolated)}))`,
    '(deny network*)', '(allow network* (local ip "localhost:*"))', '(allow network-outbound (remote ip "localhost:*"))',
    ...(socket ? [`(allow network-outbound (literal ${q(socket)}))`] : []),
    ...(docker ? [`(allow network-outbound (literal ${q(docker)}))`] : [])].join('');
}
// Everything this adapter takes on faith from the opencode binary, in one place, so a test can hold
// the installed binary to it (test/opencode-contract.test.js). Verified against 1.18.31 — a version
// not listed here has not been checked, and the test says so rather than letting it run unexamined.
export const CONTRACT = {
  versions: ['1.18.31'],
  literals: ['run [message..]', 'raw JSON events', 'agent to use', 'session id to continue', 'directory to run in',
    'run without external plugins', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_AUTOUPDATE', 'OPENCODE_DISABLE_DEFAULT_PLUGINS',
    'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT',
    'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS', 'step_start', 'step_finish', 'tool_use', 'auto-rejecting', 'maxSteps', 'external_directory',
    ...WRITE_TOOLS.filter(tool => tool.length > 4), ...NEVER_TOOLS.filter(tool => tool.length > 6)],
};

const effectiveTier = (profile = {}) =>
  profile.policy === 'read-only' ? 'read-only' : profile.policy === 'probe' ? 'probe' : profile.mode === 'plan' ? 'plan' : profile.policy === 'write' ? 'write' : 'yolo';

// CONTRACT §5: {input, cache_read, cache_write, output}, integers only, absent keys absent.
export const mapUsage = raw => {
  const usage = {};
  if (Number.isInteger(raw?.input)) usage.input = raw.input;
  if (Number.isInteger(raw?.cache?.read)) usage.cache_read = raw.cache.read;
  if (Number.isInteger(raw?.cache?.write)) usage.cache_write = raw.cache.write;
  if (Number.isInteger(raw?.output)) usage.output = raw.output;
  return usage;
};

// A local model needs no vendor credential, so none reaches it: opencode would otherwise pick up
// ANTHROPIC_API_KEY & co. from the environment and could route a "local" worker to a paid API.
const CREDENTIAL = /(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET|_SECRET_KEY)$|^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|GROQ|MISTRAL|OPENROUTER|XAI|DEEPSEEK)_/;
export const scrubCredentials = (env, keep = []) =>
  Object.fromEntries(Object.entries(env).filter(([key]) => keep.includes(key) || !CREDENTIAL.test(key)));

export function createOpencodeLive({kill = process.kill, spawn, heartbeatMs = HEARTBEAT_MS, stepBeatCapMs = STEP_BEAT_CAP_MS} = {}) {
  const pendingPath = dir => `${dir}/pending.jsonl`;

  const start = ({peer, profile = {}, session = null, stdin, cwd, dir, conclude = false}) => {
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
    const args = [...RUN_ARGS, '--agent', name, ...model, '--dir', cwd, ...(session ? ['-s', session] : [])];
    const keep = profile.apiKeyEnv ? [profile.apiKeyEnv] : [];
    const env = {...scrubCredentials(vendorEnv(process.env, profile.orchestratorEnv), keep),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      // opencode otherwise loads the USER'S Claude Code setup into the worker: ~/.claude/CLAUDE.md as
      // prompt and ~/.claude/skills. Observed live on two different models: a CLAUDE.md that says
      // "rules: @~/.claude/WORKFLOW.md" sent the worker to read a file outside the project, opencode
      // rejected it and ended the turn. A worker's instructions are its agent file and its orders.
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1'};
    const fence = effectiveTier(profile) === 'probe' ? probeSandbox(cwd, os.homedir(), profile.probeSource ?? null, grant?.BOUNCE_REPORT_BUS, profile.docker ? resolveDockerSocket() : null)
      : profile.writeFence && process.platform === 'darwin' ? writeFenceSandbox(profile.writeFence) : null;
    const spawned = fence ? {executable: '/usr/bin/sandbox-exec', args: ['-p', fence, executable, ...args]} : {executable, args};
    const live = spawnLive({...spawned, cwd, env, stdin, ...(spawn ? {spawn} : {})});
    return {live, child: live.child, pid: live.child.pid, args: spawned.args, dir, cwd, sessionId: session, tools: config.agent[name].tools, agent: name, peer, profile, conclude};
  };

  return {
    name: 'opencode',

    async launch({peer, profile, orders = '', cwd, dir}) {
      return start({peer, profile, stdin: String(orders), cwd, dir});
    },

    async resume({peer, profile, native = {}, message = '', cwd, dir}) {
      const texts = takePending(pendingPath(dir));
      return start({peer, profile, session: native?.sessionId ?? null, stdin: [...texts, String(message)].join('\n'), cwd, dir});
    },

    // Never throws: every terminal condition of the process becomes an event and ends the stream.
    async *events(handle) {
      let announced = false, lastError = null, tail = '', refused = null;
      const answer = createAnswer();
      const repeats = new Map();
      let stepActed = false, emptySteps = 0, concluded = false, reads = 0, stalled = false, capped = false;
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
            const again = start({peer: handle.peer, profile: handle.profile, session: handle.sessionId, stdin: ask, cwd: handle.cwd, dir: handle.dir, conclude: true});
            handle.child = again.child; handle.pid = again.pid; // cancel() must reach the turn that is running now
            let concludedAnswer = null;
            for await (const e of this.events(again)) { if (e.kind === 'result') { concludedAnswer = e.status === 'completed' ? e.text : null; break; } if (e.kind !== 'result') yield e; }
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
      return {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], executionPolicies: ['read-only', 'probe', 'plan', 'write', 'yolo'], quota: 'stream'};
    },

    pending: dir => readPending(pendingPath(dir)),
  };
}
