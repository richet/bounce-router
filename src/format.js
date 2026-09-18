import {Marked} from 'marked';
import {markedTerminal} from 'marked-terminal';
import {highlight, supportsLanguage} from 'cli-highlight';
import {Chalk} from 'chalk';
import wrapAnsi from 'wrap-ansi';
import sliceAnsi from 'slice-ansi';
import stripAnsi from 'strip-ansi';
import {tasks, budgets, TERMINAL} from './reducers.js';

// How many lines of a tool result the compact transcript shows before "… +N lines".
const RESULT_PREVIEW = 3;

// Only renderer-owned terminal escapes may reach the display.
export const clean = text => stripAnsi(String(text ?? ''))
  .replace(/\r\n?/g, '\n')
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  .replace(/\t/g, '    ');

// `role(row)` (optional) names who a row belongs to — the orchestrator profile, a worker's
// profile — and is shown before the provider: `main · claude · Tool`. Classic never passes it.
export function createFormatter({color = process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb', compact = false, role = null} = {}) {
  const c = new Chalk({level: color ? 1 : 0});
  const style = {
    title: c.bold.cyan, muted: c.gray, user: c.bold.cyan, assistant: c.bold.green,
    tool: c.magenta, error: c.bold.red, status: c.yellow, result: c.green,
    note: c.blue, diagnostic: c.yellow, selected: c.bold.inverse, prompt: c.cyan, quota: c.bold.blue,
    skills: c.bold.magenta,
  };
  function codeColors(text, language) {
    if (!color) return text;
    try {
      return highlight(text, {
        language: language && supportsLanguage(language) ? language : undefined,
        languageSubset: ['javascript', 'typescript', 'python', 'bash', 'json', 'css', 'xml', 'sql', 'diff', 'go', 'rust'],
        ignoreIllegals: true,
        theme: {keyword: c.magenta, string: c.green, number: c.yellow, literal: c.yellow,
          comment: c.gray, built_in: c.cyan, title: c.blue, attr: c.cyan,
          attribute: c.cyan, variable: c.cyan, type: c.yellow, regexp: c.red,
          symbol: c.magenta, meta: c.gray, addition: c.green, deletion: c.red},
      });
    } catch { return text; }
  }
  const parser = new Marked(markedTerminal({
    heading: c.bold.cyan, firstHeading: c.bold.cyan, strong: c.bold, em: c.italic,
    codespan: c.yellow, code: c.yellow, blockquote: c.gray.italic,
    html: c.gray, del: c.dim.strikethrough, link: c.blue, href: c.blue.underline,
    hr: c.gray, listitem: c.reset, table: c.reset, paragraph: c.reset,
    showSectionPrefix: false, emoji: false, unescape: true, tab: 2,
  }));
  parser.use({renderer: {
    heading({tokens}) { return c.bold.cyan(this.parser.parseInline(tokens)) + '\n\n'; },
    code({text, lang}) {
      const language = lang?.trim().split(/\s+/)[0].toLowerCase();
      const lines = text.split('\n');
      const visible = compact ? lines.slice(0, 4) : lines;
      const code = codeColors(visible.join('\n'), language);
      const folded = lines.length - visible.length;
      const more = folded ? '\n' + c.gray(`  … +${folded} lines · /details to expand`) : '';
      return code.split('\n').map(line => '  ' + line).join('\n') + more + '\n\n';
    },
    // Lists the way Claude Code shows them: `- ` and `1. ` markers at the content column, an
    // item's further lines (and nested lists) hanging under its text. marked-terminal's own list
    // renderer indents by a tab and uses `*`.
    list(token) {
      const rows = [];
      token.items.forEach((item, index) => {
        const marker = token.ordered ? `${(token.start || 1) + index}. ` : '- ';
        const check = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
        // A tight list has no blank rows inside an item; paragraph renderers add them anyway.
        const lines = this.parser.parse(item.tokens).replace(/\n+$/, '').split('\n').filter(line => token.loose || line !== '');
        rows.push(marker + check + lines[0], ...lines.slice(1).map(line => line ? ' '.repeat(marker.length) + line : ''));
      });
      return rows.join('\n') + '\n\n';
    },
    ...(compact ? {
      // Compact tables do not use marked-terminal's colon-delimited table transport.
      codespan({text}) { return c.yellow(text); },
      table({header, rows}) {
        const labels = header.map(cell => this.parser.parseInline(cell.tokens));
        const preview = rows.slice(0, 3).map(row => row.map((cell, index) =>
          `${c.gray(labels[index] + ':')} ${this.parser.parseInline(cell.tokens)}`).join(' · '));
        const more = rows.length > 3 ? `\n${c.gray(`  … +${rows.length - 3} rows · /details to expand`)}` : '';
        return preview.join('\n') + more + '\n\n';
      },
    } : {}),
    link({href, tokens}) { return c.blue(this.parser.parseInline(tokens)) + c.underline(` (${clean(href)})`); },
    // marked-terminal's text renderer emits a token's raw source instead of parsing its
    // inline tokens, so bold, emphasis and code spans inside list items reach the display
    // as literal Markdown. Parse the nested tokens; leaf text tokens still pass through.
    text(token) { return token.tokens ? this.parser.parseInline(token.tokens) : token.text; },
  }});
  const wrap = (text, width) => wrapAnsi(color ? text : stripAnsi(text), Math.max(1, width), {hard: true, trim: false}).split('\n');
  const clip = (text, width) => sliceAnsi(color ? text : stripAnsi(text), 0, Math.max(0, width));
  // A line that wraps continues under its own text — past its indentation and any list marker —
  // the way Claude Code lays out lists and indented code, rather than snapping back to column 0.
  const hang = (line, width) => {
    const lead = /^\s*(?:(?:[-*•] |\d+[.)] )\s*)?/.exec(stripAnsi(line))[0];
    if (!lead || !line.startsWith(lead) || lead.length > width / 2) return wrap(line, width).map(row => row.trimEnd());
    const rest = line.slice(lead.length);
    return wrap(rest, width - lead.length).map((row, index) => (index ? ' '.repeat(lead.length) + row.replace(/^ /, '') : lead + row).trimEnd());
  };
  const hangAll = (text, width) => text.split('\n').flatMap(line => hang(line, width));
  function markdown(text, width) {
    const source = clean(text);
    try { return hangAll(parser.parse(source).trimEnd(), width); }
    catch { return hangAll(source, width); } // Partial/unknown Markdown must never hide a response.
  }
  // Claude sends tool calls as `Name: {json}`. Escaped newlines and quotes are unreadable,
  // so display the fields as lines. The journal keeps the original text for handoffs.
  const toolLines = text => {
    const match = /^([A-Za-z_][\w.-]*): (\{[\s\S]*\})$/.exec(text.trim());
    let input;
    try { input = match && JSON.parse(match[2]); } catch { return null; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const lines = [match[1]];
    for (const [key, value] of Object.entries(input)) {
      const rows = (typeof value === 'string' ? value : JSON.stringify(value ?? null)).split('\n');
      if (rows.length > 1) lines.push(`${key}:`, ...rows.map(row => '  ' + row));
      else lines.push(`${key}: ${rows[0]}`);
    }
    return lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more lines`] : lines;
  };
  // A transcript block: its glyph on the first row, every other row two columns in under it.
  const block = (glyph, rows) => rows.map((row, index) => index ? (row ? '  ' + row : '') : `${glyph} ${row}`);
  // Short bookkeeping events read as one line; only real content earns a block of its own.
  const inline = ['status', 'progress', 'route', 'cooldown', 'attempt', 'turn', 'diagnostic', 'note', 'aside'];
  const who = e => [role?.(e) ?? null, e.provider || 'Bounce'].filter(Boolean).join(' · ');
  function event(e, width) {
    // `model` carries no text: it is what the header's model label reads, not a transcript row.
    if (['raw', 'usage', 'model', 'peer.native', 'peer.joined', 'task.attempt.ended', 'task.report.staged', 'checkpoint', 'wait.served'].includes(e.kind) || e.kind.startsWith('budget.')) return [];
    if (e.kind === 'attempt' && e.status === 'started') return event({...e, kind: 'status', text: 'Starting provider…'}, width);
    if (e.kind.startsWith('main.')) {
      const label = {'main.starting': 'Starting', 'main.started': 'Running', 'main.terminal': 'Finished', 'main.blocked': 'Blocked', 'main.delivery': 'Message'}[e.kind] ?? 'Orchestrator';
      return event({...e, kind: 'status', text: `${label} · ${e.text || e.status || e.state || ''}`}, width);
    }
    if ((e.kind.startsWith('task.') && e.kind !== 'task.fold') || e.kind.startsWith('policy.fallback')) {
      const label = e.kind === 'policy.fallback' ? `Recovery: ${e.from_profile} → ${e.to_profile}` : e.kind === 'policy.fallback.skipped' ? 'Recovery unavailable' : e.kind.slice(5).replaceAll('_', ' ');
      return event({...e, kind: ['task.failed', 'task.blocked'].includes(e.kind) ? 'error' : 'status', provider: e.profile || `worker ${e.task?.slice(0, 8) ?? ''}`,
        text: [label, e.summary || e.text || e.reason, e.next ? `next: ${e.next}` : ''].filter(Boolean).join(' · ')}, width);
    }
    // Compact mode (the orchestrator transcript): a coordinator's tool mechanics and pasted file
    // output are noise — fold each tool row to one summary line, and render foldedThread's delegation
    // rows as one line each. Classic transcript never sets compact, so it is unchanged.
    if (compact && e.kind === 'tool') {
      // A tool CALL (`Name: {json}`) is one "● Name(what for)" line; a tool RESULT is a ⎿ block
      // with its first few lines and "… +N lines" for the rest — the shape Claude Code uses, so
      // the eye can skip mechanics and land on responses and outcomes.
      // Leading blank lines go; a first line's own indentation stays, it is part of the output.
      const t = clean(e.text).replace(/^\n+/, '').trimEnd();
      const m = /^([A-Za-z_][\w.-]*): (\{[\s\S]*\})$/.exec(t.trim());
      if (m) {
        let summary = '';
        try { const o = JSON.parse(m[2]); summary = String(o.description || o.path || o.file_path || (typeof o.command === 'string' ? o.command.split('\n')[0] : '') || o.pattern || o.query || ''); } catch {}
        const head = `${style.result('●')} ${c.bold(m[1])}`;
        if (!summary) return [head];
        const room = width - stripAnsi(head).length - 3;
        return [`${head}(${summary.length > room ? summary.slice(0, Math.max(0, room)) + '…' : summary})`];
      }
      const lines = /^<persisted-output>/.test(t) ? ['output saved to a file'] : t.split('\n');
      const preview = lines.slice(0, RESULT_PREVIEW).map(line => {
        const room = width - 5;
        return stripAnsi(line).length > room ? clip(line, room - 1) + '…' : line;
      });
      const more = lines.length > preview.length ? [style.muted(`… +${lines.length - preview.length} lines`)] : [];
      return [...[...preview, ...more].map((line, index) => (index ? '     ' : `  ${style.muted('⎿')}  `) + style.muted(line)), ''];
    }
    if (compact && e.kind === 'task.fold') {
      const paint = ['failed', 'timed_out', 'cancelled', 'rejected'].includes(e.state) ? style.error
        : ['completed', 'accepted'].includes(e.state) ? style.result
        : ['blocked', 'input_required'].includes(e.state) ? style.status : style.title;
      const head = clip(`${paint(stateGlyph(e.state))} ${paint(clean(e.text))}`, width);
      const preview = e.preview ? [clip(`  ${style.muted(clean(e.preview))}`, width)] : [];
      if (e.state === 'failed' || e.state === 'timed_out') return [head, ...preview, clip(`  ${style.muted('⎿')}  ${style.muted(`next: ${failureHint(e.reason, e.text)}`)}`, width)];
      return [head, ...preview];
    }
    if (compact && e.kind === 'user' && e.typed) return [...block(style.user('>'), wrap(clean(e.typed), width - 2)), clip(`  ${style.muted('⎿')}  ${style.muted(`expanded to ${withoutBrief(e.text).length.toLocaleString()} chars · /details shows it`)}`, width), ''];
    if (compact && e.kind === 'user') return [...block(style.user('>'), wrap(clean(withoutBrief(e.text)), width - 2)), ''];
    if (compact && ['assistant', 'delta', 'result'].includes(e.kind)) return [...block('●', markdown(e.text, width - 2)), ''];
    const names = {user: 'You', assistant: 'Response', delta: 'Response', result: 'Result',
      status: 'Activity', route: 'Agent selected', tool: 'Tool output', error: 'Error',
      diagnostic: 'Diagnostics', note: 'Saved note', cooldown: 'Retry delay', attempt: 'Agent finished',
      turn: 'Turn finished', quota: 'Reported quota', skills: 'Skills', review: 'Work Done review', aside: 'By the way'};
    const label = e.kind === 'user' ? 'You' : e.kind === 'aside' ? 'You · By the way' : `${who(e)} · ${names[e.kind] || e.kind}`;
    const paint = style[e.kind] || style.muted;
    if (inline.includes(e.kind)) return compact ? hang(`  ${paint(clean(label))}  ${clean(e.text)}`, width) : wrap(`${paint(clean(label))}  ${clean(e.text)}`, width);
    const source = e.kind === 'tool' ? (toolLines(clean(e.text)) ?? [clean(e.text)]).join('\n') : clean(e.text);
    const content = ['assistant', 'delta', 'result'].includes(e.kind)
      ? markdown(e.text, width) : wrap(e.kind === 'tool' ? codeColors(source) : source, width);
    return [clip(paint(clean(label)), width), ...content, ''];
  }
  return {style, wrap, clip, markdown, event};
}

// A provider may split a fence or even a word between adjacent output deltas.
export function displayEvents(events) {
  const result = [];
  for (const event of events) {
    if (['raw', 'usage', 'checkpoint', 'session'].includes(event.kind) || !event.text) continue;
    const previous = result.at(-1);
    if (event.kind === 'delta' && previous?.kind === 'delta' && previous.provider === event.provider) {
      previous.text += event.text;
    } else result.push({...event});
  }
  return result;
}

// Session journals are append-only. Keep one layout, replacing it on resize or
// session changes; typing and scrolling do no transcript formatting work.
export function createTranscriptRenderer(formatEvent) {
  let source, columns, consumed = 0, rows = [], tail, tailStart = 0;
  return (events, width) => {
    if (source !== events || columns !== width || events.length < consumed) {
      source = events; columns = width; consumed = 0; rows = []; tail = undefined;
    }
    let dirty = false;
    const flush = () => {
      if (!dirty) return;
      rows.length = tailStart;
      for (const row of formatEvent(tail, width)) rows.push(row);
      dirty = false;
    };
    for (; consumed < events.length; consumed++) {
      const event = events[consumed];
      if (['raw', 'usage', 'checkpoint', 'session'].includes(event.kind) || !event.text) continue;
      if (event.kind === 'delta' && tail?.kind === 'delta' && tail.provider === event.provider) {
        tail.text += event.text;
      } else {
        flush();
        tailStart = rows.length;
        tail = {...event};
      }
      dirty = true;
    }
    flush();
    return rows;
  };
}

// Only use model metadata from the latest attempt, never a previous turn's default.
export function activeModel(events, provider, configured) {
  const route = events.findLastIndex(e => e.kind === 'route');
  if (route >= 0 && events[route].provider === provider && events[route].model === (configured || 'default')) {
    const reported = events.slice(route + 1).findLast(e => e.kind === 'model' && e.provider === provider);
    if (reported) return clean(reported.model);
  }
  return configured ? clean(configured) : 'Default (not reported)';
}

// Derive a small, local recap from successful turns; never summarize tool intents
// as completed work. Incremental consumption keeps the activity timer inexpensive.
export function createWorkSummary() {
  let source, consumed = 0, items = [], response = '';
  return events => {
    if (source !== events || events.length < consumed) {
      source = events; consumed = 0; items = []; response = '';
    }
    for (; consumed < events.length; consumed++) {
      const event = events[consumed];
      if (event.kind === 'user' || event.kind === 'route') response = '';
      if (event.kind === 'assistant') response = event.text || '';
      if (event.kind === 'delta') response += event.text || '';
      if (event.kind === 'result' && event.success && event.text && event.text !== 'Turn completed') response = event.text;
      if (event.kind !== 'turn') continue;
      if (event.text === 'completed') {
        const lines = clean(response).split('\n').map(line => line
          .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`_]/g, '').trim());
        const summary = lines.find(line => line && !/^(?:summary|changes|done|completed|tests|implementation)[:.!]?$/i.test(line));
        items.push(summary || 'Completed turn');
      }
      response = '';
    }
    return items;
  };
}

// Keep every item's text intact; the transcript renderer wraps to the terminal width.
export function workReview(items) {
  if (!items.length) return 'No completed turns yet.';
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n\n');
}

// Phase 6 §A1 — the TUI as a peer. Pure view reducers over session.events, exactly like every
// other reducer in src/reducers.js: no IO, no clock. src/cli.js's /tasks and /agents panes are a
// thin map over these; they carry no business logic of their own.

// Same rootOf rule as reducers.js budgets()/spend(): a replacement belongs to the root of the
// task it replaces; otherwise walk up parent links; a cycle (only possible from a directly
// journaled row) ends at the first revisited id.
function rootOf(taskView, id, seen = new Set()) {
  const t = taskView[id];
  if (!t || seen.has(id)) return id;
  seen.add(id);
  if (t.replaces && taskView[t.replaces]) return rootOf(taskView, t.replaces, seen);
  if (t.parent && taskView[t.parent]) return rootOf(taskView, t.parent, seen);
  return id;
}

// taskTree(events) → an ordered array (parents before children, depth-first, submit order
// within a level) of task-tree pane rows. remainingStarts/remainingRounds come from the task's
// root's budget remainder; null when that root has no allowance for the key at all (as opposed
// to zero, which means the allowance is simply spent).
// Why a task ended, for the fold row / AGENTS pane / board: a scheduler refusal (task.failed
// reason + text) must be visible — two real submissions were once refused for size and the
// TUI showed nothing but 'queued'.
function outcomeOf(t) {
  if (t.state === 'failed') return `${t.reason ?? 'failed'}${t.error ? `: ${t.error}` : ''}`;
  if (t.state === 'timed_out') return 'deadline exceeded';
  if (t.state === 'cancelled') return 'cancelled';
  if (t.state === 'rejected') return 'rejected';
  if ((t.state === 'completed' || t.state === 'accepted') && t.summary) return t.summary;
  return null;
}
export function taskTree(events) {
  const taskView = tasks(events);
  const budgetView = budgets(events);
  const tierByTask = {};
  for (const e of events) if (e.kind === 'task.delivered') tierByTask[e.task] = e.tier;
  // Per-worker meta for the AGENTS pane: which adapter is running it (peer.joined), the model it
  // was launched on and when it first started (task.started). Pure — read straight off the log.
  const metaByTask = {};
  for (const e of events) {
    if (e.kind === 'peer.joined' && typeof e.name === 'string' && e.name.startsWith('worker:')) (metaByTask[e.name.slice(7)] ??= {}).adapter = e.adapter ?? null;
    if (e.kind === 'task.started') { const m = (metaByTask[e.task] ??= {}); if (m.startedAt == null) m.startedAt = e.time; m.model = e.requested || null; }
  }
  const order = [];
  const seen = new Set();
  for (const e of events) if (e.kind === 'task.submitted' && typeof e.task === 'string' && e.task && !seen.has(e.task)) { seen.add(e.task); order.push(e.task); }
  const roots = order.filter(id => !taskView[id].parent);
  const rows = [];
  const visit = (id, depth) => {
    const t = taskView[id];
    const remaining = budgetView.roots[rootOf(taskView, id)]?.remaining ?? {};
    rows.push({
      task: id, depth, profile: t.profile, state: t.state,
      lastMilestone: t.lastMilestone?.text ?? null,
      deadline: t.deadline ?? null,
      remainingStarts: Object.prototype.hasOwnProperty.call(remaining, 'starts') ? remaining.starts : null,
      remainingRounds: Object.prototype.hasOwnProperty.call(remaining, 'rounds') ? remaining.rounds : null,
      blocker: t.state === 'blocked' ? t.blocker : null,
      tier: tierByTask[id] ?? null,
      adapter: metaByTask[id]?.adapter ?? null,
      model: metaByTask[id]?.model ?? null,
      startedAt: metaByTask[id]?.startedAt ?? null,
      outcome: outcomeOf(t),
    });
    for (const child of t.children) visit(child, depth + 1);
  };
  for (const id of roots) visit(id, 0);
  return rows;
}

// The legacy conversation kinds a context pane shows directly; every other kind either folds
// (task.submitted, into a single row) or is invisible here (task.activity and friends are live-
// only and never reach session.events at all — see src/core.js LIVE_KINDS).
const FOLDED_THREAD_KINDS = new Set(['user', 'assistant', 'delta', 'tool', 'error', 'note', 'aside', 'route', 'turn', 'status', 'review', 'handoff']);
// A row with no context at all predates the context field (pre-Phase-1 journals) and only ever
// occurred at the session root, so it always belongs wherever it is asked for.
const belongsToContext = (row, context) => row.context === context || row.context === undefined;
function foldRowText(t) {
  const detail = (t.state === 'blocked' ? t.blocker : null) ?? outcomeOf(t) ?? t.lastMilestone?.text ?? 'queued';
  return `${t.profile} · ${t.state} · ${detail}`;
}

// foldedThread(events, context) → the rows to show in the transcript pane for one context: every
// legacy conversation row belonging to it, plus one `task.fold` row per child task submitted
// from it, inserted at the position of that task's own task.submitted and always reflecting the
// task's CURRENT (not submit-time) state — this is what keeps a blocker visible without ever
// showing the child's own transcript (A3).
export function foldedThread(events, context) {
  const taskView = tasks(events);
  const folded = new Set();
  const rows = [];
  for (const e of events) {
    if (e.kind === 'task.submitted') {
      if (typeof e.task === 'string' && e.task && !folded.has(e.task) && belongsToContext(e, context)) {
        folded.add(e.task);
        const t = taskView[e.task];
        rows.push({kind: 'task.fold', task: e.task, state: t.state, reason: t.reason ?? null, text: foldRowText(t)});
      }
      continue;
    }
    if (FOLDED_THREAD_KINDS.has(e.kind) && belongsToContext(e, context)) rows.push(e);
  }
  return rows;
}

// workerThread(events, task, activity) → the rows to show inside one worker's agent pane:
// that task's own journaled lifecycle rows (submitted, started, milestones, blockers, deliveries,
// rework, terminal outcome), every message addressed to it (as `user` rows), and its live
// activity — which is never journaled (task.activity is a LIVE_KIND), so the caller keeps it in
// memory and passes it in as [{time, text}] — merged by time. Rows use the formatter's own kinds,
// labelled with the worker's profile, so the classic formatter renders the full detail (zoom) and
// the compact one folds it (attach). Pure: no focus state, no session, no I/O.
const WORKER_ROW = {
  'task.submitted': e => ({kind: 'note', text: `Task submitted · ${e.profile}${e.orders ? `\n${e.orders}` : ''}`}),
  'task.started': e => ({kind: 'status', text: `started · attempt ${e.attempt}${e.requested ? ` · model ${e.requested}` : ''}`}),
  'task.milestone': e => ({kind: 'note', text: `milestone · ${e.text}`}),
  'task.blocked': e => ({kind: 'error', text: `blocked · ${e.text}`}),
  'task.delivered': e => ({kind: 'status', text: `delivered (${e.tier})${e.text ? ` · ${e.text}` : ''}`}),
  'task.rework': e => ({kind: 'status', text: `rework round ${e.round}${Array.isArray(e.findings) && e.findings.length ? `\n${e.findings.map(f => `- ${typeof f === 'string' ? f : f.text ?? JSON.stringify(f)}`).join('\n')}` : ''}`}),
  'task.deadline': e => ({kind: 'error', text: e.text}),
  'task.completed': e => ({kind: 'assistant', text: e.summary || 'completed'}),
  'task.failed': e => ({kind: 'error', text: `failed · ${e.reason}${e.text ? ` · ${e.text}` : ''}`}),
  'task.cancelled': () => ({kind: 'status', text: 'cancelled'}),
  'task.accepted': e => ({kind: 'status', text: `accepted · ${e.stage}`}),
  'task.rejected': e => ({kind: 'status', text: `rejected${Array.isArray(e.questions) && e.questions.length ? `\n${e.questions.map(q => `- ${q}`).join('\n')}` : ''}`}),
};
export function workerThread(events, task, activity = []) {
  const submitted = events.find(e => e.kind === 'task.submitted' && e.task === task);
  const adapter = events.find(e => e.kind === 'peer.joined' && e.name === `worker:${task}`)?.adapter;
  const profile = [submitted?.profile ?? 'worker', adapter].filter(Boolean).join(' · ');
  const rows = [];
  for (const e of events) {
    if (e.kind === 'message' && e.to === `worker:${task}`) { rows.push({kind: 'user', time: e.time, text: e.text}); continue; }
    if (e.task !== task) continue;
    const make = WORKER_ROW[e.kind];
    if (make) rows.push({provider: profile, time: e.time, ...make(e)});
  }
  for (const a of activity) rows.push({kind: 'status', provider: profile, time: a.time, text: a.text});
  // Stable by time (ISO strings compare lexically); rows without a time keep their position.
  return rows.map((row, i) => [row, i]).sort(([a, i], [b, j]) => (a.time && b.time && a.time !== b.time) ? (a.time < b.time ? -1 : 1) : i - j).map(([row]) => row);
}

// agentsBoard(events, activityByTask) → every worker for the central agent workspace
// task): each taskTree() row plus that worker's last live activity lines (never journaled, kept in
// memory by the caller as task -> [{time, text}]) and, once terminal, its outcome as the final
// line. Pure; the terminal draw only decides how many lines of each fit.
const TERMINAL_LINE = {
  'task.completed': e => `→ completed${e.summary ? ` · ${e.summary}` : ''}`,
  'task.failed': e => `→ failed · ${e.reason}${e.text ? ` · ${e.text}` : ''}`,
  'task.cancelled': () => '→ cancelled',
  'task.accepted': e => `→ accepted · ${e.stage}`,
  'task.rejected': () => '→ rejected',
};
export function agentsBoard(events, activityByTask = new Map(), {tail = 40} = {}) {
  const outcome = {};
  for (const e of events) if (TERMINAL_LINE[e.kind] && e.task) outcome[e.task] = TERMINAL_LINE[e.kind](e);
  return taskTree(events).map(row => {
    const activity = activityByTask.get(row.task) ?? [];
    const lines = activity.slice(-tail).map(a => a.text.split('\n')[0]);
    if (outcome[row.task]) lines.push(outcome[row.task]);
    return {...row, lines, lastActivityAt: activity.findLast(item => !item.startup)?.time ?? null};
  });
}

// agentsWorkspace(events, activityByTask, orchestrator) → the complete /agents view model.
// The orchestrator has a stable first pane; each non-terminal worker is then represented once,
// with the same lifecycle state and live-activity tail used by agentsBoard(). Panes are ephemeral:
// completed/cancelled/failed work remains in the normal task history but leaves this live workspace.
// Rendering and focus stay outside this reducer, so a resize cannot discard a checkpoint or
// fabricate progress.
export function agentsWorkspace(events, activityByTask = new Map(), orchestrator = {}) {
  const panes = [{id: 'orchestrator', kind: 'orchestrator', ...orchestrator}];
  const checkpoints = new Map();
  for (const event of events) if (event.kind === 'task.milestone' && event.task) checkpoints.set(event.task, event);
  for (const worker of agentsBoard(events, activityByTask).filter(row => !TERMINAL.has(row.state))) {
    const checkpoint = checkpoints.get(worker.task);
    panes.push({id: `worker:${worker.task}`, kind: 'worker', ...worker,
      phase: checkpoint?.phase ?? null, next: checkpoint?.next ?? null,
      evidence: checkpoint?.evidence ?? null, checkpointAt: checkpoint?.time ?? null});
  }
  return {panes};
}

function paneSplit(size) {
  const first = Math.max(0, Math.floor((size - 1) / 2));
  return [first, Math.max(0, size - first - 1)];
}

// paneGrid(count, width, height) → exact rectangles for the readable /agents workspace. One
// character is reserved between adjacent panes. The fifth and later panes remain in the model but
// are reported as overflow, rather than squeezing every pane below a usable size.
export function paneGrid(count, width, height) {
  const total = Math.max(0, Math.floor(Number(count) || 0));
  const columns = Math.max(0, Math.floor(Number(width) || 0));
  const rows = Math.max(0, Math.floor(Number(height) || 0));
  const visible = Math.min(total, 4);
  const remaining = total - visible;
  if (!visible) return {visible: 0, remaining, panes: []};
  if (visible === 1) return {visible, remaining, panes: [{x: 0, y: 0, width: columns, height: rows}]};

  const [leftWidth, rightWidth] = paneSplit(columns);
  if (visible === 2) return {visible, remaining, panes: [
    {x: 0, y: 0, width: leftWidth, height: rows},
    {x: leftWidth + 1, y: 0, width: rightWidth, height: rows},
  ]};

  const [topHeight, bottomHeight] = paneSplit(rows);
  if (visible === 3) return {visible, remaining, panes: [
    {x: 0, y: 0, width: leftWidth, height: rows},
    {x: leftWidth + 1, y: 0, width: rightWidth, height: topHeight},
    {x: leftWidth + 1, y: topHeight + 1, width: rightWidth, height: bottomHeight},
  ]};
  return {visible, remaining, panes: [
    {x: 0, y: 0, width: leftWidth, height: topHeight},
    {x: leftWidth + 1, y: 0, width: rightWidth, height: topHeight},
    {x: 0, y: topHeight + 1, width: leftWidth, height: bottomHeight},
    {x: leftWidth + 1, y: topHeight + 1, width: rightWidth, height: bottomHeight},
  ]};
}

// boardLayout(agentCount, lineCounts, height) → how many activity lines each agent gets on a
// board of `height` rows where every shown agent costs one header row: agents share the rest
// evenly (an agent with fewer lines than its share yields the rest to the others, greedily in
// order); when not every agent fits with at least one line, `shown` is how many lead agents
// are drawn and the last row announces the rest. Pure.
export function boardLayout(lineCounts, height) {
  const n = lineCounts.length;
  if (!n || height <= 0) return {shown: 0, lines: [], more: n};
  let shown = n, more = 0;
  if (n * 2 > height) { shown = Math.max(1, Math.floor((height - 1) / 2)); more = n - shown; }
  const budgetRows = height - shown - (more ? 1 : 0);
  const lines = new Array(shown).fill(0);
  let left = Math.max(0, budgetRows);
  // Even share first, then hand any yielded rows to agents that still have lines to show.
  const share = Math.floor(left / shown);
  for (let i = 0; i < shown; i++) { lines[i] = Math.min(share, lineCounts[i]); left -= lines[i]; }
  for (let i = 0; i < shown && left > 0; i++) { const extra = Math.min(left, lineCounts[i] - lines[i]); lines[i] += extra; left -= extra; }
  return {shown, lines, more};
}

// withAsides(text, asides) → the prompt for the next turn with the user's /btw notes folded in
// front of it. /btw never starts a turn of its own: it is for the thing you want the agent to
// know without interrupting what it is doing. Pure.
export function withAsides(text, asides = []) {
  if (!asides.length) return text;
  return `By the way — notes from the user while you were working:\n${asides.map(a => `- ${a}`).join('\n')}\n\n${text}`;
}

// One glyph per task state, shared by the transcript's delegation rows and the AGENTS pane
// (the way Claude Code marks ⏺ steps and Codex marks • actions): a reader sees the outcome
// before reading a word. Pure.
export function stateGlyph(state) {
  if (state === 'queued') return '◌';
  if (state === 'running' || state === 'waiting' || state === 'reviewing') return '●';
  if (state === 'blocked' || state === 'input_required') return '◐';
  if (state === 'completed' || state === 'accepted') return '✔';
  if (state === 'failed' || state === 'timed_out' || state === 'cancelled' || state === 'rejected') return '✗';
  return '·';
}

// What a person can do about a failed task, from the scheduler's reason and the vendor's text.
// A failure with no next step reads as "bounce is broken"; this is the line under the ✗. Pure.
export function failureHint(reason, text = '') {
  const t = String(text || '');
  if (reason === 'missing') return 'that vendor CLI is not installed or not signed in · /login <vendor>, or change the profile\'s adapter';
  if (reason === 'limited') return 'the vendor is out of quota · /quota shows the windows; add a `fallback` profile or wait for the reset';
  if (reason === 'size') return 'the task exceeds a configured size limit · split it, or raise `limits` in the config';
  if (reason === 'depth') return 'the delegation tree is deeper than allowed · submit from the root instead';
  if (reason === 'dependency') return 'a task it depends on failed · fix that one first, then resubmit';
  if (reason === 'unsupported' || reason === 'policy') return 'the profile\'s execution policy is not supported by its adapter · change `policy` or the adapter';
  if (reason === 'orphaned') return 'the daemon restarted while it ran · resubmit the task';
  if (reason === 'baseline') return 'the workspace no longer matches the submitted baseline · resubmit against the current tree';
  if (reason === 'strategy') return 'the orchestration strategy returned a malformed decision · check the strategy config';
  if (/invalid request|missing field|invalid type|method not found|clientInfo/i.test(t)) return 'the vendor CLI speaks a different protocol version than bounce expects · update bounce (or the vendor), then resubmit';
  if (/ENOENT|not found|spawn/i.test(t)) return 'the vendor executable could not be started · check `executables` in the config and /login';
  if (/EACCES|permission/i.test(t)) return 'a permission problem starting the worker · check the workspace and the profile\'s mode';
  return 'see the full row with /agents <task>, then resubmit or /stop';
}

const BRIEF_LINE = /^You are the orchestrator peer of session /;
// The typed turn without the orchestrator's brief line in front of it (the reader typed only the rest).
export function withoutBrief(text) {
  const lines = String(text ?? '').split('\n');
  return (lines.length > 1 && BRIEF_LINE.test(lines[0]) ? lines.slice(1) : lines).join('\n');
}

// Phase 6 §A2 — pure command parsing, shared by src/cli.js's submit() dispatch and directly
// testable without a terminal. A line that is not a slash command returns null.
export function parseCommand(text) {
  if (!/^\/[a-z]+(?:\s|$)/i.test(text)) return null;
  const [command, ...parts] = text.slice(1).split(/\s+/);
  return {command, parts, arg: parts.join(' ')};
}

// The ONLY logic that decides whether /continue <profile> may start a new main turn. Pure: it
// takes the orchestration profile table and the requested name, nothing shaped like a
// session event — so nothing that folds session.events (a subscriber) could call it even by
// accident. Only the keyboard's /continue handler in src/cli.js calls it, after the user
// presses Enter; see CONTRACT.md A2/U5 and docs/local-orchestration.md "Reducers and policies".
export function continueMain(profiles, name) {
  if (!name || !Object.prototype.hasOwnProperty.call(profiles || {}, name) || profiles[name].policy === 'read-only') {
    return {ok: false, error: 'no such profile'};
  }
  return {ok: true, profile: name};
}
