// The user's side over MCP: `bounce send` as tools, for an agent outside bounce (a Claude Code session watching a
// run) that steers the orchestrator the way the user does from the TUI. 2026-10-25: "que tu puedas enviarle
// mensajes como si fuera yo". A separate server from src/mcp.js, the agents' own: no orchestrator or worker is ever
// handed a way to speak as the user. Same hand-rolled protocol (initialize, tools/list, tools/call, ping).
import {PROTOCOL_VERSION} from './mcp.js';
import {sendToOrchestrator, answerOf} from './send.js';
import {orchestratorStatus, formatStatus} from './control-status.js';
import {taskView, taskList, taskByRef} from './task-view.js';
import {formatTaskView, formatTaskList} from './task-report.js';
import {tasks as taskStates} from './reducers.js';

// Clients cap a tool call (about 60 s); a longer turn answers `waiting` with its request, and `answer` picks it up.
export const CONTROL_WAIT_SECONDS_MAX = 45;

const session = {type: 'string', description: 'The session: an id, id prefix or name. Omit it when only one session is live.'};
const waitSeconds = {type: 'number', description: `Wait up to this many seconds (at most ${CONTROL_WAIT_SECONDS_MAX}) for the turn to end. 0 or omitted: do not wait.`};
const TOOLS = [
  {name: 'sessions', description: 'The live bounce sessions: id, name, workspace, mode.', inputSchema: {type: 'object', properties: {}}},
  {name: 'status', description: 'What the session\'s orchestrator is doing: in a turn or idle and for how long, its own state note, the live tasks with the agent and AI on each, what waits for a decision, and its last answer.',
    inputSchema: {type: 'object', properties: {session}}},
  {name: 'tasks', description: 'The session\'s tasks, one line each: the live ones, or all of them.', inputSchema: {type: 'object', properties: {session, all: {type: 'boolean'}}}},
  {name: 'task', description: 'One task: state, the AI playing it, its last milestones, findings, summary or review verdict. full: true adds its whole report, verdict and orders.',
    inputSchema: {type: 'object', properties: {session, task: {type: 'string', description: 'The task id or a unique prefix.'}, full: {type: 'boolean'}}, required: ['task']}},
  {name: 'send', description: 'Send the session\'s orchestrator a message as if the user typed it in its view (journaled as "via bounce send"). A busy orchestrator gets it after its current turn. Returns the request id; with wait_seconds, also the turn\'s end and the orchestrator\'s answer.',
    inputSchema: {type: 'object', properties: {message: {type: 'string'}, session, wait_seconds: waitSeconds}, required: ['message']}},
  {name: 'answer', description: 'How a message sent earlier went: whether its turn ended, and the orchestrator\'s answer.',
    inputSchema: {type: 'object', properties: {request: {type: 'string', description: 'The request id `send` returned.'}, session, wait_seconds: waitSeconds}, required: ['request']}},
];

const ok = (text, structuredContent) => ({content: [{type: 'text', text}], ...(structuredContent === undefined ? {} : {structuredContent})});
const fail = text => ({content: [{type: 'text', text}], isError: true});
const seconds = value => Math.min(Math.max(Number(value) || 0, 0), CONTROL_WAIT_SECONDS_MAX);
const turnText = result => result.status === 'waiting'
  ? `still running; ask \`answer\` with request ${result.requestId ?? ''} later`.trim()
  : result.status === 'completed' ? (result.answer ?? '(the turn ended with no answer)') : `the turn ended ${result.status}${result.reason ? `: ${result.reason}` : ''}${result.answer ? `\n\n${result.answer}` : ''}`;

// `sessions()` lists sessions as src/sessions.js does; `connect(id)` opens a view channel to that session's daemon;
// `events(id)` reads its journal from disk (reads never go through the daemon).
export function createControlServer({sessions, connect, events = () => [], version = '0'}) {
  function pick(ref) {
    const live = sessions().filter(row => row.live);
    if (ref) {
      const found = live.filter(row => row.id === ref || row.id.startsWith(ref) || row.name === ref);
      if (found.length === 1) return {row: found[0]};
      return {error: found.length ? `"${ref}" matches ${found.length} live sessions; give more of the id` : `no live session "${ref}"`};
    }
    if (live.length === 1) return {row: live[0]};
    return {error: live.length ? `${live.length} live sessions; name one with session: ${live.map(row => `${row.id.slice(0, 8)} (${row.name})`).join(', ')}` : 'no live bounce session'};
  }

  async function callTool(name, args = {}) {
    if (name === 'sessions') {
      const live = sessions().filter(row => row.live).map(({id, name: title, cwd, operation}) => ({id, name: title, cwd, operation: operation ?? null}));
      return ok(live.length ? live.map(row => `${row.id.slice(0, 8)}  ${row.name}  ${row.operation ?? ''}  ${row.cwd}`).join('\n') : 'no live bounce session', {sessions: live});
    }
    if (['status', 'tasks', 'task'].includes(name)) {
      const {row, error} = pick(args.session);
      if (error) return fail(error);
      const rows = events(row.id);
      if (name === 'status') { const view = orchestratorStatus(rows); return ok(formatStatus(view), {session: row.id, ...view}); }
      if (name === 'tasks') { const list = taskList(rows, {all: args.all === true}); return ok(formatTaskList(list), {session: row.id, tasks: list}); }
      if (typeof args.task !== 'string' || !args.task) return fail('task needs the `task` id');
      let id;
      try { id = taskByRef(taskStates(rows), args.task); } catch (refused) { return fail(refused.message); }
      const view = taskView(rows, id, {report: args.full === true});
      return view ? ok(formatTaskView(view), view) : fail(`no task ${args.task} in this session`);
    }
    if (name === 'send' || name === 'answer') {
      const {row, error} = pick(args.session);
      if (error) return fail(error);
      if (name === 'send') {
        if (typeof args.message !== 'string' || !args.message.trim()) return fail('send needs a `message`');
        const wait = seconds(args.wait_seconds);
        const sent = await sendToOrchestrator(await connect(row.id), args.message, {wait: wait > 0, timeoutMs: wait * 1000});
        if (!sent.accepted) return fail(`the orchestrator did not take the message: ${sent.reason}`);
        const result = {session: row.id, ...sent};
        return ok(wait ? turnText(result) : `${sent.queued ? 'queued: it runs when the current turn ends' : 'sent'} · request ${sent.requestId}`, result);
      }
      if (typeof args.request !== 'string' || !args.request) return fail('answer needs the `request` id send returned');
      const result = {session: row.id, requestId: args.request, ...await answerOf(await connect(row.id), args.request, {timeoutMs: seconds(args.wait_seconds) * 1000})};
      return ok(result.status === 'unknown' ? result.reason : turnText(result), result);
    }
    return fail(`no such tool: ${name}`);
  }

  return {
    tools: TOOLS,
    async handle(message) {
      const {id, method, params} = message ?? {};
      const reply = result => ({jsonrpc: '2.0', id, result});
      if (id === undefined) return null;
      if (method === 'initialize') return reply({protocolVersion: PROTOCOL_VERSION, capabilities: {tools: {}}, serverInfo: {name: 'bounce-control', version}});
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
