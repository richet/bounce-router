import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export function resolveExecutable(provider, override, {env = process.env, home = os.homedir(), platform = process.platform, accessible = file => {try {fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile();} catch {return false;}}} = {}) {
  if (override) return override;
  const candidates = (env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir,provider));
  candidates.push(path.join(home,'.local','bin',provider),path.join(home,'.npm-global','bin',provider),`/opt/homebrew/bin/${provider}`,`/usr/local/bin/${provider}`);
  if (platform === 'darwin' && provider === 'codex') {
    for (const base of ['/Applications',path.join(home,'Applications')]) for (const app of ['Codex','ChatGPT']) candidates.push(path.join(base,`${app}.app`,'Contents','Resources','codex'));
  }
  return candidates.find(accessible) || provider;
}
