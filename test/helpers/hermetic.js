// Loaded into every test process by `npm test` (`node --test --import`): the suite never reaches this
// machine's local model server or its memory probes. A test that forgets to inject a fake for the
// scheduler's host-facing defaults (resources, localFleet, unloadLocal, localResolver) is refused
// here and its file fails, even when the production code swallows the error (readMachine and
// discoverLocalModels both degrade quietly, which is how the leak went unnoticed).
// Forked children inherit this preload too; it only wraps host calls, so they are hermetic as well.
// BOUNCE_LIVE_OPENCODE=1 is the one deliberate opt-in (test/local-opencode.live.test.js).
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';

// `npm test` names this file relative to the repo; a test that forks the CLI from another cwd inherits
// that execArgv. Pin it to this file's absolute path so every fork still finds (and keeps) the guard.
const self = fileURLToPath(import.meta.url);
const isSelf = spec => /(^|\/)test\/helpers\/hermetic\.js$/.test(spec);
for (const [index, arg] of process.execArgv.entries()) {
  if (arg.startsWith('--import=') && isSelf(arg.slice(9))) process.execArgv[index] = `--import=${self}`;
  else if (arg === '--import' && isSelf(process.execArgv[index + 1] ?? '')) process.execArgv[index + 1] = self;
}

// fork() forwards execArgv, but a test that spawn()s node (a real daemon, the CLI) does not: found live,
// a daemon spawned by test/persistent-daemon.test.js reached this machine's LM Studio. NODE_OPTIONS
// carries the guard into every node child that inherits the environment.
if (!String(process.env.NODE_OPTIONS ?? '').includes(self)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--import=${self}`;
}

// A test file runs in its own empty project, never this checkout: a daemon or worker started with
// the default cwd snapshots and copies its whole tree into attempt workspaces (observed: every file
// of the repo and its agent worktrees read per launch, 1.5 s tests taking 30 s under a full run).
// Only the test file's own process moves; children a test spawns keep the cwd the test gives them.
if (/\.test\.js$/.test(process.argv[1] ?? '')) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-test-cwd-'));
  process.chdir(project);
  process.on('exit', () => { try { fs.rmSync(project, {recursive: true, force: true}); } catch {} });
}

if (process.env.BOUNCE_LIVE_OPENCODE !== '1') {
  const HOST_COMMANDS = new Set(['lms', 'vm_stat', 'sysctl']);
  const LOCAL_MODEL_PORTS = new Set(['1234']); // LM Studio's server
  const violations = [];
  const refuse = what => {
    violations.push(what);
    return Object.assign(new Error(`hermetic test suite: refused to reach the host (${what})`), {code: 'HERMETIC'});
  };
  // A vendor CLI (named bare, through PATH, or by its resolved absolute path) that lives outside a temp dir or this repo's test helpers that
  // is the user's real, signed-in agent — a paid model call (session titling asks one on the first prompt).
  const VENDOR_COMMANDS = new Set(['claude', 'codex', 'muse', 'opencode']);
  const fakes = [fs.realpathSync(os.tmpdir()), path.dirname(self)];
  const realVendor = (file, options) => {
    if (!VENDOR_COMMANDS.has(path.basename(String(file)))) return false;
    const dirs = String(options?.env?.PATH ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const found = path.isAbsolute(String(file)) ? (fs.existsSync(file) ? String(file) : null)
      : dirs.map(dir => path.join(dir, String(file))).find(candidate => fs.existsSync(candidate));
    if (!found) return false;
    const real = fs.realpathSync(found);
    return !fakes.some(root => real.startsWith(root + path.sep)) && !real.startsWith('/private/var/folders/') && !real.startsWith('/var/folders/');
  };
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn']) {
    const original = childProcess[name];
    childProcess[name] = function (file, ...rest) {
      if (HOST_COMMANDS.has(path.basename(String(file)))) throw refuse(`${name} ${file}`);
      const options = rest.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg));
      // `--version` alone never reaches a model: test/opencode-contract.test.js holds the installed binary to it.
      const versionOnly = Array.isArray(rest[0]) && rest[0].length === 1 && rest[0][0] === '--version';
      if (!versionOnly && realVendor(file, options)) throw refuse(`${name} ${file} (the real vendor CLI on PATH)`);
      return original.call(this, file, ...rest);
    };
  }
  syncBuiltinESMExports();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && LOCAL_MODEL_PORTS.has(url.port)) {
      return Promise.reject(refuse(`fetch ${url.origin}${url.pathname}`));
    }
    return realFetch(input, init);
  };
  process.on('exit', () => {
    if (!violations.length) return;
    console.error(`hermetic test suite: ${violations.length} host access(es) refused:\n${[...new Set(violations)].map(v => `  ${v}`).join('\n')}`);
    process.exitCode = 1;
  });
}
