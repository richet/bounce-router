import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {adapters} from './adapters/index.js';

export const providers = Object.fromEntries(Object.entries(adapters).map(([name, a]) => [name, {login: a.login}]));
export const limitPattern = /rate[_ -]?limit|usage[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|insufficient_quota|too many requests|(?:hit|reached|exceeded) your (?:usage )?limit|out of (?:credits|tokens)|\b429\b/i;
export function invocation(provider, {model, mode, images = []}, promptFile) {
  if (!adapters[provider]) throw new Error(`Unknown provider: ${provider}`);
  return adapters[provider].invocation({model, mode, images}, promptFile);
}
export function normalize(provider, raw) {
  if (!adapters[provider]) throw new Error(`Unknown provider: ${provider}`);
  return adapters[provider].normalize(raw);
}

// Only error channels are classified as exhaustion. Assistant/tool text can quote errors.
export function runProcess({provider, executable = provider, args, prompt, cwd, signal, emit}) {
  return new Promise(resolve => {
    let failed = false, limited = false, terminal = false, stderr = '', closed = false;
    const child = spawn(executable, args, {cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
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
        emit(event);
      }
    });
    createInterface({input: child.stderr}).on('line', line => {
      stderr = (stderr + '\n' + line).slice(-16000);
      emit({kind: 'diagnostic', text: line});
    });
    child.on('close', (code, sig) => {
      const status = signal?.aborted ? 'cancelled' : limited || ((code !== 0 || failed) && limitPattern.test(stderr)) ? 'limited' : code === 0 && !failed && terminal ? 'completed' : 'failed';
      finish({status, code, signal: sig});
    });
  });
}
