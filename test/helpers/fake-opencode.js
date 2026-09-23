#!/usr/bin/env node
// Fake `opencode run --format json` for the adapter tests: a one-shot process, like the real one.
// It reads the prompt on stdin, prints JSON event lines in the shapes observed from opencode
// 1.18.31 (`step_start`, `tool_use`, `text`, `step_finish`, each carrying `sessionID`), and exits.
// It is a printer of observed shapes, not a second implementation of OpenCode.
//
// FAKE_OC_SCENARIO  ok (default) | fail (stderr + exit 1) | notext (steps, no text, exit 0)
//                   | denied (a tool call rejected, then text) | refused (real behaviour: stderr notice,
//                   the rejected call, no text, exit 0) | hold (stay alive until signalled)
//                   | empty / empty-notext (answer or not, then empty `tool-calls` steps forever)
//                   | stubborn (hold, and ignore SIGTERM) | loop (the same read call forever) | garbage (a non-JSON stdout line first)
// FAKE_OC_TURN_MS   delay before finishing (default 5)
// FAKE_OC_USAGE     tokens object on step_finish (vendor shape)
// FAKE_OC_WRITE     '<rel>:<content>[,…]' files written under --dir — the worker "edits" the real tree
// FAKE_OC_LOG       append ARGV / CONFIG / PROMPT / ENV lines for assertions
// FAKE_OC_READY     touch this file once signal handlers are settled (cancel tests gate on it)
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = name => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const scenario = process.env.FAKE_OC_SCENARIO ?? 'ok';
const log = line => { if (process.env.FAKE_OC_LOG) fs.appendFileSync(process.env.FAKE_OC_LOG, line + '\n'); };
const sessionID = flag('-s') ?? `ses_fake_${process.pid}`;
const dir = flag('--dir') ?? process.cwd();
const usage = process.env.FAKE_OC_USAGE ? JSON.parse(process.env.FAKE_OC_USAGE) : {total: 2, input: 1, output: 1, reasoning: 0, cache: {read: 0, write: 0}};
let seq = 0;
const emit = (type, part) => process.stdout.write(JSON.stringify({type, timestamp: Date.now(), sessionID, part: {id: `prt_${++seq}`, messageID: 'msg_1', sessionID, ...part}}) + '\n');

if (scenario === 'stubborn') process.on('SIGTERM', () => {});

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  log(`ARGV ${JSON.stringify(argv)}`);
  log(`CONFIG ${process.env.OPENCODE_CONFIG_CONTENT ?? 'null'}`);
  log(`PROMPT ${JSON.stringify(prompt)}`);
  log(`ENV ${JSON.stringify(Object.keys(process.env).filter(key => /ANTHROPIC|OPENAI|BOUNCE_|OPENCODE_/.test(key)).sort())}`);
  if (process.env.FAKE_OC_READY) fs.writeFileSync(process.env.FAKE_OC_READY, 'ready');
  if (argv[0] !== 'run') { process.stderr.write(`unknown command ${argv[0]}\n`); process.exit(2); }
  if (scenario === 'fail') { process.stderr.write('Error: connect ECONNREFUSED 127.0.0.1:1234\n'); process.exit(1); }
  if (scenario === 'garbage') process.stdout.write('not json at all\n');
  emit('step_start', {type: 'step-start'});
  // FAKE_OC_CONCLUDE=answer|silent: on a resumed turn (-s) whose config gives the agent NO tools —
  // the conclusion turn bounce asks for after a stall or at a lease end — answer, or say nothing,
  // whatever the scenario the first turn played (a held turn is concluded too).
  const cfg = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT) : {};
  const agentName = flag('--agent'); const toolsOff = agentName && cfg.agent?.[agentName]?.tools && Object.values(cfg.agent[agentName].tools).every(v => v === false);
  if (flag('-s') && toolsOff) {
    if (process.env.FAKE_OC_CONCLUDE === 'answer') emit('text', {type: 'text', text: `FAIL: the boundary is off by one (conclusion for ${prompt.slice(0, 20)})`});
    emit('step_finish', {type: 'step-finish', reason: 'stop', tokens: usage});
    return process.exit(0);
  }
  if (scenario === 'hold' || scenario === 'stubborn') { setInterval(() => {}, 1000); return; }
  if (scenario === 'empty' || scenario === 'empty-notext') {
    // The shape observed from qwen3-coder-30b-a3b: every step ends for `tool-calls`, even the empty ones.
    emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'note.txt'}, output: 'ok'}});
    emit('step_finish', {type: 'step-finish', reason: 'tool-calls', tokens: usage});
    emit('step_start', {type: 'step-start'});
    if (scenario === 'empty') emit('text', {type: 'text', text: `echo: ${prompt}`});
    emit('step_finish', {type: 'step-finish', reason: 'tool-calls', tokens: usage});
    setInterval(() => { emit('step_start', {type: 'step-start'}); emit('step_finish', {type: 'step-finish', reason: 'tool-calls', tokens: usage}); }, 20);
    return;
  }
  // FAKE_OC_SCENARIO=opener-then-silence: says one sentence, does tool work, then the turn ends with
  // no text after the last tool call — the shape of a worker that went quiet (observed live: that
  // opener became the task's completion).
  if (scenario === 'opener-then-silence') {
    emit('text', {type: 'text', text: 'I will execute this task systematically. Let me start by reading the owned files.'});
    emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'a.js'}, output: 'x'}});
    emit('step_finish', {type: 'step-finish', reason: 'tool-calls', tokens: usage});
    emit('step_start', {type: 'step-start'});
    emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'b.js'}, output: 'y'}});
    emit('step_finish', {type: 'step-finish', reason: 'stop', tokens: usage});
    return process.exit(0);
  }
  // FAKE_OC_SCENARIO=stepcap: the shape observed live when opencode's maxSteps runs out — it injects its
  // own notice as the assistant's last text, with the model's stray thinking tag ahead of it.
  if (scenario === 'stepcap') {
    emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'src/a.js'}, output: 'x'}});
    emit('step_finish', {type: 'step-finish', reason: 'tool-calls', tokens: usage});
    emit('step_start', {type: 'step-start'});
    emit('text', {type: 'text', text: '</think>\n\nCRITICAL - MAXIMUM STEPS REACHED\n\nThe maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.'});
    emit('step_finish', {type: 'step-finish', reason: 'stop', tokens: usage});
    return process.exit(0);
  }
  if (scenario === 'loop-unread') { setInterval(() => emit('tool_use', {type: 'tool', tool: 'glob', state: {status: 'completed', input: {pattern: '*.js'}, output: 'No files found'}}), 20); return; }
  if (scenario === 'loop') { emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'CHANGE.diff'}, output: 'diff'}}); setInterval(() => emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'src/a.js'}, output: 'x'}}), 20); return; }
  setTimeout(() => {
    for (const entry of (process.env.FAKE_OC_WRITE ?? '').split(',').filter(Boolean)) {
      const cut = entry.indexOf(':'); const target = path.resolve(dir, entry.slice(0, cut));
      fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, entry.slice(cut + 1));
    }
    if (scenario === 'refused') {
      process.stderr.write('\x1b[93m\x1b[1m! \x1b[0mpermission requested: external_directory (/elsewhere/*); auto-rejecting\n');
      emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'error', input: {filePath: '/elsewhere/x'}, error: 'The user rejected permission to use this specific tool call.'}});
      emit('step_finish', {type: 'step-finish', reason: 'stop', tokens: usage});
      return process.exit(0);
    }
    if (scenario === 'denied') emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'error', input: {filePath: '/etc/hosts'}, error: 'The user rejected permission to use this specific tool call.'}});
    else emit('tool_use', {type: 'tool', tool: 'read', state: {status: 'completed', input: {filePath: 'note.txt'}, output: 'ok'}});
    // The echo is the ORDERS line only: bounce appends a report line to a local worker's prompt.
    if (scenario !== 'notext') emit('text', {type: 'text', text: `echo: ${prompt.split('\n\n')[0]}`});
    // Observed live (qwen3-coder-30b): the whole report, then one more step whose only text is a
    // stray closing code fence.
    if (scenario === 'fence') { emit('step_finish', {type: 'step-finish', reason: 'tool-calls', tokens: usage}); emit('step_start', {type: 'step-start'}); emit('text', {type: 'text', text: '```'}); }
    emit('step_finish', {type: 'step-finish', reason: 'stop', tokens: usage});
    process.exit(0);
  }, Number(process.env.FAKE_OC_TURN_MS ?? 5));
});
