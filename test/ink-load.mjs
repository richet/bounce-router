import {PassThrough} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {createInkTerminal} from '../src/tui/ink-terminal.js';

const stdin = new PassThrough();
const stdout = new PassThrough();
stdin.setRawMode = () => {};
stdout.columns = 100;
stdout.rows = 30;
let outputBytes = 0;
stdout.on('data', chunk => { outputBytes += chunk.length; });
let received = 0;
let sent = 0;
let commandAcks = 0;
let draft = '';
const sentAt = [];
const pendingKeys = [];
const pendingCommands = [];
const keyLatency = [];
const commandLatency = [];
let terminal;
terminal = createInkTerminal({stdin, stdout,
  onKeypress: (str, key) => {
    const startedAt = sentAt.shift();
    received++;
    if (key?.name === 'return') {
      draft = '';
      commandAcks++;
    } else draft += str;
    const target = terminal.update({input: draft, notice: key?.name === 'return' ? `local command acknowledged ${commandAcks}` : 'input accepted'});
    pendingKeys.push({startedAt, target});
    if (key?.name === 'return') pendingCommands.push({startedAt, target});
  },
  onFrame: frame => {
    while (pendingKeys[0]?.target <= frame.revision) keyLatency.push(frame.time - pendingKeys.shift().startedAt);
    while (pendingCommands[0]?.target <= frame.revision) commandLatency.push(frame.time - pendingCommands.shift().startedAt);
  },
});
await terminal.mount({agentsOpen: true, selectedId: 'worker:worker-0', events: Array.from({length: 10000}, (_, index) => ({kind: 'assistant', id: `history-${index}`, seq: index, text: `history ${index}`}))});
for (let index = 0; index < 4; index++) {
  terminal.ingest({kind: 'task.submitted', id: `task-${index}`, seq: 10001 + index * 2, task: `worker-${index}`, profile: 'build'});
  terminal.ingest({kind: 'task.started', id: `start-${index}`, seq: 10002 + index * 2, task: `worker-${index}`, requested: 'gpt-5.6-terra'});
}
const baselineMemory = process.memoryUsage();
let maxHeap = baselineMemory.heapUsed;
let maxRss = baselineMemory.rss;
const memoryTimer = setInterval(() => {
  const memory = process.memoryUsage();
  maxHeap = Math.max(maxHeap, memory.heapUsed);
  maxRss = Math.max(maxRss, memory.rss);
}, 1000);
const started = performance.now();
let activity = 0;
let nextKeyAt = 10;
let nextCommandAt = 100;
await new Promise(resolve => {
  const timer = setInterval(() => {
    const elapsed = performance.now() - started;
    const expected = Math.min(6000, Math.floor(elapsed / 10));
    while (activity < expected) {
      terminal.ingest({kind: 'task.activity', id: `activity-${activity}`, seq: 11000 + activity, task: `worker-${activity % 4}`, text: `activity ${activity}`});
      activity++;
      if (activity >= nextKeyAt) {
        sentAt.push(performance.now());
        stdin.write('x');
        sent++;
        nextKeyAt += 10;
      }
      if (activity >= nextCommandAt) {
        sentAt.push(performance.now());
        stdin.write('\r');
        sent++;
        nextCommandAt += 100;
      }
    }
    if (elapsed >= 60000) { clearInterval(timer); resolve(); }
  }, 10);
});
clearInterval(memoryTimer);
await new Promise(resolve => setTimeout(resolve, 250));
const state = terminal.debugState();
terminal.unmount();
keyLatency.sort((a, b) => a - b);
commandLatency.sort((a, b) => a - b);
const percentile = (values, ratio) => values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
const result = {
  durationMs: performance.now() - started,
  history: 10000,
  workers: 4,
  activity,
  sent,
  received,
  commandAcks,
  keyFrames: keyLatency.length,
  commandFrames: commandLatency.length,
  keyToFrameMs: {p50: percentile(keyLatency, 0.5), p95: percentile(keyLatency, 0.95), max: keyLatency.at(-1)},
  commandAckToFrameMs: {p50: percentile(commandLatency, 0.5), p95: percentile(commandLatency, 0.95), max: commandLatency.at(-1)},
  heapGrowthMb: (maxHeap - baselineMemory.heapUsed) / 1048576,
  rssGrowthMb: (maxRss - baselineMemory.rss) / 1048576,
  outputBytes,
  ...state,
};
console.log(JSON.stringify(result));
const failed = activity !== 6000 || sent !== received || keyLatency.length !== sent
  || commandLatency.length !== commandAcks || result.keyToFrameMs.p95 > 100
  || result.commandAckToFrameMs.p95 > 100 || result.heapGrowthMb > 128 || state.outputBlocked;
if (failed) process.exitCode = 1;
