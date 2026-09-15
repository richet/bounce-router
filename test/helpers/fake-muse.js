#!/usr/bin/env node
// Fake `muse exec --json` for the muse-live adapter tests: never the real CLI.
// Reads --prompt-file from its own argv and echoes that file's content back as a
// run.output.delta, so a test can prove exactly what prompt the adapter wrote.
// Prints run.model.configured, (optional probes), the echo delta, then
// run.terminal.completed, and exits 0 once its output has drained.
//
// FAKE_MUSE_HANG=1: print run.model.configured, then stay alive forever (cancel tests).
// FAKE_MUSE_TRAP=1: as HANG, but also swallow SIGTERM, so only SIGKILL ends it.
// FAKE_MUSE_STDERR_MB=<n>: write n MB to stderr before finishing — a reader that does
//   not drain stderr deadlocks here instead of reaching the completed line.
// FAKE_MUSE_LIMITED=1: write a quota refusal to stderr and exit 1 with no terminal line.
// FAKE_MUSE_PROBE_ENV=1: first print a delta whose text is the JSON of every
//   BOUNCE_BUS* / BOUNCE_REMOTE_SESSION key visible in this process's env
//   ({"bus":"none","token":"none","remote":"none","busKeys":[]} when stripped).
import {readFileSync, writeSync} from 'node:fs';

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
const line = (payload_type, payload) => console.log(JSON.stringify({payload_type, payload}));

// Installed before the first line so that a test which waits for output knows the trap
// is already armed — otherwise a fast SIGTERM races the handler and kills by default.
if (process.env.FAKE_MUSE_TRAP === '1') process.on('SIGTERM', () => {});

line('run.model.configured', {model_id: flag('--model') ?? 'muse-fake', run_id: 'r-fake-1'});

if (process.env.FAKE_MUSE_HANG === '1' || process.env.FAKE_MUSE_TRAP === '1') {
  setInterval(() => {}, 1000); // an active handle keeps the process alive, unlike a bare pending Promise
} else if (process.env.FAKE_MUSE_LIMITED === '1') {
  writeSync(2, 'muse: rate limit exceeded, try again later\n');
  process.exit(1);
} else {
  const mb = Number(process.env.FAKE_MUSE_STDERR_MB ?? 0);
  // Through the stream, never writeSync(2): once console.log has initialised stdio, macOS
  // pipes are non-blocking and a 64 KB writeSync throws EAGAIN when the pipe is full. The
  // stream queues instead, and the natural exit below holds the process open until the
  // reader has drained it — so an adapter that never drains stderr still hangs here.
  for (let i = 0; i < mb * 16; i++) process.stderr.write('x'.repeat(65536) + '\n');
  if (process.env.FAKE_MUSE_PROBE_ENV === '1') line('run.output.delta', {text: JSON.stringify({
    bus: process.env.BOUNCE_BUS ?? 'none',
    token: process.env.BOUNCE_BUS_TOKEN_FILE ?? 'none',
    remote: process.env.BOUNCE_REMOTE_SESSION ?? 'none',
    busKeys: Object.keys(process.env).filter(k => k.startsWith('BOUNCE_BUS')),
  })});
  line('run.output.delta', {text: readFileSync(flag('--prompt-file'), 'utf8')});
  line('run.terminal.completed', {terminal: 'completed', text: 'done', run_id: 'r-fake-1'});
  process.exitCode = 0; // no process.exit(): let the event loop flush stdout and stderr first
}
