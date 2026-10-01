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

// Plans are no longer reviewed (2026-09-29); this stub keeps answering an orchestrator that still
// carries the old habit instead of failing its call.
const PLAN_WAIT_NOTE = 'plans are no longer reviewed: there is nothing to wait for; dispatch the tasks';

const TOOLS = [
  {name: 'submit', description: 'Submit a bounce event: task.submitted, a message to a worker, or a milestone.',
    inputSchema: {type: 'object', properties: {event: {type: 'object', description: 'The event, exactly as `bounce publish --event` takes it.'}}, required: ['event']}},
  {name: 'task_submit', description: 'Submit a task with stable job/retry identity. retryOf is authorized against this grant and cannot bypass review or limits.',
    inputSchema: {type: 'object', properties: {task: {type: 'string'}, profile: {type: 'string'}, orders: {type: 'string'}, requires: {type: 'array', items: {type: 'string', enum: ['read', 'exec', 'write']}}, owns: {type: 'array', items: {type: 'string'}}, userAsked: {type: 'boolean', description: 'True when the user asked for this specific AI by name; a first attempt naming a profile without it runs as the matching agent instead.'}, worker: {type: 'string', description: 'A standing worker from the roster (builder#1), or "new" for a fresh one on purpose.'}, continues: {type: 'string', description: 'A task of yours this one continues: its worker\'s session is resumed into this task\'s own copy, with these orders as what happens next. For a follow-up on the same area by the same job; after a correction of wrong work, start fresh instead.'}, depends_on: {type: 'array', items: {type: 'string'}}, deadline: {type: ['number', 'null']}, review: {type: 'object'}, steps: {type: 'string'}, check: {type: 'string', description: 'A shell command that proves the work is done. bounce runs it in the worker\'s copy when the worker finishes; only work that passes (exit 0) is put in the checkout.'}, risk: {type: 'string'}, size: {type: 'object'}, checkpoint: {type: 'object'}, parent: {type: ['string', 'null']}, jobId: {type: 'string'}, retryOf: {type: 'string'}, inPlace: {type: 'object', description: 'Run in the real checkout. authorizedBy: the seq of the user message that asked for it; omit it to cite the latest one.', properties: {authorizedBy: {type: 'number'}}}}, required: ['profile', 'orders', 'requires']}},
  {name: 'wait', description: `Wait for the first row matching every field given, up to ${WAIT_SECONDS_MAX} seconds. Answers {waiting: true} when nothing matched yet — end your turn rather than waiting again for long work; bounce wakes you with each outcome.`,
    inputSchema: {type: 'object', properties: {match: {type: 'object'}, seconds: {type: 'number'}, afterSeq: {type: 'number'}}, required: ['match']}},
  {name: 'report', description: 'Report progress or the final result for this worker attempt (workers only).',
    inputSchema: {type: 'object', properties: {report: {type: 'object'}}, required: ['report']}},
  {name: 'state', description: 'Write where the work is, in your own words: the phase, what is done, what is next, and why you changed course. One living note — each call replaces the last, and it is the first thing you are given when you wake.',
    inputSchema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}},
  {name: 'lesson', description: 'Record a lesson for this project after you corrected a worker\'s work or a check failed twice: one imperative sentence that a worker of that job should know next time here. It lands in .bounce/LESSONS.md and in every later worker\'s prompt for that job.',
    inputSchema: {type: 'object', properties: {agent: {type: 'string', description: 'The job it is for (an agent name), or "all".'}, text: {type: 'string', description: 'One sentence, imperative, no task ids.'}}, required: ['agent', 'text']}},
  {name: 'worker_retire', description: 'Retire a standing worker (a name from the roster, e.g. builder#1): its session is not continued again. Give a handoff when the next worker of that job should open with what this one knew, or set ask to true and the retiring worker writes its own handoff first.',
    inputSchema: {type: 'object', properties: {worker: {type: 'string'}, handoff: {type: 'string', description: 'What the next worker of this job should know, in a few sentences. Optional.'}, ask: {type: 'boolean', description: 'Ask the retiring worker to write the handoff itself (one read-only turn on its session). Its answer opens the next worker.'}}, required: ['worker']}},
  {name: 'worker_compact', description: 'Ask a standing worker to compact its own context (Claude workers; OpenCode and Codex cannot — retire those with a handoff instead). One turn on its session, nothing changed in the project.',
    inputSchema: {type: 'object', properties: {worker: {type: 'string'}}, required: ['worker']}},
  {name: 'task_get', description: 'One task: state, the AI playing it, lease and elapsed, its last milestones, its findings, its summary or review verdict. Bounded — never the journal itself.',
    inputSchema: {type: 'object', properties: {task: {type: 'string'},
      full: {type: 'boolean', description: 'Return the finished report/verdict whole instead of the cut summary. Use it once a task is done and you need its findings in full; the default stays bounded so a check never floods your turn.'}},
      required: ['task']}},
  {name: 'tasks_list', description: 'Every task that is still live (or all of them), one line each.',
    inputSchema: {type: 'object', properties: {all: {type: 'boolean'}}, required: []}},
  {name: 'plan_wait', description: 'No longer used: plans are not reviewed any more.', inputSchema: {type: 'object', properties: {plan: {type: 'string'}, seconds: {type: 'number'}, afterSeq: {type: 'number'}}, required: ['plan']}},
];

const ok = (text, structuredContent) => ({content: [{type: 'text', text}], ...(structuredContent === undefined ? {} : {structuredContent})});
const fail = (text, detail = null) => ({content: [{type: 'text', text}], isError: true,
  ...(detail?.code ? {structuredContent: {code: detail.code, reason: detail.reason ?? text, ...(detail.repair ? {repair: detail.repair} : {})}} : {})});
const rowText = row => row ? `${row.kind}${row.task ? ` ${row.task}` : ''}${row.seq ? ` (seq ${row.seq})` : ''}${Array.isArray(row.notes) ? row.notes.map(note => `\nnote: ${note}`).join('') : ''}` : 'null';

// `ops` is src/bridge-ops.js's interface, `views` the pure task views: both injected, both the only source
// of an answer. Returns the JSON-RPC response object, or null for a notification.
export function createMcpServer({ops, views, version = '0'}) {
  async function callTool(name, args = {}) {
    // Reads carry the same session binding as writes. Returning an explicit refusal is
    // safer than making a missing/ambiguous binding look like an empty task list.
    const binding = views.binding?.();
    if (binding && !binding.ok && (name === 'task_get' || name === 'tasks_list')) return fail(`bounce refused it: ${binding.reason}`, binding);
    if (name === 'submit') {
      if (!args.event || typeof args.event !== 'object') return fail('submit needs an `event` object');
      const result = await ops.submit(args.event);
      return result.ok ? ok(rowText(result.row), result.row) : fail(`bounce refused it: ${result.reason}`, result);
    }
    if (name === 'task_submit') {
      if (typeof args.profile !== 'string' || typeof args.orders !== 'string') return fail('task_submit needs profile and orders');
      const result = await ops.submit({kind: 'task.submitted', task: args.task, profile: args.profile, orders: args.orders, requires: args.requires, parent: args.parent ?? null,
        jobId: args.jobId, retryOf: args.retryOf, ...Object.fromEntries(['owns', 'depends_on', 'deadline', 'review', 'steps', 'check', 'continues', 'worker', 'userAsked', 'risk', 'size', 'checkpoint', 'inPlace'].filter(key => args[key] !== undefined).map(key => [key, args[key]]))});
      return result.ok ? ok(rowText(result.row), result.row) : fail(`bounce refused it: ${result.reason}`, result);
    }
    if (name === 'plan_wait') {
      if (typeof args.plan !== 'string' || !args.plan) return fail('plan_wait needs a plan id');
      return ok(PLAN_WAIT_NOTE, {waiting: false, row: null});
    }
    if (name === 'wait') {
      if (!args.match || typeof args.match !== 'object') return fail('wait needs a `match` object');
      const seconds = Math.min(Number(args.seconds) > 0 ? Number(args.seconds) : 30, WAIT_SECONDS_MAX);
      const result = await ops.wait(args.match, {timeout: seconds * 1000, afterSeq: Number(args.afterSeq) || 0});
      if (!result.ok) return fail(`bounce refused it: ${result.reason}`, result);
      return result.timedOut
        ? ok(`not yet: nothing matched in ${seconds} s. End your turn — bounce wakes you with each outcome — or ask again if this is a short dependent wait.`, {waiting: true, row: null})
        : ok(rowText(result.row), {waiting: false, row: result.row});
    }
    if (name === 'report') {
      if (!args.report || typeof args.report !== 'object') return fail('report needs a `report` object');
      const result = await ops.report(args.report);
      return result.ok ? ok(rowText(result.row), result.row) : fail(`bounce refused it: ${result.reason}`, result);
    }
    if (name === 'state') {
      if (typeof args.text !== 'string' || !args.text.trim()) return fail('state needs the note `text`');
      const result = await ops.state(args.text);
      return result.ok ? ok('kept as where you are; it replaces your last note', result.row) : fail(`bounce refused it: ${result.reason}`, result);
    }
    if (name === 'lesson') {
      if (typeof args.text !== 'string' || !args.text.trim()) return fail('lesson needs `text`: one sentence, imperative');
      const result = await ops.lesson({agent: typeof args.agent === 'string' && args.agent.trim() ? args.agent.trim() : 'all', text: args.text});
      return result.ok ? ok(`kept in .bounce/LESSONS.md for ${result.row.agent}: ${result.row.text}`, result.row) : fail(`bounce refused it: ${result.reason}`, result);
    }
    if (name === 'worker_compact') {
      if (typeof args.worker !== 'string' || !args.worker) return fail('worker_compact needs the `worker` name');
      const result = await ops.compact({worker: args.worker});
      return result.ok ? ok(`${result.row.worker} compacted (${result.row.status})`, result.row) : fail(`bounce refused it: ${result.reason}`, result);
    }
    if (name === 'worker_retire') {
      if (typeof args.worker !== 'string' || !args.worker) return fail('worker_retire needs the `worker` name');
      const result = await ops.retire({worker: args.worker, handoff: typeof args.handoff === 'string' && args.handoff.trim() ? args.handoff : null, ask: args.ask === true});
      return result.ok ? ok(`${result.row.worker} retired${result.row.handoff ? '; the next ' + result.row.profile + ' opens with your handoff' : ''}`, result.row) : fail(`bounce refused it: ${result.reason}`, result);
    }
    if (name === 'task_get') {
      if (typeof args.task !== 'string' || !args.task) return fail('task_get needs a `task` id');
      const view = views.taskView(args.task, {report: args.full === true});
      return view ? ok(formatTaskView(view), view) : fail(`no such task: ${args.task}`);
    }
    if (name === 'tasks_list') {
      const rows = views.taskList({all: args.all === true});
      const roster = views.roster?.() ?? [];
      // An MCP structured result is an object: a bare array failed Codex's schema check live ("expected record"),
      // so every tasks_list call from the orchestrator was refused by its own client (found 2026-10-01).
      return ok(roster.length ? `${formatTaskList(rows)}\n\nYour workers:\n${roster.join('\n')}` : formatTaskList(rows), {tasks: rows, workers: roster});
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
