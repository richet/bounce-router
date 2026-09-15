import {createKeyInput, createMouseInput, createPasteInput, mouseTracking, resumeTerminal, suspendTerminal} from '../terminal.js';
import {createFormatter, paneGrid} from '../format.js';
import {PassThrough} from 'node:stream';
import {emitKeypressEvents} from 'node:readline';
import {createWorkspaceProjection} from './projection.js';
import {workspaceColumns} from './Workspace.js';
import {conversationEvents} from './transcript.js';

const EMPTY_VIEW = {agentsOpen: false, selectedId: 'orchestrator', input: '', scroll: 0, notice: '', menu: [], metadata: {}, busy: false, progress: '', columns: 80, rows: 24, sidebar: true};

// CLI owns commands, drafts and focus policy. This adapter owns terminal mode, parses input once,
// and turns the incremental event log projection into an Ink frame.
export function createInkTerminal({stdin = process.stdin, stdout = process.stdout, onKeypress = () => {}, onPaste = () => {}, onResize = () => {}, onScroll = () => {}, onPress = () => {}, onFrame = () => {}, history, projectionOptions} = {}) {
  const projection = createWorkspaceProjection(projectionOptions);
  let view = {...EMPTY_VIEW};
  let app = null;
  let mounted = false;
  let suspended = false;
  let frozen = false;
  let mouseScroll = false;
  let resizeListener;
  let renderTimer;
  let flushTimer;
  let outputBlocked = false;
  let output;
  let drainListener;
  let renderCount = 0;
  let frameCount = 0;
  let revision = 0;
  let renderedRevision = 0;
  const formatter = createFormatter({color: Boolean(stdout.isTTY) && !('NO_COLOR' in process.env), compact: true});
  const detailFormatter = createFormatter({color: Boolean(stdout.isTTY) && !('NO_COLOR' in process.env)});
  let prepared = null;
  const transcriptRows = [];
  const formattedEvents = new Map();
  const keyboard = new PassThrough();
  emitKeypressEvents(keyboard);
  keyboard.on('keypress', (str, key) => onKeypress(str, key));
  const toKeyboard = text => text === '\x1b' ? onKeypress('\x1b', {name: 'escape'}) : keyboard.write(text);

  const keyInput = createKeyInput(
    toKeyboard,
    () => onKeypress('\r', {name: 'return', meta: true}),
    onKeypress,
  );
  const mouseInput = createMouseInput(keyInput, onScroll, onPress);
  const pasteInput = createPasteInput(mouseInput, onPaste);

  function visibleTranscriptRows(events, width, rowLimit) {
    const last = events.at(-1);
    if (!prepared || prepared.source !== events || prepared.length !== events.length || prepared.last !== last || prepared.details !== view.details) {
      prepared = {source: events, length: events.length, last, details: view.details,
        events: conversationEvents(events, {details: view.details})};
    }
    events = prepared.events;
    const groups = [];
    let count = 0;
    for (let index = events.length - 1; index >= 0 && count < rowLimit; index--) {
      const event = events[index];
      if (!view.details && (event.kind === 'task.observed' || event.kind === 'task.activity')) continue;
      const key = `${Boolean(view.details)}:${width}:${event.id ?? event.seq ?? index}`;
      let rows = formattedEvents.get(key);
      if (!rows) {
        rows = (view.details ? detailFormatter : formatter).event(event, width);
        formattedEvents.set(key, rows);
        if (formattedEvents.size > 400) formattedEvents.delete(formattedEvents.keys().next().value);
      }
      groups.push(rows);
      count += rows.length;
    }
    const next = groups.reverse().flat().slice(-rowLimit);
    transcriptRows.splice(0, transcriptRows.length, ...next);
    return transcriptRows;
  }

  function renderNow() {
    if (!app || suspended || frozen || outputBlocked) return;
    const contentWidth = workspaceColumns(view.columns, {sidebar: view.sidebar}).content;
    const width = view.agentsOpen && contentWidth >= 60
      ? paneGrid(projection.model().panes.length + 1, contentWidth, 10).panes[0].width - 4
      : contentWidth - 2;
    const rowLimit = Math.max(1, (view.rows ?? 24) + Math.max(0, view.scroll ?? 0));
    visibleTranscriptRows(view.scroll > 0 && history ? history() : projection.transcriptEvents(), width, rowLimit);
    renderedRevision = revision;
    app.rerender(app.elementFactory({model: projection.model(), transcriptRows, view: {...view}}));
    renderCount++;
  }
  // One bounded frame scheduler coalesces provider bursts; it never accumulates a frame queue.
  function render() {
    if (renderTimer || suspended || frozen) return;
    renderTimer = setTimeout(() => { renderTimer = null; renderNow(); }, 16);
  }
  function write(chunk) {
    const accepted = (output ?? stdout).write(chunk);
    if (!accepted) outputBlocked = true;
    return accepted;
  }
  function update(patch = {}) {
    view = {...view, ...patch, metadata: {...view.metadata, ...(patch.metadata ?? {})}};
    revision++;
    if (typeof patch.paused === 'boolean') {
      if (patch.paused) pause(); else unpause();
    }
    if (typeof patch.mouseScroll === 'boolean' && patch.mouseScroll !== mouseScroll) {
      mouseScroll = patch.mouseScroll;
      if (mounted && !suspended && !frozen) stdout.write(mouseTracking(mouseScroll));
    }
    render();
    return revision;
  }
  function ingest(event) {
    const changed = projection.ingest(event);
    if (changed) { revision++; render(); }
    return changed;
  }
  function reset(events = []) {
    projection.reset(events);
    prepared = null;
    formattedEvents.clear();
    transcriptRows.length = 0;
    revision++;
    render();
    return snapshot();
  }
  function snapshot() { return {...projection.snapshot(), view: {...view}}; }
  function paneIds() { return projection.paneIds(); }
  function suspend() { if (suspended) return; suspended = true; suspendTerminal(stdin, stdout); }
  function resume() { if (!suspended) return; suspended = false; resumeTerminal(stdin, stdout, {mouse: mouseScroll}); render(); }
  function pause() { if (frozen) return; frozen = true; stdout.write(mouseTracking(false)); }
  function unpause() { if (!frozen) return; frozen = false; stdout.write(mouseTracking(mouseScroll)); render(); }

  async function mount(initial = {}) {
    if (mounted) return;
    if (initial.events) projection.replay(initial.events);
    update({...initial, columns: stdout.columns ?? initial.columns ?? 80, rows: stdout.rows ?? initial.rows ?? 24});
    const [{render: inkRender}, React, Ink, {createWorkspace}] = await Promise.all([
      import('ink'), import('react'), import('ink'), import('./Workspace.js'),
    ]);
    const Workspace = createWorkspace(React, Ink);
    const elementFactory = props => React.createElement(Workspace, props);
    mouseScroll = Boolean(initial.mouseScroll);
    resumeTerminal(stdin, stdout, {mouse: mouseScroll});
    output = Object.create(stdout);
    output.write = chunk => {
      const accepted = stdout.write(chunk);
      if (!accepted) outputBlocked = true;
      return accepted;
    };
    drainListener = () => { outputBlocked = false; render(); };
    stdout.on?.('drain', drainListener);
    const contentWidth = workspaceColumns(view.columns, {sidebar: view.sidebar}).content;
    const width = view.agentsOpen && contentWidth >= 60
      ? paneGrid(projection.model().panes.length + 1, contentWidth, 10).panes[0].width - 4
      : contentWidth - 2;
    visibleTranscriptRows(projection.transcriptEvents(), width, Math.max(1, view.rows ?? 24));
    renderedRevision = revision;
    app = inkRender(elementFactory({model: projection.model(), transcriptRows, view: {...view}}), {
      stdin, stdout: output, exitOnCtrlC: false, patchConsole: false,
      onRender: ({renderTime}) => queueMicrotask(() => {
        frameCount++;
        onFrame({frame: frameCount, revision: renderedRevision, renderTime, time: performance.now()});
      }),
    });
    app.elementFactory = elementFactory;
    stdin.setEncoding?.('utf8');
    stdin.on('data', receive);
    resizeListener = () => { update({columns: stdout.columns ?? 80, rows: stdout.rows ?? 24}); onResize({columns: stdout.columns, rows: stdout.rows}); };
    stdout.on?.('resize', resizeListener);
    mounted = true;
  }
  function unmount() {
    clearTimeout(renderTimer); renderTimer = null;
    const wasMounted = mounted;
    if (wasMounted) stdin.off?.('data', receive);
    if (resizeListener) stdout.off?.('resize', resizeListener);
    if (drainListener) stdout.off?.('drain', drainListener);
    app?.unmount(); app = null; mounted = false;
    if (wasMounted) suspendTerminal(stdin, stdout);
  }
  function receive(chunk) {
    if (suspended) return;
    clearTimeout(flushTimer);
    pasteInput(chunk);
    flushTimer = setTimeout(() => { pasteInput.flush(); mouseInput.flush(); keyInput.flush(); }, 50);
  }
  function debugState() { return {outputBlocked, renderCount, frameCount, revision}; }
  return {mount, update, ingest, reset, snapshot, paneIds, suspend, resume, pause, unpause, unmount, debugState, write};
}
