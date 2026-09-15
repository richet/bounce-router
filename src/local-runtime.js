import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_LOCAL_IMAGE = 'node:22-alpine';
const MIB = 1024 * 1024;
const MAX_WORKSPACE_MIB = 256;
const MAX_FILES = 10000;
const MAX_DEPTH = 64;
const MANIFEST_VERSION = 1;
const CONTROL = new Set(['.git', '.bounce', '.codex', '.claude', '.agents', 'node_modules', '.ssh', '.aws', '.gnupg', '.docker']);
const SECRETS = new Set(['.env', '.env.local', '.env.production', '.npmrc', '.pypirc', '.netrc', 'credentials', 'credentials.json']);

function fault(code, message, extra = {}) { return Object.assign(new Error(message), {code, ...extra}); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function rel(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) throw fault('PATH_DENIED', 'path must be relative');
  const clean = path.posix.normalize(value.replaceAll('\\', '/'));
  if (clean === '..' || clean.startsWith('../')) throw fault('PATH_DENIED', 'path escapes workspace');
  return clean;
}
function inside(file, roots) { return roots.some(root => root === '.' || file === root || file.startsWith(`${root}/`)); }
function excluded(file) { return file.split('/').some(part => CONTROL.has(part) || SECRETS.has(part) || part.startsWith('.env.')); }
function number(value, fallback, min, max, integer = false) {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) throw fault('INVALID_RUNTIME', 'invalid runtime limit');
  return result;
}
function getLimits(profile) {
  const c = profile.container ?? {};
  const image = c.image ?? DEFAULT_LOCAL_IMAGE;
  if (typeof image !== 'string' || !image) throw fault('INVALID_RUNTIME', 'container image is required');
  return {
    image,
    memoryMiB: number(c.memoryMiB, 512, 32, 65536, true),
    cpus: number(c.cpus, 1, 0.1, 128),
    pids: number(c.pids, 64, 8, 4096, true),
    workspaceMiB: number(c.workspaceMiB, 128, 1, MAX_WORKSPACE_MIB, true),
    timeoutMs: number(profile.localOptions?.timeoutMs, 120000, 100, 3600000, true),
    maxOutput: Math.min(MIB, number(profile.localOptions?.maxOutputTokens, 2048, 1, 131072, true) * 8),
  };
}

async function snapshot(root, roots, maximum) {
  const files = [], baseline = new Map(), seen = new Set();
  let total = 0;
  async function walk(absolute, name, depth = 0) {
    if (depth > MAX_DEPTH) throw fault('WORKSPACE_LIMIT', 'workspace nesting exceeds configured limit');
    if (name !== '.' && excluded(name)) return;
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw fault('UNSAFE_LINK', `symbolic link rejected: ${name}`);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolute, {withFileTypes: true});
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) await walk(path.join(absolute, entry.name), name === '.' ? entry.name : `${name}/${entry.name}`, depth + 1);
      return;
    }
    if (!stat.isFile()) throw fault('UNSAFE_FILE', `special file rejected: ${name}`);
    if (stat.nlink !== 1) throw fault('UNSAFE_LINK', `hard-linked file rejected: ${name}`);
    if (seen.has(name)) return;
    if (seen.size >= MAX_FILES) throw fault('WORKSPACE_LIMIT', 'workspace file count exceeds configured limit');
    total += stat.size;
    if (total > maximum) throw fault('WORKSPACE_LIMIT', 'workspace snapshot exceeds configured limit');
    const content = await fs.readFile(absolute);
    files.push({path: name, content: content.toString('base64'), mode: stat.mode & 0o777});
    baseline.set(name, {hash: hash(content), mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino});
    seen.add(name);
  }
  for (const rootName of roots) {
    let current = root;
    for (const part of rootName === '.' ? [] : rootName.split('/')) {
      current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw fault('UNSAFE_LINK', `symbolic link rejected: ${rootName}`);
      } catch (cause) {
        if (cause.code === 'ENOENT') break;
        throw cause;
      }
    }
    try { await walk(path.resolve(root, rootName), rootName); }
    catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {files, baseline};
}

function statePath(root, dir) {
  const directory = path.isAbsolute(dir) ? dir : path.resolve(root, dir);
  return {directory, manifest: path.join(directory, 'local-runtime.json')};
}

async function writeManifest(location, value) {
  await fs.mkdir(location.directory, {recursive: true, mode: 0o700});
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > 64 * 1024) throw fault('MANIFEST_INVALID', 'runtime manifest exceeds limit');
  const temporary = `${location.manifest}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temporary, location.manifest);
  const directory = await fs.open(location.directory, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function isNotFound(result, kind = 'container') {
  if ((result.code ?? 0) === 0) return false;
  const text = `${result.stderr ?? ''} ${result.stdout ?? ''}`;
  return kind === 'volume' ? /no such volume|not found/i.test(text) : /no such (object|container)|not found/i.test(text);
}

function validIdentity(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value); }

const HELPER = String.raw`
const fs=require('fs'),path=require('path'),cp=require('child_process'),root='/workspace';
function err(code,message,x={}){return Object.assign(Error(message),{code,...x})}
function clean(p){if(typeof p!=='string'||!p||p.includes('\0')||path.isAbsolute(p))throw err('PATH_DENIED','invalid path');const q=path.posix.normalize(p.replaceAll('\\','/'));if(q==='..'||q.startsWith('../'))throw err('PATH_DENIED','escape');return q}
function full(p){p=clean(p);const f=path.resolve(root,p);if(f!==root&&!f.startsWith(root+'/'))throw err('PATH_DENIED','escape');let c=root;for(const x of p==='.'?[]:p.split('/')){c=path.join(c,x);if(fs.existsSync(c)&&fs.lstatSync(c).isSymbolicLink())throw err('UNSAFE_LINK','symlink: '+p)}return[p,f]}
function regular(f,p){const s=fs.lstatSync(f);if(!s.isFile())throw err('UNSAFE_FILE','not regular: '+p);if(s.nlink!==1)throw err('UNSAFE_LINK','hardlink: '+p)}
function ok(x){process.stdout.write(JSON.stringify({ok:true,...x}))}function fail(e){process.stdout.write(JSON.stringify({ok:false,code:e.code||'TOOL_FAILED',message:e.message,status:e.status,signal:e.signal,result:e.result}))}
try{const q=JSON.parse(fs.readFileSync(0,'utf8'));
if(q.op==='init'){for(const x of q.files){const[p,f]=full(x.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(x.content,'base64'),{flag:'wx',mode:x.mode&511})}ok({result:''})}
else if(q.op==='read'){const[p,f]=full(q.path);regular(f,p);const b=fs.readFileSync(f);if(b.length>q.max)throw err('OUTPUT_LIMIT','read too large');ok({result:b.toString('utf8')})}
else if(q.op==='write'){const[p,f]=full(q.path),b=Buffer.from(q.content,'utf8');if(b.length>q.max)throw err('OUTPUT_LIMIT','write too large');fs.mkdirSync(path.dirname(f),{recursive:true});if(fs.existsSync(f))regular(f,p);fs.writeFileSync(f,b);ok({result:''})}
else if(q.op==='patch'){const[p,f]=full(q.path);regular(f,p);const b=fs.readFileSync(f,'utf8');if(!b.includes(q.old))throw err('PATCH_PRECONDITION','patch precondition failed');const n=Buffer.from(b.replace(q.old,q.new));if(n.length>q.max)throw err('OUTPUT_LIMIT','patch too large');fs.writeFileSync(f,n);ok({result:''})}
else if(q.op==='run'){const r=cp.spawnSync('/bin/sh',['-c',q.command],{cwd:root,encoding:'utf8',timeout:q.timeout,maxBuffer:q.max});const result=((r.stdout||'')+(r.stderr||'')).slice(0,q.max);if(r.error)throw err(r.error.code==='ETIMEDOUT'?'COMMAND_TIMEOUT':'COMMAND_FAILED',r.error.message,{status:r.status,signal:r.signal,result});if(r.status!==0)throw err('COMMAND_FAILED','command exited '+r.status,{status:r.status,signal:r.signal,result});ok({result,status:r.status})}
else if(q.op==='collect'){const found=[];let total=0;function walk(d,p='',depth=0){if(depth>q.maxDepth)throw err('WORKSPACE_LIMIT','collection too deep');for(const e of fs.readdirSync(d,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const r=p?p+'/'+e.name:e.name,f=path.join(d,e.name),s=fs.lstatSync(f);if(s.isSymbolicLink())throw err('UNSAFE_LINK','symlink: '+r);if(s.isDirectory()){walk(f,r,depth+1);continue}if(!s.isFile())throw err('UNSAFE_FILE','special: '+r);if(s.nlink!==1)throw err('UNSAFE_LINK','hardlink: '+r);if(found.length>=q.maxFiles)throw err('WORKSPACE_LIMIT','too many files');total+=s.size;if(total>q.max)throw err('WORKSPACE_LIMIT','collection too large');found.push({path:r,content:fs.readFileSync(f).toString('base64'),mode:s.mode&511})}}walk(root);ok({files:found})}
else throw err('INVALID_TOOL','unsupported operation')}catch(e){fail(e)}
`;

async function defaultDocker({args, input = '', timeout, maxOutputBytes = MIB, maxInputBytes = MAX_WORKSPACE_MIB * MIB * 2}) {
  if (Buffer.byteLength(input) > maxInputBytes) return {stdout: '', stderr: 'docker input limit exceeded', code: 1};
  return new Promise(resolve => {
    let child, timer, stdout = '', stderr = '', settled = false;
    const done = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    try { child = spawn('docker', args, {stdio: ['pipe', 'pipe', 'pipe']}); }
    catch (cause) { done({stdout: '', stderr: cause.message, code: cause.code === 'ENOENT' ? 127 : 1}); return; }
    const append = (kind, chunk) => {
      const next = (kind === 'stdout' ? stdout : stderr) + chunk;
      if (Buffer.byteLength(next) > maxOutputBytes) { child.kill('SIGKILL'); done({stdout, stderr: 'docker output limit exceeded', code: 1}); }
      else if (kind === 'stdout') stdout = next; else stderr = next;
    };
    child.stdout.on('data', chunk => append('stdout', chunk.toString()));
    child.stderr.on('data', chunk => append('stderr', chunk.toString()));
    child.stdin.on('error', cause => done({stdout, stderr: cause.message, code: 1}));
    child.once('error', cause => done({stdout, stderr: cause.message, code: cause.code === 'ENOENT' ? 127 : 1}));
    child.once('close', code => done({stdout, stderr, code: code ?? 1}));
    timer = setTimeout(() => { child.kill('SIGKILL'); done({stdout, stderr: 'docker command timed out', code: 1}); }, timeout);
    child.stdin.end(input);
  });
}

export function createLocalRuntime({docker = defaultDocker, id = () => randomUUID()} = {}) {
  return {async prepare({cwd, dir, profile = {}, signal, onActivity} = {}) {
    let root, readPaths, writePaths, config, source, location;
    try {
      if (!cwd || !dir) throw fault('INVALID_RUNTIME', 'cwd and dir are required');
      if (signal?.aborted) throw fault('CANCELLED', 'workspace preparation cancelled');
      root = await fs.realpath(cwd);
      readPaths = (profile.readPaths?.length ? profile.readPaths : ['.']).map(rel);
      writePaths = (profile.writePaths ?? []).map(rel);
      if ([...readPaths, ...writePaths].some(excluded)) throw fault('PATH_DENIED', 'control and credential paths cannot be assigned');
      config = getLimits(profile);
      source = await snapshot(root, [...new Set([...readPaths, ...writePaths])], config.workspaceMiB * MIB);
      location = statePath(root, dir);
    } catch (cause) { cause.terminationVerified = true; throw cause; }
    const activity = text => onActivity?.({stage: 'workspace', text});
    let closed = false, finalResult;
    const hostRead = tool => {
      const file = rel(tool.arguments?.path ?? '');
      if (!inside(file, readPaths)) throw fault('PATH_DENIED', 'read outside scope');
      const item = source.files.find(value => value.path === file);
      if (!item) throw fault('PATH_DENIED', 'file unavailable in snapshot');
      const bytes = Buffer.from(item.content, 'base64');
      if (bytes.length > config.maxOutput) throw fault('OUTPUT_LIMIT', 'read too large');
      return bytes.toString('utf8');
    };
    if (!(profile.policy === 'write' && profile.mode === 'yolo')) return {
      async execute(tool) {
        if (closed) throw fault('RUNTIME_CLOSED', 'workspace closed');
        if (tool?.name === 'read_file') return hostRead(tool);
        if (tool?.name === 'search') {
          const query = String(tool.arguments?.query ?? ''); let result = '';
          for (const file of source.files) if (inside(file.path, readPaths) && Buffer.from(file.content, 'base64').toString('utf8').includes(query)) result += `${file.path}\n`;
          if (Buffer.byteLength(result) > config.maxOutput) throw fault('OUTPUT_LIMIT', 'search too large');
          return result;
        }
        throw fault('POLICY_DENIED', 'read-only profile cannot modify files or run commands');
      },
      async finish() { closed = true; return finalResult ??= {verified: true, changes: []}; },
      async cancel() { closed = true; return {verified: true}; },
    };
    if (!writePaths.length) throw fault('INVALID_RUNTIME', 'write profile requires write paths', {terminationVerified: true});

    const token = String(id()).replaceAll(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
    if (!token) throw fault('INVALID_RUNTIME', 'invalid runtime id', {terminationVerified: true});
    const ownerToken = randomUUID();
    const names = {writer: `bounce-${token}-writer`, keeper: `bounce-${token}-keeper`, volume: `bounce-${token}-workspace`};
    const label = `bounce.task=${String(dir).replaceAll(/[\r\n]/g, '').slice(0, 128)}`;
    const ownerLabel = `bounce.owner=${ownerToken}`;
    let writer, keeper, collected, artifact, closing, volumeCreated = false, ownershipMayExist = false, terminationVerified = false, finishError, cancelResult, cancelError;
    let manifest = {version: MANIFEST_VERSION, ownerToken, cwd: root, taskDir: String(dir), names, phase: 'prepared', resources: {writerId: null, keeperId: null, volumeCreated: false}, limits: {workspaceMiB: config.workspaceMiB, timeoutMs: config.timeoutMs}};
    const callDocker = (args, options = {}) => docker({args, input: options.input ?? '', timeout: options.timeout ?? config.timeoutMs, maxOutputBytes: options.output, maxInputBytes: options.inputLimit});
    const check = (result, code, message) => { if ((result.code ?? 0) !== 0) throw fault(code, `${message}: ${result.stderr || result.stdout || 'docker failed'}`); };
    const update = async (phase, extra = {}) => {
      manifest = {...manifest, ...extra, phase, resources: {...manifest.resources, ...(extra.resources ?? {})}};
      await writeManifest(location, manifest);
    };
    const inspectOwned = async container => {
      if (!validIdentity(container)) throw fault('OWNERSHIP_MISMATCH', 'invalid container identity');
      const result = await callDocker(['inspect', '--format', '{{index .Config.Labels "bounce.owner"}}|{{.State.Running}}|{{.Id}}', container], {timeout: 10000});
      if ((result.code ?? 0) !== 0) {
        if (isNotFound(result)) return {missing: true};
        throw fault('CONTAINMENT_FAILED', `container inspection failed: ${result.stderr || result.stdout}`);
      }
      const [owner, running, exactId] = result.stdout.trim().split('|');
      if (owner !== ownerToken || !validIdentity(exactId) || exactId !== container) throw fault('OWNERSHIP_MISMATCH', `container ownership mismatch: ${container}`);
      return {missing: false, running: running === 'true'};
    };
    const inspectVolume = async () => {
      const result = await callDocker(['volume', 'inspect', '--format', '{{index .Labels "bounce.owner"}}', names.volume], {timeout: 10000});
      if ((result.code ?? 0) !== 0) {
        if (isNotFound(result, 'volume')) return {missing: true};
        throw fault('CONTAINMENT_FAILED', `volume inspection failed: ${result.stderr || result.stdout}`);
      }
      if (result.stdout.trim() !== ownerToken) throw fault('OWNERSHIP_MISMATCH', 'volume ownership mismatch');
      return {missing: false};
    };
    const stop = async (container, kind, grace = 5) => {
      const before = await inspectOwned(container);
      if (before.missing) return;
      if (!before.running) return;
      const result = await callDocker(['stop', '--time', String(grace), container], {timeout: (grace + 4) * 1000});
      if ((result.code ?? 0) !== 0) check(await callDocker(['kill', container], {timeout: 5000}), 'CONTAINMENT_FAILED', `${kind} kill failed`);
      const after = await inspectOwned(container);
      if (after.missing || after.running) throw fault('CONTAINMENT_FAILED', `${kind} termination unverified`);
    };
    const removeExact = async () => {
      for (const [kind, container] of [['writer', writer], ['keeper', keeper]]) {
        if (!container) continue;
        const before = await inspectOwned(container);
        if (!before.missing) {
          if (before.running) throw fault('CONTAINMENT_FAILED', `${kind} still running during removal`);
          check(await callDocker(['rm', container], {timeout: 10000}), 'CONTAINMENT_FAILED', `${kind} removal failed`);
          const after = await callDocker(['inspect', container], {timeout: 10000});
          if (!isNotFound(after)) throw fault('CONTAINMENT_FAILED', `${kind} removal could not be verified`);
        }
      }
      if (volumeCreated) {
        const before = await inspectVolume();
        if (!before.missing) {
          check(await callDocker(['volume', 'rm', names.volume], {timeout: 10000}), 'CONTAINMENT_FAILED', 'workspace volume removal failed');
          const after = await callDocker(['volume', 'inspect', names.volume], {timeout: 10000});
          if (!isNotFound(after, 'volume')) throw fault('CONTAINMENT_FAILED', 'workspace volume removal could not be verified');
        }
      }
    };
    const helper = async (container, request, collection = false) => {
      const result = await callDocker(['exec', '--interactive', '--user', '1000:1000', '--workdir', '/workspace', container, 'node', '-e', HELPER], {
        input: JSON.stringify(request), inputLimit: config.workspaceMiB * MIB * 2, output: collection ? config.workspaceMiB * MIB * 2 : config.maxOutput * 2,
      });
      check(result, 'CONTAINMENT_FAILED', 'container helper failed');
      let response; try { response = JSON.parse(result.stdout); } catch { throw fault('CONTAINMENT_FAILED', 'invalid helper response'); }
      if (!response.ok) throw fault(response.code ?? 'TOOL_FAILED', response.message, {status: response.status, signal: response.signal, result: response.result});
      return response;
    };
    const seal = async () => {
      if (collected) return;
      activity('stopping writer before collecting results');
      await stop(writer, 'writer');
      let collectionError;
      try { collected = await helper(keeper, {op: 'collect', max: config.workspaceMiB * MIB, maxFiles: MAX_FILES, maxDepth: MAX_DEPTH}, true); }
      catch (cause) { collectionError = cause; }
      await stop(keeper, 'keeper', 1);
      terminationVerified = true;
      await update('sealed');
      if (collectionError) throw collectionError;
    };
    const saveArtifact = async cause => {
      if (artifact) return artifact;
      try {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-local-artifact-'));
        artifact = path.join(directory, 'workspace.json');
        await fs.writeFile(artifact, JSON.stringify({version: 1, cause: cause?.code, unavailable: !collected, files: collected?.files ?? []}), {flag: 'wx', mode: 0o600});
        try { await update('artifact-preserved', {artifact}); } catch {}
        return artifact;
      } catch { return undefined; }
    };
    const discoverOwned = async () => {
      const result = await callDocker(['ps', '-a', '--no-trunc', '--filter', `label=bounce.owner=${ownerToken}`, '--format', '{{.ID}}|{{.Names}}'], {timeout: 10000});
      check(result, 'CONTAINMENT_FAILED', 'owned container discovery failed');
      for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
        const [container, name] = line.split('|');
        if (!validIdentity(container)) throw fault('OWNERSHIP_MISMATCH', 'invalid discovered container identity');
        await inspectOwned(container);
        if (name === names.writer) writer = container;
        else if (name === names.keeper) keeper = container;
        else throw fault('OWNERSHIP_MISMATCH', 'unexpected container carries runtime owner token');
      }
    };
    const cleanupSetup = async () => {
      if (!ownershipMayExist) { terminationVerified = true; await update('setup-failed-cleaned', {terminationVerified: true}); return; }
      await discoverOwned();
      const volumeState = await inspectVolume();
      if (!volumeState.missing) volumeCreated = true;
      if (writer) await stop(writer, 'writer');
      if (keeper) await stop(keeper, 'keeper', 1);
      terminationVerified = true;
      await removeExact();
      await update('setup-failed-cleaned', {terminationVerified: true});
    };
    try {
      await writeManifest(location, manifest);
      activity('checking approved container image');
      const image = await callDocker(['image', 'inspect', '--format', '{{.Id}}|{{.Os}}|{{.Architecture}}|{{json (index .Config "Labels")}}', config.image]);
      if ((image.code ?? 0) !== 0) throw fault('IMAGE_MISSING', `approved image unavailable: ${config.image}`);
      const [imageId, imageOs, imageArchitecture] = image.stdout.trim().split('|');
      if (!validIdentity(imageId) || !imageOs || !imageArchitecture) throw fault('IMAGE_MISSING', 'image inspection returned invalid immutable identity');
      if (imageOs !== 'linux' || !['arm64', 'amd64'].includes(imageArchitecture)) throw fault('INVALID_RUNTIME', 'Local command workers require a Linux arm64/amd64 image');
      const labels = JSON.parse(image.stdout.trim().split('|').slice(3).join('|') || 'null') ?? {};
      const packageFile = source.files.find(file => file.path === 'package.json');
      const lockFile = source.files.find(file => file.path === 'package-lock.json');
      if (labels['bounce.toolchain'] === 'local') {
        if (!packageFile || !lockFile || labels['bounce.packagehash'] !== hash(Buffer.from(packageFile.content, 'base64')) || labels['bounce.lockhash'] !== hash(Buffer.from(lockFile.content, 'base64'))) {
          throw fault('TOOLCHAIN_STALE', 'Prepared dependencies do not match package.json/package-lock.json in the read scope; run explicit bounce local prepare and update the image pin');
        }
      } else if (/^(?:docker\.io\/library\/)?node:22[-.]/.test(config.image) && packageFile) {
        let pkg; try {pkg = JSON.parse(Buffer.from(packageFile.content, 'base64'));} catch {}
        if (Object.keys({...pkg?.dependencies, ...pkg?.devDependencies}).length) throw fault('TOOLCHAIN_SETUP_REQUIRED', 'Base Node image has no project dependencies; run explicit bounce local prepare or configure your prepared toolchain image');
      }
      await update('image-inspected', {image: {requested: config.image, id: imageId, os: imageOs, architecture: imageArchitecture}});
      for (const name of [names.writer, names.keeper]) {
        const existing = await callDocker(['container', 'inspect', name], {timeout: 5000});
        if ((existing.code ?? 0) === 0) throw fault('OWNERSHIP_CONFLICT', `runtime container name already exists: ${name}`);
        if (!isNotFound(existing)) throw fault('CONTAINMENT_FAILED', `container name availability unknown: ${existing.stderr || existing.stdout}`);
      }
      const existingVolume = await callDocker(['volume', 'inspect', names.volume], {timeout: 5000});
      if ((existingVolume.code ?? 0) === 0) throw fault('OWNERSHIP_CONFLICT', `runtime volume name already exists: ${names.volume}`);
      if (!isNotFound(existingVolume, 'volume')) throw fault('CONTAINMENT_FAILED', `volume name availability unknown: ${existingVolume.stderr || existingVolume.stdout}`);
      await update('creating-volume');
      activity('preparing isolated container workspace');
      ownershipMayExist = true;
      const volume = await callDocker(['volume', 'create', '--label', label, '--label', 'bounce.runtime=local', '--label', ownerLabel, '--driver', 'local', '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', `o=size=${config.workspaceMiB}m,uid=1000,gid=1000,mode=0700`, names.volume]);
      check(volume, 'CONTAINMENT_FAILED', 'workspace volume create failed');
      volumeCreated = true;
      await update('volume-created', {resources: {volumeCreated: true}});
      const common = ['--label', label, '--label', 'bounce.runtime=local', '--label', ownerLabel, '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only', '--user', '1000:1000', '--memory', `${config.memoryMiB}m`, '--cpus', String(config.cpus), '--pids-limit', String(config.pids), '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16m'];
      await update('creating-keeper');
      let created = await callDocker(['create', '--name', names.keeper, ...common, '--mount', `type=volume,src=${names.volume},dst=/workspace,readonly`, imageId, 'node', '-e', 'setInterval(() => {}, 1000)']);
      check(created, 'CONTAINMENT_FAILED', 'keeper register failed'); keeper = created.stdout.trim();
      if (!validIdentity(keeper)) throw fault('CONTAINMENT_FAILED', 'keeper returned invalid container ID');
      await update('keeper-registered', {resources: {keeperId: keeper}});
      await update('creating-writer');
      created = await callDocker(['create', '--name', names.writer, ...common, '--mount', `type=volume,src=${names.volume},dst=/workspace`, imageId, 'node', '-e', 'setInterval(() => {}, 1000)']);
      check(created, 'CONTAINMENT_FAILED', 'writer register failed'); writer = created.stdout.trim();
      if (!validIdentity(writer)) throw fault('CONTAINMENT_FAILED', 'writer returned invalid container ID');
      await update('writer-registered', {resources: {writerId: writer}});
      check(await callDocker(['start', keeper]), 'CONTAINMENT_FAILED', 'keeper start failed');
      if (!(await inspectOwned(keeper)).running) throw fault('CONTAINMENT_FAILED', 'keeper not running');
      await update('keeper-started');
      check(await callDocker(['start', writer]), 'CONTAINMENT_FAILED', 'writer start failed');
      if (!(await inspectOwned(writer)).running) throw fault('CONTAINMENT_FAILED', 'writer not running');
      await update('writer-started');
      await helper(writer, {op: 'init', files: source.files});
      await update('ready');
    } catch (cause) {
      let cleanupFailure;
      try { await cleanupSetup(); } catch (cleanup) { cleanupFailure = cleanup; }
      const thrown = cleanupFailure ?? cause;
      thrown.terminationVerified = cleanupFailure ? false : terminationVerified;
      thrown.recovery = location.manifest;
      if (cleanupFailure) thrown.setupError = {code: cause.code, message: cause.message};
      try { await update(cleanupFailure ? 'setup-failed-unverified' : 'setup-failed-cleaned', {terminationVerified: thrown.terminationVerified, error: {code: thrown.code, message: thrown.message}}); } catch {}
      throw thrown;
    }
    const close = () => closing ??= (async () => {
      try { await seal(); }
      finally { if (terminationVerified) { await removeExact(); await update('resources-removed', {terminationVerified: true}); } }
    })();

    async function matches(file, expected) {
      let stat;
      const absolute = path.resolve(root, file);
      let current = root;
      for (const part of file.split('/').slice(0, -1)) {
        current = path.join(current, part);
        try {
          const parent = await fs.lstat(current);
          if (parent.isSymbolicLink()) throw fault('UNSAFE_LINK', `symbolic link rejected: ${file}`);
          if (!parent.isDirectory()) throw fault('UNSAFE_FILE', `unsafe path component: ${file}`);
        } catch (cause) {
          if (cause.code === 'ENOENT') return !expected;
          throw cause;
        }
      }
      try { stat = await fs.lstat(absolute); } catch (cause) { if (cause.code === 'ENOENT') return !expected; throw cause; }
      if (stat.isSymbolicLink()) throw fault('UNSAFE_LINK', `symbolic link rejected: ${file}`);
      if (!stat.isFile()) throw fault('UNSAFE_FILE', `not a regular file: ${file}`);
      if (stat.nlink !== 1) throw fault('UNSAFE_LINK', `hard-linked file rejected: ${file}`);
      if (!expected) return false;
      return stat.dev === expected.dev && stat.ino === expected.ino && (stat.mode & 0o777) === expected.mode && hash(await fs.readFile(absolute)) === expected.hash;
    }
    async function publish() {
      activity('validating and applying owned changes');
      const results = new Map(); let total = 0;
      for (const item of collected.files ?? []) {
        const file = rel(item.path);
        if (excluded(file) || results.has(file)) throw fault('UNSAFE_FILE', `unsafe result: ${file}`);
        const content = Buffer.from(item.content, 'base64'); total += content.length;
        if (total > config.workspaceMiB * MIB) throw fault('WORKSPACE_LIMIT', 'result too large');
        results.set(file, {content, mode: item.mode & 0o777});
      }
      const changed = new Set();
      for (const [file, before] of source.baseline) if (!results.has(file) || hash(results.get(file).content) !== before.hash || results.get(file).mode !== before.mode) changed.add(file);
      for (const file of results.keys()) if (!source.baseline.has(file)) changed.add(file);
      const changes = [...changed].sort();
      for (const file of changes) if (!inside(file, writePaths)) throw fault('SCOPE_VIOLATION', `changed outside write scope: ${file}`);
      const lockPath = path.join(os.tmpdir(), `bounce-local-publish-${hash(root)}`);
      let lock; const staged = [];
      try {
        try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (cause) { if (cause.code === 'EEXIST') throw fault('OWNERSHIP_CONFLICT', 'workspace publication already owned'); throw cause; }
        for (const file of changes) if (!await matches(file, source.baseline.get(file))) throw fault('BASELINE_CONFLICT', `host changed ${file}`);
        for (const file of changes) {
          const result = results.get(file); if (!result) continue;
          const destination = path.resolve(root, file);
          if (!destination.startsWith(`${root}${path.sep}`)) throw fault('PATH_DENIED', 'publish escape');
          await fs.mkdir(path.dirname(destination), {recursive: true});
          const temp = path.join(path.dirname(destination), `.bounce-${token}-${path.basename(file)}.tmp`);
          await fs.writeFile(temp, result.content, {flag: 'wx', mode: result.mode || 0o600}); staged.push(temp);
        }
        let index = 0;
        for (const file of changes) {
          if (!await matches(file, source.baseline.get(file))) throw fault('BASELINE_CONFLICT', `host changed ${file} during publication`);
          const destination = path.resolve(root, file), result = results.get(file);
          if (result) await fs.rename(staged[index++], destination); else await fs.unlink(destination);
        }
        return changes;
      } finally {
        for (const temp of staged) await fs.rm(temp, {force: true});
        await lock?.close(); if (lock) await fs.rm(lockPath, {force: true});
      }
    }
    function changedPaths() {
      if (!collected) return [];
      const results = new Map((collected.files ?? []).map(item => [item.path, item]));
      const changed = new Set();
      for (const [file, before] of source.baseline) {
        const item = results.get(file);
        if (!item || hash(Buffer.from(item.content, 'base64')) !== before.hash || (item.mode & 0o777) !== before.mode) changed.add(file);
      }
      for (const file of results.keys()) if (!source.baseline.has(file)) changed.add(file);
      return [...changed].sort();
    }
    return {
      async execute(tool) {
        if (closed) throw fault('RUNTIME_CLOSED', 'workspace closed');
        if (signal?.aborted) throw fault('CANCELLED', 'workspace cancelled');
        const args = tool?.arguments ?? {};
        if (tool?.name === 'read_file') { const file = rel(args.path); if (!inside(file, readPaths)) throw fault('PATH_DENIED', 'read outside scope'); return (await helper(writer, {op: 'read', path: file, max: config.maxOutput})).result; }
        if (tool?.name === 'search') {
          const query = String(args.query ?? ''); let result = '';
          for (const file of source.files) if (inside(file.path, readPaths) && (await helper(writer, {op: 'read', path: file.path, max: config.maxOutput})).result.includes(query)) result += `${file.path}\n`;
          if (Buffer.byteLength(result) > config.maxOutput) throw fault('OUTPUT_LIMIT', 'search too large'); return result;
        }
        if (tool?.name === 'write_file' || tool?.name === 'patch_file') {
          const file = rel(args.path); if (excluded(file) || !inside(file, writePaths)) throw fault('PATH_DENIED', 'write outside scope');
          return (await helper(writer, tool.name === 'write_file' ? {op: 'write', path: file, content: String(args.content ?? ''), max: config.maxOutput} : {op: 'patch', path: file, old: String(args.old ?? ''), new: String(args.new ?? ''), max: config.maxOutput})).result;
        }
        if (tool?.name === 'run_command') { const command = String(args.command ?? ''); if (!(profile.commands ?? []).includes(command)) throw fault('COMMAND_DENIED', 'command not permitted'); return (await helper(writer, {op: 'run', command, timeout: config.timeoutMs, max: config.maxOutput})).result; }
        throw fault('INVALID_TOOL', `unsupported local tool: ${tool?.name}`);
      },
      async finish({publish: apply = false} = {}) {
        if (finalResult) return finalResult;
        if (finishError) throw finishError;
        if (closed) throw fault('RUNTIME_CLOSED', 'workspace closed', {terminationVerified});
        closed = true;
        try {
          await close();
          const changes = apply ? await publish() : changedPaths();
          if (!apply && changes.length) await saveArtifact();
          await update(apply ? 'published' : 'finished-unpublished', {changes, artifact, terminationVerified: true});
          return finalResult = {verified: true, changes, ...(artifact ? {artifact} : {})};
        } catch (cause) {
          const saved = await saveArtifact(cause); if (saved) cause.artifact = saved;
          cause.terminationVerified = terminationVerified; cause.recovery = location.manifest; finishError = cause;
          try { await update('finish-failed', {artifact, terminationVerified, error: {code: cause.code, message: cause.message}}); } catch {}
          throw cause;
        }
      },
      async cancel() {
        if (cancelResult) return cancelResult;
        if (cancelError) throw cancelError;
        if (finalResult || (finishError && terminationVerified)) return cancelResult = {verified: true, ...(artifact ? {artifact} : {})};
        if (finishError) {
          try {
            const result = await reconcileLocalRuntime({dir: location.directory, docker});
            terminationVerified = result.verified; artifact = result.artifact ?? artifact;
            return cancelResult = {verified: result.verified, ...(artifact ? {artifact} : {})};
          } catch (cause) { cancelError = cause; throw cause; }
        }
        closed = true;
        try { await close(); await saveArtifact(fault('CANCELLED', 'workspace cancelled')); await update('cancelled', {artifact, terminationVerified: true}); return cancelResult = {verified: true, ...(artifact ? {artifact} : {})}; }
        catch (cause) { const saved = await saveArtifact(cause); if (saved) cause.artifact = saved; cause.terminationVerified = terminationVerified; cause.recovery = location.manifest; cancelError = cause; throw cause; }
      },
    };
  }};
}

export async function reconcileLocalRuntime({dir, docker = defaultDocker} = {}) {
  if (!dir) throw fault('INVALID_RUNTIME', 'reconciliation directory is required', {terminationVerified: true});
  const location = {directory: path.resolve(dir), manifest: path.join(path.resolve(dir), 'local-runtime.json')};
  let manifest;
  try {
    const stat = await fs.stat(location.manifest);
    if (stat.size > 64 * 1024) throw fault('MANIFEST_INVALID', 'runtime manifest exceeds limit');
    manifest = JSON.parse(await fs.readFile(location.manifest, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return {verified: true, found: false, reason: 'NO_RECORD'};
    const error = cause.code === 'MANIFEST_INVALID' ? cause : fault('MANIFEST_INVALID', `runtime manifest is malformed: ${cause.message}`);
    error.terminationVerified = false;
    throw error;
  }
  const valid = manifest?.version === MANIFEST_VERSION && /^[0-9a-f-]{36}$/.test(manifest.ownerToken ?? '') && path.isAbsolute(manifest.cwd ?? '')
    && validIdentity(manifest.names?.writer) && validIdentity(manifest.names?.keeper) && validIdentity(manifest.names?.volume);
  if (!valid) throw fault('MANIFEST_INVALID', 'runtime manifest ownership record is invalid', {terminationVerified: false, recovery: location.manifest});
  const owner = manifest.ownerToken;
  const maxBytes = number(manifest.limits?.workspaceMiB, 128, 1, MAX_WORKSPACE_MIB, true) * MIB;
  const timeout = number(manifest.limits?.timeoutMs, 120000, 100, 3600000, true);
  const call = (args, options = {}) => docker({args, input: options.input ?? '', timeout: options.timeout ?? timeout, maxOutputBytes: options.output, maxInputBytes: options.inputLimit});
  const checked = (result, message) => { if ((result.code ?? 0) !== 0) throw fault('CONTAINMENT_FAILED', `${message}: ${result.stderr || result.stdout || 'docker failed'}`); };
  let terminationVerified = false, artifact = manifest.artifact;
  const inspect = async container => {
    if (!validIdentity(container)) throw fault('MANIFEST_INVALID', 'invalid recorded container ID');
    const result = await call(['inspect', '--format', '{{index .Config.Labels "bounce.owner"}}|{{.State.Running}}|{{.Id}}|{{.Name}}', container], {timeout: 10000});
    if ((result.code ?? 0) !== 0) {
      if (isNotFound(result)) return {missing: true};
      throw fault('CONTAINMENT_FAILED', `container inspection failed: ${result.stderr || result.stdout}`);
    }
    const [actualOwner, running, exactId, rawName] = result.stdout.trim().split('|');
    if (actualOwner !== owner || exactId !== container) throw fault('OWNERSHIP_MISMATCH', `recorded container is not owned: ${container}`);
    return {missing: false, running: running === 'true', name: rawName?.replace(/^\//, '')};
  };
  const stop = async (container, grace) => {
    const before = await inspect(container); if (before.missing || !before.running) return;
    const stopped = await call(['stop', '--time', String(grace), container], {timeout: (grace + 4) * 1000});
    if ((stopped.code ?? 0) !== 0) checked(await call(['kill', container], {timeout: 5000}), 'container kill failed');
    const after = await inspect(container);
    if (after.missing || after.running) throw fault('CONTAINMENT_FAILED', 'container termination could not be verified');
  };
  try {
    const listed = await call(['ps', '-a', '--no-trunc', '--filter', `label=bounce.owner=${owner}`, '--format', '{{.ID}}|{{.Names}}'], {timeout: 10000});
    checked(listed, 'owned container discovery failed');
    const identities = new Map();
    for (const line of listed.stdout.trim().split('\n').filter(Boolean)) {
      const [container] = line.split('|');
      const state = await inspect(container);
      if (!state.missing) identities.set(state.name, container);
    }
    for (const [kind, recorded] of [['writer', manifest.resources?.writerId], ['keeper', manifest.resources?.keeperId]]) {
      if (!recorded) continue;
      const state = await inspect(recorded);
      if (!state.missing) {
        if (state.name !== manifest.names[kind]) throw fault('OWNERSHIP_MISMATCH', `recorded ${kind} name mismatch`);
        identities.set(state.name, recorded);
      }
    }
    const writer = identities.get(manifest.names.writer);
    const keeper = identities.get(manifest.names.keeper);
    if ([...identities.keys()].some(name => name !== manifest.names.writer && name !== manifest.names.keeper)) throw fault('OWNERSHIP_MISMATCH', 'unexpected container has runtime owner token');
    if (writer) await stop(writer, 5);
    if (keeper) {
      const state = await inspect(keeper);
      if (!state.missing && state.running) {
        const result = await call(['exec', '--interactive', '--user', '1000:1000', '--workdir', '/workspace', keeper, 'node', '-e', HELPER], {input: JSON.stringify({op: 'collect', max: maxBytes, maxFiles: MAX_FILES, maxDepth: MAX_DEPTH}), inputLimit: 1024, output: maxBytes * 2});
        checked(result, 'recovery collection failed');
        const response = JSON.parse(result.stdout);
        if (!response.ok) throw fault(response.code ?? 'TOOL_FAILED', response.message);
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bounce-local-artifact-'));
        artifact = path.join(directory, 'workspace.json');
        await fs.writeFile(artifact, JSON.stringify({version: 1, cause: 'RECONCILED', files: response.files}), {flag: 'wx', mode: 0o600});
      }
      await stop(keeper, 1);
    }
    terminationVerified = true;
    for (const container of [writer, keeper]) {
      if (!container) continue;
      const before = await inspect(container);
      if (!before.missing) {
        checked(await call(['rm', container], {timeout: 10000}), 'container removal failed');
        const after = await call(['inspect', container], {timeout: 10000});
        if (!isNotFound(after)) throw fault('CONTAINMENT_FAILED', 'container removal could not be verified');
      }
    }
    const volume = await call(['volume', 'inspect', '--format', '{{index .Labels "bounce.owner"}}', manifest.names.volume], {timeout: 10000});
    if ((volume.code ?? 0) === 0) {
      if (volume.stdout.trim() !== owner) throw fault('OWNERSHIP_MISMATCH', 'recorded volume is not owned');
      checked(await call(['volume', 'rm', manifest.names.volume], {timeout: 10000}), 'volume removal failed');
      const after = await call(['volume', 'inspect', manifest.names.volume], {timeout: 10000});
      if (!isNotFound(after, 'volume')) throw fault('CONTAINMENT_FAILED', 'volume removal could not be verified');
    } else if (!isNotFound(volume, 'volume')) throw fault('CONTAINMENT_FAILED', `volume inspection failed: ${volume.stderr || volume.stdout}`);
    manifest = {...manifest, phase: 'reconciled', terminationVerified: true, artifact};
    await writeManifest(location, manifest);
    return {verified: true, found: true, ...(artifact ? {artifact} : {})};
  } catch (cause) {
    cause.terminationVerified = terminationVerified;
    cause.recovery = location.manifest;
    try { await writeManifest(location, {...manifest, phase: 'reconcile-failed', terminationVerified, artifact, error: {code: cause.code, message: cause.message}}); } catch {}
    throw cause;
  }
}
