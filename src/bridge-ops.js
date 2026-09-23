// The agent-facing interface (docs/plans/bridge-interface.md). Bounce speaks to the agents it runs through
// exactly these verbs; every transport — the shell bridge (src/bridge.js), the MCP server (src/mcp.js) — is
// a skin that translates argv or a tool call into one of them and its result back out. A transport holds no
// default, no limit, no policy and no error text: a capability a transport needs is a verb here first.
//
// Found live: with no read verb, the orchestrator read its own journal with `tail` and
// `jq`, and 143 KB of raw JSON landed in the chat, the journal and its own next context packet.
import fs from 'node:fs';
import {connectBus} from './bus.js';

export const DEFAULT_WAIT_MS = 30_000;
// One bus wait is capped in src/bus.js (handleWait); a longer wait — a task deadline is the natural one —
// is re-armed in chunks, each re-scanning the log, so a row landing between chunks is still returned.
export const WAIT_CHUNK_MS = 600_000;

// Which credential a caller holds. A report grant is attempt-scoped on purpose: a worker cannot turn it into
// the general publish/wait capability, whatever transport it speaks through.
export function credentials(env = process.env, {reporting = false} = {}) {
  const path = reporting ? env.BOUNCE_REPORT_BUS : env.BOUNCE_BUS;
  const tokenFile = reporting ? env.BOUNCE_REPORT_TOKEN_FILE : env.BOUNCE_BUS_TOKEN_FILE;
  if (!path || !tokenFile) {
    const names = reporting ? 'BOUNCE_REPORT_BUS and BOUNCE_REPORT_TOKEN_FILE' : 'BOUNCE_BUS and BOUNCE_BUS_TOKEN_FILE';
    return {ok: false, reason: `${names} must be set (this runs inside a bounce session)`};
  }
  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch (error) { return {ok: false, reason: `cannot read token file: ${error.message}`}; }
  return {ok: true, path, token};
}

// Every verb resolves to {ok: true, row|rows|view} or {ok: false, reason, code}: a transport decides how to
// say it, never what it says. Nothing here throws for an expected failure.
export function createOps({env = process.env, connect = connectBus, clock = () => Date.now(), waitChunkMs = WAIT_CHUNK_MS} = {}) {
  async function withClient(reporting, use) {
    const credential = credentials(env, {reporting});
    if (!credential.ok) return {ok: false, reason: credential.reason, code: 'no_credential'};
    let client;
    try { client = await connect({path: credential.path, token: credential.token}); }
    catch (error) { return {ok: false, reason: error.message, code: error.code ?? -32001}; }
    try { return await use(client); }
    catch (error) { return {ok: false, reason: error.message, code: error.code ?? -32001}; }
    finally { try { await client.close(); } catch {} }
  }

  return {
    submit: event => withClient(false, async client => ({ok: true, row: await client.publish(event)})),
    report: payload => withClient(true, async client => ({ok: true, row: await client.report(payload)})),
    // The orchestrator's own memory: one living note it rewrites each turn (docs/plans/orchestrator-memory.md).
    state: text => withClient(false, async client => ({ok: true, row: await client.publish({kind: 'state', text: String(text ?? '')})})),
    wait: (match, {timeout = DEFAULT_WAIT_MS, afterSeq = 0} = {}) => withClient(false, async client => {
      const deadline = clock() + timeout;
      let row = null;
      do {
        row = await client.wait({match, timeout: Math.min(Math.max(deadline - clock(), 0), waitChunkMs), afterSeq});
      } while (!row && clock() < deadline);
      return {ok: true, row, timedOut: !row};
    }),
  };
}
