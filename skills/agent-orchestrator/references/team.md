# bounce agent files (the team)

An agent is one markdown file: frontmatter for what bounce routes on, body as the worker's system
prompt. bounce derives the worker profiles from these files — one hidden backend per `models:`
entry, chained as fallbacks — so nothing else defines a role.

```markdown
---
name: coder                      # lowercase; letters, digits, _ -; `orchestrator` is reserved
description: Implements owned modules in this repository.
policy: write                    # write (default) | read-only
maxSteps: 60                     # optional, 1..500; caps tool steps on runtimes that can (OpenCode)
readPaths: [.]                   # optional, relative paths; used when a local AI plays it
writePaths: [src, test]          # required for a write agent to run on a local model
commands: [npm test]             # optional; commands a local worker may run
models: [codex/gpt-5.6-terra, claude/sonnet, lmstudio/qwen3-coder-next-mlx]
---
You build. Own only the paths you were given; verify red-first; report with evidence.
```

- `models:` names the PROVIDER and model (`claude/sonnet`, `codex/gpt-5.6-terra`, `muse`, `lmstudio/<model>`),
  in fallback order. Never `opencode/…`: OpenCode is the runtime local models run through, not a provider.
  `auto` first (`models: [auto, claude/default]`) lets Jev pick the AI per task, by the tier the orders need, when
  the user has Jev routing on; what follows `auto` — or, with nothing after it, every signed-in provider — is what the
  agent runs on otherwise. The shipped agents are `models: [auto]`. A list without `auto` is never overridden.
  `provider/default` is the provider's own default model. With no `models:`, every signed-in provider
  plays it in `order`, then the local endpoint on `auto`.
- Layers, later shadowing by name: this skill's `team/` (not `agents/`, which holds the vendor subagent role files) → `~/.bounce/agents/` → `<project>/.bounce/agents/`.
- A file that fails to parse is reported as INVALID, never silently replaced by a default.

## Commands

    bounce agents                       # the team in force: name · policy · source · who may play it
    bounce agents show NAME             # print the file
    bounce agents set NAME --scope project < agent.md   # define or replace (validated first)
    bounce agents set NAME --force ...  # replace a file someone edited by hand
    bounce agents remove NAME           # only files in ~/.bounce/agents or .bounce/agents

`set` is refused when the file does not parse, names a provider this machine lacks, or no AI here can
play it now (a plan session runs read-only agents only; a write agent needs `writePaths` to run on a
local model). A definition applies to newly started sessions — the running roster does not change.
When run from an orchestrator session it is journaled as `agents.defined`.
