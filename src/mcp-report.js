// The OpenCode worker gets one MCP tool backed by its attempt-scoped bus grant. It cannot
// submit tasks, address peers or publish lifecycle rows through this server.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connectBus} from './bus.js';
import {serveStdio} from './mcp.js';
import {REPORT_SCHEMA, validateReport} from './reporting.js';

const TIMEOUT_MS = 10_000;
const accepted = row => ({content: [{type: 'text', text: `report accepted (seq ${row.seq ?? '?'})`}]});
const rejected = reason => ({content: [{type: 'text', text: reason}], isError: true});

export function createReportServer({env = process.env, readFile = fs.readFileSync,
  connect = connectBus, task = env.BOUNCE_REPORT_TASK, timeoutMs = TIMEOUT_MS} = {}) {
  const tool = {name: 'report', description: 'Publish progress or a final report for this assigned worker attempt.',
    inputSchema: REPORT_SCHEMA};

  async function publish(report) {
    const problem = validateReport(report);
    if (problem) return rejected(`malformed report: ${problem}`);

    const socket = env.BOUNCE_REPORT_BUS;
    const tokenFile = env.BOUNCE_REPORT_TOKEN_FILE;
    if (!socket || !tokenFile || !task) return rejected('report grant unavailable');

    let client;
    let timer;
    let expired = false;
    try {
      const token = readFile(tokenFile, 'utf8').trim();
      if (!token) return rejected('report grant unavailable');
      const deadline = new Promise((_, reject) => {timer = setTimeout(() => {expired = true; reject(new Error('report timed out'));}, timeoutMs);});
      const connecting = connect({path: socket, token});
      // A connection that resolves after the deadline is never used, and must not keep a bus
      // grant/socket alive after the MCP call has already failed.
      connecting.then(late => { if (expired) Promise.resolve(late?.close?.()).catch(() => {}); }, () => {});
      client = await Promise.race([connecting, deadline]);
      if (!Array.isArray(client.tasks) || !client.tasks.includes(task)) return rejected('report grant task mismatch');
      // The bus binds the attempt and only acknowledges once the scheduler has appended its row.
      const row = await Promise.race([client.report(report), deadline]);
      return accepted(row);
    } catch (error) {
      return rejected(error.message === 'report timed out' ? 'report timed out'
        : error.code === 'EPERM' || error.code === 'EACCES' ? `report socket refused (${error.code})`
          : typeof error.code === 'number' ? `report rejected by bus (${error.code})` : 'report rejected');
    } finally {
      clearTimeout(timer);
      if (client) {
        let closeTimer;
        try { await Promise.race([client.close(), new Promise(resolve => {closeTimer = setTimeout(resolve, 1000);})]); } catch {}
        finally { clearTimeout(closeTimer); }
      }
    }
  }

  return {
    tools: [tool],
    async handle(message) {
      const {id, method, params} = message ?? {};
      if (id === undefined) return null;
      const reply = result => ({jsonrpc: '2.0', id, result});
      if (method === 'initialize') return reply({protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'bounce-report', version: '1'}});
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({tools: [tool]});
      if (method === 'tools/call') return reply(params?.name === 'report' ? await publish(params.arguments) : rejected('unknown report tool'));
      return {jsonrpc: '2.0', id, error: {code: -32601, message: `unknown method: ${method}`}};
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveStdio(createReportServer());
}
