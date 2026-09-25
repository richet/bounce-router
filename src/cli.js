#!/usr/bin/env node
import {login} from './login.js';
import {resolveExecutable} from './executable.js';
import {createMainClient} from './main-client.js';
import {createInkTerminal} from './tui/ink-terminal.js';
import {workspaceColumns} from './tui/Workspace.js';
import {doingNow} from './tui/status.js';
import {suggestionFrom, lastAnswer} from './tui/suggestion.js';
import {headerProvider, chooseModel, chooseOrder} from './cli-view.js';
import {backspace, clampCursor, deleteForward, deleteWordBackward, deleteWordForward, insertText, moveCursor, moveLineEnd, moveLineStart, moveVertical, moveWord} from './tui/editor.js';
import {inputDisposition} from './commands.js';
import {commands as ownCommands, completions, typedCommand, inputLayout, windowAround, modelRows, checklistRows} from './terminal.js';
import {modelCatalog, modelEntries, catalogNotes} from './models.js';
import {discoverLocalModels, switchLocal} from './local-models.js';
import {readMachine, resourceReport, createResources} from './resources.js';
import {taskView, taskList} from './task-view.js';
import {campaigns} from './orchestration.js';
import {formatTaskView, formatTaskList} from './task-report.js';
import {runLocalSetup} from './local-wizard.js';
import {createLocalSetupView} from './local-setup-view.js';
import {activateLocalProfiles} from './local-activation.js';
import {jevCommand} from './jev-command.js';
import {jevSidebarLabel} from './jev.js';
import {rolesFor, agentStore, agentsCommand, agentTable, handAIsToJev} from './agents.js';
import {createInterface} from 'node:readline';
import stringWidth from 'string-width';
import {clean, createFormatter, createWorkSummary, workReview, withAsides, continueMain} from './format.js';
import {validateOrchestration} from './profiles.js';
import {loadQuota, recordQuota, refreshQuota, quotaSnapshot, quotaShort, quotaPanel, modelPanel, quotaReport, quotaUnavailable, usageOrder} from './quota.js';
import {skillsCommand, syncSkills, inspectSkills, skillsChanged, importCandidates, importSelected, importSummary, importOrigin, syncSummary, skillAreas} from './skills.js';
import {expandVendorCommand, findVendorCommand, vendorCommandRows} from './vendor-commands.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

import {parseArgs} from 'node:util';
import {Session, Router, config, saveJSON, dataRoot} from './core.js';
import * as reducers from './reducers.js';
import {providers, runProcess} from './providers.js';
import {projectRoot, fingerprint, validate, supervise, pidAlive} from './reload.js';
import {listSessions, resolveSessionRef, sessionsTable, sessionAge} from './sessions.js';
import {titleSession, createAsk} from './session-title.js';
import {askBtw, createBtwAsk} from './btw.js';
import {createRemoteSession} from './remote.js';
import {version, checkUpdate, globalInstall, installUpdate} from './update.js';
import {helpText, helpRows} from './help.js';
const handedText = names => `${names.join(', ')} now let Jev pick their AI per task (models: [auto, …]); the models you chose stay behind it as the fallback. Needs \`bounce jev on\`.`;

// The `profiles` block is an overlay on the shipped roster (validateOrchestration), so a
// profile write only needs the block to exist: the saved config holds the user's additions and
// overrides, never a copy of the roster. `main` is written as orchestrator only because the
// absent field implied it; a present block or orchestrator is never touched.
function materialiseRoster(settings) {
  if (settings.operation !== 'orchestrator') return settings;
  if (settings.profiles === undefined) settings.profiles = {};
  settings.orchestrator ??= 'main';
  return settings;
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    image: {type: 'string', multiple: true}, cwd: {type: 'string'}, resume: {type: 'string'}, provider: {type: 'string'}, model: {type: 'string'},
    mode: {type: 'string'}, json: {type: 'boolean'}, verify: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'},
    check: {type: 'boolean'}, scope: {type: 'string'}, force: {type: 'boolean'}, list: {type: 'boolean'}, all: {type: 'boolean'}, session: {type: 'string'}, report: {type: 'boolean'},
    save: {type: 'boolean'}, 'allow-network': {type: 'boolean'},
  }});
  if (values.help) return console.log(helpText(process.stdout.columns || 100));
  if (values.version) return console.log(`bounce ${version}`);
  const restarted = process.env.BOUNCE_RESTART ? JSON.parse(process.env.BOUNCE_RESTART) : null;
  delete process.env.BOUNCE_RESTART;
  const dev = restarted?.dev ?? positionals[0] === 'dev';
  const root = dataRoot(), settings = restarted?.settings ?? config(root), cwd = fs.realpathSync(dev ? projectRoot : values.cwd || process.cwd());
  // Roles are agent files (src/agents.js); every validation and setup path below uses the same set the daemon will.
  const roles = rolesFor(root, {cwd});
  if (values.provider && !restarted) {
    if (!providers[values.provider]) throw new Error('Unknown provider');
    settings.order = [values.provider, ...settings.order.filter(p => p !== values.provider)];
  }
  if (values.mode && !restarted) { if (!['yolo', 'plan'].includes(values.mode)) throw new Error('Mode must be yolo or plan'); settings.mode = values.mode; }
  if (values.model && !restarted) {
    const initialProvider = values.provider ?? (settings.operation === 'orchestrator'
      ? settings.profiles?.[settings.orchestrator]?.adapter : null) ?? settings.order[0];
    settings.models[initialProvider] = values.model;
  }
  if (positionals[0] === 'local') {
    if (positionals[1] === 'setup') {
      if (values.json || values.save) throw new Error('Guided setup uses interactive confirmation; use `bounce agents set NAME` for automation');
      const file = path.join(root, 'config.json');
      const current = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      const baseline = current();
      const lines = createInterface({input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY)});
      const iterator = lines[Symbol.asyncIterator]();
      try {
        await runLocalSetup({settings: materialiseRoster(settings), cwd, roles, agentsDir: agentStore(root),
          ask: async question => {process.stdout.write(question); const answer = await iterator.next(); return answer.done ? null : answer.value;},
          write: text => console.log(text),
          save: next => {
            if (current() !== baseline) throw new Error('Configuration changed during setup; nothing saved. Rerun setup to preserve those changes.');
            validateOrchestration(next, undefined, {roles});
            saveJSON(file, next);
          }});
      } finally { lines.close(); }
      return;
    }
    // `bounce local on|off`: the switch, in the words `bounce jev on|off` uses.
    if (positionals[1] === 'on' || positionals[1] === 'off') {
      const saved = config(root); // the saved config, written back whole, as `bounce jev` does
      const text = switchLocal(saved, positionals[1] === 'on');
      saveJSON(path.join(root, 'config.json'), saved);
      const handed = positionals[1] === 'on' ? handAIsToJev(roles, {orchestrator: saved.orchestrator}) : [];
      console.log(`${text} · saved; applies to the next session (/local on|off applies it to a running one)`);
      if (handed.length) console.log(handedText(handed));
      return;
    }
    // Bare `bounce local` is the status view: what the endpoint has, whether the OpenCode bridge is
    // installed, and which local workers are configured. It replaces the separate `models` and
    // `check` subcommands. --verify adds the live one-line turn, which costs a real (small)
    // inference, so it is opt-in. The TUI's `/local` renders the same thing.
    if (positionals[1] === undefined) {
      const {gatherLocalStatus, formatLocalStatus} = await import('./local-setup-view.js');
      const status = await gatherLocalStatus({settings, verify: values.verify, model: positionals[2],
        executables: settings.executables ?? {}, roles});
      if (values.json) return console.log(JSON.stringify(status, null, 2));
      console.log(formatLocalStatus(status, {
        verifyHint: 'run `bounce local --verify` to prove the bridge with a one-line test turn',
        setupHint: 'run `bounce local setup`'}).join('\n'));
      if (status.problem) process.exitCode = 1;
      return;
    }
    throw new Error('Use bounce local [--verify], bounce local on|off, or bounce local setup; agents are managed with bounce agents');
  }
  if (positionals[0] === 'jev' || positionals[0] === 'typesafe') {
    // Headless twin of /jev: the same command over the saved config, written back whole.
    const saved = config(root);
    const result = await jevCommand(positionals.slice(1), {root, settings: saved, save: () => saveJSON(path.join(root, 'config.json'), saved)});
    console.log(result.text + (result.changed ? ' · saved; a running daemon reads it at its next decision' : ''));
    return;
  }
  if (positionals[0] === 'update') {
    if (values.check) {
      const release = await checkUpdate({root, force: true});
      return console.log(release.available ? `Update available: ${version} → ${release.latest}. Run bounce update.` : `Bounce ${version} is up to date.`);
    }
    return console.log(await installUpdate({root}));
  }
  if (positionals[0] === 'login') return login(positionals[1], settings, cwd);
  if (positionals[0] === 'sessions') {
    const rows = listSessions(root);
    return console.log(values.json ? JSON.stringify(rows, null, 2) : sessionsTable(rows).join('\n'));
  }
  if (positionals[0] === 'rename') {
    const [, ref, ...words] = positionals;
    const name = words.join(' ').trim();
    if (!ref || !name) throw new Error('Use: bounce rename SESSION NAME');
    const id = resolveSessionRef(root, ref);
    if (listSessions(root).find(r => r.id === id)?.live) throw new Error('That session is running · use /rename inside it');
    const target = new Session(process.cwd(), {root, id});
    target.append({kind: 'session.renamed', name});
    return console.log(`Renamed ${id.slice(0, 8)} to "${name}"`);
  }
  if (positionals[0] === 'models') {
    const [cloud, local] = await Promise.all([modelCatalog(settings, {maxAge: 0}), discoverLocalModels(settings.local, {maxAge: 0})]);
    const catalogs = [...cloud, ...local];
    if (values.json) return console.log(JSON.stringify(catalogs, null, 2));
    for (const catalog of catalogs) {
      console.log(`${catalog.provider}${catalog.account ? ` (${catalog.account})` : ''}: ${catalog.error ?? `${catalog.models.length} models`}`);
      for (const model of catalog.models) console.log(`  ${model.id === settings.models[catalog.provider] ? '✓' : ' '} ${model.id}  ${clean(model.description)}`);
    }
    return;
  }
  // What the machine can run right now: the same numbers the memory gate uses before a local dispatch.
  if (positionals[0] === 'resources') {
    const machine = readMachine();
    const fleet = await discoverLocalModels(settings.local, {maxAge: 0}).catch(() => []);
    if (values.json) return console.log(JSON.stringify({machine, fleet}, null, 2));
    return console.log(resourceReport({machine, fleet, busy: []}));
  }
  if (positionals[0] === 'quota') {
    const store = await refreshQuota(settings, {root, cwd});
    // Every vendor the config can spend on: the validated roster, so a vendor reached only
    // through a shipped builder is reported too (the TUI's usage panel reads the same view).
    let rosterProfiles = {};
    try { const view = validateOrchestration(settings); if (view.operation === 'orchestrator') rosterProfiles = view.profiles; } catch {}
    const quotaOrder = usageOrder(settings.order, rosterProfiles);
    if (values.json) return console.log(JSON.stringify(store, null, 2));
    return console.log(quotaReport(store, quotaOrder));
  }
  if (positionals[0] === 'agents') {
    const scope = values.scope || settings.skills.scope;
    if (!['user', 'project'].includes(scope)) throw new Error('--scope must be user or project');
    const input = positionals[1] === 'set' && !process.stdin.isTTY ? fs.readFileSync(0, 'utf8') : '';
    const {text, report} = agentsCommand(positionals.slice(1), {root, cwd, settings, scope, input, force: values.force});
    // Run by an orchestrator peer (its CLI carries the bridge grant), the definition is journaled so
    // the transcript shows the team changing; a plain shell invocation has no bus and just prints.
    if (positionals[1] === 'set' && process.env.BOUNCE_BUS && process.env.BOUNCE_BUS_TOKEN_FILE) {
      const {connectBus} = await import('./bus.js');
      try {
        const client = await connectBus({path: process.env.BOUNCE_BUS, token: fs.readFileSync(process.env.BOUNCE_BUS_TOKEN_FILE, 'utf8').trim()});
        try { await client.publish({kind: 'agents.defined', name: report.name, scope: report.scope, file: report.file, text}); } finally { await client.close(); }
      } catch (error) { console.error(`bounce: defined, but not journaled: ${error.message}`); }
    }
    return console.log(values.json ? JSON.stringify(report, null, 2) : text);
  }
  if (positionals[0] === 'skills') {
    const options = {root, scope: values.scope || settings.skills.scope, cwd, base: process.cwd()};
    const {text, report} = skillsCommand([...positionals.slice(1), ...(values.force ? ['--force'] : []), ...(values.list ? ['--list'] : [])], options);
    return console.log(values.json ? JSON.stringify(report ?? inspectSkills(options), null, 2) : text);
  }
  // CONTRACT.md #5 bullet 4: the built-in A/B, legacy CLI path, no daemon. Unknown session/task
  // is a thrown Error, which the top-level .catch prints to stderr and exits 1 (same convention
  // as every other legacy command's error here, e.g. Session's own "Session not found").
  // Registering that server with the agents, so nobody edits a config by hand (Daniel: "let bounce do it").
  if (positionals[0] === 'mcp' && ['install', 'uninstall'].includes(positionals[1])) {
    const {withCodexEntry, withoutCodexEntry} = await import('./mcp-install.js');
    const installing = positionals[1] === 'install';
    const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
    const said = [];
    let before = '';
    try { before = fs.readFileSync(codexConfig, 'utf8'); } catch { before = ''; }
    const result = installing ? withCodexEntry(before, process.execPath === process.argv[1] ? 'bounce' : (process.argv[1] ?? 'bounce')) : withoutCodexEntry(before);
    if (result.changed) { fs.mkdirSync(path.dirname(codexConfig), {recursive: true}); fs.writeFileSync(codexConfig, result.text); }
    said.push(`codex: ${result.changed ? (installing ? 'registered' : 'removed') : (result.reason ?? 'already current')} · ${codexConfig}`);
    // claude owns its own MCP registry: ask its CLI rather than editing its file.
    const claude = spawnSync('claude', installing ? ['mcp', 'add', '--scope', 'user', 'bounce', '--', 'bounce', 'mcp-serve'] : ['mcp', 'remove', '--scope', 'user', 'bounce'], {encoding: 'utf8'});
    said.push(`claude: ${claude.error ? `not installed here (${claude.error.code})` : claude.status === 0 ? (installing ? 'registered' : 'removed') : (claude.stderr || claude.stdout || 'refused').trim().split('\n')[0]}`);
    return console.log(said.join('\n'));
  }
  // The agent-facing interface over MCP (docs/plans/bridge-interface.md): the same verbs and views the
  // bridge and these commands use, as typed tools, so an orchestrator stops shelling and parsing.
  if (positionals[0] === 'mcp-serve') {
    const {createOps, sessionBinding} = await import('./bridge-ops.js');
    const {createMcpServer, serveStdio} = await import('./mcp.js');
    // Resolve once. Both the MCP views and mutations refresh this exact session after a
    // daemon restart; neither is allowed to pick a newer session behind the other's back.
    const binding = sessionBinding(root, {env: process.env});
    const events = () => {
      const found = binding.read();
      if (!found.ok) return [];
      return new Session(process.cwd(), {root, id: found.session}).events;
    };
    const journal = () => {
      const found = binding.read();
      return found.ok ? found.journal : null;
    };
    const server = createMcpServer({
      // Codex launches this server from its own config, so the per-session grant never reaches its env:
      // without one, it finds the live session itself and refuses when that answer is not unique.
      ops: createOps({env: process.env, binding}),
      views: {binding: () => binding.read(), taskView: (task, options) => taskView(events(), task, {journal: journal(), ...options}), taskList: options => taskList(events(), options), campaign: id => campaigns(events())[id] ?? null},
      version,
    });
    serveStdio(server);
    return new Promise(() => {}); // stdio server: it ends when its client closes the pipe
  }
  // The reads the orchestrator used to fake with `tail | jq` — the same view its tools return.
  if ((positionals[0] === 'task' || positionals[0] === 'tasks') && positionals[1] !== 'compare') {
    const ref = values.session || listSessions(root).find(row => row.live)?.id || listSessions(root)[0]?.id;
    if (!ref) throw new Error('No session to read · start one with `bounce`');
    const id = resolveSessionRef(root, ref);
    const target = new Session(process.cwd(), {root, id});
    const journal = path.join(root, 'sessions', id, 'journal.jsonl');
    if (positionals[1]) {
      const view = taskView(target.events, positionals[1], {journal, report: Boolean(values.report)});
      if (!view) throw new Error(`Unknown task: ${positionals[1]}`);
      return console.log(values.json ? JSON.stringify(view, null, 2) : formatTaskView(view));
    }
    const rows = taskList(target.events, {all: Boolean(values.all)});
    return console.log(values.json ? JSON.stringify(rows, null, 2) : formatTaskList(rows));
  }
  if (positionals[0] === 'task' && positionals[1] === 'compare') {
    const [, , sessionId, taskA, taskB] = positionals;
    if (!sessionId || !taskA || !taskB) throw new Error('Use: bounce task compare SESSION TASK_A TASK_B');
    const taskSession = new Session(process.cwd(), {root, id: sessionId});
    const view = reducers.spend?.(taskSession.events); // depends on builder-1: reducers.spend
    const rowFor = taskId => {
      const submitted = taskSession.events.find(e => e.kind === 'task.submitted' && e.task === taskId);
      if (!submitted) throw new Error(`Unknown task: ${taskId}`);
      return {...(view?.tasks?.[taskId] ?? null), orders: submitted.orders};
    };
    const a = rowFor(taskA), b = rowFor(taskB);
    return console.log(JSON.stringify({session: sessionId, a, b, same_orders: a.orders === b.orders}));
  }
  if (positionals[0] === 'doctor') {
    console.log(`Workspace: ${cwd}\nData: ${root}\nMode: ${settings.mode}\nOrder: ${settings.order.join(' → ')}`);
    const quotas = await refreshQuota(settings, {root, cwd});
    for (const provider of Object.keys(providers)) {
      await new Promise(resolve => {
        const child = spawn(resolveExecutable(provider, settings.executables[provider]), ['--version'], {stdio: ['ignore', 'pipe', 'pipe']});
        let out = ''; child.stdout.on('data', d => {out += d;});
        child.stderr.resume();
        const timer = setTimeout(() => child.kill(), 5000);
        child.once('error', e => { console.log(`${provider}: ${e.message}`); });
        child.once('close', code => {clearTimeout(timer); console.log(`${provider} (${resolveExecutable(provider, settings.executables[provider])}): ${code === 0 ? clean(out.trim()) : 'not available'} · ${quotaShort(quotas[provider]) || quotas[provider]?.error || quotaUnavailable(provider)}`); resolve();});
      });
    }
    return;
  }
  if (positionals.length && !['run', 'dev'].includes(positionals[0])) throw new Error('Unknown command. Use --help.');
  if (positionals[0] !== 'run' && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('TUI requires a terminal. Use bounce run "prompt" for headless execution.');
  if (positionals[0] === 'run' && !positionals.slice(1).join(' ').trim()) throw new Error('Provide a prompt: bounce run "prompt"');
  // Each vendor CLI only reads skills from its own directory, so bounce's copies are pushed
  // out before the session starts. Nothing is written while every agent is already current.
  // A config written for the removed in-house adapter is brought forward on load. Say so once —
  // the profile still works, but its containment changed, and silently altering a security posture
  // would be worse than a single line of notice.
  const migratedWorkers = (settings.migratedProfiles ?? []).filter(name => !name.startsWith('local.'));
  const migratedPolicies = (settings.migratedProfiles ?? []).filter(name => name.startsWith('local.'));
  const migrationNotice = [
    migratedWorkers.length ? `Local worker${migratedWorkers.length > 1 ? 's' : ''} ${migratedWorkers.join(', ')} migrated to the opencode adapter · they now work in the project directly, like cloud workers.` : '',
    migratedPolicies.length ? `Local models now load on demand (${migratedPolicies.map(name => name.split('.')[1]).join(', ')}: the old loaded-only default was dropped).` : '',
  ].filter(Boolean).join(' ');
  let skillNotice = '';
  if (settings.skills.autoSync) {
    try { if (skillsChanged(syncSkills({root, scope: settings.skills.scope, cwd}))) skillNotice = 'Skills installed to your agents.'; }
    catch (error) { skillNotice = `Skills not synced: ${error.message}`; }
  }
  // BOUNCE_REMOTE_SESSION is a distinct flag from BOUNCE_SUPERVISED (which also covers
  // the legacy TUI restart loop, src/reload.js's legacySupervise, that hosts no real
  // session over IPC): only src/reload.js's daemonSupervise sets it, for `run`. This
  // child never receives BOUNCE_BUS/BOUNCE_BUS_TOKEN_FILE in classic mode — those stay in
  // daemon.json for attach/stop only, so a vendor CLI spawned as this process's own child can
  // never inherit bus authority (see T3b rework round 2, BLOCKER). Orchestrator mode is the one
  // exception: this child holds the orchestrator grant and hands it on to its own CLI (below).
  //
  // Orchestrator mode (T3b): the supervisor validated the profile table and serialized the
  // orchestrator's own profile here, so the main conversation runs on that adapter/model/mode.
  // Both vars are set (or removed) by the supervisor on every spawn from the validated config,
  // so this is the config's decision, never something inherited from the surrounding shell.
  // The main profile selects the initial provider/model/mode. Keep legacy order available
  // for daemon failover when the profile has no explicit fallback list.
  const orchestrating = process.env.BOUNCE_ROLE === 'orchestrator' && !!process.env.BOUNCE_ORCHESTRATOR_PROFILE;
  if (orchestrating) {
    const profile = JSON.parse(process.env.BOUNCE_ORCHESTRATOR_PROFILE);
    settings.order = positionals[0] === 'run' ? [profile.adapter]
      : [profile.adapter, ...settings.order.filter(provider => provider !== profile.adapter)];
    settings.models[profile.adapter] = profile.model || settings.models[profile.adapter] || '';
    settings.mode = profile.mode;
  }
  let session = process.env.BOUNCE_REMOTE_SESSION === '1'
    ? await createRemoteSession(process)
    : new Session(cwd, {root, id: restarted?.id ?? (values.resume ? resolveSessionRef(root, values.resume) : undefined)});
  session.lock();
  // The orchestrator's CLI is a peer, not a plain vendor process: keepBus is the single
  // documented exception to runProcess's env strip (src/providers.js).
  // The orchestrator delegates ONLY through the bridge: a vendor's own subagent tools would run
  // workers bounce cannot see (observed: told to go on without codex, claude spawned its own
  // Agent and the AGENTS pane stayed empty). Claude Code exposes --disallowedTools for exactly
  // this; other vendors' subagent features have no such switch here yet, so ORDERS.md forbids them.
  const noOwnSubagents = provider => provider === 'claude' ? ['--disallowedTools', 'Agent,Task'] : [];
  // Fire-and-forget: a new session's first prompt gets a model-given title once (src/session-title.js).
  const onFirstUserPrompt = (s, cfg) => { titleSession({session: s, settings: cfg, ask: createAsk({executables: cfg.executables})}).catch(() => {}); };
  const routerOptions = {onFirstUserPrompt, ...(orchestrating ? {runner: options => runProcess({...options, keepBus: true}), extraArgs: noOwnSubagents} : {})};
  const remoteMain = orchestrating && positionals[0] !== 'run' && typeof session.runMain === 'function';
  if (remoteMain && session.main?.provider) {
    settings.models[session.main.provider] = session.main.model ?? '';
    settings.mode = session.main.mode ?? settings.mode;
  }
  let router = remoteMain ? createMainClient(session, settings, {selection: () => headerProvider({settings, orchestration, active: session.active})}) : new Router(session, settings, routerOptions);
  const orchestratorBrief = orchestrating
    ? `You are the orchestrator peer of session ${session.id}; the bounce bridge is available via BOUNCE_BUS/BOUNCE_BUS_TOKEN_FILE; see ${path.join(session.dir, 'orchestrator', 'ORDERS.md')}.\n`
    : '';
  if (restarted?.provider || values.provider) session.active = restarted?.provider || values.provider;
  if (remoteMain && values.model && !restarted) settings.models[session.active || settings.order[0]] = values.model;
  process.on('exit', () => session.unlock?.());
  // Quota readings survive restarts, so the display starts with the last known usage.
  const quotas = loadQuota(root);
  if (positionals[0] === 'run') {
    if (migrationNotice && !values.json) console.log(`[router:local] ${migrationNotice}`);
    if (skillNotice && !values.json) console.log(`[router:skills] ${skillNotice}`);
    session.onEvent = e => {
      if (e.kind === 'raw') recordQuota(quotas, root, quotaSnapshot(e.provider, e.raw));
      if (values.json) console.log(JSON.stringify(e));
      else if (e.text && !['raw', 'usage', 'progress'].includes(e.kind)) console.log(`[${e.provider || 'router'}:${e.kind}] ${clean(e.text)}`);
    };
    const cancel = () => router.cancel();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    const typed = positionals.slice(1).join(' ');
    const expanded = typed.startsWith('/') ? expandVendorCommand(typed, {root, cwd: session.cwd}) : null;
    try { const result = await router.run(orchestratorBrief + (expanded?.prompt ?? typed), values.image || [], expanded ? {typed} : {}); process.exitCode = result === 'completed' ? 0 : result === 'cancelled' ? 130 : 1; }
    finally { session.unlock(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    // `run` is always this process's whole job, and under the supervisor's daemon
    // apparatus this session is a RemoteSession that keeps the IPC channel actively
    // ref'd (createRemoteSession sends/receives on it): without an explicit exit the
    // process would never notice there is nothing left to do. flush() first, so the
    // tail rows (attempt, turn) — appended right before this point — actually reach
    // the parent's journal instead of being dropped by an exit that races their IPC
    // round trip; a dropped/closed channel is not a reason to hang here.
    try { await session.flush?.(); } catch {}
    process.exit(process.exitCode ?? 0);
  }
  let attachedTurn = remoteMain && ['running', 'starting', 'blocked'].includes(session.main?.state);
  // True from the moment Enter sends a prompt while an attached (daemon-started) turn is current
  // until that keyboard turn settles: main-service.js queues the prompt server-side, so it has
  // no requestId of its own yet here, but scheduleRender still must not treat the attached turn
  // ending as this view going idle while its own reply is still waiting to start.
  let waitingOnQueuedTurn = false;
  let input = '', inputCursor = 0, verticalColumn = null, busy = attachedTurn, suspended = false, scroll = 0, historyIndex = -1;
  let suggestion = null; // the main worker's proposed next step, offered in the prompt; never sent on its own
  const pendingTurns = [];
  const asides = [];
  async function steerAside(text) {
    if (!text) throw new Error('Use /steer <text>');
    const task = agentsOpen ? selectedWorker() : null;
    if (task) {
      if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) throw new Error('This worker has finished');
      session.append({kind: 'message', to: `worker:${task}`, text});
      notice = `Delivery requested for worker ${task.slice(0, 8)}`;
      return;
    }
    if (busy && remoteMain) {
      notice = 'Sending to the active turn…'; render();
      const result = await router.deliver(text);
      notice = result.state === 'acknowledged' || result.tier === 'live'
        ? 'Delivered into the main worker\'s turn · read when its current command returns; a pending wait ends now'
        : `Delivery ${result.state ?? result.tier ?? 'failed'}${result.reason ? ': ' + result.reason : ''}`;
      return;
    }
    if (busy) throw new Error('Live steering requires an orchestrator session');
    asides.push(text);
    session.append({kind: 'aside', text});
    notice = `Saved aside for the next orchestrator prompt · ${asides.length} pending`;
  }
  // The agent workspace is TUI-local: one focusable pane for the orchestrator and one per worker.
  // Its selection is never journaled and never changes task/model lifecycle state.
  let agentsOpen = false, selectedAgentPane = 'orchestrator';
  let details = false;
  const paneInputs = new Map();
  let terminal;
  function changePane(id) {
    paneInputs.set(selectedAgentPane, {input, inputCursor, scroll});
    selectedAgentPane = id;
    const draft = paneInputs.get(id);
    input = draft?.input ?? '';
    inputCursor = clampCursor(input, draft?.inputCursor ?? input.length);
    scroll = draft?.scroll ?? 0;
  }
  // The orchestration profile table this session was configured with, if any — read once here
  // so /continue can validate a profile name without touching the bus. A malformed config never
  // breaks the TUI: it just means /continue always reports 'no such profile'.
  let orchestration;
  try { orchestration = validateOrchestration(settings, undefined, {roles}); }
  catch { orchestration = {operation: 'classic', orchestrator: null, profiles: {}, shape: 'none', strict: false}; }
  // The mode this session actually runs in is fixed when the supervisor spawned it (the daemon
  // and its workers exist or they don't), so /operation saves the config and restarts the
  // session into the chosen mode (applyOperation). The sidebar shows the running mode and names
  // the saved one whenever they still differ (a refused or failed restart) — otherwise a session
  // switched to "classic" would keep dispatching workers under a classic label.
  const sessionOperation = orchestrating ? 'orchestrator' : 'classic';
  const pendingOperation = () => orchestration.operation === sessionOperation ? null : orchestration.operation;
  // The usage panel covers every vendor the session can spend on: in orchestrator mode the
  // workers' vendors too, not just the orchestrator's own (settings.order is narrowed to it).
  const quotaOrder = () => usageOrder(settings.order, orchestration.operation === 'orchestrator' ? orchestration.profiles : {});
  let activityTimer, activityStarted = 0, progress = '', busySince = null;
  const activity = () => `${['◐', '◓', '◑', '◒'][Math.floor((Date.now() - activityStarted) / 150) % 4]} Working · ${Math.floor((Date.now() - activityStarted) / 1000)}s`;
  let loadedFingerprint = fingerprint();
  let completionIndex = 0, menuDismissed = false, copyPaused = false;
  // On by default: the wheel scrolls the transcript, which is what a scroll gesture means here.
  // F3 hands the mouse back to the terminal for drag-selection and link clicks.
  let mouseScroll = true;
  let picker = null;
  let localSetup = null;
  // A one-line answer the TUI collects in place of a prompt (the /jev key entry): the draft is
  // masked on screen while it is open and never lands in history or the journal.
  let textPrompt = null; // {label, mask, onAnswer}
  function openTextPrompt({label, mask = false, hint, onAnswer}) {
    picker = null; input = ''; inputCursor = 0;
    textPrompt = {label, mask, onAnswer};
    notice = hint;
    render();
  }
  // The agents' own commands for this workspace join the picker after bounce's; a name bounce
  // already uses (Muse ships a review skill) is bounce's. The directories are small but the
  // picker redraws per keystroke, so the survey is kept briefly.
  const vendorOptions = () => ({root, cwd: session.cwd});
  let vendorCache = {at: 0, rows: []};
  const vendorRows = () => {
    if (Date.now() - vendorCache.at > 3000) vendorCache = {at: Date.now(), rows: vendorCommandRows(vendorOptions()).filter(([name]) => !ownCommands.some(([own]) => own === name))};
    return vendorCache.rows;
  };
  const vendorCommand = name => !!findVendorCommand(name, vendorOptions());
  const suggestions = () => menuDismissed ? [] : completions(input, vendorRows);
  const acceptCompletion = () => {const options = suggestions(); if (options.length) {input = '/' + options[completionIndex % options.length][0] + ' '; inputCursor = input.length; completionIndex = 0; menuDismissed = false; return true;} return false;};
  let notice = [restarted?.updateNotice, migrationNotice, skillNotice, 'Ready. Mouse wheel scrolls the transcript · Option-drag selects text (F3 turns the wheel off) · F2 pause for copying · /help'].filter(Boolean).join(' ');
  const history = session.events.filter(e => e.kind === 'user').map(e => e.typed ?? e.text);
  // What the next turn runs on: the orchestrator profile in orchestrator mode, else the active agent.
  const selected = () => headerProvider({settings, orchestration, active: session.active}).provider;
  const setupDefaults = {};
  const savedSettings = () => ({...settings, ...setupDefaults});
  const save = () => saveJSON(path.join(root, 'config.json'), savedSettings());
  function cancelLocalSetup() {
    if (!localSetup) return;
    const view = localSetup; localSetup = null; view.cancel();
    input = ''; inputCursor = 0;
    notice = 'Local setup cancelled · agents unchanged; an already approved image build may still finish';
    render();
  }
  function openLocalSetup(loadedOnly) {
    if (localSetup) throw new Error('Local setup is already open · answer below, Esc or /local cancel');
    picker = null;
    const file = path.join(root, 'config.json');
    const current = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const baseline = current();
    const initial = materialiseRoster(config(root));
    const view = createLocalSetupView({settings: initial, cwd: session.cwd, loadedOnly, roles, agentsDir: agentStore(root),
      onChange: render,
      save: async next => {
        if (current() !== baseline) throw new Error('Configuration changed during setup; nothing saved. Rerun /local setup.');
        validateOrchestration(next, undefined, {roles});
        saveJSON(file, next);
        // Preserve these saved fields in later TUI saves without changing the live daemon team.
        for (const key of ['profiles', 'local']) {
          if (Object.hasOwn(next, key)) settings[key] = structuredClone(next[key]);
        }
        for (const key of ['operation', 'orchestrator', 'mode']) {
          if (Object.hasOwn(next, key)) setupDefaults[key] = next[key];
        }
      }});
    // Agent files written by setup are activated once the wizard has finished writing them (they
    // land after `save`), so the roster the orchestrator reads is the one the user just chose.
    const activateAgents = async () => {
      const agents = view.state.result?.agents ?? [];
      if (!agents.length) return '';
      try { await activateLocalProfiles(session, agents); return `agents ${agents.join(', ')} active in this session`; }
      catch (error) { return `agents saved but not live: ${error.message}`; }
    };
    view.loadedOnly = loadedOnly;
    localSetup = view;
    void view.done.then(async () => {
      if (localSetup !== view) return;
      localSetup = null; input = ''; inputCursor = 0;
      const agentsNotice = view.state.result?.saved ? await activateAgents() : '';
      notice = view.state.error ? `Local setup: ${view.state.error}` : view.state.result?.saved
        ? `Local setup saved · ${agentsNotice || 'workers active in this session'}; existing agents unchanged`
        : 'Local setup finished · no configuration saved';
      session.append({kind: 'status', text: notice});
      render();
    });
    render();
  }
  const {style} = createFormatter();
  const workSummary = createWorkSummary();
  // Picking a model also picks the agent that reported it.
  const applyModel = entry => {
    router.select(entry.provider);
    chooseModel(settings, orchestration, {provider: entry.provider, model: entry.id});
    refreshOrchestration();
    save();
    const target = orchestration.operation === 'orchestrator' ? `Orchestrator ${orchestration.orchestrator}: ` : 'Model: ';
    session.append({kind: 'status', text: `${target}${entry.provider} · ${entry.label}${entry.id ? ` (${entry.id})` : ''}`});
    notice = `${entry.provider} · ${entry.label}. ${orchestration.operation === 'orchestrator' ? 'The orchestrator runs on it from the next turn.' : 'Saved as the default.'}`;
  };
  // A profile change made here (model, order) is re-read the way the daemon reads it.
  function refreshOrchestration() {
    try { orchestration = validateOrchestration(settings, undefined, {roles}); }
    catch (error) { notice = `Configuration not applied: ${error.message}`; }
  }
  // Shared by the /operation command and its picker (menu, also behind Ctrl+O) — one place
  // applies a mode change: open an (empty) overlay on the shipped roster on the first switch to
  // orchestrator, validate the whole config, persist, and — when the chosen mode is not the one
  // this session runs in — restart the session into it (same id, same transcript) through the
  // supervisor's restart channel; src/reload.js picks the other hosting path from the state's
  // `operation`. Refused before anything is saved while workers still run (a restart would orphan
  // them) or without a supervisor to restart under. Never throws — problems go to `notice`.
  function applyOperation(arg) {
    if (!['classic', 'orchestrator'].includes(arg)) { notice = 'Use /operation classic or /operation orchestrator'; return; }
    const restarting = arg !== sessionOperation;
    if (restarting) {
      const open = Object.values(reducers.tasks(session.events)).filter(t => !reducers.TERMINAL.has(t.state));
      if (open.length) { notice = `Cannot switch to ${arg}: ${open.length} worker${open.length === 1 ? ' is' : 's are'} still running · /stop first`; return; }
      if (!process.send) { notice = `Cannot switch to ${arg}: switching needs the bounce supervisor`; return; }
    }
    const previous = {operation: settings.operation, profiles: settings.profiles, orchestrator: settings.orchestrator};
    settings.operation = arg;
    if (arg === 'orchestrator') materialiseRoster(settings);
    try { orchestration = validateOrchestration(settings, undefined, {roles}); }
    catch (error) { Object.assign(settings, previous); notice = `Cannot switch to ${arg}: ${error.message}`; return; }
    delete setupDefaults.operation; delete setupDefaults.orchestrator;
    save();
    const roster = arg === 'orchestrator' ? ` · ${orchestration.orchestrator} · ${Object.entries(orchestration.profiles).map(([n, pr]) => `${n}(${pr.adapter})`).join(', ')}` : '';
    if (!restarting) { session.append({kind: 'status', text: `Operation: ${arg}${roster} — saved; already how this session runs.`}); return; }
    session.append({kind: 'status', text: `Operation: ${arg}${roster} — saved; restarting this session into ${arg}…`});
    notice = `Restarting into ${arg}…`;
    restartInto(arg).catch(error => { notice = `Restart into ${arg} failed: ${error.message} — it applies to the next session.`; render(); });
  }
  function openOperationPicker() {
    picker = {kind: 'operation', entries: ['classic', 'orchestrator'], index: orchestration.operation === 'orchestrator' ? 1 : 0, notes: []};
    notice = 'Pick an operation mode. Enter restarts this session into it · Esc cancels.';
  }
  async function openModelPicker(refresh) {
    notice = 'Asking each signed-in agent for its models…'; render();
    const catalogs = await modelCatalog(settings, refresh ? {maxAge: 0} : {});
    const entries = modelEntries(catalogs, settings);
    const notes = catalogNotes(catalogs);
    if (!entries.length) throw new Error(notes.join(' · ') || 'No agent reported any models');
    picker = {entries, notes, index: Math.max(0, entries.findIndex(e => e.provider === selected() && e.current))};
    notice = 'Select a model. Esc cancels.';
  }
  // Import is a choice, not a command: adopting an agent's whole skill set unasked is what
  // filled the store with skills the user never wanted. Offer the list and adopt the ticks.
  function openImportPicker(args) {
    const providers = args.length ? args : undefined;
    for (const provider of providers ?? []) if (!skillAreas[provider]) throw new Error(`Unknown provider: ${provider}`);
    const options = {root, scope: settings.skills.scope, cwd: session.cwd, base: session.cwd};
    const found = importCandidates({...options, providers});
    const entries = found.filter(row => row.dir);
    if (!entries.length) throw new Error(found.filter(row => row.detail).map(row => `${row.provider}: ${row.detail}`).join(' · ') || 'No agent skills left to import.');
    picker = {
      kind: 'import', entries, index: 0,
      // Nothing is ticked to begin with: "select all" is one key away, and an empty
      // selection makes Enter a safe no-op rather than a repeat of the accidental import.
      chosen: new Set(),
      notes: found.filter(row => row.action === 'invalid').map(row => `${row.skill} (${importOrigin(row)}): ${row.detail}`),
      entryLabel: entry => `${entry.skill} (${importOrigin(entry)})${entry.action === 'exists' ? ' — already in bounce, replaces it' : ''}`,
      options,
    };
    for (const entry of entries) entry.label = picker.entryLabel(entry);
    notice = 'Space ticks a skill · a all · n none · Enter imports · Esc cancels.';
  }
  function applyImport() {
    const {entries, chosen, options} = picker;
    // Closing on an empty Enter drops the next keystrokes into the prompt, where they become
    // an agent turn nobody asked for. Say what is missing and stay put instead.
    if (!chosen.size) { notice = 'Nothing ticked yet · Space ticks one · a ticks all · Esc cancels.'; return; }
    const selection = [...chosen].sort((a, b) => a - b).map(i => entries[i]);
    picker = null;
    const report = importSelected(root, selection, {home: undefined, force: true});
    const synced = syncSkills(options);
    session.append({kind: 'skills', text: [importSummary(report), syncSummary(synced)].filter(Boolean).join('\n')});
    notice = `Imported ${selection.length} skill${selection.length === 1 ? '' : 's'}.`;
  }
  const paneIds = () => terminal?.paneIds() ?? ['orchestrator'];
  const selectedWorker = () => terminal?.snapshot().panes.find(pane => pane.id === selectedAgentPane)?.task ?? null;
  const inputTarget = () => {
    const task = selectedWorker();
    if (!task) return 'main';
    const pane = terminal?.snapshot().panes.find(row => row.task === task);
    return `${pane?.profile ?? 'worker'} ${task.slice(0, 8)}`;
  };
  function render() {
    if (suspended || !terminal) return;
    if (agentsOpen && !paneIds().includes(selectedAgentPane)) {
      const previous = selectedAgentPane;
      const unsent = input;
      changePane('orchestrator');
      paneInputs.delete(previous);
      if (unsent) {
        notice = `Worker finished · unsent draft saved in transcript (${previous.slice(7, 15)})`;
        session.append({kind: 'note', text: `Unsent draft for ${previous}:\n${unsent}`});
      }
    }
    const {content: width} = workspaceColumns(process.stdout.columns || 80, {sidebar: settings.sidebar});
    const terminalRows = process.stdout.rows || 24;
    const headerRows = 1;
    const target = textPrompt ? `${textPrompt.label} › ` : localSetup ? 'setup › ' : agentsOpen ? `${inputTarget()} › ` : '';
    const promptWidth = Math.max(1, width - 2 - stringWidth(target));
    const draft = inputLayout(input, promptWidth, Math.max(1, Math.min(Math.floor(terminalRows / 3), terminalRows - headerRows - 5)));
    const options = suggestions();
    const menuBudget = Math.max(0, terminalRows - headerRows - 5 - draft.rows.length);
    const plain = s => s;
    const menu = [];
    if (picker?.kind === 'import') {
      const rows = checklistRows(picker.entries, picker.index, width - 1, picker.chosen);
      const {start, end} = windowAround(rows.length, picker.index, Math.max(1, menuBudget - 2 - picker.notes.length));
      menu.push([`Import skills · ${rows.length} found · ${picker.chosen.size} selected`, style.title]);
      for (let i = start; i < end; i++) menu.push([rows[i], i === picker.index ? style.selected : picker.chosen.has(i) ? style.result : plain]);
      for (const note of picker.notes) menu.push([note, style.diagnostic]);
      menu.push(['↑/↓ move · Space tick · a all · n none · Enter import · Esc cancel', style.muted]);
    } else if (picker?.kind === 'session') {
      const {start, end} = windowAround(picker.entries.length, picker.index, Math.max(1, menuBudget - 2));
      menu.push([`Resume a session in this workspace · ${picker.entries.length} found`, style.title]);
      for (let i = start; i < end; i++) menu.push([`${i === picker.index ? '\u203a' : ' '} ${picker.entries[i].label}`, i === picker.index ? style.selected : plain]);
      menu.push(['\u2191/\u2193 choose \u00b7 Enter resume \u00b7 Esc cancel', style.muted]);
    } else if (picker?.kind === 'operation') {
      menu.push(['Operation mode', style.title]);
      picker.entries.forEach((name, i) => menu.push([`${i === picker.index ? '\u203a' : ' '} ${name}${name === sessionOperation ? '  (running)' : name === orchestration.operation ? '  (saved)' : ''}`, i === picker.index ? style.selected : plain]));
      menu.push(['\u2191/\u2193 choose \u00b7 Enter switch (restarts the session) \u00b7 Esc cancel', style.muted]);
    } else if (picker) {
      const rows = modelRows(picker.entries, picker.index, width - 1);
      const {start, end} = windowAround(rows.length, picker.index, Math.max(1, menuBudget - 2 - picker.notes.length));
      menu.push([`Select model · ${rows.length} choices across your signed-in agents`, style.title]);
      for (let i = start; i < end; i++) menu.push([rows[i], i === picker.index ? style.selected : picker.entries[i].current ? style.result : plain]);
      for (const note of picker.notes) menu.push([note, style.diagnostic]);
      menu.push(['↑/↓ choose · 1-9 jump · Enter use it · Esc cancel', style.muted]);
    } else if (options.length) {
      completionIndex = Math.min(completionIndex, options.length - 1);
      const start = Math.max(0, completionIndex - 3);
      for (let i = start; i < Math.min(options.length, start + 5); i++) menu.push([`${i === completionIndex ? '›' : ' '} /${options[i][0]}  ${options[i][1]}`, i === completionIndex ? style.selected : style.muted]);
      menu.push(['↑/↓ choose · Tab completes · Enter runs · Esc dismiss', style.muted]);
    } else if (localSetup) {
      const state = localSetup.state;
      const question = inputLayout(state.question || 'Working… slash commands remain available', width, 3).rows;
      const history = state.lines.flatMap(line => inputLayout(line, width, 100).rows);
      const available = Math.max(0, Math.min(10, menuBudget - question.length - 2));
      menu.push([`Local setup · ${localSetup.loadedOnly ? 'currently loaded models' : 'auto-discovery'}`, style.title]);
      localSetup.scroll = Math.min(localSetup.scroll ?? 0, Math.max(0, history.length - available));
      const end = history.length - localSetup.scroll;
      for (const line of available ? history.slice(Math.max(0, end - available), end) : []) menu.push([line, style.muted]);
      for (const line of question) menu.push([line, style.result]);
      menu.push(['Enter answers · PgUp/Dn review · slash commands work · Esc cancels setup only', style.muted]);
    }
    menu.length = Math.min(menu.length, menuBudget);
    terminal.update({
      suggestion: textPrompt || localSetup || picker ? null : suggestion,
      agentsOpen, details, sidebar: settings.sidebar, selectedId: selectedAgentPane, input: textPrompt?.mask ? '•'.repeat(input.length) : input, inputCursor: clampCursor(input, inputCursor), inputTarget: textPrompt ? textPrompt.label : localSetup ? 'setup' : inputTarget(), scroll, busy, progress,
      paneScrolls: {...Object.fromEntries([...paneInputs].map(([id, value]) => [id, value.scroll])), [selectedAgentPane]: scroll},
      // When this turn began, so the header and the rail can say how long the main worker has been at it.
      // What the main worker is doing right now — thinking, a command, or a wait on a task — from the tail of the journal.
      main: {...session.main, text: progress || notice, operation: orchestration.operation, startedAt: (busySince = busy ? busySince || new Date().toISOString() : null),
        doing: busy ? doingNow(session.events.slice(-400), {tasks: reducers.tasks(session.events)}) : null},
      now: Date.now(),
      notice: localSetup?.state.question || notice, paused: copyPaused, mouseScroll,
      menu: menu.map(([text, paint]) => paint(clean(text))),
      metadata: {
        ...headerProvider({settings, orchestration, active: session.active}), mode: settings.mode,
        cwd: session.cwd, sessionId: session.id, name: reducers.sessionName(session.events), operation: sessionOperation, pendingOperation: pendingOperation(), jev: jevSidebarLabel(settings.jev),
        orchestrator: orchestration.orchestrator ?? 'main', pendingTurns: pendingTurns.length,
        ownQueued: remoteMain ? reducers.queuedPrompts(session.events).length : 0,
        // The sidebar spends 11 rows on the header block, the AGENTS list and the two gaps, plus
        // one per worker; whatever is left (sidebarRows) is split between MODELS and quota, with
        // MODELS capped at 40% (and its own blank separator row when non-empty) so quota never
        // loses its floor of 4 rows to a long model list.
        ...(() => {
          const paint = {title: style.title, text: plain, muted: style.muted, ok: style.result,
            warn: style.status, high: style.error, tick: style.note};
          const sidebarRows = Math.max(4, terminalRows - 11 - (pendingOperation() ? 1 : 0) - (terminal?.snapshot().panes.length ?? 0));
          const modelLines = modelPanel(reducers.modelUsage(session.events), {width: 28, rows: Math.floor(sidebarRows * 0.4), paint});
          const quotaLines = quotaPanel(quotas, quotaOrder(), {
            width: 28, now: Date.now(), rows: Math.max(4, sidebarRows - (modelLines.length ? modelLines.length + 1 : 0)), cooldowns: router.cooldowns, paint,
          });
          return {quotaLines, modelLines};
        })(),
      },
    });
  }
  let renderTimer;
  function scheduleRender(event) {
    if (remoteMain && event?.kind === 'main.starting' && event.provider) {
      settings.models[event.provider] = event.model ?? '';
      settings.mode = event.mode ?? settings.mode;
    }
    // A turn this view did not start — the daemon waking the orchestrator on worker outcomes
    // (main-service.js) — is held exactly like a turn found running at attach: new prompts are
    // refused with a notice, /steer steers it, Esc cancels it, its terminal row releases the input.
    if (remoteMain && !busy && event?.kind === 'main.starting') {
      attachedTurn = true; busy = true;
      notice = event.handoff ? 'Orchestrator woke on worker outcomes · /steer steers it, Esc cancels' : 'Existing turn is active · /steer steers it · /btw asks aside';
    }
    if (attachedTurn && ['main.terminal', 'main.blocked'].includes(event?.kind)) {
      attachedTurn = false;
      if (waitingOnQueuedTurn) {
        // Our own reply is already sent (through the normal keyboard path — see the Enter
        // handler) and main-service.js has it queued: this event only ends the FOREIGN turn we
        // were attached to, not ours. Stay busy; the keyboard turn's own resolution reports it.
        notice = 'Queued · runs when the current turn ends';
      } else {
        notice = event.text || `Turn ${event.status ?? 'blocked'}.`;
        // The answer is the turn's last assistant row, never this row's text (that is a failure reason).
        suggestion = event.kind === 'main.terminal' && event.status === 'completed' && !input ? suggestionFrom(lastAnswer(session.events)) : null;
        busy = false;
      }
    }
    if (event?.kind === 'progress') progress = clean(event.text);
    terminal?.ingest(event);
    if (event?.kind === 'task.delivered') notice = `Worker ${event.task.slice(0, 8)} · delivery ${event.tier}`;
    // Vendor streams repeat quota many times per turn; only a changed reading redraws.
    if (event?.kind === 'raw' && !recordQuota(quotas, root, quotaSnapshot(event.provider, event.raw))) return;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {renderTimer = null; render();}, 40);
  }
  const enter = () => { suspended = false; terminal?.resume(); render(); };
  const leave = () => { suspended = true; terminal?.suspend(); };
  // /resume and /new: hand the terminal to another session. Under the daemon this is a switch
  // message (the daemon is bound to one session and supervise() starts the next); classic
  // restarts the child into the chosen id through the existing restart channel.
  async function switchSession(id) {
    if (!process.send) throw new Error('Resuming needs the bounce supervisor');
    if (process.env.BOUNCE_REMOTE_SESSION === '1') {
      const open = Object.values(reducers.tasks(session.events)).filter(t => !reducers.TERMINAL.has(t.state));
      if (open.length) throw new Error(`${open.length} worker${open.length === 1 ? ' is' : 's are'} still running · /stop first`);
      await new Promise((resolve, reject) => process.send({type: 'switch', id: id ?? 'new'}, error => error ? reject(error) : resolve()));
      leave(); session.unlock();
      try { await session.flush?.(); } catch {}
      process.exit(76);
    }
    const state = {id: id ?? undefined, settings: savedSettings(), provider: selected(), dev};
    await new Promise((resolve, reject) => process.send({type: 'restart', state}, error => error ? reject(error) : resolve()));
    leave(); session.unlock();
    process.exit(75);
  }
  // The mode switch's restart: like restart() below but without the dev-code validation, and
  // the state names the mode so the supervisor re-hosts the session under the other path.
  async function restartInto(operation) {
    const state = {id: session.id, settings: savedSettings(), provider: selected(), dev, operation};
    await new Promise((resolve, reject) => process.send({type: 'restart', state}, error => error ? reject(error) : resolve()));
    leave(); session.unlock();
    try { await session.flush?.(); } catch {}
    process.exit(75);
  }
  async function restart() {
    notice = 'Validating updated code…'; render();
    await validate(projectRoot, text => session.append({kind: 'status', text}));
    session.append({kind: 'status', text: 'Validation passed. Restarting into updated code.'});
    const state = {id: session.id, settings: savedSettings(), provider: selected(), dev};
    await new Promise((resolve, reject) => process.send({type: 'restart', state}, error => error ? reject(error) : resolve()));
    leave(); session.unlock();
    try { await session.flush?.(); } catch {}
    process.exit(75);
  }
  async function update(checkOnly) {
    const release = await checkUpdate({root, force: true});
    if (checkOnly || !release.available) {
      session.append({kind: 'status', text: release.available ? `Update available: ${version} → ${release.latest}. Run /update.` : `Bounce ${version} is up to date.`});
      return;
    }
    await globalInstall();
    const state = {id: session.id, settings: savedSettings(), provider: selected(), dev};
    await new Promise((resolve, reject) => process.send({type: 'restart', state, update: true}, error => error ? reject(error) : resolve()));
    leave(); session.unlock();
    try { await session.flush?.(); } catch {}
    process.exit(75);
  }
  const quit = (detach = false) => { leave(); session.unlock(); void (async () => {
    try { await session.flush?.(); } catch {}
    if (!detach && process.env.BOUNCE_PERSISTENT_VIEW === '1') {
      await new Promise(resolve => process.send({type: 'control', action: 'quit'}, resolve));
    }
    process.exit(detach ? 80 : 0);
  })(); };
  async function submit(text, {parsedCommand, ownsTurn = true} = {}) {
    if (ownsTurn) {
      activityStarted = Date.now(); progress = '';
      activityTimer = setInterval(render, 150);
    }
    try {
      if (parsedCommand) {
        const {command, parts, arg} = parsedCommand;
        if (command === 'details') {
          if (!['', 'on', 'off'].includes(arg)) throw new Error('Use /details [on|off]');
          details = arg ? arg === 'on' : !details;
          scroll = 0;
          notice = details ? 'Details expanded · /details to fold · PgUp/PgDn scroll' : 'Details folded · /details to expand';
          render();
          return;
        }
        if (command === 'local') {
          if (arg === 'cancel') {cancelLocalSetup(); return;}
          if (arg === 'on' || arg === 'off') {
            // The switch, in `/jev on|off`'s words. Saved, then the agents that can still be played are
            // re-read into this session, so it applies to the next task without a restart.
            const handed = arg === 'on' ? handAIsToJev(rolesFor(root, {cwd: session.cwd}), {orchestrator: settings.orchestrator}) : [];
            const text = [switchLocal(settings, arg === 'on'), ...(handed.length ? [handedText(handed)] : [])].join('\n');
            save();
            const saved = config(root);
            const names = agentTable(rolesFor(root, {cwd: session.cwd}), saved).filter(row => !row.error && row.backends.length && row.name !== saved.orchestrator).map(row => row.name);
            session.append({kind: 'status', text});
            notice = orchestrating && names.length ? (await activateLocalProfiles(session, names)).text : text;
            render();
            return;
          }
          if (arg === 'activate' || arg.startsWith('activate ')) {
            const saved = config(root);
            const requested = arg.slice('activate'.length).trim();
            const names = requested ? [requested] : [...rolesFor(root, {cwd: session.cwd}).values()].filter(role => !role.error && role.name !== saved.orchestrator).map(role => role.name);
            if (!names.length) throw new Error('No agents to activate; see `bounce agents`');
            const result = await activateLocalProfiles(session, names);
            notice = result.text;
            render();
            return;
          }
          if (arg === '' || arg === 'verify') {
            // The same status the CLI prints, rendered into the transcript. `verify` additionally
            // runs one real turn through OpenCode, so it is opt-in here too.
            const {gatherLocalStatus, formatLocalStatus} = await import('./local-setup-view.js');
            if (arg === 'verify') { notice = 'Verifying the OpenCode bridge with a one-line test turn…'; render(); }
            const status = await gatherLocalStatus({settings: config(root), verify: arg === 'verify',
              executables: settings.executables ?? {}, roles: rolesFor(root, {cwd: session.cwd})});
            session.append({kind: 'status', text: formatLocalStatus(status, {
              verifyHint: 'run /local verify to prove the bridge with a one-line test turn',
              setupHint: 'run /local setup'}).join('\n')});
            notice = status.problem ? `Local workers NOT READY (${status.problem.stage}) · see transcript for the fix`
              : status.bridge ? 'OpenCode bridge verified'
              : 'Local status · /local verify proves the bridge · /local setup configures workers';
            scroll = 0;
            render();
            return;
          }
          if (!['setup', 'setup loaded', 'setup --loaded', 'loaded'].includes(arg)) throw new Error('Use /local [verify], /local on|off, /local setup [loaded], /local activate [NAME], or /local cancel');
          openLocalSetup(arg.includes('loaded')); return;
        }
        if (command === 'jev') {
          const result = await jevCommand(parts, {root, settings, save, interactive: true});
          if (result.prompt === 'key') {
            openTextPrompt({label: 'jev key', mask: true, hint: result.text, onAnswer: async answer => {
              if (!answer.trim()) { notice = 'No key entered · nothing changed'; render(); return; }
              const saved = await jevCommand(['key', answer.trim()], {root, settings, save});
              session.append({kind: 'status', text: saved.text});
              if (orchestrating) session.append({kind: 'control.jev', from: 'user'});
              render();
            }});
            return;
          }
          session.append({kind: 'status', text: result.text});
          // The daemon re-reads config.json at each decision; the control row refreshes its orders and
          // confirms. `refresh: 'roster'` also has it describe the roster's models again.
          if ((result.changed || result.refresh) && orchestrating) session.append({kind: 'control.jev', from: 'user', ...(result.refresh ? {refresh: result.refresh} : {})});
          render();
          return;
        }
        if (localSetup && ['new', 'resume', 'restart', 'update', 'login', 'quit', 'detach'].includes(command)) cancelLocalSetup();
        if (command === 'quit') return quit();
        if (command === 'detach') {
          if (process.env.BOUNCE_PERSISTENT_VIEW !== '1') throw new Error('Detach requires a persistent orchestrator session');
          return quit(true);
        }
        if (command === 'update') {
          if (arg && arg !== 'check') throw new Error('Use /update or /update check');
          return await update(arg === 'check');
        }
        if (command === 'restart') return await restart();
        if (command === 'help') {
          // The journal keeps the plain text (handoffs, --json readers); the transcript paints
          // the same rows from `vendor` (src/format.js), so both stay one source: src/help.js.
          const vendor = vendorRows();
          session.append({kind: 'help', text: helpRows({tui: true, vendor}).join('\n'), vendor});
          return;
        }
        if (command === 'review') {
          session.append({kind: 'review', text: workReview(workSummary(session.events))});
          scroll = 0;
          notice = 'Work review · PgUp/PgDn scroll through all items';
          return;
        }
        if (command === 'provider') {
          if (!providers[arg]) throw new Error('Choose claude, codex, or muse');
          router.select(arg); settings.order = [arg, ...settings.order.filter(p => p !== arg)]; save();
        } else if (command === 'model') {
          if (!arg || arg === 'refresh') { await openModelPicker(arg === 'refresh'); return; }
          const chosen = chooseModel(settings, orchestration, {provider: selected(), model: arg === 'default' ? '' : arg});
          refreshOrchestration(); save();
          session.append({kind: 'status', text: orchestration.operation === 'orchestrator'
            ? `Orchestrator ${orchestration.orchestrator}: ${chosen.provider} · ${chosen.model || 'default'} — runs on it from the next turn`
            : `Model: ${chosen.provider} · ${chosen.model || 'default'}`});
        } else if (command === 'mode') {
          if (!['yolo','plan'].includes(arg)) throw new Error('Use /mode yolo or /mode plan'); settings.mode = arg; delete setupDefaults.mode; save();
        } else if (command === 'operation') {
          if (!arg) { openOperationPicker(); return; }
          applyOperation(arg); return; // its own notice: a refusal, or the restart under way
        } else if (command === 'stop') {
          if (orchestration.operation !== 'orchestrator') throw new Error('/stop is only available in orchestrator mode');
          if (!process.send) throw new Error('/stop needs the orchestrator daemon (run bounce with an orchestrator config)');
          const task = arg.trim();
          process.send({type: 'control', action: task ? 'cancel' : 'stop', task: task || undefined});
          session.append({kind: 'status', text: task ? `Requested cancel of task ${task.slice(0, 8)}` : 'Requested stop of every running task'});
        } else if (command === 'msg') {
          if (orchestration.operation !== 'orchestrator') throw new Error('/msg is only available in orchestrator mode');
          const [task, ...rest] = arg.split(/\s+/); const text = rest.join(' ');
          if (!task || !text) throw new Error('Use /msg <task> <text>');
          session.append({kind: 'message', to: `worker:${task}`, text});
          session.append({kind: 'status', text: `Message queued for worker ${task.slice(0, 8)}`});
        } else if (command === 'order') {
          if (arg) {
            const order = arg.split(',').map(p => p.trim());
            if (!order.length || order.some(p => !providers[p]) || new Set(order).size !== order.length) throw new Error('Use unique provider names separated by commas');
            chooseOrder(settings, orchestration, order); router.select(order[0]); refreshOrchestration(); save();
          }
          // Explicit profile fallback takes precedence over this legacy provider order.
          const reading = settings.order.map(p => `${p} (${settings.models[p] || 'default'})`).join(' → ');
          const note = arg ? (orchestrating ? `saved · the orchestrator now runs on ${settings.order[0]}` : 'saved') : orchestrating ? 'the first agent is the orchestrator; /order codex,claude moves it' : '/order claude,codex,muse changes it';
          session.append({kind: 'status', text: `Fallback order: ${reading} · ${note}`});
        } else if (command === 'sidebar') {
          if (!['', 'on', 'off'].includes(arg)) throw new Error('Use /sidebar [on|off]');
          settings.sidebar = arg ? arg === 'on' : !settings.sidebar; save();
          notice = settings.sidebar
            ? `Sidebar shown${(process.stdout.columns || 80) < 100 ? ' once the terminal is 100 columns wide' : ''} · /sidebar to hide`
            : 'Sidebar hidden · /sidebar to show';
          render();
          return;
        } else if (command === 'quota') {
          await refreshQuota(settings, {root, store: quotas, cwd: session.cwd});
          session.append({kind: 'quota', text: quotaReport(quotas, quotaOrder())});
        } else if (command === 'retry') {
          router.cooldowns = {}; for (const p of Object.keys(providers)) session.append({kind: 'cooldown', provider: p, until: 0, text: 'Local cooldown cleared'});
        } else if (command === 'skills') {
          // Import is interactive here; every other word goes to the shared command surface.
          if (parts[0] === 'import' && !parts.includes('--all')) return openImportPicker(parts.slice(1).filter(word => !word.startsWith('--')));
          const {text} = skillsCommand(parts.filter(word => word !== '--all'), {root, scope: settings.skills.scope, cwd: session.cwd, base: session.cwd});
          session.append({kind: 'skills', text});
        } else if (command === 'note') {
          if (!arg) throw new Error('Use /note TEXT'); session.append({kind: 'note', text: arg});
        } else if (command === 'new') {
          if (process.env.BOUNCE_REMOTE_SESSION === '1') { await switchSession(null); return; }
          if (Object.keys(setupDefaults).length) {await switchSession(null); return;}
          const next = new Session(session.cwd, {root}); next.lock(); session.unlock(); session = next;
          terminal.reset(session.events);
          router = new Router(session, settings, routerOptions); session.onEvent = scheduleRender; scroll = 0;
        } else if (command === 'login') {
          // Validate before the screen flips, so a typo never drops the user out of the TUI.
          const provider = arg || selected();
          if (!providers[provider]) throw new Error('Choose claude, codex, or muse');
          leave();
          process.stdout.write(`\nbounce: handing this terminal to \u2018${provider} login\u2019. Finish it here; bounce returns when it exits.\n\n`);
          let outcome;
          try { await login(provider, settings, session.cwd); outcome = `Signed in to ${provider}.`; }
          catch (error) { outcome = `${provider} login did not complete: ${error.message}`; }
          finally { enter(); }
          // The vendor's output is on the main screen bounce just left, so say what happened.
          session.append({kind: 'status', text: outcome});
          notice = outcome;
          // A sign-in changes what the vendor will report: re-ask now, or the usage panel keeps
          // the pre-login "unavailable" reading until the next turn happens to refresh it.
          void refreshQuota(settings, {root, store: quotas, cwd: session.cwd}).then(render, () => {});
          return;
        } else if (command === 'tasks') {
          const rows = Object.values(reducers.tasks(session.events));
          // `view: 'tasks'` lets the transcript fold repeated /tasks output to its latest copy.
          session.append({kind: 'status', view: 'tasks', text: rows.length ? rows.map(task => `${task.profile} ${task.id.slice(0, 8)} · ${task.state}${task.blocker || task.error || task.summary ? ` · ${task.blocker || task.error || task.summary}` : ''}`).join('\n') : 'No tasks in this session'});
          notice = 'Task states saved in transcript · PgUp/PgDn scroll';
        } else if (command === 'rename') {
          const name = arg.trim();
          if (!name) throw new Error('Use /rename <name>');
          session.append({kind: 'session.renamed', name});
          notice = `Session renamed to "${name}"`;
        } else if (command === 'sessions') {
          const rows = listSessions(root).filter(r => r.cwd === session.cwd).slice(0, 20);
          session.append({kind: 'status', text: rows.length ? sessionsTable(rows).join('\n') : 'No sessions in this workspace'});
        } else if (command === 'resume') {
          if (arg.trim()) { await switchSession(resolveSessionRef(root, arg.trim())); return; }
          const rows = listSessions(root).filter(r => r.cwd === session.cwd && r.id !== session.id).slice(0, 30);
          if (!rows.length) throw new Error('No other sessions in this workspace');
          picker = {kind: 'session', index: 0, notes: [], entries: rows.map(r => ({id: r.id, label: `${r.name ?? r.derivedName} · ${sessionAge(r.updated)} ago · ${r.operation}${r.live ? ' · live' : ''} · ${r.id.slice(0, 8)}`}))};
          notice = 'Pick a session to resume. Esc cancels.';
          return;
        } else if (command === 'steer') {
          await steerAside(arg.trim());
          return;
        } else if (command === 'btw') {
          // A side question, never a turn: it neither reads busy nor touches router/session.active,
          // and it journals its own question/answer rows rather than delivering into anything.
          const question = arg.trim();
          if (!question) throw new Error('Use /btw <question>');
          const id = randomUUID().slice(0, 8);
          notice = 'btw · answering…';
          render();
          askBtw({session, settings, orchestration, ask: createBtwAsk({executables: settings.executables}), id, question}).catch(() => {});
          return;
        } else if (command === 'agents' || command === 'zoom' || command === 'attach') {
          if (orchestration.operation !== 'orchestrator') throw new Error('/agents is only available in orchestrator mode');
          if (!arg) {
            agentsOpen = !agentsOpen;
            changePane('orchestrator');
            notice = agentsOpen ? 'Agent workspace · Tab changes pane · typing targets the selected pane · Esc closes' : 'Agent workspace closed';
            scroll = 0; return;
          }
          const known = reducers.tasks(session.events);
          if (['main', 'orchestrator'].includes(arg)) {
            agentsOpen = true; changePane('orchestrator');
            notice = 'Focused orchestrator pane'; return;
          }
          const matches = Object.keys(known).filter(id => id.startsWith(arg));
          if (matches.length > 1 && !known[arg]) throw new Error('Task prefix is ambiguous');
          const task = known[arg] ? arg : matches[0];
          if (!task) { session.append({kind: 'status', text: 'no such task'}); return; }
          if (reducers.TERMINAL.has(known[task].state)) throw new Error('This task has finished · its outcome is in the transcript');
          agentsOpen = true; changePane(terminal.snapshot().panes.find(pane => pane.task === task)?.id ?? `worker:${task}`);
          notice = `Focused ${task.slice(0, 8)} · typing messages this worker · Tab changes pane`;
          return;
        } else if (command === 'continue') {
          // §A2/U5: this is the ONLY place a main turn can be started on an orchestration
          // profile, and it is reached only from here — the keyboard's Enter handler calling
          // this function with the typed command. continueMain is pure and takes no
          // session/event, so nothing that folds session.events (scheduleRender, any bus
          // subscriber) could reach it.
          const decision = continueMain(orchestration.profiles, arg);
          if (!decision.ok) { session.append({kind: 'status', text: decision.error}); return; }
          const profile = orchestration.profiles[decision.profile];
          settings.order = [profile.adapter, ...settings.order.filter(p => p !== profile.adapter)];
          settings.models[profile.adapter] = profile.model; router.select(profile.adapter); save();
          scroll = 0;
          notice = 'Running · Esc or Ctrl+C cancels the agent process group';
          render();
          const result = await router.run((remoteMain ? '' : orchestratorBrief) + withAsides('Continue.', asides.splice(0)));
          notice = `Turn ${result}. Session saved.`;
          void refreshQuota(settings, {root, store: quotas, cwd: session.cwd}).then(render, () => {});
          return;
        } else throw new Error('Unknown command. Type /help');
        notice = 'Updated.';
      } else if (agentsOpen && selectedWorker()) {
        // A selected worker pane is an explicit message target, never a main model turn.
        const task = selectedWorker();
        history.push(text); historyIndex = -1; scroll = 0;
        if (reducers.TERMINAL.has(reducers.tasks(session.events)[task]?.state)) throw new Error('This worker has finished · Tab selects the orchestrator');
        session.append({kind: 'message', to: `worker:${task}`, text: expandVendorCommand(text, vendorOptions())?.prompt ?? text});
        notice = `Message queued for worker ${task.slice(0, 8)}`;
      } else {
        history.push(text); historyIndex = -1; scroll = 0;
        const expanded = text.startsWith('/') ? expandVendorCommand(text, vendorOptions()) : null;
        notice = expanded ? `Running /${expanded.name} (${expanded.origin}) · Esc or Ctrl+C cancels the agent process group` : 'Running · Esc or Ctrl+C cancels the agent process group';
        render(); const result = await router.run((remoteMain ? '' : orchestratorBrief) + withAsides(expanded?.prompt ?? text, asides.splice(0)), [], expanded ? {typed: text} : {});
        // A queued send the user pulled back (Up) settles as 'withdrawn': the withdraw's own notice stands.
        if (result !== 'withdrawn') notice = `Turn ${result}. Session saved.`;
        suggestion = result === 'completed' && !input ? suggestionFrom(lastAnswer(session.events)) : null;
        void refreshQuota(settings, {root, store: quotas, cwd: session.cwd}).then(render, () => {});
        if (dev && result === 'completed' && fingerprint() !== loadedFingerprint) await restart();
      }
    } catch (e) {
      notice = e.message;
      if (!input) { input = text; inputCursor = input.length; }
    }
    finally {
      waitingOnQueuedTurn = false;
      if (!ownsTurn) { render(); return; }
      clearInterval(activityTimer); activityTimer = null; progress = '';
      const next = pendingTurns.shift();
      if (next) {
        notice = pendingTurns.length ? `Starting queued turn · ${pendingTurns.length} still queued` : 'Starting queued turn';
        render();
        const decision = inputDisposition(next, {busy: false, vendorCommand});
        void submit(next, {parsedCommand: decision.kind === 'turn' ? decision : null});
      } else {
        busy = false;
        render();
      }
    }
  }
  // A terminal reports either the whole mouse or none of it: wheel scrolling and native
  // click-drag selection cannot both be live. Rather than let a click do nothing, answer it
  // with the three ways to select text.
  const selectionHint = 'Drag-select needs the mouse back · hold Option (Shift in most terminals) to select now · F3 turns wheel scrolling off · F2 pauses so copied lines carry the transcript alone';
  function handleKey(str, key = {}) {
    if (suspended) return;
    if (key.name === 'f2') {
      copyPaused = !copyPaused;
      render();
      return;
    }
    if (copyPaused && !(key.ctrl && key.name === 'c')) return;
    if (localSetup && !picker && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {cancelLocalSetup(); return;}
    if (key.name === 'f3') {
      mouseScroll = !mouseScroll;

      notice = mouseScroll
        ? 'Mouse scrolling on · Option-drag (Shift-drag elsewhere) still selects · F3 restores plain drag-select and link clicks'
        : 'Mouse scrolling off · Drag to select text / click links · PgUp/PgDn scroll · F3 restores the wheel';
      render(); return;
    }
    if (key.ctrl && key.name === 'c') { if (busy) {void Promise.resolve(router.cancel()).catch(error => { notice = error.message; render(); }); notice = 'Cancelling…'; render();} else quit(); return; }
    if (key.ctrl && key.name === 'o') { if (picker?.kind === 'operation') picker = null; else openOperationPicker(); render(); return; }
    if (key.name === 'pageup') {if (localSetup) localSetup.scroll = (localSetup.scroll ?? 0) + 8; else scroll += 8; render(); return;}
    if (key.name === 'pagedown') {if (localSetup) localSetup.scroll = Math.max(0, (localSetup.scroll ?? 0) - 8); else scroll = Math.max(0, scroll - 8); render(); return;}
    if (picker) {
      const move = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
      if (move) picker.index = (picker.index + move + picker.entries.length) % picker.entries.length;
      else if (key.name === 'escape') {const kind = picker.kind; picker = null; notice = kind === 'import' ? 'Import cancelled. Nothing changed.' : kind === 'operation' ? 'Operation unchanged.' : kind === 'session' ? 'Session unchanged.' : 'Model unchanged.';}
      else if (picker.kind === 'import') {
        if (str === ' ' || key.name === 'space') {picker.chosen.has(picker.index) ? picker.chosen.delete(picker.index) : picker.chosen.add(picker.index);}
        else if (str === 'a') for (let i = 0; i < picker.entries.length; i++) picker.chosen.add(i);
        else if (str === 'n') picker.chosen.clear();
        else if (key.name === 'return') applyImport();
      }
      else if (str && !key.ctrl && !key.meta && /^[1-9]$/.test(str) && Number(str) <= picker.entries.length) picker.index = Number(str) - 1;
      else if (key.name === 'return') {const entry = picker.entries[picker.index]; const kind = picker.kind; picker = null; if (kind === 'operation') applyOperation(entry); else if (kind === 'session') switchSession(entry.id).catch(e => { notice = e.message; render(); }); else applyModel(entry);}
      render(); return;
    }
    if (textPrompt) {
      if (key.name === 'escape') { textPrompt = null; input = ''; inputCursor = 0; notice = 'Cancelled · nothing changed'; render(); return; }
      if (key.name === 'return' || key.name === 'enter') {
        const prompt = textPrompt; const answer = input;
        textPrompt = null; input = ''; inputCursor = 0;
        void Promise.resolve(prompt.onAnswer(answer)).catch(error => { notice = error.message; render(); });
        render(); return;
      }
      if (key.name === 'backspace') ({input, cursor: inputCursor} = backspace(input, inputCursor));
      else if (key.ctrl && key.name === 'u') { input = ''; inputCursor = 0; }
      else if (str && !key.ctrl && !key.meta && !['left', 'right', 'up', 'down', 'home', 'end', 'delete', 'tab'].includes(key.name)) ({input, cursor: inputCursor} = insertText(input, inputCursor, clean(str).replace(/\s/g, '')));
      render(); return;
    }
    if (key.name === 'escape' && agentsOpen && !input) {agentsOpen = false; changePane('orchestrator'); notice = 'Agent workspace closed'; render(); return;}
    if (key.name === 'escape' && busy) {void Promise.resolve(router.cancel()).catch(error => { notice = error.message; render(); }); return;}
    // Enter alone submits; Shift+Enter — or any other modifier, or Ctrl+J — drops down a line.
    if (key.name === 'enter' || (key.name === 'return' && (key.meta || key.ctrl || key.shift))) {({input, cursor: inputCursor} = insertText(input, inputCursor, '\n')); menuDismissed = true; render(); return;}
    const options = suggestions();
    if (options.length && ['up', 'down'].includes(key.name)) {completionIndex = (completionIndex + (key.name === 'up' ? -1 : 1) + options.length) % options.length; render(); return;}
    if (suggestion && !input && key.name === 'tab') { input = suggestion; inputCursor = input.length; suggestion = null; render(); return; }
    if (suggestion && !key.ctrl && !key.meta && str && !['tab', 'up', 'down', 'left', 'right'].includes(key.name)) suggestion = null; // typing replaces it
    if (options.length && key.name === 'tab') {acceptCompletion(); render(); return;}
    if (localSetup && key.name === 'tab') {render(); return;}
    if (agentsOpen && key.name === 'tab') {
      const ids = paneIds();
      const current = Math.max(0, ids.indexOf(selectedAgentPane));
      changePane(ids[(current + (key.shift ? -1 : 1) + ids.length) % ids.length]);
      notice = selectedWorker() ? `Input targets worker ${selectedWorker().slice(0, 8)}` : 'Input targets the orchestrator';
      render(); return;
    }
    if (input.includes('\n') && ['up', 'down'].includes(key.name)) {
      ({cursor: inputCursor, column: verticalColumn} = moveVertical(input, inputCursor, key.name, verticalColumn));
      render(); return;
    }
    // Enter only completes a half-typed command; a complete one falls through and is run.
    if (options.length && key.name === 'return' && !typedCommand(input, vendorRows)) {acceptCompletion(); render(); return;}
    if (key.name === 'escape') {menuDismissed = true; render(); return;}
    const beforeInput = input;
    verticalColumn = null;
    if (key.name === 'return') {
      if (localSetup && !input.trim().startsWith('/')) {
        if (localSetup.answer(input.trim())) {input = ''; inputCursor = 0;}
        else notice = 'Setup is working · keep editing, use a slash command, or Esc to cancel setup';
        render(); return;
      }
      const text = input.trim(); input = ''; inputCursor = 0;
      if (text) {
        const decision = inputDisposition(text, {busy, vendorCommand});
        if (agentsOpen && selectedWorker() && decision.kind === 'prompt') {
          void submit(text, {ownsTurn: false});
        } else if (decision.kind === 'lifecycle' && busy) {
          notice = `/${decision.command} cannot change the session while a turn is active · cancel it first`;
        } else if (decision.action === 'run-command') {
          void submit(text, {parsedCommand: decision, ownsTurn: false});
        } else if (decision.action === 'queue-turn' && (!attachedTurn || waitingOnQueuedTurn)) {
          // Either this view already owns the turn that is running, or it already sent its own
          // reply behind the attached turn (waitingOnQueuedTurn) and a further prompt must wait
          // its turn too — the daemon client can only track one request in flight at a time.
          // Queued locally, drained once the in-flight turn ends (the keyboard turn's own finally
          // below).
          pendingTurns.push(text); historyIndex = -1;
          notice = `Queued · ${pendingTurns.length} turn${pendingTurns.length === 1 ? '' : 's'} waiting`;
        } else {
          // A fresh turn, or the FIRST prompt typed while an attached (daemon-started) turn is
          // current and this view has not sent its own reply yet: send it through the normal
          // keyboard turn path right now (U5a: the only place a main turn starts). main-service.js
          // queues a USER prompt server-side when it lands while a run is current, so this is
          // never lost and never races the foreign turn for the daemon's slot.
          if (attachedTurn) waitingOnQueuedTurn = true;
          busy = true;
          void submit(text, {parsedCommand: decision.kind === 'turn' ? decision : null});
          if (attachedTurn) notice = 'Queued · runs when the current turn ends';
        }
      }
    }
    else if (key.name === 'left') inputCursor = (key.ctrl || key.meta) ? moveWord(input, inputCursor, 'left') : moveCursor(input, inputCursor, 'left');
    else if (key.name === 'right') inputCursor = (key.ctrl || key.meta) ? moveWord(input, inputCursor, 'right') : moveCursor(input, inputCursor, 'right');
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) inputCursor = moveLineStart(input, inputCursor);
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) inputCursor = moveLineEnd(input, inputCursor);
    else if (key.name === 'backspace') ({input, cursor: inputCursor} = (key.ctrl || key.meta) ? deleteWordBackward(input, inputCursor) : backspace(input, inputCursor));
    else if (key.name === 'delete') ({input, cursor: inputCursor} = (key.ctrl || key.meta) ? deleteWordForward(input, inputCursor) : deleteForward(input, inputCursor));
    else if (key.ctrl && key.name === 'u') { input = ''; inputCursor = 0; }
    else if (key.name === 'tab') {const i = settings.order.indexOf(selected()); router.select(settings.order[(i + 1) % settings.order.length]);}
    else if (key.name === 'up' && !input.includes('\n')) {
      const ownQueued = remoteMain && !input ? reducers.queuedPrompts(session.events) : [];
      if (ownQueued.length) {
        // Like Claude Code: Up on an empty input pulls the most recent still-queued prompt back
        // for editing instead of recalling history. This only withdraws a queued prompt; it never
        // starts a turn, so it needs no new submission call site (CONTRACT U5a).
        const latest = ownQueued.at(-1);
        void Promise.resolve(router.withdraw(latest.requestId)).then(result => {
          if (result.withdrawn) { input = result.text; inputCursor = input.length; notice = 'Pulled back for editing · Enter resends, clear to cancel'; }
          else notice = 'already started — cannot withdraw';
          render();
        }).catch(error => { notice = error.message; render(); });
      } else if (!localSetup) {
        historyIndex = Math.min(history.length - 1, historyIndex + 1); input = history[history.length - 1 - historyIndex] || ''; inputCursor = input.length;
      }
    }
    else if (key.name === 'down' && !input.includes('\n')) {if (!localSetup) {historyIndex = Math.max(-1, historyIndex - 1); input = historyIndex < 0 ? '' : history[history.length - 1 - historyIndex]; inputCursor = input.length;}}
    else if (str && !key.ctrl && !key.meta && !['left','right','home','end','delete','escape'].includes(key.name)) ({input, cursor: inputCursor} = insertText(input, inputCursor, clean(str).replace(/\n/g, ' ')));
    if (input !== beforeInput) {completionIndex = 0; menuDismissed = false;}
    render();
  }
  terminal = createInkTerminal({
    history: () => session.events,
    stdin: process.stdin, stdout: process.stdout, onKeypress: handleKey,
    onPaste: text => {
      if (suspended || copyPaused || picker) return;
      ({input, cursor: inputCursor} = insertText(input, inputCursor, clean(text))); completionIndex = 0; menuDismissed = false; render();
    },
    onScrollClamp: (id, value) => {
      if (id === (agentsOpen ? selectedAgentPane : 'orchestrator')) scroll = value;
      const saved = paneInputs.get(id);
      if (saved) paneInputs.set(id, {...saved, scroll: value});
    },
    onScroll: amount => { if (!copyPaused) { scroll = Math.max(0, scroll + amount); render(); } },
    onPress: () => { if (suspended || copyPaused || !mouseScroll || notice === selectionHint) return; notice = selectionHint; render(); },
    onResize: render,
  });
  for (const event of session.events) terminal.ingest(event);
  await terminal.mount({mouseScroll});

  session.onEvent = scheduleRender;
  // Orchestrator sessions tick so the status glyphs move and the quiet times advance between events:
  // four times a second while the main worker or any agent is working, once a second at rest.
  // unref'd so it never keeps the process alive, and render() is a no-op while suspended.
  if (orchestration.operation === 'orchestrator') {
    let beat = 0;
    const t = setInterval(() => { const working = busy || (terminal?.snapshot().panes ?? []).some(pane => pane.state === 'running'); if (working || ++beat % 4 === 0) render(); }, 250);
    t.unref?.();
  }
  void refreshQuota(settings, {root, store: quotas, cwd: session.cwd}).then(render, () => {});
  // Nothing else refreshes the sidebar while the TUI sits idle between turns: without this, a
  // reading shown on open just grows stale until the next turn or /quota. Checked once a minute,
  // unref'd so it never keeps the process alive.
  const quotaAgeTimer = setInterval(() => {
    const oldest = Math.min(...quotaOrder().map(p => Date.parse(quotas[p]?.time ?? 0) || 0));
    if (Date.now() - oldest > 10 * 60000) void refreshQuota(settings, {root, store: quotas, cwd: session.cwd}).then(render, () => {});
  }, 60000);
  quotaAgeTimer.unref?.();

  process.on('SIGTERM', () => { if (busy) {router.cancel(); const timer = setInterval(() => {if (!busy) {clearInterval(timer); quit();}}, 100);} else quit(); });
  process.on('exit', () => { clearInterval(quotaAgeTimer); terminal?.unmount(); });
  enter();
  if (!dev && process.env.BOUNCE_NO_UPDATE_CHECK !== '1') {
    void globalInstall().then(() => checkUpdate({root})).then(release => {
      if (release.available) {
        session.append({kind: 'status', text: `Update available: ${version} → ${release.latest}. Run /update.`});
        render();
      }
    }).catch(() => {});
  }
}
// publish/wait are one-process bridge commands for workers: handled here, before any
// session/config machinery, so they never spawn a supervisor and never read config.json.
async function runBridge() {
  const {bridgeCommand} = await import('./bridge.js');
  const {stdout, exitCode} = await bridgeCommand(process.argv.slice(2), process.env);
  process.stdout.write(stdout);
  process.exitCode = exitCode;
}
const [bridgeCmd] = process.argv.slice(2);
// `agents` is a bridge command too: the orchestrator's CLI defines the team and journals it over
// the grant it holds. The supervisor strips the bus grant from every plain child it spawns, so
// this must run in-process, like publish/wait/report — it reads config but never a session.
(['publish', 'wait', 'report'].includes(bridgeCmd) ? runBridge()
  : ['agents', 'mcp-serve'].includes(bridgeCmd) ? main()
  : process.env.BOUNCE_SUPERVISED === '1' && typeof process.send === 'function' ? main() : supervise()
).catch(error => {console.error(`bounce: ${error.message}`); process.exitCode = 1;});
