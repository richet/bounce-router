// A task's check: the command its orders name as proof the work is done (Daniel, 2026-09-28). bounce
// runs it itself, in the worker's copy, once the worker has finished; only work that passes is put
// in the checkout. Found live (ACE d1bc0206, task 99bd27ea): work nobody had verified was integrated
// after its one send-back, because the only judge was a review of the report's wording.
import {spawn} from 'node:child_process';
import {vendorEnv} from './adapters/live-common.js';
import {outputTail} from './command-output.js';

export const CHECK_MAX = 2000; // characters of command
export const CHECK_TIMEOUT_MS = 10 * 60_000;
const KEEP = 64 * 1024; // of output, while it runs

// Commands that only look: they read files and text, and run nothing of the work.
const LOOKS = new Set(['test', '[', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'cat', 'head', 'tail', 'wc', 'stat', 'true', 'echo']);
const SHELLS = new Set(['sh', 'bash', 'zsh']);

function onlyLooks(part) {
  const words = part.trim().replace(/^[!({\s]+/, '').split(/\s+/).filter(Boolean);
  while (words.length && /^\w+=/.test(words[0])) words.shift();
  if (!words.length) return true;
  const name = words[0].split('/').at(-1);
  // `sh -n script` reads the script for syntax; it does not run it.
  if (SHELLS.has(name)) return words[1] === '-n';
  return LOOKS.has(name);
}

// A check made only of commands that look for files or text proves that they exist, not that the
// work is right. Found live (ACE e3bd01d5): under such checks a local builder wrote the report the
// check looked for ("VERDICT: PASS", 0 assertions) beside its own run's "VERDICT: FAIL".
export const weakCheck = command => String(command).split(/&&|\|\||[;|\n]/).every(onlyLooks);

export const validCheck = value => typeof value === 'string' && value.trim().length > 0 && value.length <= CHECK_MAX;

// Resolves, never rejects: a command that cannot start is a check that did not pass, with the reason
// as its output.
export function runCheck({command, cwd, timeoutMs = CHECK_TIMEOUT_MS, env = vendorEnv(process.env)}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    let output = '';
    let timedOut = false;
    let settled = false;
    const done = exit => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A tool the shell could not find, or a shell that did not start: the check said nothing about
      // the work. Exit 127 alone does not say that: found live, a missing script the task was to write
      // ends the same way ("No such file or directory"), and that is the work's to fix.
      const notFound = (exit === 126 || exit === 127) && /: command not found\s*$/.test(outputTail(output));
      const unrunnable = !timedOut && (exit === null || notFound);
      resolve({command, exit, passed: exit === 0 && !timedOut, output: outputTail(output), ms: Date.now() - startedAt,
        ...(weakCheck(command) ? {weak: true} : {}),
        ...(unrunnable ? {unrunnable: true} : {}), ...(timedOut ? {timedOut: true, minutes: Math.round(timeoutMs / 60_000)} : {})});
    };
    // Its own process group, so a check that started servers or children is stopped whole.
    const child = spawn('/bin/sh', ['-c', command], {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    const collect = chunk => { output = (output + chunk).slice(-KEEP); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { output += `\n${error.message}`; done(null); });
    child.on('close', code => done(code));
  });
}
