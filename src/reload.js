import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {installUpdate} from './update.js';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {Session, config, dataRoot} from './core.js';
import {createBus, connectBus} from './bus.js';
import {createScheduler} from './scheduler.js';
import {hostSession} from './remote.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export function fingerprint(root = projectRoot) {
  const hash = createHash('sha256');
  function visit(dir) {
    for (const item of fs.readdirSync(dir, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir,item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) {hash.update(path.relative(root,file)); hash.update(fs.readFileSync(file));}
    }
  }
  visit(path.join(root,'src'));
  hash.update(fs.readFileSync(path.join(root,'package.json')));
  return hash.digest('hex');
}
export async function validate(root = projectRoot, emit = () => {}) {
  for (const script of ['check','test']) {
    emit(script === 'check' ? 'Checking syntax…' : 'Running tests…');
    await new Promise((resolve,reject) => {
      const child = spawn('npm',['run',script],{cwd:root,stdio:['ignore','pipe','pipe']});
      let output = '';
      const capture = d => { output = (output + d.toString()).slice(-32000); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error(`npm run ${script} timed out`));},120000);
      child.once('error', e => {clearTimeout(timer);reject(e);});
      child.once('close', code => {clearTimeout(timer); if (code !== 0 && output) emit(output); else if (code === 0) emit(script === 'check' ? 'Syntax checks passed.' : 'Tests passed.'); code === 0 ? resolve() : reject(new Error(`npm run ${script} failed; keeping this running version. Fix the code and /restart again.`));});
    });
  }
}

// ---- shared helpers -------------------------------------------------------

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function daemonJsonPath(dir) { return path.join(dir, 'daemon.json'); }

function readDaemonJson(dir) {
  try { return JSON.parse(fs.readFileSync(daemonJsonPath(dir), 'utf8')); }
  catch { return null; }
}

function writeDaemonJson(dir, info) {
  fs.writeFileSync(daemonJsonPath(dir), JSON.stringify(info, null, 2) + '\n', {mode: 0o600});
}

function removeDaemonJson(dir) {
  try { fs.unlinkSync(daemonJsonPath(dir)); } catch {}
}

function formatRow(row, json) {
  if (row == null) return 'null';
  if (json) return JSON.stringify(row);
  return `[${row.from}:${row.kind}] ${row.text ?? ''}`;
}

// Derives Phase 2's single orchestration profile from legacy settings — real adapters
// arrive in Phase 3; see docs/local-orchestration.md "Process model".
export function buildProfiles(settings) {
  return {main: {adapter: settings.order[0], mode: settings.mode, fallback: settings.order.slice(1)}};
}

// Enforces that only the `user` peer may publish control.* — src/bus.js has no notion
// of peer roles beyond task ownership, so this authority lives here (see T3b orders,
// "Prohibitions and open questions"). Exported so test/daemon.test.js can drive it
// directly without a real socket (D8).
export function installControlAuthority({session, scheduler, onStopped}) {
  return session.subscribe(row => {
    if (row.kind !== 'control.stop') return;
    if (row.from !== 'user') return; // control.* is publishable only by the user peer
    scheduler.stop().then(result => { onStopped(result); }).catch(() => {});
  });
}

// ---- legacy (no daemon) path: --help, sessions, models, quota, skills, doctor, login, update ----

async function legacySupervise(args, {spawnChild, updateInstall}) {
  let resume;
  for (;;) {
    const outcome = await new Promise(resolve => {
      let request, update;
      const child = spawnChild(process.execPath,[cliPath,...args],{
        stdio:['inherit','inherit','inherit','ipc'],
        env:{...process.env,BOUNCE_SUPERVISED:'1',BOUNCE_RESTART:resume ? JSON.stringify(resume) : ''},
      });
      const terminate = () => child.kill('SIGTERM');
      const interrupt = () => {}; // Foreground process group delivers Ctrl+C to the child too.
      process.on('SIGTERM',terminate); process.on('SIGINT',interrupt);
      child.on('message', message => {if (message?.type === 'restart') {request = message.state; update = message.update === true;}});
      child.once('error', error => {console.error(error.message);});
      child.once('close', (code,signal) => {
        process.off('SIGTERM',terminate); process.off('SIGINT',interrupt);
        resolve({code:code ?? (signal ? 130 : 1),request,update});
      });
    });
    if (outcome.code !== 75 || !outcome.request) {process.exitCode=outcome.code;return;}
    resume=outcome.request;
    if (outcome.update) {
      try {resume.updateNotice = await updateInstall();}
      catch (error) {resume.updateNotice = `Update failed: ${error.message}. Retry with /update.`;}
      console.log(resume.updateNotice);
    }
  }
}

// ---- daemon path: `run` (with or without --detach) and the bare/dev TUI ----

async function daemonSupervise(args, {spawnChild, updateInstall, adapters: extraAdapters = {}, profiles: profileOverride, onReady} = {}) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, strict: false, options: {
    cwd: {type: 'string'}, resume: {type: 'string'}, detach: {type: 'boolean'},
  }});
  const dev = positionals[0] === 'dev';
  // Set (only) by detachRun's spawned background process (BOUNCE_DETACHED=1): this
  // process is the backgrounded daemon, so it drains until every task is terminal
  // instead of cancelling the tree the moment its own `run` child exits. A test can
  // set the same env var around a direct, in-process supervise() call to get the same
  // drain semantics without actually forking a background process.
  const detachedDaemon = process.env.BOUNCE_DETACHED === '1';
  const root = dataRoot();
  const settings = config(root);
  const cwd = fs.realpathSync(values.cwd || process.cwd());
  const session = new Session(cwd, {root, id: values.resume});
  session.lock();

  const adapters = {...extraAdapters};
  const profiles = profileOverride ?? buildProfiles(settings);

  const bus = await createBus({session, dir: session.dir});
  const scheduler = createScheduler({session, adapters, profiles, sessionMode: settings.mode});
  const userGrant = bus.grant({peer: 'user', canSubmit: true, tasks: [], context: session.id});
  writeDaemonJson(session.dir, {pid: process.pid, bus: bus.path, started: new Date().toISOString(), userToken: userGrant.file});

  let unverifiedOnStop = [];
  let currentChild = null;
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
  const allRootsTerminal = () => Object.values(scheduler.tasks()).every(t => t.parent || TERMINAL.has(t.state));

  let finished = false;
  async function finish(code) {
    if (finished) return;
    finished = true;
    process.exitCode = code;
    stopUnsubscribe();
    scheduler.close();
    process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigterm);
    await bus.close().catch(() => {});
    session.unlock();
    if (unverifiedOnStop.length) writeDaemonJson(session.dir, {pid: process.pid, bus: bus.path, started: new Date().toISOString(), userToken: userGrant.file, unverified: unverifiedOnStop});
    else removeDaemonJson(session.dir);
  }

  const stopUnsubscribe = installControlAuthority({
    session, scheduler,
    onStopped: ({cancelled, unverified}) => {
      unverifiedOnStop = unverified;
      if (unverified.length) console.error(`bounce: could not verify termination of: ${unverified.join(', ')}`);
      session.publish({kind: 'control.stopped', cancelled, unverified});
      if (currentChild) try { currentChild.kill('SIGTERM'); } catch {}
      // Give the just-published row's socket write a tick to actually flush to the
      // `stop` client before bus.close() destroys every open socket — publish() only
      // queues the write; destroying the socket immediately after can race it and
      // hand the client 'bus connection closed' instead of the control.stopped row.
      setTimeout(() => { void finish(unverified.length ? 1 : 0); }, 50);
    },
  });

  if (onReady) await onReady({scheduler, session, bus});

  // Attached (foreground `bounce run`, HEAD parity): forward SIGTERM/SIGINT to the
  // live child, exactly like the pre-Phase-2 supervisor — the child's own cancellation
  // (Router.cancel()) drives its exit code (130), which then flows through the normal
  // outcome.code !== 75 branch below (cancel the tree, log unverified, finish(130)).
  // Detached (backgrounded) daemon: there is no foreground child session to hand the
  // signal to in the same sense, so a direct SIGTERM/SIGINT tears the daemon down here.
  const onSigterm = () => {
    if (!detachedDaemon) { if (currentChild) try { currentChild.kill('SIGTERM'); } catch {} return; }
    void (async () => {
      const {unverified} = await scheduler.stop();
      unverifiedOnStop = unverified;
      if (unverified.length) console.error(`bounce: could not verify termination of: ${unverified.join(', ')}`);
      if (currentChild) try { currentChild.kill('SIGTERM'); } catch {}
      await finish(143);
      process.exit(143);
    })();
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);

  // Detached daemon only: waits for every root task to go terminal (or for `finish`
  // to already have run, via control.stop/SIGTERM) before the daemon is allowed to
  // exit — a headless `run --detach` whose child process already closed must still
  // stay up while a delegated task runs.
  function waitForDrain() {
    return new Promise(resolve => {
      if (finished || allRootsTerminal()) return resolve();
      const unsub = session.subscribe(() => { if (finished || allRootsTerminal()) { unsub(); resolve(); } });
    });
  }

  let resume = values.resume ? {id: session.id} : null;
  for (;;) {
    if (finished) break;
    const childArgs = args.filter(a => a !== '--detach');
    const outcome = await new Promise(resolvePromise => {
      let request, update;
      const child = spawnChild(process.execPath, [cliPath, ...childArgs], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
          ...process.env, BOUNCE_SUPERVISED: '1', BOUNCE_REMOTE_SESSION: '1',
          BOUNCE_RESTART: resume ? JSON.stringify(resume) : '',
        },
      });
      currentChild = child;
      const host = hostSession({session, child});
      child.on('message', message => { if (message?.type === 'restart') { request = message.state; update = message.update === true; } });
      child.once('error', error => { console.error(error.message); });
      child.once('close', (code, signal) => {
        currentChild = null;
        host.detach();
        resolvePromise({code: code ?? (signal ? 130 : 1), request, update});
      });
    });
    if (finished) break;
    if (outcome.code !== 75 || !outcome.request) {
      if (detachedDaemon) {
        await waitForDrain();
      } else {
        // Attached: a live task must not keep `bounce run` alive forever just because
        // its own child process exited — cancel the tree the same way `stop` does.
        const {unverified} = await scheduler.stop();
        unverifiedOnStop = unverified;
        if (unverified.length) console.error(`bounce: could not verify termination of: ${unverified.join(', ')}`);
      }
      await finish(outcome.code);
      break;
    }
    resume = outcome.request;
    if (outcome.update) {
      try { resume.updateNotice = await (updateInstall ?? installUpdate)(); }
      catch (error) { resume.updateNotice = `Update failed: ${error.message}. Retry with /update.`; }
    }
  }
}

async function detachRun(args, {spawnChild}) {
  const {values} = parseArgs({args, allowPositionals: true, strict: false, options: {
    cwd: {type: 'string'}, resume: {type: 'string'}, detach: {type: 'boolean'}, json: {type: 'boolean'},
  }});
  const root = dataRoot();
  const cwd = fs.realpathSync(values.cwd || process.cwd());
  // Minting (or reopening) the session here, in the foreground, is what lets us print
  // the id immediately; the detached daemon reopens the same session by id.
  const session = new Session(cwd, {root, id: values.resume});
  const id = session.id;
  const childArgs = args.filter(a => a !== '--detach').filter(a => a !== '--resume' && a !== id);
  if (!childArgs.includes('--json')) childArgs.push('--json');
  childArgs.push('--resume', id);
  const child = spawnChild(process.execPath, [cliPath, ...childArgs], {
    detached: true, stdio: 'ignore', env: {...process.env, BOUNCE_DETACHED: '1'},
  });
  child.unref();
  console.log(values.json ? JSON.stringify({id}) : id);
  process.exitCode = 0;
}

async function attachCommand(args) {
  const {values, positionals} = parseArgs({args: args.slice(1), allowPositionals: true, options: {json: {type: 'boolean'}}});
  const id = positionals[0];
  if (!id) { console.error('bounce: attach requires a session id'); process.exitCode = 2; return; }
  const root = dataRoot();
  const dir = path.join(root, 'sessions', id);
  const info = readDaemonJson(dir);
  if (!info || !pidAlive(info.pid)) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  let client;
  try { client = await connectBus({path: info.bus, token: fs.readFileSync(info.userToken, 'utf8').trim()}); }
  catch (error) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  const printRow = row => console.log(formatRow(row, values.json));
  const initial = await client.events({afterSeq: 0});
  for (const row of initial) printRow(row);
  let last = initial.at(-1)?.seq ?? 0;
  const DEAD = Symbol('dead');
  const watchPid = pid => {
    let timer;
    const promise = new Promise(resolve => { timer = setInterval(() => { if (!pidAlive(pid)) { clearInterval(timer); resolve(DEAD); } }, 200); });
    return {promise, cancel: () => clearInterval(timer)};
  };
  for (;;) {
    if (!pidAlive(info.pid)) break;
    const watcher = watchPid(info.pid);
    let row;
    try { row = await Promise.race([client.wait({match: {}, afterSeq: last, timeout: 30000}), watcher.promise]); }
    catch { watcher.cancel(); break; }
    watcher.cancel();
    if (row === DEAD) break;
    if (row) { printRow(row); last = row.seq ?? last; }
  }
  try { await client.close(); } catch {}
  process.exitCode = 0;
}

async function stopCommand(args) {
  const [id] = args.slice(1);
  if (!id) { console.error('bounce: stop requires a session id'); process.exitCode = 2; return; }
  const root = dataRoot();
  const dir = path.join(root, 'sessions', id);
  const info = readDaemonJson(dir);
  if (!info || !pidAlive(info.pid)) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  let client;
  try { client = await connectBus({path: info.bus, token: fs.readFileSync(info.userToken, 'utf8').trim()}); }
  catch (error) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  await client.publish({kind: 'control.stop'}).catch(() => {});
  let row = null;
  try { row = await client.wait({match: {kind: 'control.stopped'}, timeout: 30000}); }
  catch { row = null; } // the daemon may tear down its socket before this reply is flushed; fall back to daemon.json below
  try { await client.close(); } catch {}
  if (row) {
    console.log(JSON.stringify(row));
    process.exitCode = row.unverified?.length ? 1 : 0;
    if (row.unverified?.length) console.log(`unverified: ${row.unverified.join(', ')}`);
    return;
  }
  // No in-band reply (socket torn down first): daemon.json is authoritative — it is
  // removed on a fully verified stop, and kept (with `unverified`) otherwise.
  try {
    await waitFor(() => !pidAlive(info.pid), {timeout: 5000});
  } catch { /* fall through to whatever's on disk */ }
  const after = readDaemonJson(dir);
  if (!after) { console.log('stopped'); process.exitCode = 0; return; }
  if (after.unverified?.length) { console.log(`unverified: ${after.unverified.join(', ')}`); process.exitCode = 1; return; }
  console.log('stop timed out'); process.exitCode = 1;
}

async function waitFor(fn, {timeout = 5000, interval = 20} = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, interval));
  }
}

// ---- dispatcher -------------------------------------------------------

export async function supervise(args = process.argv.slice(2), {spawnChild = spawn, updateInstall = installUpdate, adapters, profiles, onReady} = {}) {
  const command = args[0];
  if (command === 'attach') return attachCommand(args);
  if (command === 'stop') return stopCommand(args);
  if (command === 'run' && args.includes('--detach')) return detachRun(args, {spawnChild});
  if (command === 'run') return daemonSupervise(args, {spawnChild, updateInstall, adapters, profiles, onReady});
  // Bare/`dev` TUI keeps the pre-Phase-2 supervisor loop unchanged (Phase 6 gives the TUI
  // its own bus client); only `run` gets the per-session daemon apparatus in Phase 2.
  return legacySupervise(args, {spawnChild, updateInstall});
}
