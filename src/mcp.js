// MCP over stdio: the second transport for the agent-facing interface (docs/plans/bridge-interface.md).
// Every tool here is a verb of src/bridge-ops.js or a view of src/task-view.js; this file decides nothing.
//
// Tools only, deliberately: researched 2026-09-22 — Codex pulls MCP resources through callable tools and
// skipped `resources/subscribe`, Claude Code refreshes its catalog on `list_changed` but pushes nothing into
// a running turn, and the current spec replaced the old subscribe RPC anyway. The stream an orchestrator
// should use is what bounce already has: a bounded `wait`, and a handoff that wakes it with a new turn.
//
// Hand-rolled rather than taking the SDK: initialize, tools/list, tools/call and ping is the whole surface.
import {createInterface} from 'node:readline';
import {formatTaskView, formatTaskList} from './task-report.js';

export const PROTOCOL_VERSION = '2025-06-18';
// Clients cap a tool call (Codex `tool_timeout_sec`, default 60 s; Claude Code similar): a wait answers
// "not yet" well inside that instead of hanging, and the caller decides whether to ask again or end its turn.
export const WAIT_SECONDS_MAX = 45;

const TOOLS = [
  {name: 'submit', description: 'Submit a bounce event: task.submitted, plan.submitted, a message to a worker, or a milestone.',
    inputSchema: {type: 'object', properties: {event: {type: 'object', description: 'The event, exactly as `bounce publish --event` takes it.'}}, required: ['event']}},
  {name: 'wait', description: `Wait for the first row matching every field given, up to ${WAIT_SECONDS_MAX} seconds. Answers {waiting: true} when nothing matched yet — end your turn rather than waiting again for long work; bounce wakes you with each outcome.`,
    inputSchema: {type: 'object', properties: {match: {type: 'object'}, seconds: {type: 'number'}, afterSeq: {type: 'number'}}, required: ['match']}},
  {name: 'report', description: 'Report progress or the final result for this worker attempt (workers only).',
    inputSchema: {type: 'object', properties: {report: {type: 'object'}}, required: ['report']}},
  {name: 'state', description: 'Write where the campaign is, in your own words: the phase, what is done, what is next, and why you changed course. One living note — each call replaces the last, and it is the first thing you are given when you wake.',
    inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}},
  {name: 'task_get', description: 'One task: state, the AI playing it, lease and elapsed, its last milestones, its findings, its summary or review verdict. Bounded — never the journal itself.',
    inputSchema: {type: 'object', properties: {task: {type: 'string'},
      full: {type: 'boolean', description: 'Return the finished report/verdict whole instead of the cut summary. Use it once a task is done and you need its findings in full; the default stays bounded so a check never floods your turn.'}},
      required: ['task']}},
  {name: 'tasks_list', description: 'Every task that is still live (or all of them), one line each.',
    inputSchema: {type: 'object', properties: {all: {type: 'boolean'}}, required: []}},
];

const ok = (text, structuredContent) => ({content: [{type: 'text', text}], ...(structuredContent === undefined ? {} : {structuredContent})});
const fail = text => ({content: [{type: 'text', text}], isError: true});
const rowText = row => row ? `${row.kind}${row.task ? ` ${row.task}` : ''}${row.seq ? ` (seq ${row.seq})` : ''}` : 'null';

// `ops` is src/bridge-ops.js's interface, `views` the pure task views: both injected, both the only source
// of an answer. Returns the JSON-RPC response object, or null for a notification.
export function createMcpServer({ops, views, version = '0'}) {
  async function callTool(name, args = {}) {
    if (name === 'submit') {
      if (!args.event || typeof args.event !== 'object') return fail('submit needs an `event` object');
      const result = await ops.submit(args.event);
      return result.ok ? ok(rowText(result.row), result.row) : fail(`bounce refused it: ${result.reason}`);
    }
    if (name === 'wait') {
      if (!args.match || typeof args.match !== 'object') return fail('wait needs a `match` object');
      const seconds = Math.min(Number(args.seconds) > 0 ? Number(args.seconds) : 30, WAIT_SECONDS_MAX);
      const result = await ops.wait(args.match, {timeout: seconds * 1000, afterSeq: Number(args.afterSeq) || 0});
      if (!result.ok) return fail(`bounce refused it: ${result.reason}`);
      return result.timedOut
        ? ok(`not yet: nothing matched in ${seconds} s. End your turn — bounce wakes you with each outcome — or ask again if this is a short dependent wait.`, {waiting: true, row: null})
        : ok(rowText(result.row), {waiting: false, row: result.row});
    }
    if (name === 'report') {
      if (!args.report || typeof args.report !== 'object') return fail('report needs a `report` object');
      const result = await ops.report(args.report);
      return result.ok ? ok(rowText(result.row), result.row) : fail(`bounce refused it: ${result.reason}`);
    }
    if (name === 'state') {
      if (typeof args.text !== 'string' || !args.text.trim()) return fail('state needs the note `text`');
      const result = await ops.state(args.text);
      return result.ok ? ok('kept as where you are; it replaces your last note', result.row) : fail(`bounce refused it: ${result.reason}`);
    }
    if (name === 'task_get') {
      if (typeof args.task !== 'string' || !args.task) return fail('task_get needs a `task` id');
      const view = views.taskView(args.task, {report: args.full === true});
      return view ? ok(formatTaskView(view), view) : fail(`no such task: ${args.task}`);
    }
    if (name === 'tasks_list') {
      const rows = views.taskList({all: args.all === true});
      return ok(formatTaskList(rows), rows);
    }
    return fail(`no such tool: ${name}`);
  }

  return {
    tools: TOOLS,
    async handle(message) {
      const {id, method, params} = message ?? {};
      const reply = result => ({jsonrpc: '2.0', id, result});
      if (id === undefined) return null; // a notification: nothing to answer
      if (method === 'initialize') return reply({protocolVersion: PROTOCOL_VERSION, capabilities: {tools: {}}, serverInfo: {name: 'bounce', version}});
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({tools: TOOLS});
      if (method === 'tools/call') {
        try { return reply(await callTool(params?.name, params?.arguments ?? {})); }
        catch (error) { return reply(fail(`bounce: ${error.message}`)); }
      }
      return {jsonrpc: '2.0', id, error: {code: -32601, message: `unknown method: ${method}`}};
    },
  };
}

// stdio: newline-delimited JSON in, the same out. Nothing else is written to stdout — a stray line would
// break the protocol — so every diagnostic goes to stderr.
export function serveStdio(server, {input = process.stdin, output = process.stdout} = {}) {
  const lines = createInterface({input});
  lines.on('line', async line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { output.write(JSON.stringify({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'parse error'}}) + '\n'); return; }
    try {
      const response = await server.handle(message);
      if (response) output.write(JSON.stringify(response) + '\n');
    } catch (error) {
      if (message?.id !== undefined) output.write(JSON.stringify({jsonrpc: '2.0', id: message.id, error: {code: -32603, message: error.message}}) + '\n');
    }
  });
  return () => lines.close();
}
