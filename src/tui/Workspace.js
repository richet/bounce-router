import {clean, createFormatter, paneGrid} from '../format.js';
import {promptLayout} from './prompt-layout.js';

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
  function Sidebar({metadata = {}, panes, main, height}) {
    const status = main.state ?? 'ready';
    const lines = [
      {text: 'BOUNCE', color: 'cyan', bold: true},
      {text: [metadata.provider ?? 'agent', metadata.mode ?? 'plan', metadata.jev].filter(Boolean).join(' · ')},
      {text: `Model: ${metadata.model || 'provider default'}`, color: 'gray'},
      {text: `${metadata.operation ?? 'classic'} · ${status}`, color: 'yellow'},
      {text: `${metadata.pendingTurns ?? 0} prompt${metadata.pendingTurns === 1 ? '' : 's'} queued`, color: 'gray'},
      {text: metadata.cwd ?? '', color: 'gray'},
      {text: `Session ${(metadata.sessionId ?? '').slice(0, 8)}`, color: 'gray'},
      {text: ''},
      ...(metadata.quotaLines ?? []).map(text => ({text})),
      {text: ''},
      {text: `AGENTS · ${panes.length + 1}`, color: 'cyan', bold: true},
      {text: `● ${metadata.orchestrator ?? 'main'} · ${status}`},
      ...panes.map(pane => ({text: `● ${pane.profile} · ${pane.state}`})),
    ];
    return React.createElement(Box, {
      width: 32, height, flexShrink: 0, borderStyle: 'single', borderLeft: true,
      borderTop: false, borderRight: false, borderBottom: false,
      borderColor: 'gray', paddingLeft: 1, flexDirection: 'column', overflow: 'hidden',
    }, ...lines.slice(0, height).map((row, index) => React.createElement(Text, {
      key: index, color: row.color, bold: row.bold, wrap: 'truncate-end',
    }, row.text || ' ')));
  }
  function Pane({pane, selected, x, y, width, height, scroll = 0, now = Date.now()}) {
    const title = pane.kind === 'orchestrator' ? 'orchestrator' : `${pane.profile} · ${pane.task.slice(0, 8)}${pane.model ? ` · ${pane.model}` : ''}`;
    const details = [
      [pane.state, pane.phase ? `phase: ${pane.phase}` : null, pane.updatedAt ? `updated: ${ageText(pane.updatedAt, now)}` : null].filter(Boolean).join(' · '),
      [pane.text, pane.next ? `next: ${pane.next}` : null].filter(Boolean).join(' · '),
      pane.operation ? `operation: ${pane.operation}` : '',
      [pane.evidence ? `evidence: ${evidenceText(pane.evidence)}` : null, pane.delivery ? `delivery: ${pane.delivery}` : null, pane.recovery ? `recovery: ${pane.recovery}` : null].filter(Boolean).join(' · '),
    ].filter(Boolean);
    const available = Math.max(0, height - 3 - details.length);
    const activity = paneText(pane);
    const end = Math.max(0, activity.length - Math.max(0, scroll));
    const activityRows = activity.slice(Math.max(0, end - available), end).map(text => {
      if (pane.kind !== 'orchestrator' && (/^[\w.-]+: \{/.test(text) || text.includes('\n'))) {
        return activityFormatter.event({kind: 'tool', text}, Math.max(1, width - 4))[0] ?? '';
      }
      return text;
    });
    const rows = [...details, ...activityRows];
    return React.createElement(Box, {position: 'absolute', left: x, top: y, borderStyle: 'round', borderColor: selected ? 'cyan' : 'gray', width, height, paddingX: 1, flexDirection: 'column', overflow: 'hidden'},
      React.createElement(Text, {bold: true, color: selected ? 'cyan' : undefined}, `${selected ? '●' : '○'} ${title}`),
      ...rows.map((text, index) => React.createElement(Text, {key: `${index}:${text}`, wrap: 'truncate-end'}, text || ' ')));
  }
  function Workspace({model, transcriptRows, view}) {
    const {total, content: columns, sidebar} = workspaceColumns(view.columns, {sidebar: view.sidebar});
    const height = Math.max(8, view.rows ?? 24);
    const draft = promptLayout(view.input ?? '', view.inputCursor, columns - 4, Math.max(1, Math.floor(height / 3)));
    const menu = (view.menu ?? []).slice(0, Math.max(0, height - draft.length - 6))
      .map(item => typeof item === 'string' ? {text: item} : item);
    const main = view.main ?? {};
    const allPanes = [{
      id: 'orchestrator', kind: 'orchestrator', role: main.role ?? 'orchestrator',
      profile: main.profile ?? view.metadata?.orchestrator ?? 'main',
      state: main.state ?? (view.busy ? 'working' : 'ready'),
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
    const end = Math.max(0, transcript.length - Math.max(0, view.scroll ?? 0));
    const rows = transcript.slice(Math.max(0, end - bodyHeight), end);
    const content = React.createElement(Box, {flexDirection: 'column', width: columns, height, flexShrink: 0, overflow: 'hidden'},
      React.createElement(Box, {height: 1, flexShrink: 0}, React.createElement(Text, {bold: true, color: 'cyan', wrap: 'truncate-end'}, sidebar
        ? `${view.agentsOpen ? 'Agent workspace · Tab changes pane' : `Conversation · ${view.details ? 'details expanded' : 'details folded'} · /details`}`
        : `bounce · ${view.metadata?.provider ?? 'agent'} · ${view.metadata?.mode ?? 'READY'}`)),
      view.agentsOpen
        ? React.createElement(Box, {position: 'relative', width: columns, height: bodyHeight}, ...visible.slice(0, grid.visible).map((pane, index) => React.createElement(Pane, {
          key: pane.id, pane, selected: pane.id === view.selectedId,
          x: grid.panes[index].x, y: grid.panes[index].y,
          width: grid.panes[index].width, height: grid.panes[index].height,
          scroll: view.paneScrolls?.[pane.id] ?? (pane.id === view.selectedId ? view.scroll : 0),
          now: view.now ?? Date.now(),
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
            row.before, React.createElement(Text, {inverse: true}, row.atEnd ? '▏' : row.caret), row.after))),
        React.createElement(Text, {color: 'yellow', wrap: 'truncate-end'}, (view.notice ?? '').replace(/\n/g, ' '))));
    return React.createElement(Box, {flexDirection: 'row', columnGap: sidebar ? 1 : 0, width: total, height}, content,
      sidebar ? React.createElement(Sidebar, {metadata: view.metadata, panes: model.panes, main: allPanes[0], height}) : null);
  }
  return Workspace;
}
