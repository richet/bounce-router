import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
export const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const {version} = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const stable = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export function newer(candidate, current = version) {
  if (!stable(candidate) || !stable(current)) return false;
  const a = candidate.split('.').map(BigInt), b = current.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export async function npm(args, {timeout = 10000} = {}) {
  const {stdout} = await exec('npm', args, {timeout, maxBuffer: 1024 * 1024, cwd: packageRoot});
  return stdout.trim();
}
export async function globalInstall({root = packageRoot, run = npm, platform = process.platform} = {}) {
  const prefix = await run(['prefix', '--global']);
  const expected = path.join(prefix, ...(platform === 'win32' ? [] : ['lib']), 'node_modules', 'bouncerouter');
  try {
    if (!path.isAbsolute(prefix) || fs.lstatSync(expected).isSymbolicLink() || fs.realpathSync(expected) !== fs.realpathSync(root)) throw new Error();
  } catch {
    throw new Error('Self-update requires a global npm installation using the npm on PATH. Development checkouts, npm links and local installs are skipped. Use npm install -g bouncerouter@latest to install globally.');
  }
  return prefix;
}
export async function checkUpdate({root, force = false, run = npm, now = Date.now()} = {}) {
  const file = root && path.join(root, 'update-check.json');
  if (!force && file) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now >= cached.checkedAt && now - cached.checkedAt < 86400000 && stable(cached.latest)) return {latest: cached.latest, available: newer(cached.latest)};
    } catch {}
  }
  const latest = JSON.parse(await run(['view', 'bouncerouter@latest', 'version', '--json']));
  if (!stable(latest)) throw new Error('npm returned an invalid stable release version');
  if (file) {
    try {fs.mkdirSync(root, {recursive: true}); fs.writeFileSync(file, JSON.stringify({checkedAt: now, latest}) + '\n');} catch {}
  }
  return {latest, available: newer(latest)};
}
export async function installUpdate({run = npm, detect = globalInstall, root} = {}) {
  const prefix = await detect({run});
  const release = await checkUpdate({root, force: true, run});
  if (!release.available) return `Bounce ${version} is up to date.`;
  await run(['install', '--global', '--prefix', prefix, `bouncerouter@${release.latest}`], {timeout: 120000});
  return `Updated bounce to ${release.latest}.`;
}
