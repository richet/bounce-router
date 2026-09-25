// "Is it still working?" answered at a glance: a glyph that moves while something works, the model
// it runs on, and how long since it last did anything. Pure, so the rail, the header and the pane
// titles say the same thing and a frame is a function of the clock.
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 120;
const WORKING = new Set(['running', 'working', 'starting']);
const FIXED = {queued: '◌', completed: '✓', accepted: '✓', failed: '✗', cancelled: '✗', timed_out: '✗', rejected: '✗', blocked: '!', input_required: '?'};

export const isWorking = state => WORKING.has(state);
export const glyph = (state, now = Date.now()) => isWorking(state) ? SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] : FIXED[state] ?? '●';

// A model by its identifier. The provider path and the packaging of a local build (format,
// quantisation, tuning) say nothing a person needs in a 30-column rail, and the whole name of a
// local model (`qwen3-coder-30b-a3b-instruct-mlx@4bit`) never fits it.
export function shortModel(model) {
  const id = String(model ?? '').split('/').pop().replace(/\[[^\]]*\]$/, '').replace(/@.*$/, '');
  return id.split('-').filter(part => !/^(mlx|gguf|instruct|\d+bit|q\d\w*|fp\d+|bf\d+)$/i.test(part)).join('-');
}

export function quietFor(time, now = Date.now()) {
  const elapsed = Number(now) - Date.parse(time);
  if (!time || !Number.isFinite(elapsed)) return '';
  if (elapsed < 1000) return 'now';
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}s`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  return `${Math.floor(elapsed / 3_600_000)}h`;
}

// One row: glyph, the job (a routed `agent@ai` profile shows the agent), the model, then either the
// time since it last did something (while working) or its state. The model gives way first.
export function agentRow(pane, now = Date.now(), width = 30) {
  const [name, routed = ''] = String(pane.profile ?? '').split('@');
  const model = shortModel(pane.model || routed);
  const tail = isWorking(pane.state) ? quietFor(pane.activityAt ?? pane.updatedAt ?? pane.startedAt, now) : pane.state ?? '';
  // Spaces, not dots, between the parts: `⠋ builder qwen3-coder-next 12s` is exactly the rail's 30 columns.
  const head = `${glyph(pane.state, now)} ${name}`;
  const fits = extra => [...head].length + 1 + [...model].length + extra <= width;
  // A finished row that is too long drops the word before it shortens the model: ✓ and ✗ already say it.
  // `!` and `?` do not: a blocked row without its word read as a crash (observed live), so it keeps it.
  if (!isWorking(pane.state) && !WAITING.has(pane.state) && model && !fits([...tail].length + 1) && FIXED[pane.state] && fits(0)) return `${head} ${model}`;
  const room = width - [...head].length - 1 - (tail ? [...tail].length + 1 : 0);
  const shown = [...model].length <= room ? model : room >= 4 ? `${[...model].slice(0, room - 1).join('')}…` : '';
  return [head, shown, tail].filter(Boolean).join(' ');
}

// Under a working agent's row: the phase it last reported and how long ago that milestone was. A
// spinner and a quiet time cannot tell steady progress from spinning; this can. Found live: seven
// milestones in forty minutes ("baseline 66 passed / 1 failed", "two seams green") and the rail
// showed none of them.
export function progressRow(pane, now = Date.now(), width = 30) {
  if (!isWorking(pane.state)) return '';
  if (!pane.phase) return '  └ no milestone yet';
  const tail = quietFor(pane.updatedAt, now);
  const room = width - 4 - (tail ? [...tail].length + 3 : 0);
  const phase = [...String(pane.phase)].length <= room ? String(pane.phase) : `${[...String(pane.phase)].slice(0, Math.max(1, room - 1)).join('')}…`;
  return `  └ ${phase}${tail ? ` · ${tail}` : ''}`;
}

// Under a blocked or input-required row: what it waits on, in words. Blocked is a decision someone
// owes, not a failure; the reason is the task.blocked row's own.
const WAITING = new Set(['blocked', 'input_required']);
const WAITING_ON = {
  review_not_accepted: "review didn't accept", review_uncertain: 'review unsure',
  review_unavailable: 'no review verdict', report_repair_unavailable: 'report not repaired',
  report_incomplete: 'reported work left', repeated_findings: 'same findings twice',
  termination_unverified: 'process may still run', rounds: 'review rounds used up',
};
export function waitingRow(pane, width = 30) {
  if (!WAITING.has(pane.state)) return '';
  const text = pane.state === 'input_required' ? 'needs your input' : WAITING_ON[pane.reason] ?? 'needs a decision';
  const room = width - 4;
  return `  └ ${[...text].length <= room ? text : `${[...text].slice(0, room - 1).join('')}…`}`;
}

// The colour of a row. A worker that is "working" but has said nothing for two minutes is the one
// to look at: that, not the word running, is what a stall looks like.
export const STALL_MS = 120_000;
export function rowColor(pane, now = Date.now()) {
  if (isWorking(pane.state)) { const quiet = Number(now) - Date.parse(pane.activityAt ?? pane.updatedAt ?? pane.startedAt); return quiet >= STALL_MS ? 'red' : 'yellow'; }
  return {completed: 'green', accepted: 'green', failed: 'red', cancelled: 'red', timed_out: 'red', rejected: 'red', blocked: 'magenta', input_required: 'magenta', queued: 'gray'}[pane.state];
}

// "What is it doing right now?" for any worker, the main one included, from what is already
// journaled. Found live: a main worker showed only a spinner for seven minutes; it was inside
// `bounce wait` on a task that was on its second attempt. Four answers: thinking, running a command
// (which one), waiting on a task (and that task's own state), or idle.
const TOOL_CALL = /^([A-Za-z_][\w.-]*): (\{[\s\S]*\})$/;
const WAIT_TASK = /bounce\s+wait\b[^]*?"task"\s*:\s*"([0-9a-f-]{8,})"/;
// One row at a time (so a projection can keep it incrementally); `tasks` only matters for a wait.
export function doingStep(state = {what: 'idle', since: null}, e, {tasks = {}} = {}) {
  if (e.kind === 'main.started' || e.kind === 'task.started') return {what: 'thinking', since: e.time};
  if (['main.terminal', 'main.blocked', 'task.completed', 'task.failed', 'task.cancelled', 'task.accepted'].includes(e.kind)) return {what: 'idle', since: e.time};
  if (e.kind === 'progress') return state.what === 'command' || state.what === 'waiting' ? state : {what: 'thinking', since: state.what === 'thinking' ? state.since : e.time};
  if (e.kind === 'assistant') return {what: 'thinking', since: e.time};
  if (e.kind === 'tool') {
    const m = TOOL_CALL.exec(String(e.text ?? '').trim());
    if (!m) return {what: 'thinking', since: e.time}; // a tool result: the command is over
    let input = {}; try { input = JSON.parse(m[2]); } catch {}
    const command = typeof input.command === 'string' ? input.command : '';
    const waitFor = WAIT_TASK.exec(command)?.[1];
    if (waitFor) {
      const target = Object.entries(tasks).find(([id]) => id.startsWith(waitFor));
      const [id, t] = target ?? [waitFor, null];
      const detail = t ? `${String(t.profile ?? '').split('@')[0]} ${t.state}${t.attempt > 1 || t.model ? ` (${[t.attempt > 1 ? `attempt ${t.attempt}` : '', t.model ? shortModel(t.model) : ''].filter(Boolean).join(', ')})` : ''}` : 'unknown task';
      return {what: 'waiting', task: id, text: `waiting on ${id.slice(0, 8)} · ${detail}`, since: e.time};
    }
    const what = String(input.description || input.file_path || input.path || command.split('\n')[0] || input.pattern || input.query || '').trim();
    return {what: 'command', text: `${m[1]}${what ? `: ${what}` : ''}`, since: e.time};
  }
  if (e.kind === 'task.activity' || e.kind === 'task.observed') {
    const text = String(e.text ?? '').trim();
    const mm = /^([A-Za-z_][\w.-]*) (running|started|completed|error)$/.exec(text);
    if (mm && (mm[2] === 'running' || mm[2] === 'started')) return {what: 'command', text: mm[1], since: e.time};
    if (mm) return {what: 'thinking', since: e.time};
    if (e.kind === 'task.observed') return {what: 'thinking', since: e.time};
  }
  return state;
}

export function doingNow(events, {tasks = {}, now = Date.now(), task = null} = {}) {
  const mine = events.filter(e => task ? e.task === task && ['task.started', 'task.activity', 'task.observed', 'task.completed', 'task.failed', 'task.cancelled', 'task.accepted'].includes(e.kind)
    : (e.from === 'main' || e.kind.startsWith('main.')) && ['main.started', 'main.terminal', 'main.blocked', 'tool', 'assistant', 'progress'].includes(e.kind));
  return mine.reduce((state, e) => doingStep(state, e, {tasks}), {what: 'idle', since: null});
}

// One line: a glyph for the kind of doing, the specifics trimmed to fit, and how long it has been so.
export function doingLine(doing, now = Date.now(), width = 30) {
  if (!doing || doing.what === 'idle') return '';
  const glyph = {thinking: '…', command: '⚙', waiting: '⏳'}[doing.what] ?? '·';
  const tail = quietFor(doing.since, now);
  const full = doing.what === 'thinking' ? 'thinking' : doing.text ?? doing.what;
  const room = width - [...glyph].length - 1 - (tail ? [...tail].length + 3 : 0);
  let text = full;
  if ([...text].length > room) {
    // keep the first meaningful part: for a wait, "waiting on <id>"; else clip with an ellipsis
    const head = doing.what === 'waiting' ? full.split(' · ')[0] : null;
    text = head && [...head].length <= room ? head : `${[...full].slice(0, Math.max(1, room - 1)).join('')}…`;
  }
  return `${glyph} ${text}${tail ? ` · ${tail}` : ''}`;
}
