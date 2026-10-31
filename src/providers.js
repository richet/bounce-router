import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {adapters} from './adapters/index.js';
import {prepareCodexHome} from './codex-home.js';

export const providers = Object.fromEntries(Object.entries(adapters).map(([name, a]) => [name, {login: a.login}]));
export const limitPattern = /rate[_ -]?limit|usage[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|insufficient_quota|too many requests|(?:hit|reached|exceeded) your (?:usage )?limit|out of (?:credits|tokens)|\b429\b/i;
// `resume`: the vendor's own id for the thread this turn continues (a `peer.native` row), for an adapter
// that declares `resumes: true`; the others start fresh and ignore it.
// `stream`: the caller renders text as it is generated (the classic TUI); adapters without partial output ignore it.
// `executable`: the CLI this turn runs (resolveExecutable), for an adapter whose flags depend on its version.
export function invocation(provider, {model, mode, images = [], ephemeral = false, resume = null, stream = false, cwd, executable}, promptFile) {
  if (!adapters[provider]) throw new Error(`Unknown provider: ${provider}`);
  return adapters[provider].invocation({model, mode, images, ephemeral, stream, cwd, executable, resume: adapters[provider].resumes ? resume : null}, promptFile);
}
export const canResume = provider => adapters[provider]?.resumes === true;
// What a provider sets up around a classic turn before its process starts (opencode 2.x: a server to stream from).
export const prepareTurn = (provider, options) => adapters[provider]?.prepareTurn ? adapters[provider].prepareTurn(options) : null;
// A provider that cannot run without a chosen model (opencode: no model, nothing to run) says so.
export const requiresModel = provider => adapters[provider]?.requiresModel === true;
// Environment an adapter needs its CLI to see (opencode's config travels in OPENCODE_CONFIG_CONTENT);
// nothing for the vendors that take everything on argv.
export function providerEnv(provider, options) {
  if (!adapters[provider]) throw new Error(`Unknown provider: ${provider}`);
  return adapters[provider].env ? adapters[provider].env(options) : {};
}
export function normalize(provider, raw) {
  if (!adapters[provider]) throw new Error(`Unknown provider: ${provider}`);
  return adapters[provider].normalize(raw);
}

// The environment a vendor CLI runs with, the adapter's additions laid over it. A vendor CLI must never see the bus,
// a grant, or the role/profile that would make a nested bounce believe it is the orchestrator: it acts through its own
// adapter, not as a peer. The single exception (T3b): the orchestrator profile's own CLI *is* a peer — it holds the
// orchestrator grant and talks to the bridge — so only that one child keeps BOUNCE_BUS*. The supervisor's own flags
// go too (same set as live-common's DAEMON_FLAGS): a nested `bounce` in the vendor's shell must not think it is the
// supervised child or a daemon.
export function vendorChildEnv({executable, keepBus = false, extraEnv = {}}) {
  const {BOUNCE_BUS, BOUNCE_BUS_TOKEN_FILE, BOUNCE_REMOTE_SESSION, BOUNCE_ROLE, BOUNCE_ORCHESTRATOR_PROFILE,
    BOUNCE_SUPERVISED, BOUNCE_DETACHED, BOUNCE_VIEW_DAEMON, BOUNCE_PERSISTENT_VIEW, BOUNCE_RESTART, ...env} = process.env;
  if (keepBus && BOUNCE_BUS !== undefined) { env.BOUNCE_BUS = BOUNCE_BUS; env.BOUNCE_BUS_TOKEN_FILE = BOUNCE_BUS_TOKEN_FILE; }
  Object.assign(env, extraEnv);
  prepareCodexHome(executable, env);
  return env;
}

// Only error channels are classified as exhaustion. Assistant/tool text can quote errors.
// `env`: the adapter's additions (providerEnv), laid over the stripped process environment.
export function runProcess({provider, executable = provider, args, prompt, cwd, signal, emit, keepBus = false, env: extraEnv = {}}) {
  return new Promise(resolve => {
    let failed = false, limited = false, terminal = false, stderr = '', closed = false, lastText = '';
    const env = vendorChildEnv({executable, keepBus, extraEnv});
    const child = spawn(executable, args, {cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    const finish = result => { if (!closed) { closed = true; clearTimeout(killTimer); signal?.removeEventListener('abort', cancel); resolve(result); } };
    let killTimer;
    const kill = sig => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch {} };
    const cancel = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1500); };
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    child.on('error', error => { emit({kind: 'error', text: error.message}); finish({status: error.code === 'ENOENT' ? 'missing' : 'failed'}); });
    child.stdin.on('error', () => {}); // EPIPE: the process may reject arguments before reading stdin.
    child.stdin.end(adapters[provider] ? adapters[provider].stdin(prompt) : prompt);
    const out = createInterface({input: child.stdout});
    out.on('line', line => {
      let raw;
      try { raw = JSON.parse(line); } catch { emit({kind: 'status', text: line}); return; }
      emit({kind: 'raw', raw});
      for (const event of normalize(provider, raw)) {
        if (event.kind === 'error') { failed = true; limited ||= limitPattern.test(event.text); }
        if (event.kind === 'result') { terminal = true; failed ||= !event.success; }
        if (event.kind === 'assistant') lastText = event.text;
        emit(event);
      }
    });
    createInterface({input: child.stderr}).on('line', line => {
      stderr = (stderr + '\n' + line).slice(-16000);
      emit({kind: 'diagnostic', text: line});
    });
    child.on('close', (code, sig) => {
      // A CLI with no result line (opencode `run`): the exit is the result, the last answer its text.
      if (adapters[provider]?.resultOnExit && !terminal && !signal?.aborted) {
        terminal = true;
        const success = code === 0 && !failed;
        emit({kind: 'result', text: success ? lastText : `${provider} exited ${code ?? sig}`, success});
        failed ||= !success;
      }
      const status = signal?.aborted ? 'cancelled' : limited || ((code !== 0 || failed) && limitPattern.test(stderr)) ? 'limited' : code === 0 && !failed && terminal ? 'completed' : 'failed';
      finish({status, code, signal: sig});
    });
  });
}
