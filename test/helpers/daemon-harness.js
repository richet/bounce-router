// Test-only harness (T3b D4/D5/D10): spawns the real supervise() daemon as its own OS
// process (so pid-based liveness checks are meaningful) while injecting a fake task
// adapter through supervise()'s own {adapters, profiles, onReady} seam — never through
// a shipped env var. Which fake adapter to install is the one thing this harness reads
// from the environment (HARNESS_ADAPTER=hang|stubborn), because that's how any spawned
// process is parameterized in a test; src/reload.js itself has no such gate.
import {supervise} from '../../src/reload.js';

function makeAdapter(kind) {
  if (kind === 'hang') return {
    async launch() { return {}; },
    async *events() { await new Promise(() => {}); },
    async cancel() { return {verified: true}; },
  };
  if (kind === 'stubborn') return {
    async launch() { return {}; },
    async *events() { await new Promise(() => {}); },
    async cancel() { return {verified: false}; },
  };
  throw new Error(`unknown HARNESS_ADAPTER: ${kind}`);
}

// node --test also scans this directory and loads this file directly (see
// test/helpers/fake-adapter.js's own comment on the same behavior); only actually run
// the daemon when deliberately invoked with HARNESS_ADAPTER set, so a direct load here
// is an inert no-op instead of spawning a real supervisor mid test-discovery.
if (process.env.HARNESS_ADAPTER) await main();

async function main() {
  const adapter = makeAdapter(process.env.HARNESS_ADAPTER);
  await supervise(process.argv.slice(2), {
    adapters: {harness: adapter},
    profiles: {
      main: {adapter: 'codex', mode: 'yolo', fallback: []},
      harness: {adapter: 'harness', mode: 'yolo', fallback: []},
    },
    onReady: async ({scheduler}) => {
      scheduler.submit({parent: null, profile: 'harness', orders: 'x', deadline: null});
    },
  }).catch(error => { console.error(`bounce: ${error.message}`); process.exitCode = 1; });
}
