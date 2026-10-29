import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {saveJSON} from './core.js';

// Which opencode a local worker runs on decides how it is driven: 1.x and 2.x differ in the `run`
// flags, the config shape and the tool names (src/adapters/opencode-live.js). Both are read from
// `--version`: 1.x prints the bare version (`1.18.31`), 2.x the command name and a v (`opencode v2.0.29`).
// The versions the adapter was run against for real (test/local-opencode.live.test.js); another
// version of a supported major is expected to work, and `bounce doctor` says it is unverified.
export const VERIFIED = ['1.18.31', '2.0.29'];
export const SUPPORTED_MAJORS = [1, 2];
// What `bounce doctor --fix` installs when the opencode found is missing or unsupported. 2.x is not
// published to npm (only 1.x is), so the fix is the verified 1.x release.
export const FIX_VERSION = '1.18.31';

export function parseOpencodeVersion(text) {
  const line = String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n')[0].trim();
  const match = /^(?:opencode\s+v?)?(\d+)\.(\d+)\.(\d+)\S*$/i.exec(line);
  return match ? {version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1])} : null;
}

// One `--version` per binary for the life of the process: the answer does not change under a running
// session, and every worker turn would otherwise pay for it.
const cache = new Map();
export function opencodeVersion(executable, {run = file => execFileSync(file, ['--version'], {encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe']})} = {}) {
  if (cache.has(executable)) return cache.get(executable);
  let found;
  try { found = parseOpencodeVersion(run(executable)) ?? {error: 'unrecognised --version output'}; }
  catch (error) { found = {error: error.code === 'ENOENT' ? 'not installed' : error.message.split('\n')[0]}; }
  if (!found.error) cache.set(executable, found);
  return found;
}

// The verdict `bounce doctor` reports, and what --fix acts on.
export function opencodeStatus(found) {
  if (found.error) return {ok: false, fixable: true, text: found.error};
  if (VERIFIED.includes(found.version)) return {ok: true, text: `${found.version} · verified`};
  if (SUPPORTED_MAJORS.includes(found.major)) return {ok: true, text: `${found.version} · ${found.major}.x is supported, this version unverified (BOUNCE_LIVE_OPENCODE=1 node --test test/local-opencode.live.test.js)`};
  return {ok: false, fixable: true, text: `${found.version} · unsupported: local workers run on opencode ${SUPPORTED_MAJORS.map(major => `${major}.x`).join(' or ')}`};
}

// `bounce doctor --fix`: install the verified release into bounce's own data root — never over the
// user's opencode — and point `executables.opencode` at it. Only that key of config.json changes.
// npm may skip the package's postinstall (it links the platform binary in), so when the installed
// binary does not answer `--version` the postinstall is run by hand, as opencode's own error says to.
export function fixOpencode({root, version = FIX_VERSION, exec = (file, args, options) => execFileSync(file, args, {encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'], ...options})} = {}) {
  const prefix = path.join(root, 'opencode', version);
  fs.mkdirSync(prefix, {recursive: true, mode: 0o700});
  exec('npm', ['install', '--prefix', prefix, '--no-save', '--no-audit', '--no-fund', `opencode-ai@${version}`]);
  const binary = path.join(prefix, 'node_modules', '.bin', 'opencode');
  const check = () => parseOpencodeVersion((() => { try { return exec(binary, ['--version']); } catch { return ''; } })());
  if (check()?.version !== version) exec(process.execPath, ['postinstall.mjs'], {cwd: path.join(prefix, 'node_modules', 'opencode-ai')});
  const found = check();
  if (found?.version !== version) throw new Error(`installed opencode-ai@${version} under ${prefix}, but ${binary} --version did not report ${version}`);
  cache.delete(binary);
  const file = path.join(root, 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  saveJSON(file, {...config, executables: {...(config.executables ?? {}), opencode: binary}});
  return {binary, version};
}
