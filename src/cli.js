#!/usr/bin/env node
import {login} from './login.js';
import {resolveExecutable} from './executable.js';
import {PassThrough} from 'node:stream';
import {completions, typedCommand, frameDiff, createMouseInput, mouseTracking, createPasteInput, createKeyInput, inputLayout, windowAround, modelRows, checklistRows, suspendTerminal, resumeTerminal} from './terminal.js';
import {modelCatalog, modelEntries, catalogNotes} from './models.js';
import {clean, createFormatter, createTranscriptRenderer, activeModel} from './format.js';
import {loadQuota, recordQuota, refreshQuota, quotaSnapshot, quotaShort, quotaReport, quotaUnavailable} from './quota.js';
import {skillsCommand, syncSkills, inspectSkills, skillsChanged, importCandidates, importSelected, importSummary, syncSummary, skillAreas} from './skills.js';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {emitKeypressEvents} from 'node:readline';
import {parseArgs} from 'node:util';
import {Session, Router, config, saveJSON, dataRoot} from './core.js';
import {providers} from './providers.js';
import {projectRoot, fingerprint, validate, supervise} from './reload.js';
import {version, checkUpdate, globalInstall, installUpdate} from './update.js';
import {BOUNCE_LOGO} from './logo.js';

const help = `bounce — one terminal, your coding agents

  bounce [--cwd PATH] [--resume ID] [--provider NAME] [--model ID]
  bounce run "prompt" [--image PATH ...] [--cwd PATH] [--json] [--mode yolo|plan]
  bounce login claude|codex|muse
  bounce models [--json]
  bounce quota [--json]
  bounce skills [list|sync|new NAME|add PATH|remove NAME|import [NAME] [--list]|clear|reset] [--scope user|project]
  bounce sessions
  bounce doctor
  bounce update [--check]  Check for or install the latest npm release
  bounce dev        Improve bounce itself; validate/reload after changes

TUI commands:
  /provider NAME        Select and save the default agent
  /model                Pick from every model your signed-in agents report
  /model ID             Set selected agent's model; "default" resets
  /model refresh        Re-ask each agent for its catalog, then pick
  /order claude,codex,muse  Save the fallback order
  /mode yolo|plan       YOLO default; plan uses restrictive provider flags
  /login NAME           Open the vendor's native login flow
  /new                  Start a new session in this workspace
  /note TEXT            Save a durable handoff note
  /skills               List bounce skills and where each agent has them
  /skills sync          Install them into every agent's skills directory
  /skills new NAME      Scaffold a SKILL.md under ~/.bounce/skills
  /skills add PATH      Adopt a skill folder or SKILL.md into bounce
  /skills remove NAME   Delete it from bounce and from every agent
  /skills import [NAME] Pick from the skills an agent already has
  /skills clear         Remove every copy bounce installed
  /skills reset         Delete every bounce skill and withdraw its copies
  /quota                Show the subscription usage each agent reports
  /retry                Clear locally recorded quota cooldowns
  /update [check]       Install the latest npm release, or only check
  /restart              Test and reload updated code, keeping this session
  /help                 Show commands
  /quit                 Exit (Esc cancels an active turn)

Drop PNG/JPEG/GIF/WebP files into your prompt, then press Enter to send.

Keys: / command picker · Tab complete (or next agent) · F2 pause for copying
      Enter send · Shift+Enter newline (Alt+Enter and Ctrl+J too)
      PgUp/PgDn scroll · F3 toggle mouse scrolling · ↑/↓ prompt history
      Ctrl+C cancel turn / exit when idle · Ctrl+U clear input

You can keep typing while an agent works. Press Enter to queue each next message.

Node.js 22+. Config and journals: BOUNCE_HOME or ~/.bounce.
YOLO disables provider approvals/sandboxing. Native CLI credentials stay with vendors.
Model names are passed through to each CLI. Quota comes from the agents themselves:
Codex answers on demand, Claude reports its windows while a turn runs, Muse reports none.
`;
function listSessions(root) {
  const dir = path.join(root, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(id => {
    try { const s = new Session(process.cwd(), {root, id}); return [{id, cwd: s.cwd, updated: s.events.at(-1)?.time, prompt: s.events.find(e => e.kind === 'user')?.text?.slice(0, 80) ?? '(empty)'}]; }
    catch { return []; }
  }).sort((a,b) => b.updated.localeCompare(a.updated));
}
async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    image: {type: 'string', multiple: true}, cwd: {type: 'string'}, resume: {type: 'string'}, provider: {type: 'string'}, model: {type: 'string'},
    mode: {type: 'string'}, json: {type: 'boolean'}, help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'},
    check: {type: 'boolean'}, scope: {type: 'string'}, force: {type: 'boolean'}, list: {type: 'boolean'}, all: {type: 'boolean'},
  }});
  if (values.help) return console.log(help);
  if (values.version) return console.log(`bounce ${version}`);
  const restarted = process.env.BOUNCE_RESTART ? JSON.parse(process.env.BOUNCE_RESTART) : null;
  delete process.env.BOUNCE_RESTART;
  const dev = restarted?.dev ?? positionals[0] === 'dev';
  const root = dataRoot(), settings = restarted?.settings ?? config(root), cwd = fs.realpathSync(dev ? projectRoot : values.cwd || process.cwd());
  if (values.provider && !restarted) {
    if (!providers[values.provider]) throw new Error('Unknown provider');
    settings.order = [values.provider, ...settings.order.filter(p => p !== values.provider)];
  }
  if (values.mode && !restarted) { if (!['yolo', 'plan'].includes(values.mode)) throw new Error('Mode must be yolo or plan'); settings.mode = values.mode; }
  if (values.model && !restarted) settings.models[settings.order[0]] = values.model;
  if (positionals[0] === 'update') {
    if (values.check) {
      const release = await checkUpdate({root, force: true});
      return console.log(release.available ? `Update available: ${version} → ${release.latest}. Run bounce update.` : `Bounce ${version} is up to date.`);
    }
    return console.log(await installUpdate({root}));
  }
  if (positionals[0] === 'login') return login(positionals[1], settings, cwd);
  if (positionals[0] === 'sessions') return console.log(JSON.stringify(listSessions(root), null, 2));
  if (positionals[0] === 'models') {
    const catalogs = await modelCatalog(settings, {maxAge: 0});
    if (values.json) return console.log(JSON.stringify(catalogs, null, 2));
    for (const catalog of catalogs) {
      console.log(`${catalog.provider}${catalog.account ? ` (${catalog.account})` : ''}: ${catalog.error ?? `${catalog.models.length} models`}`);
      for (const model of catalog.models) console.log(`  ${model.id === settings.models[catalog.provider] ? '✓' : ' '} ${model.id}  ${clean(model.description)}`);
    }
    return;
  }
  if (positionals[0] === 'quota') {
    const store = await refreshQuota(settings, {root, cwd});
    if (values.json) return console.log(JSON.stringify(store, null, 2));
    return console.log(quotaReport(store, settings.order));
  }
  if (positionals[0] === 'skills') {
    const options = {root, scope: values.scope || settings.skills.scope, cwd, base: process.cwd()};
    const {text, report} = skillsCommand([...positionals.slice(1), ...(values.force ? ['--force'] : []), ...(values.list ? ['--list'] : [])], options);
    return console.log(values.json ? JSON.stringify(report ?? inspectSkills(options), null, 2) : text);
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
  let skillNotice = '';
  if (settings.skills.autoSync) {
    try { if (skillsChanged(syncSkills({root, scope: settings.skills.scope, cwd}))) skillNotice = 'Skills installed to your agents.'; }
    catch (error) { skillNotice = `Skills not synced: ${error.message}`; }
  }
  let session = new Session(cwd, {root, id: restarted?.id ?? values.resume});
  session.lock();
  let router = new Router(session, settings);
  if (restarted?.provider || values.provider) session.active = restarted?.provider || values.provider;
  process.on('exit', () => session.unlock?.());
  // Quota readings survive restarts, so the display starts with the last known usage.
  const quotas = loadQuota(root);
  if (positionals[0] === 'run') {
    if (skillNotice && !values.json) console.log(`[router:skills] ${skillNotice}`);
    session.onEvent = e => {
      if (e.kind === 'raw') recordQuota(quotas, root, quotaSnapshot(e.provider, e.raw));
      if (values.json) console.log(JSON.stringify(e));
      else if (e.text && !['raw', 'usage', 'progress'].includes(e.kind)) console.log(`[${e.provider || 'router'}:${e.kind}] ${clean(e.text)}`);
    };
    const cancel = () => router.cancel();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    try { const result = await router.run(positionals.slice(1).join(' '), values.image || []); process.exitCode = result === 'completed' ? 0 : result === 'cancelled' ? 130 : 1; }
    finally { session.unlock(); process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
    return;
  }
  let input = '', busy = false, suspended = false, scroll = 0, historyIndex = -1;
  const pending = [];
  let activityTimer, activityStarted = 0, progress = '';
  const activity = () => `${['◐', '◓', '◑', '◒'][Math.floor((Date.now() - activityStarted) / 150) % 4]} Working · ${Math.floor((Date.now() - activityStarted) / 1000)}s`;
  let loadedFingerprint = fingerprint();
  let completionIndex = 0, menuDismissed = false, copyPaused = false, previousFrame = [], previousCursor = '';
  let mouseScroll = false;
  let picker = null;
  const suggestions = () => menuDismissed ? [] : completions(input);
  const acceptCompletion = () => {const options = suggestions(); if (options.length) {input = '/' + options[completionIndex % options.length][0] + ' '; completionIndex = 0; menuDismissed = false; return true;} return false;};
  let notice = [restarted?.updateNotice, skillNotice, 'Ready. Select text / open links with your terminal. F2 pause · F3 mouse scroll · /help'].filter(Boolean).join(' ');
  const history = session.events.filter(e => e.kind === 'user').map(e => e.text);
  const selected = () => session.active || settings.order[0];
  const save = () => saveJSON(path.join(root, 'config.json'), settings);
  const {style, clip, event: formatEvent} = createFormatter();
  const transcriptRows = createTranscriptRenderer(formatEvent);
  // Picking a model also picks the agent that reported it.
  const applyModel = entry => {
    session.active = entry.provider;
    settings.order = [entry.provider, ...settings.order.filter(p => p !== entry.provider)];
    settings.models[entry.provider] = entry.id;
    save();
    session.append({kind: 'status', text: `Model: ${entry.provider} · ${entry.label}${entry.id ? ` (${entry.id})` : ''}`});
    notice = `${entry.provider} · ${entry.label}. Saved as the default.`;
  };
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
      notes: found.filter(row => row.action === 'invalid').map(row => `${row.skill} (${row.provider}): ${row.detail}`),
      entryLabel: entry => `${entry.skill} (${entry.provider})${entry.action === 'exists' ? ' — already in bounce, replaces it' : ''}`,
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
  function render() {
    if (suspended || copyPaused) return;
    const width = Math.max(4, (process.stdout.columns || 80) - 2);
    const terminalRows = process.stdout.rows || 24;
    // The banner only earns its extra rows when the art fits the width and still
    // leaves the transcript, composer and status bar room; otherwise fall back to
    // the one-line title. Every budget below is measured from the header height,
    // so the bottom chrome stays on screen whichever banner is showing.
    const art = BOUNCE_LOGO.split('\n');
    const logoFits = width >= Math.max(...art.map(row => row.length)) && terminalRows >= art.length + 13;
    const headerRows = (logoFits ? art.length : 1) + 4;
    const draft = inputLayout(input, width - 2, Math.max(1, Math.min(Math.floor(terminalRows / 3), terminalRows - headerRows - 5)));
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
    }
    menu.length = Math.min(menu.length, menuBudget);
    const bodyHeight = Math.max(1, terminalRows - headerRows - 4 - draft.rows.length - menu.length);
    const rows = transcriptRows(session.events, width);
    scroll = Math.min(scroll, Math.max(0, rows.length - bodyHeight));
    const end = rows.length - scroll;
    const body = rows.slice(Math.max(0, end - bodyHeight), end);
    while (body.length < bodyHeight) body.push('');
    const line = '─'.repeat(width);
    const banner = logoFits ? art.map(row => style.title(row)) : [style.title(' BOUNCE')];
    const header = [
      ...banner,
      style.status(clean(`${selected()} · Model: ${activeModel(session.events, selected(), settings.models[selected()])} · ${settings.mode.toUpperCase()}${settings.mode === 'yolo' ? ' (approvals + sandbox bypassed)' : ''} · ${busy ? `RUNNING${pending.length ? ` · ${pending.length} QUEUED` : ''}` : 'READY'}`)),
      style.muted(clean(`${session.cwd} · session ${session.id.slice(0, 8)}`)),
      style.muted(clean(settings.order.map(p => `${p}${router.cooldowns[p] > Date.now() ? ' [cooldown]' : ''}${quotaShort(quotas[p]) ? ` (${quotaShort(quotas[p])})` : ''}`).join(' → '))),
      style.muted(line),
    ];
    const nextFrame = [
      ...header.map(s => clip(s, width)),
      ...body, ...menu.map(([text, paint]) => clip(paint(clean(text)), width)),
      style.muted(line),
      ...draft.rows.map((row, i) => style.prompt(i === 0 ? '❯ ' : '  ') + row),
      style.muted(line), clip(style.status(clean(busy && activityTimer ? [activity(), progress, notice].filter(Boolean).join(' · ') : notice)), width),
    ];
    const update = frameDiff(previousFrame, nextFrame);
    const cursor = `\x1b[${header.length + body.length + menu.length + 2 + draft.cursorRow};${3 + draft.cursorColumn}H\x1b[1 q\x1b[?25h`;
    if (update || cursor !== previousCursor) process.stdout.write((update ? '\x1b[?25l' + update : '') + cursor);
    previousCursor = cursor;
    previousFrame = nextFrame;
  }
  let renderTimer;
  function scheduleRender(event) {
    if (event?.kind === 'progress') progress = clean(event.text);
    // Vendor streams repeat quota many times per turn; only a changed reading redraws.
    if (event?.kind === 'raw' && !recordQuota(quotas, root, quotaSnapshot(event.provider, event.raw))) return;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {renderTimer = null; render();}, 40);
  }
  const enter = () => { suspended = false; previousFrame = []; previousCursor = ''; resumeTerminal(process.stdin, process.stdout, {mouse: mouseScroll && !copyPaused}); render(); };
  const leave = () => { suspended = true; suspendTerminal(process.stdin, process.stdout); };
  async function restart() {
    notice = 'Validating updated code…'; render();
    await validate(projectRoot, text => session.append({kind: 'status', text}));
    session.append({kind: 'status', text: 'Validation passed. Restarting into updated code.'});
    const state = {id: session.id, settings, provider: selected(), dev};
    await new Promise((resolve, reject) => process.send({type: 'restart', state}, error => error ? reject(error) : resolve()));
    leave(); session.unlock(); process.exit(75);
  }
  async function update(checkOnly) {
    const release = await checkUpdate({root, force: true});
    if (checkOnly || !release.available) {
      session.append({kind: 'status', text: release.available ? `Update available: ${version} → ${release.latest}. Run /update.` : `Bounce ${version} is up to date.`});
      return;
    }
    await globalInstall();
    const state = {id: session.id, settings, provider: selected(), dev};
    await new Promise((resolve, reject) => process.send({type: 'restart', state, update: true}, error => error ? reject(error) : resolve()));
    leave(); session.unlock(); process.exit(75);
  }
  const quit = () => { leave(); session.unlock(); process.exit(0); };
  async function submit(text) {
    activityStarted = Date.now(); progress = '';
    activityTimer = setInterval(render, 150);
    try {
      if (/^\/[a-z]+(?:\s|$)/i.test(text)) {
        const [command, ...parts] = text.slice(1).split(/\s+/); const arg = parts.join(' ');
        if (command === 'quit') return quit();
        if (command === 'update') {
          if (arg && arg !== 'check') throw new Error('Use /update or /update check');
          return await update(arg === 'check');
        }
        if (command === 'restart') return await restart();
        if (command === 'help') {session.append({kind: 'status', text: help}); return;}
        if (command === 'provider') {
          if (!providers[arg]) throw new Error('Choose claude, codex, or muse');
          session.active = arg; settings.order = [arg, ...settings.order.filter(p => p !== arg)]; save();
        } else if (command === 'model') {
          if (!arg || arg === 'refresh') { await openModelPicker(arg === 'refresh'); return; }
          settings.models[selected()] = arg === 'default' ? '' : arg; save();
        } else if (command === 'mode') {
          if (!['yolo','plan'].includes(arg)) throw new Error('Use /mode yolo or /mode plan'); settings.mode = arg; save();
        } else if (command === 'order') {
          const order = arg.split(',').map(p => p.trim());
          if (!order.length || order.some(p => !providers[p]) || new Set(order).size !== order.length) throw new Error('Use unique provider names separated by commas');
          settings.order = order; session.active = order[0]; save();
        } else if (command === 'quota') {
          await refreshQuota(settings, {root, store: quotas, cwd: session.cwd});
          session.append({kind: 'quota', text: quotaReport(quotas, settings.order)});
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
          const next = new Session(session.cwd, {root}); next.lock(); session.unlock(); session = next;
          router = new Router(session, settings); session.onEvent = scheduleRender; scroll = 0;
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
          return;
        } else throw new Error('Unknown command. Type /help');
        notice = 'Updated.';
      } else {
        history.push(text); historyIndex = -1; scroll = 0;
        notice = 'Running · Esc or Ctrl+C cancels the agent process group';
        render(); const result = await router.run(text); notice = `Turn ${result}. Session saved.`;
        void refreshQuota(settings, {root, store: quotas, cwd: session.cwd}).then(render, () => {});
        if (dev && result === 'completed' && fingerprint() !== loadedFingerprint) await restart();
      }
    } catch (e) {notice = e.message; if (!input) input = text;}
    finally {
      clearInterval(activityTimer); activityTimer = null; progress = '';
      const next = pending.shift();
      if (next) {
        notice = pending.length ? `Starting queued message · ${pending.length} still queued` : 'Starting queued message';
        render();
        void submit(next);
      } else {
        busy = false;
        render();
      }
    }
  }
  const keyboard = new PassThrough();
  // Node's keypress parser holds a lone ESC until another byte follows, so deliver it directly.
  const toKeyboard = text => text === '\x1b' ? handleKey('\x1b', {name: 'escape'}) : keyboard.write(text);
  // Asking the terminal to report Shift+Enter also re-encodes Ctrl+C, Escape and friends,
  // so decoded modifier keys are dispatched straight to handleKey; a modified Enter becomes
  // the event the prompt already treats as "newline, do not submit".
  const keyInput = createKeyInput(toKeyboard, () => handleKey('\r', {name: 'return', meta: true}), handleKey);
  const mouseInput = createMouseInput(keyInput, amount => {
    if (suspended || copyPaused || !mouseScroll) return;
    scroll = Math.max(0, scroll + amount); render();
  });
  const pasteInput = createPasteInput(text => mouseInput(text), text => {
    if (suspended || copyPaused || picker) return;
    input += clean(text);
    completionIndex = 0; menuDismissed = false; render();
  });
  let mouseTimer;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (suspended) return;
    clearTimeout(mouseTimer);
    pasteInput(chunk);
    mouseTimer = setTimeout(() => {pasteInput.flush(); mouseInput.flush(); keyInput.flush();}, 50);
  });
  function handleKey(str, key = {}) {
    if (suspended) return;
    if (key.name === 'f2') {
      copyPaused = !copyPaused;
      process.stdout.write(mouseTracking(mouseScroll && !copyPaused));
      if (copyPaused) {
        process.stdout.write('\x1b[?25l');
        previousCursor = '';
        const row = Math.max(1, previousFrame.length);
        process.stdout.write(`\x1b[${row};1H\x1b[2KPaused — select/copy or open links with your terminal; F2 resumes.`);
        previousFrame[row - 1] = '';
      } else render();
      return;
    }
    if (copyPaused && !(key.ctrl && key.name === 'c')) return;
    if (key.name === 'f3') {
      mouseScroll = !mouseScroll;
      process.stdout.write(mouseTracking(mouseScroll));
      notice = mouseScroll
        ? 'Mouse scrolling on · F3 restores text selection and link clicks · F2 pauses for copying'
        : 'Mouse scrolling off · Select text / open links with your terminal · PgUp/PgDn scroll';
      render(); return;
    }
    if (key.ctrl && key.name === 'c') { if (busy) {router.cancel(); notice = 'Cancelling…'; render();} else quit(); return; }
    if (key.name === 'escape' && busy) {router.cancel(); return;}
    if (key.name === 'pageup') {scroll += 8; render(); return;}
    if (key.name === 'pagedown') {scroll = Math.max(0, scroll - 8); render(); return;}
    if (picker) {
      const move = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
      if (move) picker.index = (picker.index + move + picker.entries.length) % picker.entries.length;
      else if (key.name === 'escape') {const kind = picker.kind; picker = null; notice = kind === 'import' ? 'Import cancelled. Nothing changed.' : 'Model unchanged.';}
      else if (picker.kind === 'import') {
        if (str === ' ' || key.name === 'space') {picker.chosen.has(picker.index) ? picker.chosen.delete(picker.index) : picker.chosen.add(picker.index);}
        else if (str === 'a') for (let i = 0; i < picker.entries.length; i++) picker.chosen.add(i);
        else if (str === 'n') picker.chosen.clear();
        else if (key.name === 'return') applyImport();
      }
      else if (str && !key.ctrl && !key.meta && /^[1-9]$/.test(str) && Number(str) <= picker.entries.length) picker.index = Number(str) - 1;
      else if (key.name === 'return') {const entry = picker.entries[picker.index]; picker = null; applyModel(entry);}
      render(); return;
    }
    // Enter alone submits; Shift+Enter — or any other modifier, or Ctrl+J — drops down a line.
    if (key.name === 'enter' || (key.name === 'return' && (key.meta || key.ctrl || key.shift))) {input += '\n'; menuDismissed = true; render(); return;}
    const options = suggestions();
    if (options.length && ['up', 'down'].includes(key.name)) {completionIndex = (completionIndex + (key.name === 'up' ? -1 : 1) + options.length) % options.length; render(); return;}
    if (options.length && key.name === 'tab') {acceptCompletion(); render(); return;}
    // Enter only completes a half-typed command; a complete one falls through and is run.
    if (options.length && key.name === 'return' && !typedCommand(input)) {acceptCompletion(); render(); return;}
    if (key.name === 'escape') {menuDismissed = true; render(); return;}
    const beforeInput = input;
    if (key.name === 'return') {
      const text = input.trim(); input = '';
      if (text) {
        if (busy) {
          pending.push(text); historyIndex = -1;
          notice = `Queued · ${pending.length} message${pending.length === 1 ? '' : 's'} waiting`;
        } else { busy = true; void submit(text); }
      }
    }
    else if (key.name === 'backspace') input = [...input].slice(0,-1).join('');
    else if (key.ctrl && key.name === 'u') input = '';
    else if (key.name === 'tab') {const i = settings.order.indexOf(selected()); session.active = settings.order[(i + 1) % settings.order.length];}
    else if (key.name === 'up') {historyIndex = Math.min(history.length - 1, historyIndex + 1); input = history[history.length - 1 - historyIndex] || '';}
    else if (key.name === 'down') {historyIndex = Math.max(-1, historyIndex - 1); input = historyIndex < 0 ? '' : history[history.length - 1 - historyIndex];}
    else if (str && !key.ctrl && !key.meta && !['left','right','home','end','delete','escape'].includes(key.name)) input += clean(str).replace(/\n/g, ' ');
    if (input !== beforeInput) {completionIndex = 0; menuDismissed = false;}
    render();
  }
  emitKeypressEvents(keyboard);
  keyboard.on('keypress', handleKey);
  session.onEvent = scheduleRender;
  void refreshQuota(settings, {root, store: quotas, cwd: session.cwd}).then(render, () => {});
  process.stdout.on('resize', render);
  process.on('SIGTERM', () => { if (busy) {router.cancel(); const timer = setInterval(() => {if (!busy) {clearInterval(timer); quit();}}, 100);} else quit(); });
  process.on('exit', () => { if (!suspended) leave(); });
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
(process.env.BOUNCE_SUPERVISED === '1' && typeof process.send === 'function' ? main() : supervise()).catch(error => {console.error(`bounce: ${error.message}`); process.exitCode = 1;});
