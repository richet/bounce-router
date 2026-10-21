export {opencodeProviderConfig, samplingOptions} from './local-opencode-provider.js';
import {opencodeProviderConfig} from './local-opencode-provider.js';

// ---------------------------------------------------------------------------------------------
// The bridge preflight.
//
// bounce configures OpenCode, and OpenCode drives the model — so a local worker depends on a second
// binary that bounce does not ship and cannot assume. Without this, a missing or misconfigured
// `opencode` only surfaces at first dispatch as `spawn ... ENOENT`, long after setup. (It replaces
// the container-era `bounce local check`, which verified Docker readiness.)
//
// It runs a real one-line turn through the REAL adapter rather than inspecting configuration,
// because the interesting failures are not visible in config: opencode happily lists whatever model
// the generated block declares, whether or not LM Studio can actually serve it. Only a turn that
// completes proves the bridge end to end.
export async function checkOpencodeBridge({settings, endpoint = 'lmstudio', model, executable,
  env = process.env, timeoutMs = 120_000, adapter: supplied} = {}) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const {resolveExecutable} = await import('./executable.js');

  const binary = resolveExecutable('opencode', executable);
  const result = {binary, config: {ready: false}, worker: {ready: false}, model: model ?? null, endpoint};

  let config;
  try {
    ({config} = opencodeProviderConfig({settings, endpoint, model, env}));
    result.config.ready = true;
  } catch (error) {
    result.config.reason = error.message;
    return result;
  }

  const adapter = supplied ?? (await import('./adapters/opencode-live.js')).createOpencodeLive({});
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-bridge-check-')));
  const dir = path.join(cwd, '.task');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  let handle;
  try {
    handle = await adapter.launch({
      peer: 'bridge-check', cwd, dir,
      orders: 'Reply with exactly: OK. Call no tools.',
      profile: {executables: {opencode: binary}, opencodeConfig: config, providerID: endpoint,
        model, policy: 'read-only', mode: 'yolo'},
    });
    // The adapter has no timers of its own (a worker is bounded by its task); this check is not a
    // task, so it bounds itself: killing our own child ends the stream.
    const timer = setTimeout(() => { result.worker.reason = `no reply within ${timeoutMs}ms`; void adapter.cancel(handle); }, timeoutMs);
    try {
      for await (const event of adapter.events(handle)) {
        if (event.kind === 'error') { result.worker.reason = event.code === 'missing' ? `opencode is not installed or not on PATH (${binary})` : event.text ?? event.code; break; }
        if (event.kind !== 'result') continue;
        if (event.status === 'completed') { result.worker.ready = true; result.worker.reply = String(event.text ?? '').trim().slice(0, 200); }
        else result.worker.reason ??= event.text ?? event.code ?? 'the worker did not complete';
        break;
      }
    } finally { clearTimeout(timer); }
  } catch (error) {
    result.worker.reason = /ENOENT/.test(error.message)
      ? `opencode is not installed or not on PATH (${binary})`
      : error.message;
  } finally {
    try { if (handle) await adapter.cancel(handle); } catch {}
    fs.rmSync(cwd, {recursive: true, force: true});
  }
  return result;
}
