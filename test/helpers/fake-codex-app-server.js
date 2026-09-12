#!/usr/bin/env node
// Fake `codex app-server` for the codex-live adapter tests. Stands in for the real
// vendor CLI, which is never spawned by a test. Protocol (locked, see T5a):
//   initialize {}                  → result {}
//   initialized                    (notification, no id) — no answer
//   thread/start {}                → result {threadId: 't-<n>'}
//   thread/resume {threadId}       → result {threadId}
//   turn/start {threadId, input:[{type:'text', text}], model?}
//                                  → result {turnId: 'u-<n>'}, then after FAKE_DELAY_MS
//                                    notifications item/completed {item:{type:'agent_message',
//                                    text:'echo: '+text}} and turn/completed {turnId, usage}
//   turn/interrupt {threadId}      → result {} and an immediate turn/completed {..., interrupted:true}
//   anything else                  → error {code:-32601}
// Every received line is appended verbatim to the file named by env FAKE_LOG; a line that
// does not parse is ignored. One object per line, `jsonrpc` omitted, numeric ids on requests.
import fs from 'node:fs';

const logFile = process.env.FAKE_LOG;
const delay = Number(process.env.FAKE_DELAY_MS ?? 0);
// FAKE_USAGE=<json>   usage object on turn/completed (default {input_tokens:1, output_tokens:1} — vendor field names)
const defaultUsage = process.env.FAKE_USAGE ? JSON.parse(process.env.FAKE_USAGE) : {input_tokens: 1, output_tokens: 1};
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const notify = (method, params) => send({method, params});

let threads = 0, turns = 0, running = null;

const complete = extra => {
  const turn = running;
  running = null;
  clearTimeout(turn.timer);
  notify('turn/completed', {turnId: turn.turnId, usage: defaultUsage, ...extra});
};

const handlers = {
  initialize: () => ({}),
  'thread/start': () => ({threadId: `t-${++threads}`}),
  'thread/resume': params => ({threadId: params?.threadId}),
  'turn/start': params => {
    const turnId = `u-${++turns}`;
    const text = params?.input?.[0]?.text ?? '';
    running = {turnId, timer: setTimeout(() => {
      notify('item/completed', {item: {type: 'agent_message', text: `echo: ${text}`}});
      complete();
    }, delay)};
    return {turnId};
  },
  'turn/interrupt': () => {
    if (running) complete({usage: {}, interrupted: true});
    return {};
  },
};

const handle = message => {
  if (message.method === 'initialized') return;
  const handler = handlers[message.method];
  if (!handler) return send({id: message.id, error: {code: -32601, message: `Unknown method: ${message.method}`}});
  const result = handler(message.params);
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
