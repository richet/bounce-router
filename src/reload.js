import fs from 'node:fs';
import {createClaudeLive} from './adapters/claude-live.js';
import {createCodexLive} from './adapters/codex-live.js';
import {createMuseLive} from './adapters/muse-live.js';
import {createLocalLive} from './adapters/local-live.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {installUpdate} from './update.js';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {Session, config, dataRoot} from './core.js';
import {createBus, connectBus} from './bus.js';
import {validateOrchestration} from './profiles.js';
import {providers} from './providers.js';
import {createScheduler} from './scheduler.js';
import {hostSession} from './remote.js';

const CHILD_KILL_GRACE_MS = 1500; // same grace as runProcess's cancel and live-common's verifiedCancel

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

// Written whole then renamed into place: `stop`, `attach`, `sessions` and the tests read this
// file while the daemon may be rewriting it (observed as a torn JSON.parse under six parallel D5 runs).
function writeDaemonJson(dir, info) {
  const tmp = `${daemonJsonPath(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, daemonJsonPath(dir));
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

// The four rows that end a task, mirroring src/reducers.js's own switch — `timed_out` is a
// derived state, not a kind: the row that produces it is `task.deadline`.
const TERMINAL_KINDS = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.deadline']);
// Set explicitly on every spawned child, from the validated config alone: whatever the daemon's
// own environment carries, the child's operation mode is never inherited (T3b rework, item 1).
const ORCHESTRATOR_ENV = ['BOUNCE_BUS', 'BOUNCE_BUS_TOKEN_FILE', 'BOUNCE_ROLE', 'BOUNCE_ORCHESTRATOR_PROFILE'];

// The orchestrator profile's standing brief, written once per daemon start: where its skill
// lives and how to reach the bridge. The prompt line cli.js prepends points at this file.
function writeOrders({session, root, bus, grant, profiles = {}, orchestrator}) {
  const dir = path.join(session.dir, 'orchestrator');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, 'ORDERS.md');
  fs.writeFileSync(file, [
    `# Orchestrator orders — session ${session.id}`, '',
    'You coordinate; workers implement. Delegate every implementation task to a worker profile below.',
    'Do not edit the repository yourself and do not read bounce\'s own source to learn the bridge — everything you need is here.', '',
    `Skill: ${path.join(root, 'skills', 'agent-orchestrator', 'SKILL.md')}`, '',
    'Bridge (already in your environment):',
    `    BOUNCE_BUS=${bus.path}`,
    `    BOUNCE_BUS_TOKEN_FILE=${grant.file}`, '',
    'Worker profiles you can submit to (name → adapter/model):',
    ...Object.entries(profiles).filter(([name]) => name !== orchestrator).map(([name, p]) => `    ${name} → ${[p.adapter, p.model].filter(Boolean).join('/')}${p.role ? ` (${p.role})` : ''}`),
    '',
    'Submit work with `bounce publish --event <json>` and wait for it with `bounce wait --match <json>`.',
    'Example — submit one task, then wait for it to end:',
    `    bounce publish --event '{"kind":"task.submitted","parent":null,"profile":"${Object.keys(profiles).find(n => n !== orchestrator) ?? 'build'}","orders":"<goal, owned paths, acceptance, how to verify>","deadline":3600000}'`,
    `    bounce wait --match '{"kind":"task.completed","task":"<task id from the publish reply>"}' --timeout 3600`,
    'Fields: parent (null for a root task), profile (a name above), orders (the brief, required), deadline (ms, optional),',
    'depends_on (task ids, optional), review ({"prelaunch": <profile>, "completion": <profile>}, optional, review-role profiles only).',
    'The publish reply carries the task id. A refusal arrives as a task.failed row naming the reason — read it before retrying.',
    'Terminal rows: task.completed, task.failed, task.cancelled, task.rejected. Steer a running worker with',
    `    bounce publish --event '{"kind":"message","to":"worker:<task id>","text":"..."}'`, '',
    'You may publish only: task.submitted, task.milestone, task.blocked, task.input_required, task.usage, task.activity, message.',
    'Everything else is refused — `user`, `control.*`, and every task lifecycle row the scheduler owns.',
  ].join('\n') + '\n', {mode: 0o600});
  return file;
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

async function daemonSupervise(args, {spawnChild, updateInstall, adapters: extraAdapters = {}, profiles: profileOverride, strategy: strategyOverride, onReady} = {}) {
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
  // The live adapters are orchestrator mode's workers; a test may replace any of them by name.
  // Classic mode never dispatches, so registering them costs it nothing.
  const adapters = {claude: createClaudeLive(), codex: createCodexLive(), muse: createMuseLive(), local: createLocalLive(), ...extraAdapters};
  // Validated once, before anything is created: an invalid orchestration config throws out of
  // supervise() (cli.js prints it and exits 1) with no session, daemon.json or socket behind it.
  // A profile whose vendor binary is absent fails at dispatch as task.failed{reason:'missing'}.
  const orchestration = validateOrchestration(settings, [...new Set([...Object.keys(adapters), ...Object.keys(providers)])]);
  const orchestrating = orchestration.operation === 'orchestrator';
  const cwd = fs.realpathSync(values.cwd || process.cwd());
  const session = new Session(cwd, {root, id: values.resume});
  session.lock();

  const profiles = profileOverride ?? (orchestrating ? orchestration.profiles : buildProfiles(settings));

  // Phase 8: the strategy seam, same shape as `adapters`/`profiles` above — a test (or, later, a
  // config-driven caller) may inject a strategy object directly; absent, the declarative
  // `strategy:` setting resolved by validateOrchestration (default: defaultStrategy) applies.
  const scheduler = createScheduler({session, adapters, profiles, sessionMode: settings.mode, strict: orchestration.strict, strategy: strategyOverride ?? orchestration.strategy});
  const bus = await createBus({session, dir: session.dir, validate: scheduler.validate});
  const userGrant = bus.grant({peer: 'user', canSubmit: true, tasks: [], context: session.id});
  // daemon.json is written AFTER the SIGTERM/SIGINT handlers are installed (below), never here:
  // it is the daemon's discovery record, so the moment it exists a `stop`/SIGTERM can arrive, and
  // a signal landing before the handler is installed would hit Node's default terminate — the
  // daemon dies with no cleanup, leaving the socket and daemon.json behind (the D10 flake).

  // Orchestrator mode: the main conversation is a peer, not a plain vendor session. It gets the
  // orchestrator grant (canSubmit, its own context, no tasks — never the user grant), its profile
  // to run on, and a standing brief on disk; classic mode reaches none of this.
  const orchestratorProfile = orchestrating ? orchestration.profiles[orchestration.orchestrator] : null;
  const orchestratorGrant = orchestrating ? bus.grant({peer: 'orchestrator', canSubmit: true, tasks: [], context: session.id}) : null;
  if (orchestrating) writeOrders({session, root, bus, grant: orchestratorGrant, profiles: orchestration.profiles, orchestrator: orchestration.orchestrator});
  if (orchestrating) session.append({kind: 'operation', operation: 'orchestrator', orchestrator: orchestration.orchestrator, shape: orchestration.shape, text: `Operation: orchestrator on ${orchestration.orchestrator} (${orchestration.shape})`});

  // Worker grants are the dispatch policy expressed on the bus: a task that starts gets a grant
  // scoped to itself alone, and any terminal row revokes it. The orchestrator's own grant is
  // widened in place as it opens tasks, so it can report on its work and on nothing else. The
  // scheduler stays unaware of the bus; token paths are daemon-side state, never journaled.
  const workerTokens = new Map(); // peer -> token file, for the life of that worker's grant
  const grantsUnsubscribe = !orchestrating ? () => {} : session.subscribe(row => {
    if (row.kind === 'task.submitted' && row.from === 'orchestrator') bus.extendGrant('orchestrator', [row.task]);
    else if (row.kind === 'task.started') {
      const peer = `worker:${row.task}`;
      workerTokens.set(peer, bus.grant({peer, tasks: [row.task], context: row.context}).file);
    } else if (TERMINAL_KINDS.has(row.kind) && workerTokens.delete(`worker:${row.task}`)) {
      void bus.revoke(`worker:${row.task}`);
    }
  });

  let unverifiedOnStop = [];
  let currentChild = null;
  // Teardown terminates the main child the way a vendor process is terminated (runProcess,
  // verifiedCancel): SIGTERM, then SIGKILL after a grace period. A child that never exits
  // would otherwise hold the IPC channel, and with it this daemon and whoever waits on its
  // pipes, forever (Phase 3 gate incident: D5's child survived SIGTERM under load).
  const terminateChild = () => {
    const child = currentChild;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => { if (currentChild === child) try { child.kill('SIGKILL'); } catch {} }, CHILD_KILL_GRACE_MS);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  };
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
  const allRootsTerminal = () => Object.values(scheduler.tasks()).every(t => t.parent || TERMINAL.has(t.state));

  let finished = false;
  let finishPromise = null;
  // Single-flight AND single-completion. Two teardown paths can fire together: the SIGTERM
  // handler's finish(143), and the run loop's finish() once a cancel makes the task tree
  // terminal and waitForDrain() resolves. The old `if (finished) return` guarded double-
  // EXECUTION but the second caller returned immediately, so the run loop could break and let
  // main() return — Node then empties the loop and exits between bus.close() (socket unlinked)
  // and removeDaemonJson (daemon.json left on disk): the intermittent D5/D10 flake. Memoizing
  // the promise makes every caller await the SAME completion, so no exit path proceeds until
  // removeDaemonJson has run. `finished` is still set synchronously for waitForDrain's check.
  const finish = code => {
    if (finishPromise) return finishPromise;
    finished = true;
    finishPromise = (async () => {
      process.exitCode = code;
      stopUnsubscribe();
      grantsUnsubscribe();
      scheduler.close();
      process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigterm);
      // Every grant this daemon minted goes away with it: the worker and orchestrator grants
      // explicitly here, the user grant with bus.close(), which unlinks every remaining token file.
      for (const peer of workerTokens.keys()) await bus.revoke(peer).catch(() => {});
      workerTokens.clear();
      if (orchestratorGrant) await bus.revoke('orchestrator').catch(() => {});
      await bus.close().catch(() => {});
      session.unlock();
      if (unverifiedOnStop.length) writeDaemonJson(session.dir, {pid: process.pid, bus: bus.path, started: new Date().toISOString(), userToken: userGrant.file, unverified: unverifiedOnStop});
      else removeDaemonJson(session.dir);
    })();
    return finishPromise;
  };

  const stopUnsubscribe = installControlAuthority({
    session, scheduler,
    onStopped: ({cancelled, unverified}) => {
      unverifiedOnStop = unverified;
      if (unverified.length) console.error(`bounce: could not verify termination of: ${unverified.join(', ')}`);
      session.publish({kind: 'control.stopped', cancelled, unverified});
      terminateChild();
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
      terminateChild();
      await finish(143);
      process.exit(143);
    })();
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);
  // Now discoverable: a signal from here on is caught by onSigterm and torn down cleanly.
  writeDaemonJson(session.dir, {pid: process.pid, bus: bus.path, started: new Date().toISOString(), userToken: userGrant.file});

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
    const childEnv = {
      ...process.env, BOUNCE_SUPERVISED: '1', BOUNCE_REMOTE_SESSION: '1',
      BOUNCE_RESTART: resume ? JSON.stringify(resume) : '',
    };
    // Removed first, then set only in orchestrator mode: a classic run must not inherit a stale
    // (or hostile) BOUNCE_ROLE/BOUNCE_BUS from whoever started the daemon.
    for (const key of ORCHESTRATOR_ENV) delete childEnv[key];
    if (orchestratorProfile) Object.assign(childEnv, {
      BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: orchestratorGrant.file,
      BOUNCE_ROLE: 'orchestrator', BOUNCE_ORCHESTRATOR_PROFILE: JSON.stringify(orchestratorProfile),
    });
    const outcome = await new Promise(resolvePromise => {
      let request, update;
      const child = spawnChild(process.execPath, [cliPath, ...childArgs], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: childEnv,
      });
      currentChild = child;
      const host = hostSession({session, child});
      child.on('message', message => {
        if (message?.type === 'restart') { request = message.state; update = message.update === true; }
        // Phase 9.3 steering: the interactive orchestrator child (the TUI) asks the daemon to
        // cancel one task or the whole tree over its own IPC channel — the scheduler owns cancel,
        // and the resulting task.cancelled rows flow back to the TUI's AGENTS pane.
        else if (message?.type === 'control') {
          if (message.action === 'stop') scheduler.stop().catch(() => {});
          else if (message.action === 'cancel' && message.task) scheduler.cancel(message.task).catch(() => {});
        }
      });
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

export async function supervise(args = process.argv.slice(2), {spawnChild = spawn, updateInstall = installUpdate, adapters, profiles, strategy, onReady} = {}) {
  const command = args[0];
  if (command === 'attach') return attachCommand(args);
  if (command === 'stop') return stopCommand(args);
  if (command === 'run' && args.includes('--detach')) return detachRun(args, {spawnChild});
  if (command === 'run') return daemonSupervise(args, {spawnChild, updateInstall, adapters, profiles, strategy, onReady});
  // Phase 9 (interactive orchestrator): the interactive TUI whose config is orchestrator gets the
  // full daemon apparatus (bus + scheduler + orchestrator grant) with an INTERACTIVE child — the
  // args carry no `run`, so cli.js enters its multi-turn TUI branch as the orchestrator peer and
  // each user turn delegates over the bridge. Classic config keeps the pre-Phase-2 legacySupervise
  // loop, byte-identical. We read only the raw `operation` field (not full validateOrchestration,
  // which would reject a `local` profile under the default adapter list) and let daemonSupervise
  // do the real validation and surface any error.
  let operation = 'classic';
  try { operation = config(dataRoot()).operation ?? 'classic'; } catch { /* a broken config surfaces in the classic TUI below */ }
  if (operation === 'orchestrator') return daemonSupervise(args, {spawnChild, updateInstall, adapters, profiles, strategy, onReady});
  return legacySupervise(args, {spawnChild, updateInstall});
}
