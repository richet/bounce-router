import {createConnection as nodeConnect} from 'node:net';
import nodeFs from 'node:fs';
import claude from './claude.js';
import {resolveExecutable} from '../executable.js';
import {limitPattern} from '../providers.js';
import {spawnLive, vendorEnv, verifiedCancel, appendPending, readPending, takePending, TEXT_MAX} from './live-common.js';

const WRITE_WAIT = 2000; // how long a live push waits for the turn to take the message

// CONTRACT.md #5: live adapters yield usage already normalized to {input, cache_read,
// cache_write, output} — only the keys the vendor actually reported, integers — so
// reducers.spend never has to know a vendor's field names. claude: input_tokens→input,
// cache_read_input_tokens→cache_read, cache_creation_input_tokens→cache_write,
// output_tokens→output. The classic normalizer (src/adapters/claude.js) keeps yielding the
// raw vendor shape unchanged — only this live adapter maps it before yielding.
const USAGE_FIELDS = [['input_tokens', 'input'], ['cache_read_input_tokens', 'cache_read'],
  ['cache_creation_input_tokens', 'cache_write'], ['output_tokens', 'output']];
const mapUsage = raw => {
  const usage = {};
  for (const [from, to] of USAGE_FIELDS) if (Number.isInteger(raw?.[from])) usage[to] = raw[from];
  return usage;
};

// Single-quote for the shell the CLI runs the hook command in; a quote inside the path is closed,
// escaped and reopened, so a task directory with spaces or quotes still writes to the right file.
export const shellQuote = value => `'${String(value).replace(/'/g, "'\\''")}'`;

// Passed verbatim inside --settings; claude runs it with the messaging socket and token already
// exported, so the hook — not bounce — is what writes the file, and only for this user (0600).
export const hookCommand = dir =>
  `node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({socket:process.env.CLAUDE_CODE_MESSAGING_SOCKET,token:process.env.CLAUDE_CODE_MESSAGING_TOKEN}),{mode:0o600})" ${shellQuote(`${dir}/messaging.json`)}`;

export const settingsFor = dir => JSON.stringify({hooks: {SessionStart: [{hooks: [{type: 'command', command: hookCommand(dir)}]}]}});

export function createClaudeLive({connect = nodeConnect, fs = nodeFs, kill = process.kill, spawn, writeWait = WRITE_WAIT} = {}) {
  const pendingPath = dir => `${dir}/pending.jsonl`;
  const messagingPath = dir => `${dir}/messaging.json`;

  const start = ({profile = {}, extraArgs = [], stdin, cwd, dir}) => {
    const {model, mode, images = []} = profile;
    const executable = resolveExecutable('claude', profile.executables?.claude);
    const args = [...claude.invocation({model, mode, images}), ...extraArgs, '--settings', settingsFor(dir)];
    const live = spawnLive({executable, args: [...args, ...(profile.orchestratorEnv ? ['--disallowedTools', 'Agent,Task'] : [])], cwd, env: vendorEnv(process.env, {...profile.orchestratorEnv, ...profile.report}), stdin: claude.stdin(stdin), ...(spawn ? {spawn} : {})});
    return {live, child: live.child, pid: live.child.pid, args, dir, cwd, sessionId: null};
  };

  return {
    async launch({peer, profile, orders, cwd, dir, userImages = []}) {
      return start({profile: {...profile, images: userImages}, stdin: orders, cwd, dir});
    },

    async resume({peer, profile, native, message, cwd, dir, userImages = []}) {
      const texts = takePending(pendingPath(dir));
      return start({profile: {...profile, images: userImages}, extraArgs: ['--resume', native.sessionId], stdin: [...texts, message].join('\n'), cwd, dir});
    },

    // Never throws: every terminal condition of the process becomes an event and ends the stream.
    // A failed result is `limited` when the error channel (an is_error result, a rejected
    // rate_limit_event, or the stderr tail on exit) carries the vendor's usage-limit text —
    // the same providers.limitPattern the classic runProcess path classifies with.
    async *events(handle) {
      let sawResult = false, limited = false;
      for await (const event of handle.live.events) {
        if (event.kind === 'diagnostic') { yield event; continue; }
        if (event.kind === 'error') { yield {kind: 'error', code: event.code, text: event.text}; return; }
        if (event.kind === 'exit') {
          if (!sawResult) yield {kind: 'result', status: event.limited ? 'limited' : 'failed', text: 'protocol error: claude exited without result'};
          return;
        }
        let raw;
        try { raw = JSON.parse(event.text); } catch { yield {kind: 'status', text: event.text}; continue; }
        yield {kind: 'raw', raw}; // the scheduler journals raw rows for quota, before the normalized view
        // Resuming a session that left background tasks behind, Claude Code reports them and emits an
        // EMPTY result — zero model turns — BEFORE it runs the prompt it was given (reproduced with
        // the real CLI, 2.1.278). Whoever consumes this stream ends the turn at the first result, so
        // that one must not count: the orchestrator's hand-off was being swallowed by it.
        if (raw?.type === 'result' && raw.num_turns === 0 && raw.is_error !== true && !String(raw.result ?? '').trim()) {
          yield {kind: 'diagnostic', text: 'claude reported leftover background tasks with an empty result; waiting for the turn itself'};
          continue;
        }
        for (const normalized of claude.normalize(raw)) {
          if (normalized.kind === 'peer.native') {
            handle.sessionId = normalized.sessionId;
            yield {kind: 'native', provider: normalized.provider, sessionId: normalized.sessionId};
            continue;
          }
          if (normalized.kind === 'error') limited ||= limitPattern.test(normalized.text);
          if (normalized.kind === 'result') {
            sawResult = true;
            yield {kind: 'result', text: normalized.text, success: normalized.success, status: normalized.success ? 'completed' : limited ? 'limited' : 'failed'};
            continue;
          }
          if (normalized.kind === 'usage') { yield {kind: 'usage', usage: mapUsage(normalized.usage)}; continue; }
          yield normalized;
        }
      }
      if (!sawResult) yield {kind: 'result', status: 'failed', text: 'protocol error: claude stream ended without result'};
    },

    async deliver(handle, {text}) {
      text = String(text);
      const queue = () => {
        if (handle.live.exited() && !handle.sessionId) return 'queued';
        return appendPending(pendingPath(handle.dir), text) ? 'next-turn' : 'queued';
      };
      if (text.length > TEXT_MAX) return 'queued';
      let messaging = null;
      try { messaging = JSON.parse(fs.readFileSync(messagingPath(handle.dir), 'utf8')); } catch {}
      if (typeof messaging?.socket !== 'string' || !messaging.socket) return queue();
      const delivered = await new Promise(resolve => {
        let settled = false, wrote = false, socket = null;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { socket?.end(); socket?.destroy(); } catch {}
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), writeWait);
        try {
          socket = connect(messaging.socket.replace(/^uds:/, ''));
          socket.on('error', () => finish(false));
          socket.on('close', () => finish(wrote)); // only a turn that took the message and closed counts as live
          socket.on('connect', () => {
            socket.write(JSON.stringify({type: 'auth', token: messaging.token}) + '\n');
            socket.end(JSON.stringify({type: 'user', message: {role: 'user', content: text}}) + '\n');
            wrote = true;
          });
        } catch { finish(false); }
      });
      return delivered ? 'live' : queue();
    },

    async cancel(handle) {
      return verifiedCancel(handle.child, {kill});
    },

    capabilities() {
      return {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], executionPolicies: ['read-only', 'plan', 'yolo'], quota: 'stream'};
    },

    pending: dir => readPending(pendingPath(dir)),
  };
}
