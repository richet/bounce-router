// One-process bridge client for workers: `bounce publish` and `bounce wait` speak
// straight to src/bus.js over BOUNCE_BUS / BOUNCE_BUS_TOKEN_FILE. Never imports
// cli.js, reload.js or core.js, and never spawns anything — see docs/local-orchestration.md
// "Process model". bridgeCommand is pure I/O in, {stdout, exitCode} out so callers
// (src/cli.js, tests) never touch process.exit themselves.
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {createOps, DEFAULT_WAIT_MS, WAIT_CHUNK_MS} from './bridge-ops.js';


function formatRow(row, json) {
  if (row == null) return 'null';
  if (json) return JSON.stringify(row);
  // A task row leads with its id: the orchestrator needs it for the very next `wait`, and the plain
  // form used to hide it (observed: an orchestrator digging the id out of the tasks/ directory).
  return `[${row.from}:${row.kind}]${typeof row.task === 'string' ? ` task=${row.task}` : ''} ${row.text ?? ''}`;
}

function parseJsonArg(value, label) {
  const raw = value.startsWith('@') ? fs.readFileSync(value.slice(1), 'utf8') : value;
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`invalid ${label}: ${error.message}`); }
}

export async function bridgeCommand(argv, env = process.env, {waitChunkMs = WAIT_CHUNK_MS} = {}) {
  const [command, ...rest] = argv;
  // A transport: argv in, stdout out. Credentials, defaults and the verbs themselves live in
  // src/bridge-ops.js, so the MCP transport cannot drift from this one.
  const ops = createOps({env, waitChunkMs});

  let values;
  try {
    ({values} = parseArgs({args: rest, allowPositionals: false, options: {
      event: {type: 'string'}, report: {type: 'string'}, match: {type: 'string'}, timeout: {type: 'string'},
      'after-seq': {type: 'string'}, json: {type: 'boolean'},
    }}));
  } catch (error) { return {stdout: `bounce: ${error.message}\n`, exitCode: 2}; }

  let call;
  try {
    if (command === 'publish') {
      if (!values.event) throw new Error('publish requires --event');
      const event = parseJsonArg(values.event, 'event');
      call = () => ops.submit(event);
    } else if (command === 'report') {
      if (!values.report) throw new Error('report requires --report');
      const report = parseJsonArg(values.report, 'report');
      call = () => ops.report(report);
    } else if (command === 'wait') {
      if (!values.match) throw new Error('wait requires --match');
      const match = parseJsonArg(values.match, 'match');
      const timeout = Math.round(Number(values.timeout ?? DEFAULT_WAIT_MS / 1000) * 1000);
      if (!Number.isFinite(timeout) || timeout < 0) throw new Error('invalid --timeout');
      let afterSeq = 0;
      if (values['after-seq'] !== undefined) {
        afterSeq = Number(values['after-seq']);
        if (!Number.isInteger(afterSeq)) throw new Error('invalid --after-seq');
      }
      call = () => ops.wait(match, {timeout, afterSeq});
    } else throw new Error(`unknown bridge command: ${command}`);
  } catch (error) { return {stdout: `bounce: ${error.message}\n`, exitCode: 2}; }

  const result = await call();
  if (!result.ok) return {stdout: `bounce: ${result.code === 'no_credential' ? result.reason : `${result.code} ${result.reason}`}\n`, exitCode: result.code === 'no_credential' ? 2 : 3};
  return {stdout: formatRow(result.row, values.json) + '\n', exitCode: result.timedOut ? 1 : 0};
}
