// One-process bridge client for workers: `bounce publish` and `bounce wait` speak
// straight to src/bus.js over BOUNCE_BUS / BOUNCE_BUS_TOKEN_FILE. Never imports
// cli.js, reload.js or core.js, and never spawns anything — see docs/local-orchestration.md
// "Process model". bridgeCommand is pure I/O in, {stdout, exitCode} out so callers
// (src/cli.js, tests) never touch process.exit themselves.
import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {connectBus} from './bus.js';

const WAIT_CHUNK_MS = 600_000;

function formatRow(row, json) {
  if (row == null) return 'null';
  if (json) return JSON.stringify(row);
  return `[${row.from}:${row.kind}] ${row.text ?? ''}`;
}

function parseJsonArg(value, label) {
  const raw = value.startsWith('@') ? fs.readFileSync(value.slice(1), 'utf8') : value;
  try { return JSON.parse(raw); }
  catch (error) { throw new Error(`invalid ${label}: ${error.message}`); }
}

export async function bridgeCommand(argv, env = process.env, {waitChunkMs = WAIT_CHUNK_MS} = {}) {
  const [command, ...rest] = argv;
  // Reporting is deliberately a separate, attempt-scoped credential. A worker cannot turn a
  // report capability into the general publish/wait capability even by invoking this CLI.
  const reporting = command === 'report';
  const busPath = reporting ? env.BOUNCE_REPORT_BUS : env.BOUNCE_BUS;
  const tokenFile = reporting ? env.BOUNCE_REPORT_TOKEN_FILE : env.BOUNCE_BUS_TOKEN_FILE;
  if (!busPath || !tokenFile) return {stdout: `bounce: ${reporting ? 'BOUNCE_REPORT_BUS and BOUNCE_REPORT_TOKEN_FILE' : 'BOUNCE_BUS and BOUNCE_BUS_TOKEN_FILE'} must be set\n`, exitCode: 2};

  let token;
  try { token = fs.readFileSync(tokenFile, 'utf8').trim(); }
  catch (error) { return {stdout: `bounce: cannot read token file: ${error.message}\n`, exitCode: 2}; }

  let values;
  try {
    ({values} = parseArgs({args: rest, allowPositionals: false, options: {
      event: {type: 'string'}, report: {type: 'string'}, match: {type: 'string'}, timeout: {type: 'string'},
      'after-seq': {type: 'string'}, json: {type: 'boolean'},
    }}));
  } catch (error) { return {stdout: `bounce: ${error.message}\n`, exitCode: 2}; }

  let event, report, match, timeout, afterSeq = 0;
  try {
    if (command === 'publish') {
      if (!values.event) throw new Error('publish requires --event');
      event = parseJsonArg(values.event, 'event');
    } else if (command === 'report') {
      if (!values.report) throw new Error('report requires --report');
      report = parseJsonArg(values.report, 'report');
    } else if (command === 'wait') {
      if (!values.match) throw new Error('wait requires --match');
      match = parseJsonArg(values.match, 'match');
      timeout = Math.round(Number(values.timeout ?? 30) * 1000);
      if (!Number.isFinite(timeout) || timeout < 0) throw new Error('invalid --timeout');
      if (values['after-seq'] !== undefined) {
        afterSeq = Number(values['after-seq']);
        if (!Number.isInteger(afterSeq)) throw new Error('invalid --after-seq');
      }
    } else throw new Error(`unknown bridge command: ${command}`);
  } catch (error) { return {stdout: `bounce: ${error.message}\n`, exitCode: 2}; }

  let client;
  try { client = await connectBus({path: busPath, token}); }
  catch (error) { return {stdout: `bounce: ${error.code ?? -32001} ${error.message}\n`, exitCode: 3}; }

  try {
    if (command === 'publish') {
      const row = await client.publish(event);
      return {stdout: formatRow(row, values.json) + '\n', exitCode: 0};
    }
    if (command === 'report') {
      const row = await client.report(report);
      return {stdout: formatRow(row, values.json) + '\n', exitCode: 0};
    }
    // One bus wait is capped at 600 s (src/bus.js handleWait); a longer --timeout — the task
    // deadline is the natural one — is re-armed here in chunks. Every chunk re-scans the log
    // before subscribing, so a row that lands between two chunks is still returned.
    const deadline = Date.now() + timeout;
    let row = null;
    do {
      row = await client.wait({match, timeout: Math.min(Math.max(deadline - Date.now(), 0), waitChunkMs), afterSeq});
    } while (!row && Date.now() < deadline);
    return {stdout: formatRow(row, values.json) + '\n', exitCode: row ? 0 : 1};
  } catch (error) {
    return {stdout: `bounce: ${error.code ?? -32001} ${error.message}\n`, exitCode: 3};
  } finally {
    try { await client.close(); } catch {}
  }
}
