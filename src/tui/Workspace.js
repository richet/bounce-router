import {clean, createFormatter, paneGrid} from '../format.js';
import {promptLayout} from './prompt-layout.js';
import {agentRow, doingLine, glyph, progressRow, quietFor, rowColor, shortModel, waitingRow} from './status.js';
import {deriveSessionName} from '../session-names.js';

// The sidebar's own session identity line: an explicit/prompt-derived name (metadata.name)
// wins, else the id's stable memorable name. No id here — the sidebar is ~30 columns and
// there is only one session in view; lists (bounce sessions, /resume) keep the id prefix.
function sessionLine(metadata) {
  return `Session ${metadata.name || deriveSessionName(String(metadata.sessionId ?? ''))}`;
}

// The status rail is on unless switched off (`/sidebar off`), and even then only fits a terminal
// wide enough to leave a readable conversation beside it.
export function workspaceColumns(columns = 80, {sidebar: wanted = true} = {}) {
  const total = Math.max(20, columns);
  const sidebar = wanted && total >= 100 ? 32 : 0;
  return {total, sidebar, content: total - sidebar - (sidebar ? 1 : 0)};
}

function line(event) {
  const label = event.kind === 'user' ? 'You' : event.from ?? event.provider ?? 'Bounce';
  const text = clean(event.typed ?? event.text ?? event.summary ?? event.kind).replace(/\n+/g, ' ');
  return `${label} · ${text}`;
}

function paneText(pane) {
  return pane.activity ?? [];
}

// Adapter heartbeats ("generating · step open 30 s") already show in the pane header's
// `operation:` line — listing them again in the activity feed too is pure noise.
const HEARTBEAT_RE = /^generating · step open \d+ s$/;
// opencode's tool-call activity rows read `${tool} ${status}` (`read completed`, `bash running`).
const TOOL_STATUS_RE = /^([\w.-]+) (completed|error|running|pending|queued|started)$/i;
// A raw serialized call (`Bash: {"description":…}`) carries real argument detail worth keeping,
// unlike a bare status row — format.js's compact `tool` renderer already turns it into `Bash(…)`.
const TOOL_CALL_RE = /^[\w.-]+: \{[\s\S]*\}$/;

// A worker pane's activity feed mixes prose (read in full, word-wrapped like the orchestrator's own
// answers), tool bookkeeping (collapsed to one `name ×count` counter per consecutive run), and
// heartbeats (dropped entirely). Returns the fully rendered, already-wrapped rows, newest last.
function workerActivityRows(activity, width, activityFormatter) {
  const blocks = [];
  let run = null;
  const flushRun = () => {
    if (!run) return;
    blocks.push([activityFormatter.style.muted(run.order.map(name => `${name} ×${run.counts.get(name)}`).join(' · '))]);
    run = null;
  };
  for (const entry of activity) {
    const text = String((entry && typeof entry === 'object' ? entry.text : entry) ?? '');
    const source = entry && typeof entry === 'object' ? entry.source ?? null : null;
    if (source === 'activity' && (text === '' || HEARTBEAT_RE.test(text))) continue;
    const callArgs = TOOL_CALL_RE.test(text);
    const toolName = !callArgs && (source === 'tool' ? text.split(/\s+/)[0] || text
      : source === 'activity' ? TOOL_STATUS_RE.exec(text)?.[1] ?? null : null);
    if (toolName) {
      run ??= {counts: new Map(), order: []};
      if (!run.counts.has(toolName)) run.order.push(toolName);
      run.counts.set(toolName, (run.counts.get(toolName) ?? 0) + 1);
      continue;
    }
    flushRun();
    if (source === 'error') { blocks.push([activityFormatter.style.error(text)]); continue; }
    if (callArgs) { blocks.push([activityFormatter.event({kind: 'tool', text}, width)[0] ?? '']); continue; }
    // The shared formatter appends a trailing blank spacer row between transcript blocks; a pane's
    // limited height has no room for it, so only the wrapped content rows are kept.
    const prose = activityFormatter.event({kind: 'assistant', text}, width);
    while (prose.length > 1 && prose.at(-1) === '') prose.pop();
    blocks.push(prose);
  }
  flushRun();
  return blocks.flat();
}

function evidenceText(evidence) {
  if (Array.isArray(evidence)) return evidence.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(', ');
  if (evidence && typeof evidence === 'object') return JSON.stringify(evidence);
  return evidence == null ? '' : String(evidence);
}

function ageText(time, now) {
  const elapsed = Math.max(0, Number(now) - Date.parse(time));
  if (!Number.isFinite(elapsed)) return 'unknown';
  if (elapsed < 1000) return 'just now';
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s ago`;
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
  return `${Math.floor(elapsed / 3600000)}h ago`;
}

// Kept in plain createElement form so the Node ESM test runner needs no JSX transform.
export function createWorkspace(React, Ink) {
  const {Box, Text} = Ink;
  const activityFormatter = createFormatter({compact: true});
  function Sidebar({metadata = {}, panes, main, height, now}) {
    const status = main.state ?? 'ready';
    const lines = [
      {text: 'BOUNCE', color: 'cyan', bold: true},
      {text: [metadata.provider ?? 'agent', metadata.mode ?? 'plan', metadata.jev].filter(Boolean).join(' · ')},
      {text: `Model: ${metadata.model || 'provider default'}`, color: 'gray'},
      {text: `${metadata.operation ?? 'classic'} · ${status}`, color: 'yellow'},
      ...(metadata.pendingOperation ? [{text: `→ ${metadata.pendingOperation} on next session`, color: 'yellow'}] : []),
      {text: metadata.ownQueued > 0 ? `${metadata.ownQueued} queued · ↑ to edit`
        : `${metadata.pendingTurns ?? 0} prompt${metadata.pendingTurns === 1 ? '' : 's'} queued`, color: 'gray'},
      {text: metadata.cwd ?? '', color: 'gray'},
      {text: sessionLine(metadata), color: 'gray'},
      {text: ''},
      ...(metadata.quotaLines ?? []).map(text => ({text})),
      ...(metadata.modelLines?.length ? [{text: ''}, ...metadata.modelLines.map(text => ({text}))] : []),
      {text: ''},
      {text: `AGENTS · ${panes.length + 1}`, color: 'cyan', bold: true},
      // Each row moves while that worker works, names its model, and says how long it has been quiet.
      {text: agentRow({profile: metadata.orchestrator ?? 'main', state: status, model: main.model, startedAt: main.startedAt}, now), color: rowColor({state: status}, now)},
      ...(status === 'working' && doingLine(main.doing, now) ? [{text: `  ${doingLine(main.doing, now, 28)}`, color: main.doing?.what === 'waiting' ? 'cyan' : 'gray'}] : []),
      ...panes.flatMap(pane => [{text: agentRow(pane, now), color: rowColor(pane, now)}, ...(pane.state === 'running' && doingLine(pane.doing, now) ? [{text: `  ${doingLine(pane.doing, now, 28)}`, color: 'gray'}] : []), ...(progressRow(pane, now) ? [{text: progressRow(pane, now), color: 'gray'}] : []), ...(waitingRow(pane) ? [{text: waitingRow(pane), color: 'gray'}] : [])]),
    ];
    return React.createElement(Box, {
      width: 32, height, flexShrink: 0, borderStyle: 'single', borderLeft: true,
      borderTop: false, borderRight: false, borderBottom: false,
      borderColor: 'gray', paddingLeft: 1, flexDirection: 'column', overflow: 'hidden',
    }, ...lines.slice(0, height).map((row, index) => React.createElement(Text, {
      key: index, color: row.color, bold: row.bold, wrap: 'truncate-end',
    }, row.text || ' ')));
  }
  function Pane({pane, selected, x, y, width, height, scroll = 0, now = Date.now(), onScrollClamp}) {
    const title = pane.kind === 'orchestrator' ? 'orchestrator' : `${String(pane.profile).split('@')[0]} · ${pane.task.slice(0, 8)}${pane.model ? ` · ${shortModel(pane.model)}` : ''}${pane.inPlace ? ' · in place' : ''}`;
    // A blocked/input_required pane leads with why, not with whatever prose (often stale success
    // text from an earlier milestone) happens to sit in pane.text — see src/tui/projection.js,
    // which keeps the blocker in its own field so a later milestone can't clobber it.
    const details = [
      ...(['blocked', 'input_required'].includes(pane.state) && pane.blocked ? [`blocked: ${pane.blocked}`] : []),
      [pane.state, pane.state === 'running' || pane.kind === 'orchestrator' ? doingLine(pane.doing, now, 60) : null, pane.phase ? `phase: ${pane.phase}` : null, pane.updatedAt ? `updated: ${ageText(pane.updatedAt, now)}` : null].filter(Boolean).join(' · '),
      [pane.text, pane.next ? `next: ${pane.next}` : null].filter(Boolean).join(' · '),
      pane.operation ? `operation: ${pane.operation}` : '',
      [pane.evidence ? `evidence: ${evidenceText(pane.evidence)}` : null, pane.delivery ? `delivery: ${pane.delivery}` : null, pane.recovery ? `recovery: ${pane.recovery}` : null].filter(Boolean).join(' · '),
    ].filter(Boolean);
    const available = Math.max(0, height - 3 - details.length);
    const activity = paneText(pane);
    // The orchestrator pane already receives fully-formatted, pre-wrapped transcript rows; a worker
    // pane's raw activity entries are wrapped here so scrolling can operate on rendered rows.
    const allRows = pane.kind === 'orchestrator' ? activity : workerActivityRows(activity, Math.max(1, width - 4), activityFormatter);
    const boundedScroll = Math.min(Math.max(0, scroll), Math.max(0, allRows.length - available));
    React.useLayoutEffect(() => { if (scroll !== boundedScroll) onScrollClamp?.(pane.id, boundedScroll); }, [scroll, boundedScroll, pane.id, onScrollClamp]);
    const end = allRows.length - boundedScroll;
    const activityRows = allRows.slice(Math.max(0, end - available), end);
    const rows = [...details, ...activityRows];
    return React.createElement(Box, {position: 'absolute', left: x, top: y, borderStyle: 'round', borderColor: selected ? 'cyan' : 'gray', width, height, paddingX: 1, flexDirection: 'column', overflow: 'hidden'},
      React.createElement(Text, {bold: true, color: selected ? 'cyan' : undefined}, `${pane.kind === 'orchestrator' ? (selected ? '●' : '○') : glyph(pane.state, now)} ${title}`),
      ...rows.map((text, index) => React.createElement(Text, {key: `${index}:${text}`, wrap: 'truncate-end'}, text || ' ')));
  }
  function Workspace({model, transcriptRows, view, onScrollClamp}) {
    const {total, content: columns, sidebar} = workspaceColumns(view.columns, {sidebar: view.sidebar});
    const height = Math.max(8, view.rows ?? 24);
    const draft = promptLayout(view.input ?? '', view.inputCursor, columns - 4, Math.max(1, Math.floor(height / 3)));
    const menu = (view.menu ?? []).slice(0, Math.max(0, height - draft.length - 6))
      .map(item => typeof item === 'string' ? {text: item} : item);
    const main = view.main ?? {};
    const now = view.now ?? Date.now();
    // The main worker is working while a turn is in flight, whatever the daemon last said its state was.
    const working = Boolean(view.busy) || ['running', 'starting'].includes(main.state);
    const mainState = working ? 'working' : main.state === 'blocked' ? 'blocked' : 'ready';
    const mainModel = shortModel(main.model || view.metadata?.model);
    const allPanes = [{
      id: 'orchestrator', kind: 'orchestrator', role: main.role ?? 'orchestrator',
      profile: main.profile ?? view.metadata?.orchestrator ?? 'main',
      state: mainState, model: mainModel, startedAt: main.startedAt, doing: main.doing,
      phase: main.phase,
      text: main.text ?? view.progress ?? view.notice ?? '',
      next: main.next,
      operation: main.operation,
      evidence: main.evidence,
      updatedAt: main.updatedAt,
      delivery: main.delivery,
      recovery: main.recovery,
      activity: transcriptRows,
    }, ...model.panes];
    let visible = allPanes;
    if (view.agentsOpen) {
      const selected = allPanes.find(pane => pane.id === view.selectedId) ?? allPanes[0];
      if (columns < 60) visible = [selected];
      else if (allPanes.indexOf(selected) >= 4) visible = [allPanes[0], selected, ...allPanes.filter(pane => pane !== allPanes[0] && pane !== selected).slice(0, 2)];
      else visible = allPanes.slice(0, 4);
    }
    const remaining = view.agentsOpen ? Math.max(0, allPanes.length - visible.length) : 0;
    const bodyHeight = Math.max(0, height - menu.length - draft.length - (remaining ? 1 : 0) - 3);
    const grid = paneGrid(visible.length, columns, bodyHeight);
    const transcript = transcriptRows ?? model.transcript.map(line);
    const boundedScroll = Math.min(Math.max(0, view.scroll ?? 0), Math.max(0, transcript.length - bodyHeight));
    React.useLayoutEffect(() => {
      if (!view.agentsOpen && (view.scroll ?? 0) !== boundedScroll) onScrollClamp?.('orchestrator', boundedScroll);
    }, [view.agentsOpen, view.scroll, boundedScroll, onScrollClamp]);
    const end = transcript.length - boundedScroll;
    const rows = transcript.slice(Math.max(0, end - bodyHeight), end);
    const content = React.createElement(Box, {flexDirection: 'column', width: columns, height, flexShrink: 0, overflow: 'hidden'},
      React.createElement(Box, {height: 1, flexShrink: 0}, React.createElement(Text, {bold: true, color: working ? 'yellow' : 'cyan', wrap: 'truncate-end'}, sidebar
        ? `${glyph(mainState, now)} ${view.metadata?.orchestrator ?? 'main'}${mainModel ? ` · ${mainModel}` : ''} · ${mainState}${working && quietFor(main.startedAt, now) ? ` ${quietFor(main.startedAt, now)}` : ''}${working && doingLine(main.doing, now, 60) ? ` · ${doingLine(main.doing, now, 60)}` : ''} · ${view.agentsOpen ? 'Agent workspace · Tab changes pane' : `Conversation · ${view.details ? 'details expanded' : 'details folded'} · /details`}`
        : `bounce · ${view.metadata?.provider ?? 'agent'} · ${view.metadata?.mode ?? 'READY'}`)),
      view.agentsOpen
        ? React.createElement(Box, {position: 'relative', width: columns, height: bodyHeight}, ...visible.slice(0, grid.visible).map((pane, index) => React.createElement(Pane, {
          key: pane.id, pane, selected: pane.id === view.selectedId,
          x: grid.panes[index].x, y: grid.panes[index].y,
          width: grid.panes[index].width, height: grid.panes[index].height,
          scroll: view.paneScrolls?.[pane.id] ?? (pane.id === view.selectedId ? view.scroll : 0),
          now, onScrollClamp,
        })))
        // An empty Text is zero rows high in Ink, which would swallow the blank row between
        // blocks, paragraphs and headings; a single space keeps the row.
        : React.createElement(Box, {height: bodyHeight, flexDirection: 'column', overflow: 'hidden'}, ...rows.map((text, index) => React.createElement(Text, {key: `${index}:${text}`, wrap: 'truncate-end'}, text || ' '))),
      view.agentsOpen && remaining ? React.createElement(Text, {color: 'gray'}, `+ ${remaining} more agents · Tab cycles`) : null,
      ...menu.map((item, index) => React.createElement(Box, {key: `menu:${index}`, height: 1, flexShrink: 0}, React.createElement(Text, {wrap: 'truncate-end', color: item.selected ? 'cyan' : item.muted ? 'gray' : undefined}, item.text.replace(/\n/g, ' ')))),
      React.createElement(Box, {height: draft.length + 2, flexShrink: 0, flexDirection: 'column'},
        React.createElement(Text, {color: 'cyan', wrap: 'truncate-end'}, `── Message ${view.inputTarget ?? 'orchestrator'} · Enter send · Shift+Enter newline ${'─'.repeat(columns)}`),
        ...draft.map((row, index) => React.createElement(Text, {key: `input:${index}`, wrap: 'truncate-end'},
          React.createElement(Text, {color: 'cyan'}, `${index === 0 ? '❯' : ' '} `),
          row.caret === undefined ? row.text : React.createElement(React.Fragment, null,
            row.before, React.createElement(Text, {inverse: true}, row.atEnd ? '▏' : row.caret), row.after),
          // The main worker's proposed next step, dim after the caret while the input is empty: Tab takes it, typing replaces it.
          index === 0 && !view.input && view.suggestion ? React.createElement(Text, {color: 'gray'}, ` ${view.suggestion}  ⇥ Tab`) : null)),
        React.createElement(Text, {color: 'yellow', wrap: 'truncate-end'}, (view.notice ?? '').replace(/\n/g, ' '))));
    return React.createElement(Box, {flexDirection: 'row', columnGap: sidebar ? 1 : 0, width: total, height}, content,
      sidebar ? React.createElement(Sidebar, {metadata: view.metadata, panes: model.panes, main: allPanes[0], height, now}) : null);
  }
  return Workspace;
}
