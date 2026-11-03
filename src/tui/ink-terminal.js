import {createKeyInput, createMouseInput, createPasteInput, mouseTracking, resumeTerminal, suspendTerminal} from '../terminal.js';
import {createFormatter, paneGrid} from '../format.js';
import {PassThrough} from 'node:stream';
import {emitKeypressEvents} from 'node:readline';
import {createWorkspaceProjection} from './projection.js';
import {workspaceColumns} from './Workspace.js';
import {conversationEvents} from './transcript.js';
import {clampToRegion, extendSelection, hitTest, inHeader, selectedText} from './selection.js';
import {splitInline} from './inline.js';

const EMPTY_VIEW = {agentsOpen: false, selectedId: 'orchestrator', input: '', scroll: 0, notice: '', menu: [], metadata: {}, busy: false, progress: '', columns: 80, rows: 24, sidebar: true};

// CLI owns commands, drafts and focus policy. This adapter owns terminal mode, parses input once,
// and turns the incremental event log projection into an Ink frame.
export function createInkTerminal({stdin = process.stdin, stdout = process.stdout, onKeypress = () => {}, onPaste = () => {}, onResize = () => {}, onScroll = () => {}, onScrollClamp = () => {}, onCopy = () => {}, onFrame = () => {}, history, projectionOptions} = {}) {
  const projection = createWorkspaceProjection(projectionOptions);
  let view = {...EMPTY_VIEW};
  let app = null;
  let mounted = false;
  let suspended = false;
  let mouseScroll = false;
  let resizeListener;
  let renderTimer;
  let flushTimer;
  let outputBlocked = false;
  let output;
  let drainListener;
  let renderCount = 0;
  let frameCount = 0;
  // Selection (src/tui/selection.js): the regions the last frame drew, the drag in progress (its region and the
  // frame held still under it), and the last click, for double and triple clicks.
  let regions = [];
  // Inline (step 7): the rows printed to the scrollback so far, by id, and a key that remounts <Static> after a reset.
  let inline = false;
  const printed = [];
  const printedIds = new Set();
  let staticKey = 0;
  let drag = null;
  let lastClick = null;
  const MULTI_CLICK_MS = 400;
  let revision = 0;
  let renderedRevision = 0;
  const formatter = createFormatter({color: Boolean(stdout.isTTY) && !('NO_COLOR' in process.env), compact: true, foldAnswers: false});
  const detailFormatter = createFormatter({color: Boolean(stdout.isTTY) && !('NO_COLOR' in process.env)});
  let prepared = null;
  let heldTranscript = null;
  const heldActivities = new Map();
  const transcriptRows = [];
  const formattedEvents = new Map();
  const keyboard = new PassThrough();
  emitKeypressEvents(keyboard);
  // Any key ends a shown selection, as in a terminal.
  const keypress = (str, key) => { clearSelection(); onKeypress(str, key); };
  keyboard.on('keypress', (str, key) => keypress(str, key));
  const toKeyboard = text => text === '\x1b' ? keypress('\x1b', {name: 'escape'}) : keyboard.write(text);

  const keyInput = createKeyInput(
    toKeyboard,
    () => keypress('\r', {name: 'return', meta: true}),
    keypress,
  );
  const mouseInput = createMouseInput(keyInput, (amount, at) => onScroll(amount, hitTest(regions, at.x, at.y)?.region.id), pointer);
  const pasteInput = createPasteInput(mouseInput, onPaste);

  function visibleTranscriptRows(events, width, rowLimit) {
    const last = events.at(-1);
    if (!prepared || prepared.source !== events || prepared.length !== events.length || prepared.last !== last || prepared.details !== view.details) {
      prepared = {source: events, length: events.length, last, details: view.details,
        events: conversationEvents(events, {details: view.details})};
    }
    events = prepared.events;
    // Prompts this view still holds (cli.js pendingTurns, sent when the running turn ends) are shown
    // where they will land, as the user's and marked queued; they are not in the journal yet.
    const pending = (view.metadata?.pendingPrompts ?? []).map((text, index) => ({id: `pending:${index}:${text}`, kind: 'user', text, queued: true, local: true}));
    if (pending.length) events = [...events, ...pending];
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

  function clampScroll(id, scroll) {
    const selected = view.agentsOpen ? view.selectedId : 'orchestrator';
    view = {...view, paneScrolls: {...view.paneScrolls, [id]: scroll}, ...(id === selected ? {scroll} : {})};
    onScrollClamp(id, scroll);
  }

  // The conversation rows, cached until the events change.
  function conversationRows(events) {
    const last = events.at(-1);
    if (!prepared || prepared.source !== events || prepared.length !== events.length || prepared.last !== last || prepared.details !== view.details) {
      prepared = {source: events, length: events.length, last, details: view.details, events: conversationEvents(events, {details: view.details})};
    }
    return prepared.events;
  }
  function formatted(event, width, index) {
    const key = `${Boolean(view.details)}:${width}:${event.id ?? event.seq ?? index}`;
    let rows = formattedEvents.get(key);
    if (!rows) {
      rows = (view.details ? detailFormatter : formatter).event(event, width);
      formattedEvents.set(key, rows);
      if (formattedEvents.size > 400) formattedEvents.delete(formattedEvents.keys().next().value);
    }
    return rows;
  }
  // Rows that are final join the printed list once, in order; the rest are drawn live under them.
  function inlineFrameProps() {
    const width = Math.max(20, view.columns ?? 80) - 2;
    const rows = conversationRows(projection.transcriptEvents()).filter(event => view.details || !['task.observed', 'task.activity'].includes(event.kind));
    const {committed, live} = splitInline(rows, {busy: Boolean(view.busy)});
    committed.forEach((event, index) => {
      const id = String(event.id ?? event.seq ?? `row:${index}`);
      if (printedIds.has(id)) return;
      printedIds.add(id);
      printed.push({id, lines: formatted(event, width, index)});
    });
    const pending = (view.metadata?.pendingPrompts ?? []).map((text, index) => ({id: `pending:${index}:${text}`, kind: 'user', text, queued: true, local: true}));
    const liveRows = [...live, ...pending].flatMap((event, index) => formatted(event, width, `live:${index}`));
    return {model: projection.model(), transcriptRows: [], view: {...view}, inline: {staticItems: [...printed], staticKey, liveRows}};
  }

  function frameProps() {
    if (inline) return inlineFrameProps();
    return liveFrameProps();
  }
  function liveFrameProps() {
    const model = projection.model();
    const contentWidth = workspaceColumns(view.columns, {sidebar: view.sidebar}).content;
    const width = view.agentsOpen && contentWidth >= 60
      ? paneGrid(model.panes.length + 1, contentWidth, 10).panes[0].width - 4
      : contentWidth - 2;
    const transcriptScroll = view.agentsOpen ? (view.paneScrolls?.orchestrator ?? (view.selectedId === 'orchestrator' ? view.scroll : 0)) : view.scroll;
    const rowLimit = Math.max(1, (view.rows ?? 24) + Math.max(0, transcriptScroll ?? 0));
    // Scrolled back, or with the mouse button down, the content holds still (new rows wait below), so the text under
    // the pointer does not move and a drag past the edge can scroll through it.
    if (transcriptScroll > 0 && !heldTranscript) heldTranscript = (history ? history() : projection.transcriptEvents()).slice();
    else if (drag && !heldTranscript) heldTranscript = projection.transcriptEvents().slice();
    else if (!(transcriptScroll > 0) && !drag) heldTranscript = null;
    const transcriptVisible = !view.agentsOpen || contentWidth >= 60 || view.selectedId === 'orchestrator';
    if (transcriptVisible) visibleTranscriptRows(heldTranscript ?? projection.transcriptEvents(), width, rowLimit);
    const paneIds = new Set(model.panes.map(pane => pane.id));
    for (const id of heldActivities.keys()) if (!paneIds.has(id)) heldActivities.delete(id);
    const panes = model.panes.map(pane => {
      const scroll = view.paneScrolls?.[pane.id] ?? (pane.id === view.selectedId ? view.scroll : 0);
      if (!scroll && !drag) { heldActivities.delete(pane.id); return pane; }
      if (!heldActivities.has(pane.id)) heldActivities.set(pane.id, pane.activity.slice());
      return {...pane, activity: heldActivities.get(pane.id)};
    });
    return {model: {...model, panes}, transcriptRows, view: {...view}, onScrollClamp: clampScroll, onLayout: drawn => { regions = drawn; followDrag(); }};
  }

  function renderNow() {
    if (!app || suspended || outputBlocked) return;
    renderedRevision = revision;
    app.rerender(app.elementFactory(frameProps()));
    renderCount++;
  }
  // One bounded frame scheduler coalesces provider bursts; it never accumulates a frame queue.
  function render() {
    if (renderTimer || suspended) return;
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
    if (typeof patch.mouseScroll === 'boolean' && patch.mouseScroll !== mouseScroll) {
      mouseScroll = patch.mouseScroll;
      if (mounted && !suspended && !inline) stdout.write(mouseTracking(mouseScroll));
    }
    render();
    return revision;
  }
  function clearSelection() {
    if (!view.selection || drag) return;
    view = {...view, selection: null};
    revision++;
    render();
  }
  function setSelection(selection) {
    view = {...view, selection};
    revision++;
    render();
  }
  // Held past a region's top or bottom edge, the drag scrolls that region a row at a time (the caller scrolls it,
  // as for the wheel) and the selection follows what comes into view.
  const AUTO_SCROLL_MS = 50;
  function autoScroll(past) {
    if (!drag || drag.past === past) return;
    clearInterval(drag.timer);
    drag.past = past;
    drag.timer = past ? setInterval(() => { if (drag) onScroll(past === 'above' ? 1 : -1, drag.region.id); }, AUTO_SCROLL_MS) : null;
  }
  // A new frame of the dragged region: rows it gained above (a transcript scrolled back loads older rows at its top)
  // move the selection's rows down by as many, and a pointer past the edge selects up to the newly shown edge row.
  function followDrag() {
    if (!drag || !view.selection) return;
    const region = regions.find(candidate => candidate.id === drag.region.id);
    if (!region) return;
    const gained = region.rows.length - drag.rowCount;
    drag.region = region;
    drag.rowCount = region.rows.length;
    let {anchor, head} = view.selection;
    if (gained) { anchor = {...anchor, row: anchor.row + gained}; head = {...head, row: head.row + gained}; }
    if (drag.past) { const {past, ...edge} = clampToRegion(region, drag.last.x, drag.last.y, {fromHeader: drag.fromHeader}); head = edge; }
    if (anchor !== view.selection.anchor || head.row !== view.selection.head.row || head.col !== view.selection.head.col) setSelection({...view.selection, anchor, head});
  }
  // Press starts a selection in the region under the pointer (two or three quick clicks pick a word or a row),
  // drag extends it without leaving that region, release copies it. A click with no drag selects nothing.
  function pointer(event) {
    if (suspended) return;
    if (event.kind === 'press') {
      const hit = hitTest(regions, event.x, event.y);
      const now = Date.now();
      const clicks = lastClick && now - lastClick.at < MULTI_CLICK_MS && lastClick.x === event.x && lastClick.y === event.y ? lastClick.clicks + 1 : 1;
      lastClick = {at: now, x: event.x, y: event.y, clicks};
      if (!hit) { drag = null; clearSelection(); return; }
      const at = {row: hit.row, col: hit.col};
      // The row count is kept as a number: the transcript's row list is one array, refilled in place each frame.
      drag = {region: hit.region, rowCount: hit.region.rows.length, fromHeader: inHeader(hit.region, hit.row), clicks, last: event, timer: null, past: null};
      setSelection({region: hit.region.id, ...(clicks > 1 ? extendSelection(hit.region, at, clicks) : {anchor: at, head: at})});
      return;
    }
    if (!drag || !view.selection) return;
    if (event.kind === 'drag') {
      drag.last = event;
      const {past, ...head} = clampToRegion(drag.region, event.x, event.y, {fromHeader: drag.fromHeader});
      autoScroll(past ?? null);
      setSelection({...view.selection, head});
      return;
    }
    autoScroll(null);
    const text = selectedText(drag.region, view.selection);
    drag = null;
    if (text) onCopy(text);
    else setSelection(null);
    render();
  }
  function ingest(event) {
    const changed = projection.ingest(event);
    // New content moves the rows under a shown selection; it ends, unless the button is still down.
    if (changed && view.selection && !drag) view = {...view, selection: null};
    if (changed) { revision++; render(); }
    return changed;
  }
  function reset(events = []) {
    projection.reset(events);
    // A new conversation starts on a clean screen; its history is printed again from the top.
    if (inline) { printed.length = 0; printedIds.clear(); staticKey++; if (mounted) stdout.write('\x1b[2J\x1b[3J\x1b[H'); }
    prepared = null;
    heldTranscript = null;
    heldActivities.clear();
    formattedEvents.clear();
    transcriptRows.length = 0;
    revision++;
    render();
    return snapshot();
  }
  function snapshot() { return {...projection.snapshot(), view: {...view}}; }
  function paneIds() { return projection.paneIds(); }
  // Inline, the live rows (turn in flight, prompt, status) are erased first: the terminal then gets its cursor back
  // under the printed history, not wherever Ink left it.
  function suspend() { if (suspended) return; if (inline) app?.clear?.(); suspended = true; suspendTerminal(stdin, stdout); }
  function resume() { if (!suspended) return; suspended = false; resumeTerminal(stdin, stdout, {mouse: mouseScroll, inline}); render(); }

  async function mount(initial = {}) {
    if (mounted) return;
    // React's development build records a performance.measure (with a props diff) for every
    // component each render, and Node keeps those entries until cleared. Found live: an idle TUI
    // re-rendering on its tick grew to 3.9 GB. The TUI is never a React dev session: React is only
    // loaded by the import below, so this selects its production build.
    process.env.NODE_ENV ??= 'production';
    if (initial.events) projection.replay(initial.events);
    update({...initial, columns: stdout.columns ?? initial.columns ?? 80, rows: stdout.rows ?? initial.rows ?? 24});
    const [{render: inkRender}, React, Ink, {createWorkspace}] = await Promise.all([
      import('ink'), import('react'), import('ink'), import('./Workspace.js'),
    ]);
    const Workspace = createWorkspace(React, Ink);
    const elementFactory = props => React.createElement(Workspace, props);
    mouseScroll = Boolean(initial.mouseScroll);
    inline = Boolean(initial.inline);
    suspended = false;
    resumeTerminal(stdin, stdout, {mouse: mouseScroll, inline});
    output = Object.create(stdout);
    // Suspended, the screen is the shell's: Ink's own last render on unmount must not land on it.
    output.write = chunk => {
      if (suspended) return true;
      const accepted = stdout.write(chunk);
      if (!accepted) outputBlocked = true;
      return accepted;
    };
    drainListener = () => { outputBlocked = false; render(); };
    stdout.on?.('drain', drainListener);
    renderedRevision = revision;
    app = inkRender(elementFactory(frameProps()), {
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
  // What inline would have printed: the conversation and each task's outcome, without live worker activity.
  function scrollbackLines() {
    const width = Math.max(20, view.columns ?? 80) - 2;
    const rows = conversationRows(projection.transcriptEvents()).filter(event => !['task.observed', 'task.activity', 'progress'].includes(event.kind));
    return rows.flatMap((event, index) => formatted(event, width, index));
  }
  // `scrollback`: leave the session in the terminal's own scrollback, as inline does, once the alternate screen is
  // gone. Leaving it a second time would restore the cursor saved on entry, over what was just printed.
  function unmount({scrollback = false} = {}) {
    clearTimeout(renderTimer); renderTimer = null;
    const wasMounted = mounted;
    if (wasMounted) stdin.off?.('data', receive);
    if (resizeListener) stdout.off?.('resize', resizeListener);
    if (drainListener) stdout.off?.('drain', drainListener);
    const lines = scrollback && wasMounted && !inline ? scrollbackLines() : [];
    app?.unmount(); app = null; mounted = false;
    if (wasMounted && !suspended) suspendTerminal(stdin, stdout);
    suspended = true;
    if (lines.length) stdout.write(`${lines.join('\n')}\n`);
  }
  function receive(chunk) {
    if (suspended) return;
    clearTimeout(flushTimer);
    pasteInput(chunk);
    flushTimer = setTimeout(() => { pasteInput.flush(); mouseInput.flush(); keyInput.flush(); }, 50);
  }
  function debugState() { return {outputBlocked, renderCount, frameCount, revision}; }
  return {mount, update, ingest, reset, snapshot, paneIds, suspend, resume, unmount, debugState, write, regions: () => regions, inlineState: () => ({inline, printed: printed.map(item => item.id)})};
}
