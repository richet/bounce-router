import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {limitPattern, normalize, vendorChildEnv} from './providers.js';

// One vendor process per conversation instead of one per turn (docs/ARCHITECTURE.md § Classic mode). claude
// started as `-p --input-format stream-json` keeps reading user messages on stdin and answers each with a result
// line, so the second turn skips the CLI's start (~1 s measured) and the thread stays warm. A process is reused
// while what it was launched with is the same (provider, executable, arguments other than --resume, environment,
// directory); otherwise, or once it has died or been cancelled, the next turn launches a new one, and Router.run's
// --resume carries the thread across. Turns on one conversation never overlap: Router.run runs one at a time.
export const PERSISTENT = new Set(['claude']);
const STREAM_INPUT = ['--input-format', 'stream-json'];

function withoutResume(args) {
  const out = [];
  for (let index = 0; index < args.length; index++) { if (args[index] === '--resume') index++; else out.push(args[index]); }
  return out;
}

const userMessage = prompt => prompt.startsWith('{') && prompt.endsWith('\n')
  ? prompt
  : JSON.stringify({type: 'user', parent_tool_use_id: null, message: {role: 'user', content: prompt}}) + '\n';

export function createConversations() {
  const live = new Map(); // provider -> {key, child, turn}
  const killGroup = (child, sig) => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch {} };
  function end(provider, sig = 'SIGTERM') {
    const entry = live.get(provider);
    if (!entry) return;
    live.delete(provider);
    entry.closed = true;
    try { entry.child.stdin.end(); } catch {}
    killGroup(entry.child, sig);
    setTimeout(() => killGroup(entry.child, 'SIGKILL'), 1500).unref();
  }
  function launch({provider, executable, args, env, cwd, key}) {
    const launchArgs = args.includes('--input-format') ? args : [...args, ...STREAM_INPUT];
    const child = spawn(executable, launchArgs, {cwd, env: vendorChildEnv({executable, extraEnv: env}), detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    const entry = {key, child, turn: null, closed: false};
    child.stdin.on('error', () => {});
    createInterface({input: child.stdout}).on('line', line => entry.turn?.line(line));
    createInterface({input: child.stderr}).on('line', line => entry.turn?.stderr(line));
    child.on('error', error => { entry.turn?.finish({status: error.code === 'ENOENT' ? 'missing' : 'failed'}, error.message); if (live.get(provider) === entry) live.delete(provider); });
    child.on('close', (code, sig) => { if (live.get(provider) === entry) live.delete(provider); entry.closed = true; entry.turn?.finish({status: 'failed', code, signal: sig}); });
    live.set(provider, entry);
    return entry;
  }
  function turn({provider, executable = provider, args, prompt, cwd, env = {}, signal, emit}) {
    const key = JSON.stringify([executable, withoutResume(args), env, cwd]);
    if (live.get(provider)?.key !== key) end(provider);
    const entry = live.get(provider) ?? launch({provider, executable, args, env, cwd, key});
    return new Promise(resolve => {
      let failed = false, limited = false, stderr = '', done = false;
      const finish = (result, message) => {
        if (done) return;
        done = true;
        entry.turn = null;
        signal?.removeEventListener('abort', cancel);
        if (message) emit({kind: 'error', text: message});
        resolve(result);
      };
      // A cancelled turn takes its process with it: the next turn resumes the thread on a new one.
      const cancel = () => { finish({status: 'cancelled'}); end(provider); };
      entry.turn = {
        line(text) {
          let raw;
          try { raw = JSON.parse(text); } catch { emit({kind: 'status', text}); return; }
          emit({kind: 'raw', raw});
          for (const event of normalize(provider, raw)) {
            if (event.kind === 'error') { failed = true; limited ||= limitPattern.test(event.text); }
            emit(event);
            if (event.kind === 'result') {
              failed ||= !event.success;
              finish({status: limited || (failed && limitPattern.test(stderr)) ? 'limited' : failed ? 'failed' : 'completed'});
            }
          }
        },
        stderr(text) { stderr = (stderr + '\n' + text).slice(-16000); emit({kind: 'diagnostic', text}); },
        finish,
      };
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, {once: true});
      if (entry.closed) { finish({status: 'failed'}); return; }
      entry.child.stdin.write(userMessage(prompt));
    });
  }
  const closeAll = () => { for (const provider of [...live.keys()]) end(provider); };
  return {turn, close: end, closeAll, alive: provider => live.has(provider)};
}
