#!/usr/bin/env node
// Fake `codex app-server` for the codex-live adapter tests. Stands in for the real
// vendor CLI, which is never spawned by a test. Protocol (locked, see T5a):
//   initialize {}                  → result {}
//   initialized                    (notification, no id) — no answer
//   thread/start {approvalPolicy,sandbox}
//                                  → result {thread:{id:'t-<n>'}}
//   thread/resume {threadId,...thread settings}
//                                  → result {thread:{id:threadId}}
//   turn/start {threadId, input:[{type:'text', text}], model?}
//                                  → result {turn:{id:'u-<n>'}}, then after FAKE_DELAY_MS
//                                    notifications item/completed, thread/tokenUsage/updated,
//                                    and turn/completed, all with v2-required fields
//   turn/steer {threadId,expectedTurnId,input} → result {turnId}
//   turn/interrupt {threadId,turnId} → result {} and an immediate interrupted turn/completed
//   anything else                  → error {code:-32601}
// Every received line is appended verbatim to the file named by env FAKE_LOG; a line that
// does not parse is ignored. One object per line, `jsonrpc` omitted, numeric ids on requests.
// FAKE_LIMIT=launch  → turn/start is refused with the vendor's usage-limit text (observed live:
//                      codex-cli answers turn/start with this error once the account is exhausted)
// FAKE_LIMIT=turn    → the turn ends with turn/completed status:failed carrying the same text
// FAKE_LIMIT=notify  → an `error` notification carries the text, then turn/completed fails bare
import fs from 'node:fs';

const logFile = process.env.FAKE_LOG;
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
const limitMode = process.env.FAKE_LIMIT ?? '';
export const USAGE_LIMIT_TEXT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 2:50 PM.";
// FAKE_USAGE=<json>   v2 TokenUsageBreakdown (default includes each schema-required field)
const defaultUsage = process.env.FAKE_USAGE ? JSON.parse(process.env.FAKE_USAGE) : {
  inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2,
};
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({method, params});

let threads = 0, turns = 0, running = null;

const complete = ({status = 'completed', error} = {}) => {
  const turn = running;
  running = null;
  clearTimeout(turn.timer);
  if (status === 'completed') {
    notify('item/completed', {threadId: turn.threadId, turnId: turn.turnId, completedAtMs: Date.now(),
      item: {id: `item-${turn.turnId}`, type: 'agentMessage', text: `echo: ${turn.text}`}});
    notify('thread/tokenUsage/updated', {threadId: turn.threadId, turnId: turn.turnId,
      tokenUsage: {last: defaultUsage, total: defaultUsage}});
  }
  notify('turn/completed', {threadId: turn.threadId, turn: {id: turn.turnId, items: [], status,
    ...(error ? {error: {message: error}} : {})}});
};

const handlers = {
  // Mirrors codex-cli 0.154's contract: clientInfo is required.
  initialize: params => {
    if (!params?.clientInfo?.name) throw Object.assign(new Error('Invalid request: missing field `clientInfo`'), {code: -32600});
    return {};
  },
  // codex-cli 0.154's shape: the thread object, not a bare threadId.
  'thread/start': params => {
    if (!['never', 'on-request'].includes(params?.approvalPolicy) || !['read-only', 'workspace-write', 'danger-full-access'].includes(params?.sandbox)) {
      throw Object.assign(new Error('thread/start requires App Server permission settings'), {code: -32602});
    }
    return {thread: {id: `t-${++threads}`}};
  },
  'thread/resume': params => {
    if (typeof params?.threadId !== 'string' || !['never', 'on-request'].includes(params?.approvalPolicy)) {
      throw Object.assign(new Error('thread/resume requires threadId and permission settings'), {code: -32602});
    }
    return {thread: {id: params.threadId}};
  },
  'turn/start': params => {
    if (!['never', 'on-request'].includes(params?.approvalPolicy) || !params?.sandboxPolicy?.type) {
      throw Object.assign(new Error('turn/start requires App Server permission settings'), {code: -32602});
    }
    if (limitMode === 'launch') throw Object.assign(new Error(USAGE_LIMIT_TEXT), {code: -32000});
    const turnId = `u-${++turns}`;
    const text = params?.input?.[0]?.text ?? '';
    running = {turnId, timer: setTimeout(() => {
      if (limitMode === 'turn') return complete({status: 'failed', error: USAGE_LIMIT_TEXT});
      if (limitMode === 'notify') {
        notify('error', {threadId: params.threadId, turnId, error: {message: USAGE_LIMIT_TEXT}});
        return complete({status: 'failed'});
      }
      complete();
    }, delay), threadId: params.threadId, text};
    return {turn: {id: turnId}};
  },
  'turn/steer': params => {
    if (!running || params?.threadId !== running.threadId || params?.expectedTurnId !== running.turnId) {
      throw Object.assign(new Error('turn/steer expectedTurnId does not match the active turn'), {code: -32602});
    }
    return {turnId: running.turnId};
  },
  'turn/interrupt': params => {
    if (!running || params?.threadId !== running.threadId || params?.turnId !== running.turnId) {
      throw Object.assign(new Error('turn/interrupt requires the active threadId and turnId'), {code: -32602});
    }
    complete({status: 'interrupted'});
    return {};
  },
};

const handle = message => {
  if (message.method === 'initialized') return;
  const handler = handlers[message.method];
  if (!handler) return send({id: message.id, error: {code: -32601, message: `Unknown method: ${message.method}`}});
  let result;
  try { result = handler(message.params); }
  catch (error) { return send({id: message.id, error: {code: error.code ?? -32603, message: error.message}}); }
  if (message.id !== undefined) send({id: message.id, result});
};

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n')) {
    const line = buffer.slice(0, cut);
    buffer = buffer.slice(cut + 1);
    if (!line.trim()) continue;
    if (logFile) fs.appendFileSync(logFile, line + '\n');
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});
process.stdin.on('end', () => process.exit(0)); // the client closed the pipe: the server is done
process.stdin.resume();
