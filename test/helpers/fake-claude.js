#!/usr/bin/env node
// Fake `claude -p` for the live-adapter tests. It never touches a real CLI: it binds the
// messaging socket itself, really executes the SessionStart hook command it finds in its own
// `--settings` argv (so messaging.json is written by the hook, not faked), streams a
// claude-shaped system/init + result pair, and records what it received.
//
// FAKE_SOCKET=<path>      bind a unix socket there and export CLAUDE_CODE_MESSAGING_SOCKET=uds:<path>
// FAKE_TOKEN=<string>     value exported as CLAUDE_CODE_MESSAGING_TOKEN (default 'tok-fake')
// FAKE_SESSION=<string>   session_id on the init/result lines (default 'sess-fake')
// FAKE_RECEIVED=<path>    append every line received on the socket, verbatim
// FAKE_STDIN=<path>       write everything read on stdin
// FAKE_HOLD=1             stay alive after the init line (a running turn) instead of finishing
// FAKE_TRAP_SIGTERM=1     install a no-op SIGTERM handler, so only SIGKILL ends it
// FAKE_READY=<path>       touch this file once the SIGTERM disposition above is settled — a test
//                         that cancels must gate on it, or it races the interpreter's boot
// FAKE_STDERR_LINES=<n>   write n 1,000-character lines to stderr before finishing
// FAKE_USAGE=<json>       usage object on the result line (default '{}' — vendor field names)
import {execSync} from 'node:child_process';
import {createServer} from 'node:net';
import fs from 'node:fs';
import {createInterface} from 'node:readline';

const argv = process.argv.slice(2);
const settings = argv[argv.indexOf('--settings') + 1];
const socketPath = process.env.FAKE_SOCKET;
const token = process.env.FAKE_TOKEN ?? 'tok-fake';
const received = process.env.FAKE_RECEIVED;

if (process.env.FAKE_TRAP_SIGTERM === '1') process.on('SIGTERM', () => {});

const start = async () => {
  if (socketPath) await new Promise(resolve => {
    const server = createServer(socket => {
      createInterface({input: socket}).on('line', line => {
        if (received) fs.appendFileSync(received, line + '\n');
        if (!line.includes('"auth"')) socket.end(); // the turn consumed the message
      });
    });
    server.listen(socketPath, () => { server.unref(); resolve(); }); // must not outlive the turn itself
  });
  // The real CLI exports these before any hook runs; the hook command reads them from its env.
  if (argv.includes('--settings')) {
    const command = JSON.parse(settings).hooks.SessionStart[0].hooks[0].command;
    // A hook that dies with the process group must not turn into a crash of the worker itself.
    try {
      execSync(command, {env: {...process.env,
        CLAUDE_CODE_MESSAGING_SOCKET: socketPath ? `uds:${socketPath}` : '',
        CLAUDE_CODE_MESSAGING_TOKEN: token}});
    } catch {}
  }
  const sessionId = process.env.FAKE_SESSION ?? 'sess-fake';
  console.log(JSON.stringify({type: 'system', subtype: 'init', session_id: sessionId, tools: []}));
  const noisy = Number(process.env.FAKE_STDERR_LINES ?? 0);
  for (let n = 0; n < noisy; n++) process.stderr.write('d'.repeat(1000) + '\n');
  let stdin = '';
  process.stdin.on('data', chunk => { stdin += chunk; });
  await new Promise(resolve => process.stdin.on('end', resolve));
  if (process.env.FAKE_STDIN) fs.writeFileSync(process.env.FAKE_STDIN, stdin);
  // Only here is the worker past every synchronous startup step, so its SIGTERM disposition
  // is the one a cancel will actually meet. A cancelling test must gate on this marker.
  if (process.env.FAKE_READY) fs.writeFileSync(process.env.FAKE_READY, 'ready');
  if (process.env.FAKE_HOLD === '1') { setInterval(() => {}, 1000); return; }
  const usage = process.env.FAKE_USAGE ? JSON.parse(process.env.FAKE_USAGE) : {};
  console.log(JSON.stringify({type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, usage}));
  process.exitCode = 0;
};
start();
