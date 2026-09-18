// One source for what bounce can do: `bounce --help` prints it as plain text and /help paints it
// in the transcript. Commands are grouped by what the user is trying to do rather than the order
// they were added, so the eye lands on a heading before it reads a row.
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';

export const TAGLINE = 'one terminal, your coding agents';

// A row is [name, argument hint, description]. The hint is painted apart from the name so the
// part you type verbatim stands out from the part you fill in.
export const CLI_USAGE = [
  ['bounce', '[--cwd PATH] [--resume ID] [--provider NAME] [--model ID]', 'Open the interactive view'],
  ['bounce run', '"prompt" [--image PATH ...] [--cwd PATH] [--json] [--mode yolo|plan] [--detach]', 'Run one prompt'],
  ['bounce attach', 'ID [--json]', 'Reopen its interactive view; --json streams the journal'],
  ['bounce stop', 'ID', 'Cancel a running session\'s task tree and exit its daemon'],
  ['bounce publish', '--event JSON|@FILE [--json]', 'One-process bridge: publish an event'],
  ['bounce report', '--report JSON|@FILE [--json]', 'Worker: report progress or final outcome'],
  ['bounce wait', '--match JSON --timeout SECONDS [--after-seq N] [--json]', 'Bridge: wait for one event'],
  ['bounce login', 'claude|codex|muse', 'Open the vendor\'s native login flow'],
  ['bounce models', '[--json]', 'List the models each agent reports, cloud and local'],
  ['bounce local models', '[--json]', 'Discover local models without loading them'],
  ['bounce local setup', '', 'Guided model recommendation and worker configuration'],
  ['bounce local profile', 'NAME JSON [--save]', 'Preview/add a local worker; writes require explicit scope'],
  ['bounce local check', '[IMAGE]', 'Diagnose Docker/image/project setup (no build)'],
  ['bounce local prepare', '[IMAGE] [--allow-network]', 'Explicitly cache Linux npm dependencies'],
  ['bounce quota', '[--json]', 'Show the subscription usage each agent reports'],
  ['bounce jev', '[key KEY|key clear|on|off|review on|off|routing on|off|roster [refresh]|model ID|confidence N|test]', 'Jev (TypeSafe) decision model; no arg shows status'],
  ['bounce skills', '[list|sync|new NAME|add PATH|remove NAME|import [NAME] [--list]|clear|reset] [--scope user|project]', 'Manage the skills bounce installs into every agent'],
  ['bounce sessions', '[--json]', 'List sessions: name, age, mode, id, workspace (● = live)'],
  ['bounce rename', 'SESSION NAME', 'Name a session (SESSION = name, id or id prefix; --resume takes the same)'],
  ['bounce task compare', 'SESSION A B', 'Built-in A/B: compare two tasks (tokens, wall, rounds) from the log'],
  ['bounce doctor', '', 'Report workspace, data dir, mode, order and each agent\'s version and quota'],
  ['bounce update', '[--check]', 'Check for or install the latest npm release'],
  ['bounce dev', '', 'Improve bounce itself; validate/reload after changes'],
];

export const TUI_SECTIONS = [
  {title: 'Agents & models', rows: [
    ['/provider', 'NAME', 'Select and save the default agent'],
    ['/model', '', 'Pick from every model your signed-in agents report'],
    ['/model', 'ID', 'Set the selected agent\'s model; "default" resets'],
    ['/model refresh', '', 'Re-ask each agent for its catalog, then pick'],
    ['/model worker', 'PROFILE [auto|endpoint/model|refresh] [--save]', 'Select a local worker\'s model, not the main agent\'s'],
    ['/model worker', 'PROFILE prefer|exclude REF,REF [--save]', 'Edit local model preferences'],
    ['/order', '[claude,codex,muse]', 'Show the fallback order, or save a new one'],
    ['/mode', 'yolo|plan', 'YOLO is the default; plan uses restrictive provider flags'],
    ['/login', 'NAME', 'Open the vendor\'s native login flow'],
  ]},
  {title: 'Local workers', rows: [
    ['/local setup', '[loaded]', 'Guided local worker setup here; loaded limits choices to loaded models'],
    ['/local cancel', '', 'Cancel setup without interrupting agents'],
    ['/local activate', '[NAME]', 'Activate saved local workers in this session without restarting'],
  ]},
  {title: 'Orchestration', rows: [
    ['/operation', '[NAME]', 'Switch/pick classic|orchestrator; no arg opens a menu, Ctrl+O toggles'],
    ['/continue', 'PROFILE', 'Start an orchestrator turn on that profile'],
    ['/stop', '[TASK]', 'Cancel one task, or every running task with no arg'],
    ['/msg', 'TASK TEXT', 'Send a message to a running worker'],
    ['/agents', '[TASK]', 'Interactive split panes for the orchestrator and every worker; optionally focus one'],
    ['/tasks', '', 'Show task states and retained outcomes'],
    ['/jev', '', 'Jev (TypeSafe) decision model status: key (last 4 chars), model, review/routing flags; /jev help lists subcommands'],
    ['/jev key', '[KEY|clear]', 'Store the API key in a 0600 file (TYPESAFE_API_KEY overrides); no KEY opens a masked prompt'],
    ['/jev', 'on|off', 'Enable everything Jev does (verdicts and routing); also /jev review on|off · /jev routing on|off · /jev roster [refresh] · /jev model ID · /jev confidence N · /jev test'],
  ]},
  {title: 'Session', rows: [
    ['/new', '', 'Start a new session in this workspace'],
    ['/rename', 'NAME', 'Name this session'],
    ['/resume', '[SESSION]', 'Resume another session here; no arg opens a picker'],
    ['/sessions', '', 'List this workspace\'s sessions'],
    ['/note', 'TEXT', 'Save a durable handoff note'],
    ['/btw', 'TEXT', 'Steer the focused agent live; when idle, save an aside for its next turn'],
    ['/review', '', 'Show the full text of every session work item'],
    ['/detach', '', 'Close this view; orchestrator and workers keep running'],
    ['/quit', '', 'Stop this session and exit (Esc cancels an active turn)'],
  ]},
  {title: 'Skills', rows: [
    ['/skills', '', 'List bounce skills and where each agent has them'],
    ['/skills sync', '', 'Install them into every agent\'s skills directory'],
    ['/skills new', 'NAME', 'Scaffold a SKILL.md under ~/.bounce/skills'],
    ['/skills add', 'PATH', 'Adopt a skill folder or SKILL.md into bounce'],
    ['/skills remove', 'NAME', 'Delete it from bounce and from every agent'],
    ['/skills import', '[NAME]', 'Pick from the skills an agent already has'],
    ['/skills clear', '', 'Remove every copy bounce installed'],
    ['/skills reset', '', 'Delete every bounce skill and withdraw its copies'],
    ['/skills seed', '--force', 'Reinstall the skills bounce ships, including ones you deleted'],
  ]},
  {title: 'View & housekeeping', rows: [
    ['/details', '[on|off]', 'Expand or fold tool output and worker dispatch details'],
    ['/sidebar', '[on|off]', 'Show or hide the status sidebar (saved; needs a 100-column terminal)'],
    ['/quota', '', 'Show the subscription usage each agent reports'],
    ['/retry', '', 'Clear locally recorded quota cooldowns'],
    ['/update', '[check]', 'Install the latest npm release, or only check'],
    ['/restart', '', 'Test and reload updated code, keeping this session'],
    ['/help', '', 'Show this help'],
  ]},
];

export const KEYS = [
  ['/', '', 'Command picker'],
  ['Tab', '', 'Complete a command, or move to the next agent pane'],
  ['Enter', '', 'Send; while an agent works, queue the next message'],
  ['Shift+Enter', '', 'Newline (Alt+Enter and Ctrl+J too)'],
  ['↑/↓', '', 'Prompt history'],
  ['PgUp/PgDn', '', 'Scroll the transcript (the mouse wheel does too)'],
  ['F2', '', 'Pause the view for copying'],
  ['F3', '', 'Mouse scroll off, so click-drag selects text'],
  ['Ctrl+O', '', 'Toggle classic/orchestrator'],
  ['Ctrl+U', '', 'Clear the input'],
  ['Ctrl+C', '', 'Cancel the turn; exit when idle'],
  ['Esc', '', 'Cancel an active turn or close a picker'],
];

export const NOTES = [
  'Drop PNG/JPEG/GIF/WebP files into your prompt, then press Enter to send.',
  'Node.js 22+. Config and journals live in BOUNCE_HOME or ~/.bounce.',
  'YOLO disables provider approvals and sandboxing. Native CLI credentials stay with the vendors.',
  'Model names are passed through to each CLI. Quota comes from the agents themselves: Codex answers on demand, Claude reports its windows while a turn runs, Muse reports none.',
];

// Agents' own commands (vendor-commands.js rows: name, description, hint) as help rows.
export const vendorSection = rows => rows.length ? {
  title: 'Commands your agents keep here',
  note: 'Expanded by bounce, so they work whichever agent answers.',
  rows: rows.map(([name, description, hint]) => [`/${name}`, hint ?? '', description]),
} : null;

const noPaint = {title: s => s, name: s => s, hint: s => s, text: s => s, muted: s => s, key: s => s};
// Widest label that still leaves room for a description; anything wider stands on its own line.
// A narrow pane lowers the cap so the description column keeps at least half the line.
const LABEL_CAP = 28;
const labelCap = width => Math.min(LABEL_CAP, Math.floor(width * 0.4));
const GUTTER = 2;

const wrapText = (text, width) => wrapAnsi(text, Math.max(1, width), {hard: true}).split('\n');
const labelWidth = ([name, hint]) => stringWidth(name) + (hint ? 1 + stringWidth(hint) : 0);
// Where descriptions start when these rows share one column: past the widest label that fits.
export const descriptionColumn = (rows, {indent = 0, width = 100} = {}) => {
  const fitting = rows.map(labelWidth).filter(w => w <= labelCap(width));
  return indent + (fitting.length ? Math.max(...fitting) : 0) + GUTTER;
};

// A two-column table: labels (name + hint) share one column so the descriptions line up; a
// description wraps under itself, never back under the label. `column` lets several tables
// share one description column; a label too wide for it stands on its own line.
export function tableRows(rows, {width = 100, indent = 2, paint = {}, key = false, column = descriptionColumn(rows, {indent, width})} = {}) {
  const p = {...noPaint, ...paint};
  const labelOf = ([name, hint]) => (key ? p.key(name) : p.name(name)) + (hint ? ' ' + p.hint(hint) : '');
  const lead = ' '.repeat(indent);
  // A label longer than the line continues under its own hint, not back at the name; when
  // even that leaves no room, it continues one step in from the name.
  const labelLines = ([name, hint]) => {
    const painted = key ? p.key(name) : p.name(name);
    if (!hint) return wrapText(painted, width - indent).map(line => lead + line);
    const hang = indent + stringWidth(name) + 1;
    if (width - hang < 12) return wrapText(painted + ' ' + p.hint(hint), width - indent - GUTTER).map((line, index) => (index ? ' '.repeat(indent + GUTTER) : lead) + line);
    return wrapText(p.hint(hint), width - hang).map((line, index) => (index ? ' '.repeat(hang) : lead + painted + ' ') + line);
  };
  // A narrow pane cannot hold two columns: stack every description under its label instead.
  const stacked = width - column < 24;
  const out = [];
  for (const row of rows) {
    const label = labelOf(row), labelCols = labelWidth(row), description = row[2] ?? '';
    if (!description) { out.push(...labelLines(row)); continue; }
    if (stacked || indent + labelCols + GUTTER > column) {
      const inner = ' '.repeat(indent + GUTTER);
      out.push(...labelLines(row));
      out.push(...wrapText(description, width - inner.length).map(line => inner + p.text(line)));
      continue;
    }
    const body = wrapText(description, width - column);
    out.push(lead + label + ' '.repeat(column - indent - labelCols) + p.text(body[0]));
    out.push(...body.slice(1).map(line => ' '.repeat(column) + p.text(line)));
  }
  return out;
}

const sectionRows = (section, {width, paint, column, key = false}) => {
  const p = {...noPaint, ...paint};
  return [
    p.title(section.title),
    ...(section.note ? wrapText(section.note, width).map(line => p.muted(line)) : []),
    ...tableRows(section.rows, {width, indent: 2, paint, key, column}),
    '',
  ];
};

// Every row of the help, painted (or not). `vendor` adds the agents' own commands; `tui` puts
// the TUI's commands first because that is where the reader is; `bounce --help` leads with usage.
export function helpRows({width = 100, paint = {}, vendor = [], tui = false} = {}) {
  const p = {...noPaint, ...paint};
  const sections = [...TUI_SECTIONS, vendorSection(vendor)].filter(Boolean);
  // Every slash-command section shares one description column, so the eye tracks a single
  // edge from heading to heading; usage and keys are shaped differently and align on their own.
  const column = descriptionColumn(sections.flatMap(section => section.rows), {indent: 2, width});
  const commands = sections.flatMap(section => sectionRows(section, {width, paint, column}));
  const usage = sectionRows({title: 'Command line', rows: CLI_USAGE}, {width, paint});
  const keys = sectionRows({title: 'Keys', rows: KEYS}, {width, paint, key: true});
  const notes = NOTES.flatMap(note => wrapText(note, width).map(line => p.muted(line)));
  // The transcript already labels the block; only the command line needs the banner.
  const banner = tui ? [] : [`${p.name('bounce')} ${p.muted('— ' + TAGLINE)}`, ''];
  return [
    ...banner,
    ...(tui ? [...commands, ...keys, ...usage] : [...usage, ...commands, ...keys]),
    ...notes,
  ];
}

// `bounce --help`: plain text, usage first.
export const helpText = (width = 100) => helpRows({width}).join('\n');
