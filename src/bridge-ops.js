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
  // `createBus` may need a short fallback outside the session directory. daemon.json
  // is the daemon's published endpoint; deriving bus.sock here silently binds reads
  // and writes to different places on long BOUNCE_HOME paths.
  let daemon = null;
  try { daemon = JSON.parse(fs.readFileSync(nodePath.join(home, 'daemon.json'), 'utf8')); } catch {}
  let token = null;
  try { token = readdir(nodePath.join(home, 'tokens')).find(name => name.startsWith('orchestrator-')) ?? null; } catch {}
  if (!token) return {ok: false, reason: `session ${live[0].id.slice(0, 8)} has no orchestrator grant yet: it is not running in orchestrator mode, or has not started its first turn`};
  return {ok: true, path: daemon?.bus || nodePath.join(home, 'bus.sock'), tokenFile: nodePath.join(home, 'tokens', token), session: live[0].id,
    incarnation: daemon?.started ?? null};
}

// A binding is selected exactly once, then refreshed only for that same session. This
// is what prevents an MCP server from reading session A after session B has appeared.
export function sessionBinding(root, {env = process.env, discover = liveSessionCredentials} = {}) {
  const explicit = env.BOUNCE_SESSION;
  const envBus = env.BOUNCE_BUS;
  let selected = null;
  const choose = () => {
    if (selected) return {ok: true, session: selected};
    if (explicit) {
      const rows = listSessions(root);
      const matches = rows.filter(row => row.id === explicit || row.id.startsWith(explicit));
      if (matches.length !== 1) return {ok: false, code: 'session_not_found', reason: `session ${explicit} is not an unambiguous session`, repair: 'set BOUNCE_SESSION to one full session id'};
      selected = matches[0].id;
      return {ok: true, session: selected};
    }
    // A server launched inside a session keeps its own grant. Match that endpoint to
    // the session record so its reads share the binding without replacing a worker or
    // user capability with the orchestrator token.
    if (envBus) {
      const matches = listSessions(root).filter(row => row.live && (() => {
        try { return JSON.parse(fs.readFileSync(nodePath.join(root, 'sessions', row.id, 'daemon.json'), 'utf8')).bus === envBus; }
        catch { return false; }
      })());
      if (matches.length !== 1) return {ok: false, code: 'session_binding_unresolved', reason: 'the supplied BOUNCE_BUS does not identify one live session', repair: 'set BOUNCE_SESSION to the intended session id'};
      selected = matches[0].id;
      return {ok: true, session: selected};
    }
    const found = discover(root);
    if (!found.ok) return found;
    selected = found.session;
    return {ok: true, session: selected};
  };
  const read = () => {
    const chosen = choose();
    if (!chosen.ok) return chosen;
    const home = nodePath.join(root, 'sessions', chosen.session);
    let daemon = null;
    try { daemon = JSON.parse(fs.readFileSync(nodePath.join(home, 'daemon.json'), 'utf8')); } catch {}
    const conventional = nodePath.join(home, 'bus.sock');
    if (envBus && envBus !== daemon?.bus && envBus !== conventional) return {ok: false, code: 'session_bus_mismatch', reason: `BOUNCE_BUS does not belong to session ${chosen.session.slice(0, 8)}`, repair: 'set BOUNCE_SESSION to the session that owns BOUNCE_BUS, or unset one of them'};
    return {ok: true, session: chosen.session, path: envBus || daemon?.bus || conventional, journal: nodePath.join(home, 'journal.jsonl'), incarnation: daemon?.started ?? null};
  };
  const refresh = () => {
    const bound = read();
    if (!bound.ok) return bound;
    const home = nodePath.join(root, 'sessions', bound.session);
    // Discovery never lends a stale token to a dead session. Explicit offline sessions
    // remain readable through read(), but cannot mutate until their daemon is live.
    if (!envBus && !listSessions(root).some(row => row.id === bound.session && row.live)) return {ok: false, code: 'session_not_live', reason: `session ${bound.session.slice(0, 8)} is not live`, repair: 'resume that session before submitting or waiting'};
    const tokenFile = envBus ? env.BOUNCE_BUS_TOKEN_FILE : (() => {
      try { const token = fs.readdirSync(nodePath.join(home, 'tokens')).find(name => name.startsWith('orchestrator-')) ?? null; return token && nodePath.join(home, 'tokens', token); } catch { return null; }
    })();
    if (!tokenFile) return {ok: false, code: 'missing_grant', reason: `session ${bound.session.slice(0, 8)} has no usable bridge grant`, repair: 'start or resume that session with its bridge grant'};
    let token;
    try { token = fs.readFileSync(tokenFile, 'utf8').trim(); } catch (error) { return {ok: false, code: 'missing_grant', reason: `cannot read token file: ${error.message}`, repair: 'refresh the session bridge grant'}; }
    return {...bound, tokenFile, token};
  };
  return {read, refresh, session: () => selected};
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
export function createOps({env = process.env, connect = connectBus, clock = () => Date.now(), waitChunkMs = WAIT_CHUNK_MS, discover = null, binding = null} = {}) {
  async function withClient(reporting, use) {
    const credential = reporting ? credentials(env, {reporting, discover}) : (binding ? binding.refresh() : credentials(env, {reporting, discover}));
    if (!credential.ok) return {ok: false, reason: credential.reason, code: credential.code ?? 'no_credential', repair: credential.repair};
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
