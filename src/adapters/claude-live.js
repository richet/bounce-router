import {createConnection as nodeConnect} from 'node:net';
import nodeFs from 'node:fs';
import claude from './claude.js';
import {spawnLive, vendorEnv, verifiedCancel, appendPending, readPending, takePending, TEXT_MAX} from './live-common.js';

const WRITE_WAIT = 2000; // how long a live push waits for the turn to take the message

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
    const {executable = 'claude', preArgs = [], model, mode, images = []} = profile;
    const args = [...preArgs, ...claude.invocation({model, mode, images}), ...extraArgs, '--settings', settingsFor(dir)];
    const live = spawnLive({executable, args, cwd, env: vendorEnv(), stdin: claude.stdin(stdin), ...(spawn ? {spawn} : {})});
    return {handle: {live, child: live.child, pid: live.child.pid, args, dir, cwd, sessionId: null}};
  };

  return {
    async launch({peer, profile, orders, cwd, dir}) {
      return start({profile, stdin: orders, cwd, dir});
    },

    async resume({peer, profile, native, message, cwd, dir}) {
      const texts = takePending(pendingPath(dir));
      return start({profile, extraArgs: ['--resume', native.sessionId], stdin: [...texts, message].join('\n'), cwd, dir});
    },

    // Never throws: every terminal condition of the process becomes an event and ends the stream.
    async *events(handle) {
      let sawResult = false;
      for await (const event of handle.live.events) {
        if (event.kind === 'diagnostic') { yield event; continue; }
        if (event.kind === 'error') { yield {kind: 'error', code: event.code, text: event.text}; return; }
        if (event.kind === 'exit') {
          if (!sawResult) yield {kind: 'result', status: event.limited ? 'limited' : event.code === 0 ? 'completed' : 'failed'};
          return;
        }
        let raw;
        try { raw = JSON.parse(event.text); } catch { yield {kind: 'status', text: event.text}; continue; }
        yield {kind: 'raw', raw}; // the scheduler journals raw rows for quota, before the normalized view
        for (const normalized of claude.normalize(raw)) {
          if (normalized.kind === 'peer.native') handle.sessionId = normalized.sessionId;
          if (normalized.kind === 'result') sawResult = true;
          yield normalized;
        }
      }
    },

    async deliver(handle, {text}) {
      const queue = () => {
        if (handle.live.exited() && !handle.sessionId) return 'queued';
        return appendPending(pendingPath(handle.dir), text) ? 'next-turn' : 'queued';
      };
      if (typeof text !== 'string' || text.length > TEXT_MAX) return 'queued';
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
            socket.write(JSON.stringify({text}) + '\n');
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
      return {live: true, resume: true, modelPin: true, policies: ['yolo', 'plan'], quota: 'stream'};
    },

    pending: dir => readPending(pendingPath(dir)),
  };
}
