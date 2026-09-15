import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants as fsConstants} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LOCAL_TOOLCHAIN_IMAGE = 'node:22-alpine';
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const DOCKER_TIMEOUT = 15_000;

function failure(code, message, extra = {}) { return Object.assign(new Error(message), {code, ...extra}); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function resultCode(result) { return result?.code ?? 0; }
function output(result) { return String(result?.stderr || result?.stdout || 'docker command failed').trim(); }
function supportedPlatform(image) { return image.os === 'linux' && ['amd64', 'arm64'].includes(image.architecture); }

async function defaultDocker({args, input = '', timeout = DOCKER_TIMEOUT, maxOutputBytes = 1024 * 1024}) {
  return new Promise(resolve => {
    let child; let stdout = ''; let stderr = ''; let done = false;
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const append = (which, chunk) => {
      const text = chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + Buffer.byteLength(text) > maxOutputBytes) {
        child.kill('SIGKILL'); finish({code: 1, stdout, stderr: 'docker output limit exceeded'}); return;
      }
      if (which === 'stdout') stdout += text; else stderr += text;
    };
    let timer;
    try { child = spawn('docker', args, {shell: false, stdio: ['pipe', 'pipe', 'pipe']}); }
    catch (cause) { finish({code: cause.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: cause.message}); return; }
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.stdin.on('error', cause => finish({code: 1, stdout, stderr: cause.message}));
    child.once('error', cause => finish({code: cause.code === 'ENOENT' ? 127 : 1, stdout, stderr: cause.message}));
    child.once('close', code => finish({code: code ?? 1, stdout, stderr}));
    timer = setTimeout(() => { child.kill('SIGKILL'); finish({code: 1, stdout, stderr: 'docker command timed out'}); }, timeout);
    child.stdin.end(input);
  });
}

function call(docker, args, options = {}) {
  return docker({args, input: options.input ?? '', timeout: options.timeout ?? DOCKER_TIMEOUT, maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024});
}

async function inspectImage(docker, image, {requireNode22 = true} = {}) {
  const inspected = await call(docker, ['image', 'inspect', '--format', '{{json .}}', image]);
  if (resultCode(inspected) !== 0) return {ready: false, requested: image, reason: 'IMAGE_MISSING'};
  let data;
  try { data = JSON.parse(inspected.stdout); } catch { return {ready: false, requested: image, reason: 'IMAGE_METADATA_INVALID'}; }
  const value = {ready: true, requested: image, id: data.Id, os: data.Os, architecture: data.Architecture, sizeBytes: data.Size, labels: data.Config?.Labels ?? {}, repoDigests: data.RepoDigests ?? []};
  if (!value.id || !value.os || !value.architecture || !Number.isFinite(value.sizeBytes)) return {...value, ready: false, reason: 'IMAGE_METADATA_INVALID'};
  if (!supportedPlatform(value)) return {...value, ready: false, reason: 'UNSUPPORTED_PLATFORM'};
  return value;
}

async function readDependencyInputs(cwd) {
  const root = await fs.realpath(cwd);
  const files = [];
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(root, name);
    let handle;
    try { handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
    catch (cause) {
      if (cause.code === 'ENOENT') continue;
      if (cause.code === 'ELOOP') throw failure('UNSAFE_INPUT', `${name} must be a regular, non-linked file`);
      throw cause;
    }
    let stat; let content;
    try {
      stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw failure('UNSAFE_INPUT', `${name} must be a regular, non-linked file`);
      if (stat.size > MAX_INPUT_BYTES) throw failure('INPUT_TOO_LARGE', `${name} exceeds the ${MAX_INPUT_BYTES} byte setup limit`);
      content = await handle.readFile();
      if (content.length > MAX_INPUT_BYTES) throw failure('INPUT_TOO_LARGE', `${name} grew beyond the ${MAX_INPUT_BYTES} byte setup limit while reading`);
    } finally { await handle.close(); }
    files.push({name, content});
  }
  const packageFile = files.find(file => file.name === 'package.json');
  const lockFile = files.find(file => file.name === 'package-lock.json');
  if (!packageFile) throw failure('PACKAGE_MISSING', 'Local toolchain setup requires a regular package.json.');
  let manifest;
  try { manifest = JSON.parse(packageFile.content); } catch { throw failure('PACKAGE_INVALID', 'package.json is not valid JSON.'); }
  if (!lockFile) throw failure('LOCKFILE_MISSING', 'Local toolchain setup supports npm projects with package-lock.json. Generate and review a lockfile first.');
  if (manifest.packageManager && !String(manifest.packageManager).startsWith('npm@')) throw failure('UNSUPPORTED_PACKAGE_MANAGER', 'Local toolchain setup currently supports npm package-lock projects only.');
  return {root, manifest, packageFile, lockFile};
}

function projectDiagnosis(inputs) {
  const declared = inputs.manifest.packageManager || (inputs.lockFile ? 'npm (package-lock.json)' : undefined);
  const node = inputs.manifest.engines?.node;
  return {
    packageManager: {ready: Boolean(inputs.lockFile), name: declared ?? 'unknown', reason: inputs.lockFile ? undefined : 'LOCKFILE_MISSING'},
    runtime: {ready: false, required: 'Node 22', declared: node, reason: 'Image metadata cannot prove the Node runtime. Explicit setup will probe the local image without network access.'},
  };
}

export async function inspectLocalToolchain({cwd, image = DEFAULT_LOCAL_TOOLCHAIN_IMAGE, docker = defaultDocker} = {}) {
  if (!cwd || typeof cwd !== 'string') throw failure('INVALID_CWD', 'cwd is required');
  if (!image || typeof image !== 'string') throw failure('INVALID_IMAGE', 'image is required');
  const dockerResult = await call(docker, ['version', '--format', '{{.Server.Version}}']);
  const dockerReady = resultCode(dockerResult) === 0;
  let inputs; let project;
  try { inputs = await readDependencyInputs(cwd); project = projectDiagnosis(inputs); }
  catch (cause) { project = {packageManager: {ready: false, reason: cause.code}, runtime: {ready: false, required: 'Node 22', reason: cause.message}}; }
  const inspected = dockerReady ? await inspectImage(docker, image) : {ready: false, requested: image, reason: 'DOCKER_MISSING'};
  return {
    ready: dockerReady && inspected.ready && project.packageManager.ready,
    docker: {ready: dockerReady, reason: dockerReady ? undefined : (resultCode(dockerResult) === 127 ? 'DOCKER_MISSING' : 'DOCKER_UNAVAILABLE')},
    image: inspected,
    ...project,
    suggestion: 'Use node:22-alpine for small images, or node:22-bookworm-slim when native dependencies need Debian compatibility.',
  };
}

function dockerfile({base, baseId, cacheKey, packageHash, lockHash, platform}) {
  return `FROM ${base}\nLABEL bounce.toolchain=local bounce.cachekey=${cacheKey} bounce.packagehash=${packageHash} bounce.lockhash=${lockHash} bounce.base=${base} bounce.baseid=${baseId} bounce.platform=${platform}\nUSER root\nRUN mkdir -p /opt/bounce-deps /node_modules && chown -R node:node /opt/bounce-deps /node_modules\nWORKDIR /opt/bounce-deps\nCOPY --chown=node package.json package-lock.json ./\nUSER node\nRUN npm ci --ignore-scripts --no-audit --no-fund && mkdir -p node_modules\nUSER root\nRUN rm -rf /node_modules && ln -s /opt/bounce-deps/node_modules /node_modules\nENV PATH=/opt/bounce-deps/node_modules/.bin:$PATH\nUSER node\n`;
}

async function verifiedBaseReference(docker, image, onActivity) {
  const digest = image.repoDigests.find(value => typeof value === 'string' && value.includes('@sha256:'));
  if (digest) {
    const verified = await inspectImage(docker, digest, {requireNode22: false});
    if (verified.ready && verified.id === image.id) return {reference: digest, temporaryTag: undefined};
  }
  const tag = `bounce-toolchain-base:${digestValue(image.id).slice(0, 20)}-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  onActivity?.({stage: 'toolchain', text: 'pinning the verified local base image to a private temporary tag'});
  const tagged = await call(docker, ['tag', image.id, tag]);
  if (resultCode(tagged) !== 0) throw failure('BASE_PIN_FAILED', `Could not pin the inspected local image: ${output(tagged)}`);
  const verified = await inspectImage(docker, tag, {requireNode22: false});
  if (!verified.ready || verified.id !== image.id) throw failure('BASE_PIN_FAILED', 'The private local base tag did not resolve to the inspected image ID.');
  return {reference: tag, temporaryTag: tag};
}
function digestValue(value) { return String(value).replace(/^sha256:/, ''); }

async function probeNode22(docker, image) {
  const owner = randomUUID();
  try {
    const probe = await call(docker, ['run', '--rm', '--label', `bounce.setup=${owner}`, '--network', 'none', '--user', '1000:1000', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '1', '--pids-limit', '32', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=1m', '--entrypoint', 'node', image.id, '-p', 'process.versions.node'], {timeout: 20_000});
    const major = Number.parseInt(String(probe.stdout).trim().split('.')[0], 10);
    if (resultCode(probe) !== 0 || major !== 22) throw failure('UNSUPPORTED_RUNTIME', `The inspected image did not pass the isolated Node 22 probe: ${output(probe)}`);
  } finally {
    const listed = await call(docker, ['ps', '-a', '--no-trunc', '--filter', `label=bounce.setup=${owner}`, '--format', '{{.ID}}']);
    if (resultCode(listed) !== 0) throw failure('SETUP_CLEANUP_UNVERIFIED', `Could not verify probe cleanup; inspect Docker label bounce.setup=${owner}`);
    for (const id of String(listed.stdout).trim().split('\n').filter(Boolean)) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw failure('SETUP_CLEANUP_UNVERIFIED', 'Invalid probe container identity');
      const inspected = await call(docker, ['inspect', '--format', '{{index .Config.Labels "bounce.setup"}}|{{.Id}}', id]);
      if (resultCode(inspected) !== 0 || inspected.stdout.trim() !== `${owner}|${id}`) throw failure('SETUP_CLEANUP_UNVERIFIED', 'Probe ownership could not be verified');
      const removed = await call(docker, ['rm', '--force', id]);
      if (resultCode(removed) !== 0) throw failure('SETUP_CLEANUP_UNVERIFIED', `Could not stop owned probe ${id}`);
    }
  }
}

export async function prepareLocalToolchain({cwd, image = DEFAULT_LOCAL_TOOLCHAIN_IMAGE, allowNetwork = false, docker = defaultDocker, onActivity} = {}) {
  if (typeof allowNetwork !== 'boolean') throw failure('INVALID_NETWORK_OPTION', 'allowNetwork must be a boolean');
  const inspected = await inspectLocalToolchain({cwd, image, docker});
  if (!inspected.docker.ready) throw failure(inspected.docker.reason, 'Docker is required to prepare a local toolchain.');
  if (!inspected.image.ready) throw failure(inspected.image.reason, `Cannot use ${image}: ${inspected.image.reason}.`);
  const inputs = await readDependencyInputs(cwd);
  await probeNode22(docker, inspected.image);
  const platform = `${inspected.image.os}/${inspected.image.architecture}`;
  const packageHash = digest(inputs.packageFile.content); const lockHash = digest(inputs.lockFile.content);
  const key = digest(`${inputs.root}\0${inspected.image.id}\0${platform}\0${packageHash}\0${lockHash}`);
  let tag = `bounce-toolchain:${key.slice(0, 32)}`;
  const existing = await inspectImage(docker, tag, {requireNode22: false});
  if (existing.ready && existing.labels['bounce.toolchain'] === 'local' && existing.labels['bounce.cachekey'] === key && existing.labels['bounce.packagehash'] === packageHash && existing.labels['bounce.lockhash'] === lockHash && existing.labels['bounce.baseid'] === inspected.image.id && existing.labels['bounce.platform'] === platform) {
    return {ready: true, reused: true, cacheKey: key, image: inspected, preparedImage: tag, preparedImageId: existing.id, profileImageID: existing.id, network: allowNetwork ? 'docker-default' : 'none'};
  }
  if (existing.ready) tag = `${tag}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const context = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-toolchain-'));
  let pin;
  try {
    await fs.writeFile(path.join(context, 'package.json'), inputs.packageFile.content, {mode: 0o600, flag: 'wx'});
    await fs.writeFile(path.join(context, 'package-lock.json'), inputs.lockFile.content, {mode: 0o600, flag: 'wx'});
    pin = await verifiedBaseReference(docker, inspected.image, onActivity);
    const file = dockerfile({base: pin.reference, baseId: inspected.image.id, cacheKey: key, packageHash, lockHash, platform});
    await fs.writeFile(path.join(context, 'Dockerfile'), file, {mode: 0o600, flag: 'wx'});
    onActivity?.({stage: 'toolchain', text: allowNetwork ? 'building dependencies with Docker default build networking' : 'building dependencies with Docker build networking disabled'});
    const args = ['build', '--pull=false', '--tag', tag, '--label', 'bounce.toolchain=local', '--label', `bounce.cachekey=${key}`];
    if (!allowNetwork) args.push('--network=none');
    args.push('--file', path.join(context, 'Dockerfile'), context);
    const built = await call(docker, args, {input: file, timeout: 10 * 60_000, maxOutputBytes: 1024 * 1024});
    if (resultCode(built) !== 0) {
      if (!allowNetwork) throw failure('DEPENDENCIES_UNAVAILABLE', `Offline dependency build failed: ${output(built)}. --network=none disables RUN networking, but BuildKit may still resolve image metadata; no pull is requested. Re-run explicit setup with allowNetwork: true for ordinary Docker build networking used by npm downloads.`);
      throw failure('TOOLCHAIN_BUILD_FAILED', `Toolchain build failed: ${output(built)}`);
    }
    const prepared = await inspectImage(docker, tag, {requireNode22: false});
    if (!prepared.ready || prepared.labels['bounce.toolchain'] !== 'local' || prepared.labels['bounce.cachekey'] !== key || prepared.labels['bounce.packagehash'] !== packageHash || prepared.labels['bounce.lockhash'] !== lockHash || prepared.labels['bounce.baseid'] !== inspected.image.id || prepared.labels['bounce.platform'] !== platform) throw failure('TOOLCHAIN_VERIFICATION_FAILED', 'Docker built an image whose local toolchain labels could not be verified.');
    return {ready: true, reused: false, cacheKey: key, image: inspected, preparedImage: tag, preparedImageId: prepared.id, profileImageID: prepared.id, network: allowNetwork ? 'docker-default' : 'none'};
  } finally { if (pin?.temporaryTag) await call(docker, ['image', 'rm', pin.temporaryTag]); await fs.rm(context, {recursive: true, force: true}); }
}
