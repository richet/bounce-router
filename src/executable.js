import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export function resolveExecutable(provider, override, {env = process.env, home = os.homedir(), accessible = file => {try {fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile();} catch {return false;}}} = {}) {
  if (override) return override;
  const candidates = (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir,provider));
  candidates.push(path.join(home,'.local','bin',provider),path.join(home,'.npm-global','bin',provider),`/opt/homebrew/bin/${provider}`,`/usr/local/bin/${provider}`);
  // opencode's own installer puts the binary here and adds it to the interactive shell's PATH.
  // A context with a reduced PATH (a GUI-launched terminal, a stripped environment, a daemon that
  // did not inherit the login profile) would otherwise report it missing while it is installed.
  if (provider === 'opencode') candidates.push(path.join(home, '.opencode', 'bin', provider));
  return candidates.find(accessible) || provider;
}
