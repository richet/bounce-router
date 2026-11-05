// One source for what bounce can do: `bounce --help` prints it as plain text and /help paints it
// in the transcript. Commands are grouped by what the user is trying to do rather than the order
// they were added, so the eye lands on a heading before it reads a row.
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import stripAnsi from 'strip-ansi';

export const TAGLINE = 'one terminal, your coding agents';

// `bounce --help`, laid out like `ace --help`: a usage line, commands grouped by what you are trying to
// do (named without the repeated `bounce`), one description column, then the options. A row is
// [command, argument hint, description]; the hint is painted apart in /help so the part you type
// verbatim stands out from the part you fill in.
export const CLI_USAGE_LINES = [
  ['bounce [options]', 'Open the interactive view'],
  ['bounce <command> [options]', 'Run one command'],
];

export const CLI_SECTIONS = [
  {title: 'Sessions', rows: [
    ['run', '"prompt" [--image <path> ...] [--mode yolo|plan] [--detach]', 'Run one prompt; --detach keeps it in the background'],
    ['sessions', '', 'List sessions: name, age, mode, id, workspace (● = live)'],
    ['attach', '<session>', 'Reopen a session\'s view; --json streams its journal'],
    ['send', '[--session <ref>] [--wait] [--caller <who>] "message"', 'Message a live orchestrator; --wait prints its answer'],
    ['stop', '<session>', 'Cancel a session\'s task tree and end its daemon'],
    ['watch', '<session> [--after <n>] [--idle <min>] [--timeout <s>]', 'Wait until it is done (0), needs you (2) or goes quiet (3)'],
    ['reserve', '<name> <value>|--next <n> [--session <ref>]', 'Hold a migration number, port or name against other sessions'],
    ['release', '<name> <value> [--session <ref>]', 'Give a reserved name back'],
    ['reservations', '[--session <ref>] [--json]', 'What this project\'s sessions hold'],
    ['rename', '<session> <name>', 'Name a session'],
    ['tasks', '[--all] [--session <ref>]', 'What each task is doing now'],
    ['task', '<task> [--session <ref>]', 'One task: state, milestones, findings, summary'],
    ['stats', '[session] [--tasks] [--against <session>]', 'What a session cost and got'],
    ['lineage', '[session]', 'Which vendor session served each turn, task and review'],
  ]},
  {title: 'Agents and models', rows: [
    ['login', 'claude|codex|muse', 'Open the vendor\'s own login'],
    ['models', '', 'List the models each agent reports, cloud and local'],
    ['quota', '', 'Show the subscription usage each agent reports'],
    ['agents', '[list|show <name>]', 'The team in force, and who may play each agent'],
    ['agents set', '<name> [--scope user|project] [--force]', 'Define or replace an agent from markdown on stdin'],
    ['agents remove', '<name>', 'Delete an agent file'],
    ['bindings', '[update [--save]]', 'Who plays each agent; update finds newer models'],
    ['jev', '[on|off|key <key>|routing on|off|review on|off|help]', 'Jev (TypeSafe) decisions; no argument shows status'],
  ]},
  {title: 'Local models', rows: [
    ['local', '[--verify]', 'LM Studio, the OpenCode bridge, agents it may play'],
    ['local on|off', '', 'Let agents use local models, or skip them'],
    ['local setup', '', 'Write models.yaml and bindings.yml (interactive)'],
    ['resources', '', 'Free memory, swap, and what each local model would cost'],
  ]},
  {title: 'Skills', rows: [
    ['skills', '[list|sync] [--scope user|project]', 'The skills bounce keeps and copies into every agent'],
    ['skills new|add|remove', '<name|path>', 'Create, adopt or delete one of them'],
    ['skills import', '[agent] [--list]', 'Adopt skills an agent already has'],
    ['skills clear|reset', '[--force]', 'Withdraw bounce\'s copies; reset also empties its store'],
    ['skills seed', '--force', 'Reinstall the skills bounce ships'],
    ['skill install', '', 'Teach your own agents to set up and run bounce'],
  ]},
  {title: 'MCP', rows: [
    ['mcp install|uninstall', '', 'Add or remove bounce\'s MCP server in Claude and Codex'],
    ['mcp-serve', '[--control]', 'Serve MCP on stdio; --control exposes a live session'],
  ]},
  {title: 'Bridge (workers and scripts)', rows: [
    ['publish', '--event <json|@file>', 'Publish an event on the session bus'],
    ['report', '--report <json|@file>', 'Worker: report progress or the final outcome'],
    ['wait', '--match <json> --timeout <seconds> [--after-seq <n>]', 'Wait for one event'],
  ]},
  {title: 'Maintenance', rows: [
    ['doctor', '[--fix]', 'Versions, quota, setup; --fix installs a usable opencode'],
    ['prune', '', 'List the workers\' copies, then remove the ones you pick'],
    ['prune', '--ended [--older-than 7d] [--yes]', 'Without asking: ended copies of stopped sessions, unused that long'],
    ['task compare', '<session> <a> <b>', 'Compare two tasks: tokens, wall time, rounds'],
    ['update', '[--check]', 'Install the latest npm release, or only check'],
    ['dev', '', 'Improve bounce itself; validate and reload after changes'],
  ]},
];

export const CLI_OPTIONS = [
  ['--cwd <path>', '', 'Work in that folder instead of the current one'],
  ['--resume <session>', '', 'Reopen a session: its name, id or a unique id prefix'],
  ['--provider <name>', '', 'Start on this agent'],
  ['--model <id>', '', 'Start on this model'],
  ['--session <ref>', '', 'Which session; default: the live one in this folder'],
  ['--json', '', 'Print JSON instead of readable output'],
  ['-v, --version', '', 'Print the version'],
  ['-h, --help', '', 'Show this help'],
];

// Every command as one row, for the TUI's /help, which lists the command line after its own commands.
export const CLI_USAGE = CLI_SECTIONS.flatMap(section => section.rows.map(([name, hint, description]) => [`bounce ${name}`, hint, description]));

export const TUI_SECTIONS = [
  {title: 'Agents & models', rows: [
    ['/provider', 'NAME', 'Select and save the default agent'],
    ['/model', '', 'Pick from every model your signed-in agents report'],
    ['/model', 'ID', 'Set the selected agent\'s model; "default" resets'],
    ['/model refresh', '', 'Re-ask each agent for its catalog, then pick'],
    ['/order', '[claude,codex,muse,opencode]', 'Show the fallback order, or save a new one'],
    ['/mode', 'yolo|plan', 'YOLO is the default; plan uses restrictive provider flags'],
    ['/login', 'NAME', 'Open the vendor\'s native login flow'],
  ]},
  {title: 'Local workers', rows: [
    ['/local', '[verify]', 'Local status: models, the OpenCode bridge, agents a local model may play'],
    ['/local on|off', '', 'Let agents run on local models, or make them skip their local AIs; applies to this session'],
    ['/local setup', '[loaded]', 'Write this machine\'s models and the bindings; loaded limits choices to loaded models'],
    ['/local cancel', '', 'Cancel setup without interrupting agents'],
    ['/local activate', '[AGENT]', 'Re-read agent files into this session without restarting'],
  ]},
  {title: 'Orchestration', rows: [
    ['/operation', '[NAME]', 'Switch classic|orchestrator (restarts this session into it); no arg or Ctrl+O opens a menu'],
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
    ['/btw', 'QUESTION', 'Ask a side question about this session; answers once, from context, without touching the running turn'],
    ['/steer', 'TEXT', 'Steer the focused agent live; when idle, save an aside for its next turn'],
    ['/review', '', 'Show the full text of every session work item'],
    ['/detach', '', 'Close this view; orchestrator and workers keep running'],
    ['/quit', '', 'Stop this session and exit; /exit does the same (Esc cancels an active turn)'],
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
    ['/prune', '[all|none|1,3-5]', 'List the workers\' copies (last used, integrated or not), then remove the ones you pick'],
    ['/quota', '', 'Show the subscription usage each agent reports'],
    ['/retry', '', 'Clear locally recorded quota cooldowns'],
    ['/unblock', '', 'Continue after a restart when the previous orchestrator is gone'],
    ['/config', '[key value | unset key]', 'Show or change settings; saved to config.json, validated, says when it applies'],
    ['/stats', '[tasks]', 'What this session cost and got: outcomes, time by AI, tokens, checks, reviews, workers'],
    ['/update', '[check]', 'Install the latest npm release, or only check'],
    ['/restart', '', 'Test and reload updated code, keeping this session'],
    ['/help', '', 'Show this help'],
  ]},
];

export const KEYS = [
  ['/', '', 'Command picker'],
  ['Tab', '', 'Complete a command, or move to the next agent pane'],
  ['Enter', '', 'Send; while an agent works, queue the next message'],
  ['Shift+Enter', '', 'Newline (Alt+Enter, Ctrl+J and \\ then Enter too)'],
  ['↑/↓', '', 'Prompt history, kept per workspace across sessions; ↑ on an empty draft takes back a queued prompt'],
  ['Ctrl+R', '', 'Search prompt history'],
  ['PgUp/PgDn', '', 'Scroll the transcript (the wheel scrolls what is under it)'],
  ['Drag', '', 'Select and copy; double-click a word, triple-click a line'],
  ['F3', '', 'Hand the mouse back to the terminal (its own selection and links)'],
  ['Ctrl+O', '', 'Choose classic/orchestrator (restarts the session)'],
  ['Ctrl+U', '', 'Clear the input'],
  ['Ctrl+W / Ctrl+K', '', 'Delete the word before the caret / to the end of the line'],
  ['Ctrl+Y', '', 'Put back what Ctrl+W or Ctrl+K deleted'],
  ['Ctrl+_', '', 'Undo an edit'],
  ['Ctrl+C', '', 'Cancel the turn; else clear the draft; press twice to quit'],
  ['Esc', '', 'Cancel an active turn or close a picker; twice clears the draft'],
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

// `bounce --help`: plain text in ace's shape. Rows share one description column; a label too wide for
// it stands on its own line with the description under that column, as ace does.
const CLI_COLUMN = 44;
// Painted with /help's palette when `paint` is given: titles bold cyan, commands cyan, arguments gray,
// options yellow. Layout is measured on the plain text, so colour never moves a column.
export function cliRows(width = 100, paint = {}) {
  const p = {...noPaint, ...paint};
  const column = Math.min(CLI_COLUMN, Math.max(20, Math.floor(width * 0.45)));
  const pad = ' '.repeat(column);
  const paintLabel = (line, name, nameOf) => line.startsWith(name) ? nameOf(name) + p.hint(line.slice(name.length)) : p.hint(line);
  const row = (name, hint, description, indent, nameOf = p.name) => {
    const label = hint ? `${name} ${hint}` : name;
    const body = wrapText(description, Math.max(20, width - column)).map(line => p.text(line));
    const lead = ' '.repeat(indent);
    if (indent + stringWidth(label) + 2 <= column) {
      return [lead + paintLabel(label, name, nameOf) + ' '.repeat(column - indent - stringWidth(label)) + body[0], ...body.slice(1).map(line => pad + line)];
    }
    const labelLines = wrapText(label, width - indent - 2).map((line, i) => lead + (i ? '  ' + p.hint(line) : paintLabel(line, name, nameOf)));
    return [...labelLines, ...body.map(line => pad + line)];
  };
  const section = (title, rows, nameOf) => [p.title(`${title}:`), ...rows.flatMap(([name, hint, description]) => row(name, hint, description, 2, nameOf)), ''];
  return [
    `${p.title('bounce')} ${p.muted('— ' + TAGLINE)}`,
    '',
    ...CLI_USAGE_LINES.flatMap(([usage, description], i) => {
      const [command, ...rest] = usage.split(' ');
      const lead = i ? '       ' : 'Usage: ';
      return row(lead + command, rest.join(' '), description, 0, () => (i ? lead : p.title(lead)) + p.name(command));
    }),
    '',
    ...CLI_SECTIONS.flatMap(({title, rows}) => section(title, rows)),
    ...section('Options', CLI_OPTIONS, p.key),
    ...wrapText('Inside the view, /help lists its own commands and keys. Settings and sessions live in BOUNCE_HOME or ~/.bounce.', width).map(line => p.muted(line)),
    ...wrapText('YOLO, the default mode, turns off the agents\' own approvals and sandboxing.', width).map(line => p.muted(line)),
  ];
}
export const helpText = (width = 100, paint) => cliRows(width, paint).join('\n');
