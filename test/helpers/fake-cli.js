#!/usr/bin/env node
// Fake vendor CLI for daemon/bridge acceptance tests: ignores stdin/args, prints one
// codex-style `turn.completed` line, and exits 0 — so `bounce run` completes a real
// (fake) turn without ever spawning a real vendor CLI.
//
// FAKE_CLI_HANG=1: never finish (a task that never completes).
// FAKE_CLI_PROBE_ENV=1: first print an agent_message row whose text is
//   {bus, token} read from this process's own env (BOUNCE_BUS / BOUNCE_BUS_TOKEN_FILE,
//   or 'absent') — used to prove those are never handed to a vendor CLI.
// FAKE_CLI_WAIT_FILE=<path>: poll for that file to exist before printing the
//   completed line — lets a test control exactly when this "turn" finishes instead
//   of racing a fixed delay.
process.stdin.resume();

async function main() {
  if (process.env.FAKE_CLI_HANG === '1') {
    setInterval(() => {}, 1000); // an active handle, unlike a bare unresolved Promise, actually keeps the process alive
    return;
  }
  if (process.env.FAKE_CLI_PROBE_ENV === '1') {
    const probe = {bus: process.env.BOUNCE_BUS ?? 'absent', token: process.env.BOUNCE_BUS_TOKEN_FILE ?? 'absent'};
    console.log(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(probe)}}));
  }
  const waitFile = process.env.FAKE_CLI_WAIT_FILE;
  if (waitFile) {
    const fs = await import('node:fs');
    while (!fs.existsSync(waitFile)) await new Promise(r => setTimeout(r, 20));
  }
  console.log(JSON.stringify({type: 'turn.completed', usage: {}}));
  process.exit(0);
}
main();
