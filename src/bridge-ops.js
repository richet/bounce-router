// The agent-facing interface (docs/plans/bridge-interface.md). Bounce speaks to the agents it runs through
// exactly these verbs; every transport — the shell bridge (src/bridge.js), the MCP server (src/mcp.js) — is
// a skin that translates argv or a tool call into one of them and its result back out. A transport holds no
// default, no limit, no policy and no error text: a capability a transport needs is a verb here first.
//
// Found live: with no read verb, the orchestrator read its own journal with `tail` and
// `jq`, and 143 KB of raw JSON landed in the chat, the journal and its own next context packet.
import fs from 'node:fs';
import nodePath from 'node:path';
import {connectBus} from './bus.js';
import {listSessions} from './sessions.js';

export const DEFAULT_WAIT_MS = 30_000;
// One bus wait is capped in src/bus.js (handleWait); a longer wait — a task deadline is the natural one —
// is re-armed in chunks, each re-scanning the log, so a row landing between chunks is still returned.
export const WAIT_CHUNK_MS = 600_000;

// Which credential a caller holds. A report grant is attempt-scoped on purpose: a worker cannot turn it into
// the general publish/wait capability, whatever transport it speaks through.
// The session a client-launched server should act on: the live one, found the way `bounce task` finds it.
// It refuses rather than guesses — no live session, or more than one, is answered with a reason the caller
// can act on. Writing into the wrong campaign is worse than not writing.
export function liveSessionCredentials(root, {list = null, readdir = fs.readdirSync} = {}) {
  const sessions = (list ?? listSessions)(root);
  const live = sessions.filter(row => row.live);
  if (!live.length) return {ok: false, reason: 'no live bounce session on this machine: start one with `bounce`, or set BOUNCE_BUS and BOUNCE_BUS_TOKEN_FILE'};
  if (live.length > 1) return {ok: false, reason: `${live.length} live bounce sessions (${live.map(row => row.id.slice(0, 8)).join(', ')}): set BOUNCE_BUS and BOUNCE_BUS_TOKEN_FILE to name the one you mean`};
  const home = nodePath.join(root, 'sessions', live[0].id);
  let token = null;
  try { token = readdir(nodePath.join(home, 'tokens')).find(name => name.startsWith('orchestrator-')) ?? null; } catch {}
  if (!token) return {ok: false, reason: `session ${live[0].id.slice(0, 8)} has no orchestrator grant yet: it is not running in orchestrator mode, or has not started its first turn`};
  return {ok: true, path: nodePath.join(home, 'bus.sock'), tokenFile: nodePath.join(home, 'tokens', token), session: live[0].id};
}

// A server the vendor client launches — `bounce mcp-serve` from codex's own config — never receives the
// per-session grant, because bounce did not spawn it. `discover` is how such a transport finds the session
// itself; the env grant always wins when it is there, and the discovery's own refusal reaches the caller
// verbatim so it can say WHY rather than "must be set".
export function credentials(env = process.env, {reporting = false, discover = null} = {}) {
  let path = reporting ? env.BOUNCE_REPORT_BUS : env.BOUNCE_BUS;
  let tokenFile = reporting ? env.BOUNCE_REPORT_TOKEN_FILE : env.BOUNCE_BUS_TOKEN_FILE;
  if ((!path || !tokenFile) && discover && !reporting) {
    const found = discover();
    if (!found.ok) return {ok: false, reason: found.reason};
    ({path, tokenFile} = found);
  }
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
export function createOps({env = process.env, connect = connectBus, clock = () => Date.now(), waitChunkMs = WAIT_CHUNK_MS, discover = null} = {}) {
  async function withClient(reporting, use) {
    const credential = credentials(env, {reporting, discover});
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
