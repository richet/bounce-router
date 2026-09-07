import {spawn as spawnProcess} from 'node:child_process';
import {createInterface} from 'node:readline';

// One newline-delimited JSON conversation with a vendor CLI. The caller owns the
// protocol; this owns process lifetime, timeouts and failure text. A failure is
// returned, never thrown: one silent agent must not hide the others.
export function queryLines({executable, args, requests, read, spawn = spawnProcess, timeout = 20000, cwd, messages = {}}) {
  return new Promise(resolve => {
    const out = {};
    let child, settled = false, stderr = '';
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch {}
      resolve({out, error: error ?? null});
    };
    const timer = setTimeout(() => finish(messages.timeout ?? `${executable} did not answer in time`), timeout);
    try { child = spawn(executable, args, {cwd, stdio: ['pipe', 'pipe', 'pipe']}); }
    catch (error) { return finish(error.message); }
    child.on('error', error => finish(error.code === 'ENOENT' ? (messages.missing ?? `${executable} is not installed`) : error.message));
    child.stdin.on('error', () => {}); // The CLI may exit before reading the request.
    child.stderr?.on('data', d => {stderr = (stderr + d).slice(-4000);});
    createInterface({input: child.stdout}).on('line', line => {
      let raw;
      try { raw = JSON.parse(line); } catch { return; }
      if (read(raw, out)) finish();
    });
    child.on('close', () => finish(stderr.trim().split('\n').at(-1) || (messages.closed ?? `${executable} exited before answering`)));
    for (const request of requests) child.stdin.write(JSON.stringify(request) + '\n');
  });
}
