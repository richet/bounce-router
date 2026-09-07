#!/usr/bin/env node
import {resolveExecutable} from './executable.js';
import {PassThrough} from 'node:stream';
import {completions, frameDiff, createMouseInput, mouseTracking, createPasteInput, inputLayout, windowAround, modelRows} from './terminal.js';
import {modelCatalog, modelEntries, catalogNotes} from './models.js';
import {clean, createFormatter, createTranscriptRenderer, activeModel} from './format.js';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {emitKeypressEvents} from 'node:readline';
import {parseArgs} from 'node:util';
import {Session, Router, config, saveJSON, dataRoot} from './core.js';
import {providers} from './providers.js';
import {projectRoot, fingerprint, validate, supervise} from './reload.js';

const help = `localrouter — one terminal, your coding agents

  localrouter [--cwd PATH] [--resume ID] [--provider NAME] [--model ID]
  localrouter run "prompt" [--image PATH ...] [--cwd PATH] [--json] [--mode yolo|plan]
  localrouter login claude|codex|muse
  localrouter models [--json]
  localrouter sessions
  localrouter doctor
  localrouter dev        Improve localrouter itself; validate/reload after changes

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
  /retry                Clear locally recorded quota cooldowns
  /restart              Test and reload updated code, keeping this session
  /help                 Show commands
  /quit                 Exit (Esc cancels an active turn)

Drop PNG/JPEG/GIF/WebP files into your prompt, then press Enter to send.

Keys: / command picker · Tab complete (or next agent) · F2 pause for copying
      Enter send · Alt+Enter newline · Mouse wheel / PgUp/PgDn scroll · ↑/↓ prompt history
      Ctrl+C cancel turn / exit when idle · Ctrl+U clear input

Node.js 22+. Config and journals: LOCALROUTER_HOME or ~/.localrouter.
YOLO disables provider approvals/sandboxing. Native CLI credentials stay with vendors.
Model names are passed through to each CLI; remaining subscription quota is unknown.
`;
const login = (provider, settings, cwd) => new Promise((resolve, reject) => {
  if (!providers[provider]) return reject(new Error('Choose claude, codex, or muse'));
  const child = spawn(resolveExecutable(provider, settings.executables[provider]), providers[provider].login, {cwd, stdio: 'inherit'});
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Login exited ${code}`)));
});
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
  }});
  if (values.help) return console.log(help);
  if (values.version) return console.log('localrouter 0.1.0');
  const restarted = process.env.LOCALROUTER_RESTART ? JSON.parse(process.env.LOCALROUTER_RESTART) : null;
  delete process.env.LOCALROUTER_RESTART;
  const dev = restarted?.dev ?? positionals[0] === 'dev';
  const root = dataRoot(), settings = restarted?.settings ?? config(root), cwd = fs.realpathSync(dev ? projectRoot : values.cwd || process.cwd());
  if (values.provider && !restarted) {
    if (!providers[values.provider]) throw new Error('Unknown provider');
    settings.order = [values.provider, ...settings.order.filter(p => p !== values.provider)];
  }
  if (values.mode && !restarted) { if (!['yolo', 'plan'].includes(values.mode)) throw new Error('Mode must be yolo or plan'); settings.mode = values.mode; }
  if (values.model && !restarted) settings.models[settings.order[0]] = values.model;
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
  if (positionals[0] === 'doctor') {
    console.log(`Workspace: ${cwd}\nData: ${root}\nMode: ${settings.mode}\nOrder: ${settings.order.join(' → ')}`);
    for (const provider of Object.keys(providers)) {
      await new Promise(resolve => {
        const child = spawn(resolveExecutable(provider, settings.executables[provider]), ['--version'], {stdio: ['ignore', 'pipe', 'pipe']});
        let out = ''; child.stdout.on('data', d => {out += d;});
        child.stderr.resume();
        const timer = setTimeout(() => child.kill(), 5000);
        child.once('error', e => { console.log(`${provider}: ${e.message}`); });
        child.once('close', code => {clearTimeout(timer); console.log(`${provider} (${resolveExecutable(provider, settings.executables[provider])}): ${code === 0 ? clean(out.trim()) : 'not available'} · quota unknown`); resolve();});
      });
    }
    return;
  }
  if (positionals.length && !['run', 'dev'].includes(positionals[0])) throw new Error('Unknown command. Use --help.');
  if (positionals[0] !== 'run' && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('TUI requires a terminal. Use localrouter run "prompt" for headless execution.');
  if (positionals[0] === 'run' && !positionals.slice(1).join(' ').trim()) throw new Error('Provide a prompt: localrouter run "prompt"');
  let session = new Session(cwd, {root, id: restarted?.id ?? values.resume});
  session.lock();
  let router = new Router(session, settings);
  if (restarted?.provider || values.provider) session.active = restarted?.provider || values.provider;
  process.on('exit', () => session.unlock?.());
  if (positionals[0] === 'run') {
    session.onEvent = e => {
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
  let activityTimer, activityStarted = 0, progress = '';
  const activity = () => `${['◐', '◓', '◑', '◒'][Math.floor((Date.now() - activityStarted) / 150) % 4]} Working · ${Math.floor((Date.now() - activityStarted) / 1000)}s`;
  let loadedFingerprint = fingerprint();
  let completionIndex = 0, menuDismissed = false, copyPaused = false, previousFrame = [], previousCursor = '';
  let picker = null;
  const suggestions = () => menuDismissed ? [] : completions(input);
  const acceptCompletion = () => {const options = suggestions(); if (options.length) {input = '/' + options[completionIndex % options.length][0] + ' '; completionIndex = 0; menuDismissed = false; return true;} return false;};
  let notice = 'Ready. /help for commands. Quota is unknown until a provider reports exhaustion.';
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
  function render() {
    if (suspended || copyPaused) return;
    const width = Math.max(4, (process.stdout.columns || 80) - 2);
    const terminalRows = process.stdout.rows || 24;
    const draft = inputLayout(input, width - 2, Math.max(1, Math.min(Math.floor(terminalRows / 3), terminalRows - 10)));
    const options = suggestions();
    const menuBudget = Math.max(0, terminalRows - 10 - draft.rows.length);
    const plain = s => s;
    const menu = [];
    if (picker) {
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
      menu.push(['↑/↓ choose · Tab/Enter complete · Esc dismiss', style.muted]);
    }
    menu.length = Math.min(menu.length, menuBudget);
    const bodyHeight = Math.max(1, terminalRows - 9 - draft.rows.length - menu.length);
    const rows = transcriptRows(session.events, width);
    scroll = Math.min(scroll, Math.max(0, rows.length - bodyHeight));
    const end = rows.length - scroll;
    const body = rows.slice(Math.max(0, end - bodyHeight), end);
    while (body.length < bodyHeight) body.push('');
    const line = '─'.repeat(width);
    const header = [
      style.title(' LOCALROUTER') + style.muted('  /  your agents, one conversation'),
      `${selected()} · Model: ${activeModel(session.events, selected(), settings.models[selected()])} · ${settings.mode.toUpperCase()}${settings.mode === 'yolo' ? ' (approvals + sandbox bypassed)' : ''} · ${busy ? 'RUNNING' : 'READY'}`,
      `${session.cwd} · session ${session.id.slice(0, 8)}`,
      settings.order.map(p => `${p}${router.cooldowns[p] > Date.now() ? ' [cooldown]' : ''}`).join(' → '), line,
    ];
    const nextFrame = [
      ...header.map((s, i) => clip(i === 0 ? s : (i === 1 ? style.status : style.muted)(clean(s)), width)),
      ...body, ...menu.map(([text, paint]) => clip(paint(clean(text)), width)),
      style.muted(line),
      ...draft.rows.map((row, i) => style.prompt(i === 0 ? '❯ ' : '  ') + row),
      style.muted(line), clip(style.status(clean(busy && activityTimer ? [activity(), progress, notice].filter(Boolean).join(' · ') : notice)), width),
    ];
    const update = frameDiff(previousFrame, nextFrame);
    const cursor = busy ? '\x1b[?25l' : `\x1b[${header.length + body.length + menu.length + 2 + draft.cursorRow};${3 + draft.cursorColumn}H\x1b[1 q\x1b[?25h`;
    if (update || cursor !== previousCursor) process.stdout.write((update ? '\x1b[?25l' + update : '') + cursor);
    previousCursor = cursor;
    previousFrame = nextFrame;
  }
  let renderTimer;
  function scheduleRender(event) {
    if (event?.kind === 'progress') progress = clean(event.text);
    if (event?.kind === 'raw' || renderTimer) return;
    renderTimer = setTimeout(() => {renderTimer = null; render();}, 40);
  }
  const enter = () => { suspended = false; previousFrame = []; previousCursor = ''; process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[?2004h' + mouseTracking(!copyPaused)); render(); };
  const leave = () => { suspended = true; process.stdin.setRawMode(false); process.stdout.write(mouseTracking(false) + '\x1b[?2004l\x1b[0 q\x1b[?25h\x1b[?1049l'); };
  async function restart() {
    notice = 'Validating updated code…'; render();
    await validate(projectRoot, text => session.append({kind: 'status', text}));
    session.append({kind: 'status', text: 'Validation passed. Restarting into updated code.'});
    const state = {id: session.id, settings, provider: selected(), dev};
    await new Promise((resolve, reject) => process.send({type: 'restart', state}, error => error ? reject(error) : resolve()));
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
        } else if (command === 'retry') {
          router.cooldowns = {}; for (const p of Object.keys(providers)) session.append({kind: 'cooldown', provider: p, until: 0, text: 'Local cooldown cleared'});
        } else if (command === 'note') {
          if (!arg) throw new Error('Use /note TEXT'); session.append({kind: 'note', text: arg});
        } else if (command === 'new') {
          const next = new Session(session.cwd, {root}); next.lock(); session.unlock(); session = next;
          router = new Router(session, settings); session.onEvent = scheduleRender; scroll = 0;
        } else if (command === 'login') {
          leave(); try { await login(arg || selected(), settings, session.cwd); } finally {enter();}
        } else throw new Error('Unknown command. Type /help');
        notice = 'Updated.';
      } else {
        history.push(text); historyIndex = -1; scroll = 0;
        notice = 'Running · Esc or Ctrl+C cancels the agent process group';
        render(); const result = await router.run(text); notice = `Turn ${result}. Session saved.`;
        if (dev && result === 'completed' && fingerprint() !== loadedFingerprint) await restart();
      }
    } catch (e) {notice = e.message; if (!input) input = text;}
    finally {clearInterval(activityTimer); activityTimer = null; busy = false; progress = ''; render();}
  }
  const keyboard = new PassThrough();
  // Node's keypress parser holds a lone ESC until another byte follows, so deliver it directly.
  const toKeyboard = text => text === '\x1b' ? handleKey('\x1b', {name: 'escape'}) : keyboard.write(text);
  const mouseInput = createMouseInput(toKeyboard, amount => {
    if (suspended || copyPaused) return;
    scroll = Math.max(0, scroll + amount); render();
  });
  const pasteInput = createPasteInput(text => mouseInput(text), text => {
    if (busy || suspended || copyPaused || picker) return;
    input += clean(text);
    completionIndex = 0; menuDismissed = false; render();
  });
  let mouseTimer;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (suspended) return;
    clearTimeout(mouseTimer);
    pasteInput(chunk);
    mouseTimer = setTimeout(() => {pasteInput.flush(); mouseInput.flush();}, 50);
  });
  function handleKey(str, key = {}) {
    if (suspended) return;
    if (key.name === 'f2') {
      copyPaused = !copyPaused;
      process.stdout.write(mouseTracking(!copyPaused));
      if (copyPaused) {
        process.stdout.write('\x1b[?25l');
        previousCursor = '';
        const row = Math.max(1, previousFrame.length);
        process.stdout.write(`\x1b[${row};1H\x1b[2KDisplay paused — select and copy text; F2 resumes.`);
        previousFrame[row - 1] = '';
      } else render();
      return;
    }
    if (copyPaused && !(key.ctrl && key.name === 'c')) return;
    if (key.ctrl && key.name === 'c') { if (busy) {router.cancel(); notice = 'Cancelling…'; render();} else quit(); return; }
    if (key.name === 'escape' && busy) {router.cancel(); return;}
    if (key.name === 'pageup') {scroll += 8; render(); return;}
    if (key.name === 'pagedown') {scroll = Math.max(0, scroll - 8); render(); return;}
    if (picker) {
      const move = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
      if (move) picker.index = (picker.index + move + picker.entries.length) % picker.entries.length;
      else if (str && !key.ctrl && !key.meta && /^[1-9]$/.test(str) && Number(str) <= picker.entries.length) picker.index = Number(str) - 1;
      else if (key.name === 'escape') {picker = null; notice = 'Model unchanged.';}
      else if (key.name === 'return') {const entry = picker.entries[picker.index]; picker = null; applyModel(entry);}
      render(); return;
    }
    if (busy) return;
    if (key.name === 'return' && key.meta) {input += '\n'; menuDismissed = true; render(); return;}
    const options = suggestions();
    if (options.length && ['up', 'down'].includes(key.name)) {completionIndex = (completionIndex + (key.name === 'up' ? -1 : 1) + options.length) % options.length; render(); return;}
    if (options.length && ['tab', 'return'].includes(key.name)) {acceptCompletion(); render(); return;}
    if (key.name === 'escape') {menuDismissed = true; render(); return;}
    const beforeInput = input;
    if (key.name === 'return') {const text = input.trim(); input = ''; if (text) {busy = true; void submit(text);} }
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
  process.stdout.on('resize', render);
  process.on('SIGTERM', () => { if (busy) {router.cancel(); const timer = setInterval(() => {if (!busy) {clearInterval(timer); quit();}}, 100);} else quit(); });
  process.on('exit', () => { if (!suspended) leave(); });
  enter();
}
(process.env.LOCALROUTER_SUPERVISED === '1' && typeof process.send === 'function' ? main() : supervise()).catch(error => {console.error(`localrouter: ${error.message}`); process.exitCode = 1;});
