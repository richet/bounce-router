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
  if (!isWorking(pane.state) && model && !fits([...tail].length + 1) && FIXED[pane.state] && fits(0)) return `${head} ${model}`;
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

// The colour of a row. A worker that is "working" but has said nothing for two minutes is the one
// to look at: that, not the word running, is what a stall looks like.
export const STALL_MS = 120_000;
export function rowColor(pane, now = Date.now()) {
  if (isWorking(pane.state)) { const quiet = Number(now) - Date.parse(pane.activityAt ?? pane.updatedAt ?? pane.startedAt); return quiet >= STALL_MS ? 'red' : 'yellow'; }
  return {completed: 'green', accepted: 'green', failed: 'red', cancelled: 'red', timed_out: 'red', rejected: 'red', blocked: 'red', input_required: 'magenta', queued: 'gray'}[pane.state];
}
