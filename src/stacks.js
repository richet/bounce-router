// Docker Compose stacks a worker started in its copy. A copy's stack outlives its task unless something takes it down,
// and stacks left behind keep their networks: found live, enough of them exhausted Docker's address pools and new
// stacks failed to start. A stack belongs to a copy when its compose file lives in it; `docker compose ls` names
// every project with its config files, including a project whose copy is already gone.
import fs from 'node:fs';
import path from 'node:path';
import {execFile, spawn as spawnProcess} from 'node:child_process';

const COMPOSE_FILE = /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/;

function docker(args, {timeoutMs = 120000} = {}) {
  return new Promise(resolve => {
    execFile('docker', args, {timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}, (error, stdout, stderr) => {
      if (error) return resolve({ok: false, missing: error.code === 'ENOENT', error: String(stderr || error.message).trim().split('\n').at(-1).slice(0, 300)});
      resolve({ok: true, stdout: String(stdout)});
    });
  });
}

// Whether a stack could have been started from this folder: a compose file at its top or one level down.
export function mayHoldStack(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, {withFileTypes: true}); } catch { return false; }
  if (names.some(entry => entry.isFile() && COMPOSE_FILE.test(entry.name))) return true;
  return names.some(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules'
    && (() => { try { return fs.readdirSync(path.join(dir, entry.name)).some(name => COMPOSE_FILE.test(name)); } catch { return false; } })());
}

// Every compose project on the machine: [{name, status, configFiles}]. Empty when docker is not installed.
export async function composeProjects({run = docker} = {}) {
  const listed = await run(['compose', 'ls', '--all', '--format', 'json']);
  if (!listed.ok) return listed.missing ? [] : Promise.reject(new Error(`docker compose ls failed: ${listed.error}`));
  let rows = [];
  try { rows = JSON.parse(listed.stdout.trim() || '[]'); } catch { throw new Error('docker compose ls printed no JSON'); }
  return rows.map(row => ({name: row.Name, status: row.Status ?? '', configFiles: String(row.ConfigFiles ?? '').split(',').map(file => file.trim()).filter(Boolean)}));
}

const inside = (file, dir) => file.startsWith(`${dir.replace(/\/+$/, '')}/`);
export const stacksUnder = (dir, projects) => projects.filter(project => project.configFiles.some(file => inside(file, dir)));

// Takes one project down with its volumes and networks; it needs no compose file, so it works for a deleted copy too.
export async function takeDown(name, {run = docker} = {}) {
  const result = await run(['compose', '-p', name, 'down', '--volumes', '--remove-orphans']);
  return result.ok ? {ok: true} : {ok: false, error: result.error};
}

// Whether a project still holds volumes. A project whose containers are gone is missing from `docker compose ls`, and
// its volumes stay: found live, a worker's own plain `down` left hundreds of volumes that nothing took down after it.
export async function hasVolumes(name, {run = docker} = {}) {
  const listed = await run(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${name}`]);
  return listed.ok && listed.stdout.trim() !== '';
}

// The compose projects started on this machine while bounce runs, with their config files, read from Docker's events as
// each container is created. A worker that takes its own stack down without its volumes leaves nothing `docker compose
// ls` can list; this remembers the project's name, so the copy's end can still take its volumes down.
export function watchStacks({spawn = spawnProcess} = {}) {
  const projects = new Map();
  let child = null;
  try {
    child = spawn('docker', ['events', '--filter', 'type=container', '--filter', 'event=create', '--format', '{{json .Actor.Attributes}}'], {stdio: ['ignore', 'pipe', 'ignore']});
  } catch { return {projects: () => [], close() {}}; }
  child.on('error', () => {});
  let buffer = '';
  child.stdout?.setEncoding?.('utf8');
  child.stdout?.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      let labels = null;
      try { labels = JSON.parse(line); } catch { continue; }
      const name = labels?.['com.docker.compose.project'];
      const files = String(labels?.['com.docker.compose.project.config_files'] ?? '').split(',').map(file => file.trim()).filter(Boolean);
      if (name && files.length) projects.set(name, {name, status: '', configFiles: files});
    }
  });
  return {projects: () => [...projects.values()], close() { try { child.kill(); } catch {} }};
}

// Every stack whose compose file is in `dir`: {down: [names], failed: [{name, error}]}. `seen` adds the projects watched
// while they ran (watchStacks): one no longer listed is taken down only when it still holds volumes.
export async function stacksDown(dir, {list = composeProjects, down = takeDown, seen = [], leftover = hasVolumes} = {}) {
  const result = {down: [], failed: []};
  const listed = stacksUnder(dir, await list());
  const names = new Set(listed.map(project => project.name));
  const gone = [];
  for (const project of stacksUnder(dir, seen)) if (!names.has(project.name) && await leftover(project.name)) { names.add(project.name); gone.push(project); }
  for (const project of [...listed, ...gone]) {
    const done = await down(project.name);
    if (done.ok) result.down.push(project.name);
    else result.failed.push({name: project.name, error: done.error});
  }
  return result;
}
