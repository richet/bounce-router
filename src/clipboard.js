import fs from 'node:fs';
import path from 'node:path';
import {spawn as spawnProcess} from 'node:child_process';

// The system clipboard, reached the way a terminal app reaches it. OSC 52 asks the terminal itself to set the
// clipboard: it works in most current terminals and over SSH, needs nothing installed, and fails silently where a
// terminal does not allow it. So a desktop clipboard tool is also given the text when one is installed.

// Inside tmux, an escape sequence for the outer terminal travels in a DCS passthrough with its ESCs doubled.
export function osc52(text, env = process.env) {
  const sequence = `\x1b]52;c;${Buffer.from(String(text), 'utf8').toString('base64')}\x07`;
  return env.TMUX ? `\x1bPtmux;${sequence.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : sequence;
}

function onPath(name, env = process.env) {
  return String(env.PATH ?? '').split(path.delimiter).some(dir => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

// [command, args] for each tool this desktop can use, in the order tried.
export function clipboardTools({env = process.env, platform = process.platform, found = name => onPath(name, env)} = {}) {
  if (platform === 'darwin') return found('pbcopy') ? [['pbcopy', []]] : [];
  const tools = [];
  if (env.WAYLAND_DISPLAY && found('wl-copy')) tools.push(['wl-copy', []]);
  if (env.DISPLAY && found('xclip')) tools.push(['xclip', ['-selection', 'clipboard']]);
  if (env.DISPLAY && found('xsel')) tools.push(['xsel', ['--clipboard', '--input']]);
  return tools;
}

function feed([command, args], text, spawn) {
  return new Promise(resolve => {
    let child;
    try { child = spawn(command, args, {stdio: ['pipe', 'ignore', 'ignore'], detached: false}); } catch { resolve(false); return; }
    child.on('error', () => resolve(false));
    child.on('close', code => resolve(code === 0));
    child.stdin.end(text);
  });
}

// Copies `text`; resolves with how many lines went and by which routes. The terminal route is always written;
// the first desktop tool that succeeds is enough.
export async function copyToClipboard(text, {write = chunk => process.stdout.write(chunk), env = process.env, platform = process.platform, found, spawn = spawnProcess} = {}) {
  write(osc52(text, env));
  const via = ['terminal'];
  for (const tool of clipboardTools({env, platform, ...(found ? {found} : {})})) {
    if (await feed(tool, text, spawn)) { via.push(tool[0]); break; }
  }
  return {lines: String(text).split('\n').length, via};
}
