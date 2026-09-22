import {resolveExecutable} from '../executable.js';
import {spawnLive, vendorEnv, verifiedCancel, appendPending, readPending, takePending, TEXT_MAX} from './live-common.js';

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
const CONCLUDE_PROMPT = 'Your tools are off. You repeated the same call with nothing new; you have already read what you need. From what you have read, give your final answer now, in full, as the orders asked. If you cannot, say what is missing.';
const READS = new Set(['read', 'grep']); // listing files (glob) is not reading material
const CHANGES = new Set(['write', 'edit', 'apply_patch', 'bash']);
// Observed live (qwen3-coder-30b-a3b via LM Studio): the model answers, but every step is reported as
// finishing for `tool-calls` even when it called none, so opencode keeps looping on empty steps until
// the step cap. A step with no tool call and no new text is empty; this many in a row ends the turn —
// as the answer it already gave, or as no progress if it never gave one.
const EMPTY_STEP_LIMIT = 2;

// The policy tier becomes the agent's tools map — the same ladder the vendor CLIs get as flags.
// A read-only or plan worker has no tool that can change anything; write/yolo edit and run
// commands in the real tree, exactly as a claude or codex yolo worker does.
const READ_TOOLS = ['read', 'grep', 'glob'];
const WRITE_TOOLS = ['write', 'edit', 'apply_patch', 'bash'];
// No todo list either: it gave a stuck model something to do forever instead of answering.
const NEVER_TOOLS = ['todowrite', 'task', 'websearch', 'webfetch', 'skill', 'question', 'invalid'];
export function toolsFor(policy) {
  const writes = policy === 'write' || policy === 'yolo';
  return Object.fromEntries([...READ_TOOLS.map(tool => [tool, true]), ...WRITE_TOOLS.map(tool => [tool, writes]), ...NEVER_TOOLS.map(tool => [tool, false])]);
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
  profile.policy === 'read-only' ? 'read-only' : profile.mode === 'plan' ? 'plan' : profile.policy === 'write' ? 'write' : 'yolo';

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

export function createOpencodeLive({kill = process.kill, spawn} = {}) {
  const pendingPath = dir => `${dir}/pending.jsonl`;

  const start = ({profile = {}, session = null, stdin, cwd, dir, conclude = false}) => {
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
    const config = {...(profile.opencodeConfig ?? {}), ...outside, agent: {...(profile.opencodeConfig?.agent ?? {}), [name]: {
      description: agent.description ?? 'A bounce worker.', mode: 'primary',
      ...(agent.prompt ? {prompt: agent.prompt} : {}), maxSteps: conclude ? CONCLUDE_STEPS : agent.maxSteps ?? DEFAULT_STEPS,
      tools: conclude ? Object.fromEntries(Object.keys(toolsFor(effectiveTier(profile))).map(tool => [tool, false])) : toolsFor(effectiveTier(profile))}}};
    const model = profile.providerID && profile.model ? ['-m', `${profile.providerID}/${profile.model}`] : [];
    const args = [...RUN_ARGS, '--agent', name, ...model, '--dir', cwd, ...(session ? ['-s', session] : [])];
    const keep = profile.apiKeyEnv ? [profile.apiKeyEnv] : [];
    const env = {...scrubCredentials(vendorEnv(process.env, {...profile.orchestratorEnv, ...profile.report}), keep),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      // opencode otherwise loads the USER'S Claude Code setup into the worker: ~/.claude/CLAUDE.md as
      // prompt and ~/.claude/skills. Observed live on two different models: a CLAUDE.md that says
      // "rules: @~/.claude/WORKFLOW.md" sent the worker to read a file outside the project, opencode
      // rejected it and ended the turn. A worker's instructions are its agent file and its orders.
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1'};
    const live = spawnLive({executable, args, cwd, env, stdin, ...(spawn ? {spawn} : {})});
    return {live, child: live.child, pid: live.child.pid, args, dir, cwd, sessionId: session, tools: config.agent[name].tools, agent: name, profile, conclude};
  };

  return {
    name: 'opencode',

    async launch({profile, orders = '', cwd, dir}) {
      return start({profile, stdin: String(orders), cwd, dir});
    },

    async resume({profile, native = {}, message = '', cwd, dir}) {
      const texts = takePending(pendingPath(dir));
      return start({profile, session: native?.sessionId ?? null, stdin: [...texts, String(message)].join('\n'), cwd, dir});
    },

    // Never throws: every terminal condition of the process becomes an event and ends the stream.
    async *events(handle) {
      let announced = false, lastText = null, lastError = null, tail = '', refused = null;
      const repeats = new Map();
      let stepActed = false, emptySteps = 0, concluded = false, reads = 0, stalled = false;
      const plain = text => String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/^[!\s]+/, '').trim();
      for await (const event of handle.live.events) {
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
          if (stalled && reads > 0 && !handle.conclude && handle.sessionId) {
            yield {kind: 'diagnostic', text: `stalled after reading ${reads} file${reads === 1 ? '' : 's'}; asked once, tools off, for its conclusion`};
            const again = start({profile: handle.profile, session: handle.sessionId, stdin: CONCLUDE_PROMPT, cwd: handle.cwd, dir: handle.dir, conclude: true});
            handle.child = again.child; handle.pid = again.pid; // cancel() must reach the turn that is running now
            let answer = null;
            for await (const e of this.events(again)) { if (e.kind === 'result') { answer = e.status === 'completed' ? e.text : null; break; } if (e.kind !== 'result') yield e; }
            if (answer !== null) { yield {kind: 'diagnostic', text: 'the conclusion turn answered: that answer is the result'}; yield {kind: 'result', status: 'completed', text: answer}; return; }
            yield {kind: 'diagnostic', text: 'the conclusion turn gave no answer'};
          }
          if ((event.code === 0 || concluded) && lastText !== null && !lastError) yield {kind: 'result', status: 'completed', text: lastText};
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
          if (part.text.trim()) { const said = part.text.trim(); if (/[\p{L}\p{N}]/u.test(said)) lastText = said; stepActed = true; yield {kind: 'assistant', text: said}; }
        } else if (raw.type === 'tool_use') {
          const status = part.state?.status ?? '';
          stepActed = true;
          yield {kind: 'activity', text: `${part.tool ?? 'tool'} ${status}`.trim()};
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
          const usage = mapUsage(part.tokens);
          if (Object.keys(usage).length) yield {kind: 'usage', usage};
          emptySteps = stepActed ? 0 : emptySteps + 1;
          stepActed = false;
          if (emptySteps >= EMPTY_STEP_LIMIT && !concluded && !lastError) {
            if (lastText !== null) concluded = true; // it already answered: that answer is the result
            else lastError = `no progress: ${EMPTY_STEP_LIMIT} empty steps and no answer`;
            yield {kind: 'diagnostic', text: concluded ? `ended the turn after ${EMPTY_STEP_LIMIT} empty steps; the worker had already answered` : lastError};
            void verifiedCancel(handle.child, {kill});
          }
        } else if (raw.type === 'step_start') {
          yield {kind: 'activity', text: ''};
        } else if (raw.type === 'error') {
          lastError = String(raw.error?.data?.message ?? raw.error?.message ?? raw.error?.name ?? 'opencode error').slice(0, 1000);
          yield {kind: 'diagnostic', text: lastError};
        }
      }
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

    capabilities() {
      return {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], executionPolicies: ['read-only', 'plan', 'write', 'yolo'], quota: 'stream'};
    },

    pending: dir => readPending(pendingPath(dir)),
  };
}
