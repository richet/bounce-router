import {spawn as nodeSpawn} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {invocation, normalize} from '../providers.js';
import {resolveExecutable} from '../executable.js';
import muse from './muse.js';
import {TEXT_MAX, appendPending, promptSafe, readPending, spawnLive, takePending, vendorEnv, verifiedCancel} from './live-common.js';

const field = value => value === undefined || value === null || value === '' ? 'none' : promptSafe(value);

// Maps the transport's events onto this adapter's event contract. `raw` precedes each
// normalized batch so recordQuota sees the vendor line; the exit code only becomes a
// result when the stream carried none, so a real terminal line always wins.
async function* museEvents(live) {
  let sawResult = false;
  for await (const event of live.events) {
    if (event.kind === 'line') {
      let raw;
      try { raw = JSON.parse(event.text); } catch { yield {kind: 'status', text: event.text}; continue; }
      yield {kind: 'raw', raw};
      for (const normalized of normalize('muse', raw)) {
        sawResult ||= normalized.kind === 'result';
        // The scheduler only recognizes the adapter-event spelling 'native' (see scheduler.js);
        // the provider layer emits the journal spelling 'peer.native'.
        if (normalized.kind === 'peer.native') { yield {kind: 'native', provider: normalized.provider, sessionId: normalized.sessionId}; continue; }
        // Same gap for 'result': the provider layer reports success/failure as a boolean, but the
        // scheduler (and the exit-code fallback below) only ever look at event.status.
        if (normalized.kind === 'result') { yield {kind: 'result', text: normalized.text, status: normalized.success ? 'completed' : 'failed'}; continue; }
        yield normalized;
      }
    } else if (event.kind === 'diagnostic') yield event;
    else if (event.kind === 'error') { yield {kind: 'error', code: event.code, text: event.text}; return; }
    else if (!sawResult) yield {kind: 'result', status: event.limited ? 'limited' : event.code === 0 ? 'completed' : 'failed'};
  }
}

export function createMuseLive({spawn = nodeSpawn, kill = process.kill} = {}) {
  // `muse` reads its prompt from --prompt-file, never stdin, so no shell is ever involved.
  const start = ({promptFile, profile = {}, cwd, dir, native}) => new Promise((resolve, reject) => {
    const executable = resolveExecutable('muse', profile.executables?.muse);
    const args = invocation('muse', {model: profile.model, mode: profile.mode}, promptFile);
    const live = spawnLive({executable, args, cwd, env: vendorEnv(), stdin: muse.stdin(), spawn});
    // A spawn failure is the one outcome the caller cannot act on through the stream:
    // the scheduler maps `.code === 'missing'` to task.failed{reason:'missing'}.
    live.child.once('error', error => {
      const failure = new Error(`muse failed to launch: ${error.message}`);
      failure.code = error.code === 'ENOENT' ? 'missing' : error.code;
      reject(failure);
    });
    // C1: launch/resume resolve to the handle itself, never {handle}.
    live.child.once('spawn', () => resolve({
      child: live.child, dir, args, promptFile, native: native ?? null, events: museEvents(live),
    }));
  });

  return {
    name: 'muse',

    async launch({peer, profile, orders, cwd, dir}) {
      // C2: dir is the scheduler's, already created (0700) before launch. Kept defensively
      // (recursive, so a no-op against an existing 0700 dir) because launch writes orders.txt
      // into dir itself and the conformance suite's direct-call case doesn't pre-create it.
      mkdirSync(dir, {recursive: true, mode: 0o700});
      const promptFile = join(dir, 'orders.txt');
      writeFileSync(promptFile, orders);
      return start({promptFile, profile, cwd, dir, native: peer?.native});
    },

    // Single-consumer: one process, one stream, so the second caller gets what the first left.
    events(handle) { return handle.events; },

    // Always 'queued': nothing verified pushes text into a running muse turn, so the honest
    // claim is a file the next launch reads. A refused append (cap or size) still reports
    // 'queued' — the tier describes the channel, not whether this message made the cut.
    async deliver(handle, {text}) {
      // C4: coerce first, then cap — a text over TEXT_MAX is queued without ever touching the file.
      const value = String(text);
      if (value.length > TEXT_MAX) return 'queued';
      appendPending(join(handle.dir, 'pending.jsonl'), value);
      return 'queued';
    },

    // Re-launch, not a native continuation: the prompt is a compact checkpoint —
    // last milestone, blocker and the queued messages — never a transcript.
    async resume({native, message, cwd, dir, profile, checkpoint = {}}) {
      // Kept here (unlike launch): resume is not yet scheduler-driven (Phase 4), so dir may not exist.
      mkdirSync(dir, {recursive: true, mode: 0o700});
      // Every peer-supplied line is flattened: nothing queued may forge the template.
      const pending = takePending(join(dir, 'pending.jsonl')).map(promptSafe);
      const promptFile = join(dir, 'resume.txt');
      writeFileSync(promptFile, `Resume. Last milestone: ${field(checkpoint.lastMilestone)}\n`
        + `Blocker: ${field(checkpoint.blocker)}\n`
        + `Pending messages:\n${pending.length ? pending.join('\n') : 'none'}\n\n${message}\n`);
      return start({promptFile, profile, cwd, dir, native});
    },

    pending(handle) { return readPending(join(handle.dir, 'pending.jsonl')); },

    cancel(handle) { return verifiedCancel(handle.child, {kill}); },

    capabilities: muse.capabilities,
  };
}
