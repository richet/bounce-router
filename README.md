# localrouter

One TUI for your installed Claude Code, Codex, and Muse coding agents. Uses native CLI login and headless processes; localrouter owns the conversation and carries context between providers.

## Run

Requires Node.js 22+ and at least one provider CLI on PATH. Run `npm install` in this project before the first launch.

```sh
node /Users/rich/Projects/Lupchoo/localrouter/src/cli.js --cwd /path/to/your/repo
```

Or run `npm start` from this project. Optional: `npm link` exposes `localrouter` on PATH.

```sh
localrouter login claude
localrouter login codex
localrouter login muse
localrouter doctor
localrouter models
localrouter --cwd /path/to/repo
localrouter run "Implement the feature and run relevant tests" --cwd /path/to/repo
localrouter sessions
localrouter --resume SESSION_ID
```

Login temporarily hands the terminal to the vendor. Finish its browser/device login, then return to the TUI. Existing CLI logins work without logging in again. localrouter never reads or exchanges credentials. Native CLI environment variables and settings still apply; if you have vendor API keys set, the vendor may prefer them over subscription login.

## Display

Assistant responses render Markdown headings, emphasis, lists, quotes, links, tables, and syntax-highlighted fenced code blocks. Unlabelled code blocks and literal tool output use automatic language detection. While a turn is pending, a spinner and elapsed seconds remain visible, including during silent provider work; F2 pauses animation for copying. Event labels, status, and command selection use distinct colors. Layout wraps by terminal cell width and preserves ANSI styles. Set `NO_COLOR=1` to disable colors; `TERM=dumb` also disables styling. Journals and headless `run`/`--json` output retain their original format.

## Image attachments

Drop image files into the terminal input, add your question, and press Enter. Quoted paths, shell-escaped spaces, and local `file://` URLs are supported. PNG, JPEG, GIF and WebP are accepted (up to 10 files, 5 MiB each). Paths stay visible and editable until submission. Clipboard bitmap paste is not implemented; save the screenshot as a file and drag it in.

Claude receives base64 image blocks through stream-JSON input; Codex and Muse receive repeated `--image` flags. A vision-capable provider model is required. Images are copied into the private session directory before sending, so fallback uses the same bytes even if the original is moved. Journals store attachment metadata and saved paths, not base64. Later turns include those saved paths in history; images are automatically attached only to their original turn and its fallback attempts.

Headless usage: `localrouter run "Explain this screenshot" --image "/path/Screen shot.png"` (repeat `--image` for more files). Standalone local image paths in prompt text are also detected as attachments. Missing explicit image paths or invalid files stop submission with an error.

## Controls

- Type `/` to open the command picker; type a prefix to filter. Up/down selects, Tab or Enter completes, and Enter then submits. Esc dismisses the picker.
- Tab switches agent when the picker is closed.
- F2 freezes display updates for selecting/copying text while an agent runs; F2 resumes. Events continue to be saved while paused. Unchanged frames produce no terminal writes, and ordinary updates redraw only changed rows.
- `/provider claude` selects and saves the default.
- `/model` lists every model each signed-in agent reports and lets you pick one: up/down or 1-9 to choose, Enter to use it, Esc to cancel. A pick saves the model and makes that agent the default. `/model refresh` re-asks the agents; catalogs are cached for five minutes.
- `/model MODEL_ID` saves the selected provider's model without opening the picker; `/model default` uses its native default.
- Catalogs come from each CLI's own protocol (Claude stream-JSON `initialize`, Codex app-server `model/list`, Muse MSP `model/list`), so no model list is hard-coded. `localrouter models [--json]` prints the same catalogs headlessly. An agent that is not installed or not signed in is listed as a note under the picker instead of hiding the others.
- `/order claude,codex,muse` saves routing order. Omit a provider to disable it.
- `/mode yolo` (default) bypasses native approvals and sandboxing.
- `/mode plan` requests Claude plan mode, Codex read-only sandbox, or Muse disabled write/shell. It is not an interactive approval bridge, and provider-native tools/configuration determine exact restrictions.
- `/login [provider]`, `/new`, `/note TEXT`, `/retry`, `/help`, `/quit`.
- Escape or Ctrl+C cancels the running process group; Ctrl+C while idle exits.
- Mouse wheel or trackpad scrolls the transcript (three lines per tick); PgUp/PgDn also scroll. F2 releases mouse capture for selecting/copying text. Up/down recalls prompts; Ctrl+U clears input.

YOLO intentionally lets agents run commands and change files with your user permissions. Launch in the workspace you intend to let the agents modify.

## Routing and context

Default order: Claude → Codex → Muse. Successful fallback becomes sticky for the session. Provider exhaustion detected in structured errors, or stderr on failed execution, moves to the next provider. A missing executable also falls through. Authentication, permission, network, model, and other failures stop the turn rather than replaying side effects on another provider. Every provider is attempted at most once per turn. Escape never causes fallback.

A provider hitting limits is skipped for a configurable local delay (30 minutes by default). This is **not** a subscription reset estimate. `/retry` clears the local delay. Exact remaining subscription quota is currently unknown. Usage events are recorded when supplied by the CLI; no account percentages or costs are invented.

Every turn starts a fresh native CLI process with a handoff. The handoff includes the original request, a bounded recent journal suffix, current request, and Git HEAD/status/diff-stat. It asks the next agent to inspect partially completed work. Full raw provider events and normalized conversation/tool events remain in the journal. Git observation does not commit, stash, reset, or roll back files. Switching is not transactional: an exhausted agent may already have performed side effects.

## Local storage

`~/.localrouter` (override with `LOCALROUTER_HOME`):

- `config.json`: order, mode, per-provider models, cooldownMinutes, contextChars, executable overrides.
- `sessions/<uuid>/journal.jsonl`: append-only normalized and raw events.
- `sessions/<uuid>/handoff.txt`: latest cross-provider prompt.
- `sessions/<uuid>/lock`: prevents concurrent session writers; stale PID locks are recovered.

Directories/files are created with owner-only permissions. Journals contain prompts and tool output, which can include sensitive project content. On handoff this context is sent through the next configured provider. To remove localrouter history, remove the relevant session directory while it is not running. Provider-native histories remain under each vendor's control.

Example config:

```json
{
  "order": ["claude", "codex", "muse"],
  "mode": "yolo",
  "models": {},
  "executables": {},
  "cooldownMinutes": 30,
  "contextChars": 48000
}
```

Executable discovery checks PATH, common local install directories, and the macOS Codex/ChatGPT app bundles. `doctor` shows the resolved path. An explicit `executables.codex` override takes precedence if needed. Configuration is global to localrouter; sessions remember their workspace. `--provider`, `--model`, and `--mode` override a launch; slash commands persist settings.

## Development and verification

```sh
npm test
npm run check
```

Tests use fixture processes and temporary directories, without subscription calls. The Muse adapter was additionally checked against the installed CLI's offline echo event stream. Live authenticated coding runs and browser login flows require manual integration validation.

Protocol references: [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode), [Claude programmatic execution](https://code.claude.com/docs/en/headless), and installed `muse exec --help` plus `muse exec --provider echo --no-session-log --json` (verified 2026-09-08).

## Current boundaries

This is a working v0.1 foundation. It uses a simple terminal renderer, not a full terminal emulator: multiline input composition is basic. Claude/Codex messages render as structured events arrive; Muse renders output deltas. Native session resume, semantic long-history compaction, interactive tool approvals, and vendor quota APIs are not implemented. Context is bounded and may omit older decisions; `/note` helps record current handoff details. Raw events preserve unrecognized provider data for adapter updates. Providers can change their flags/event formats, so review adapter fixtures when upgrading them.

## Improve localrouter using localrouter

After `npm link`, run `localrouter dev` from any directory. It opens the actual localrouter source directory as the agent workspace. Ask for an improvement, for example:

> Add a /status command showing the current provider, model, routing order, and local cooldowns. Add relevant tests and update the README.

In dev mode, a successful agent turn that changes `src/` or `package.json` triggers `npm run check` and `npm test`. If both pass, a supervisor starts a fresh process and resumes the same journal, workspace, selected provider, model settings, and permission mode. Failed validation keeps the current process running so you can ask the agent to fix the problem. No relink is needed: npm's link already points to these source files.

Use `/restart` in any TUI session to validate and reload manually. A regular launch does not automatically reload. Restart happens between turns, never during a running agent command. Source edits are kept on disk even when checks fail; there is no automatic rollback. Passing tests cannot guarantee the updated app starts successfully; if startup fails, fix the source and use `localrouter --resume ID` (IDs are listed by `localrouter sessions`). Changes to the supervisor itself require fully quitting and launching again. This reloads local changes; it does not download releases or run Git pulls.

The header labels the selected model and updates when the provider reports its model. If neither a model override nor runtime metadata is available, it shows `Default (not reported)`; use `/model ID` to select one explicitly. Localrouter activity labels describe local progress. Restart validation shows concise success messages and retains diagnostic output on failure.

The prompt shows a blinking block cursor and grows as text wraps, up to one third of the terminal height. Longer drafts keep their last lines visible. Pasted newlines are preserved; Alt+Enter inserts a newline and Enter sends. F2 hides the cursor while copying, and exit restores the terminal’s default cursor style.
