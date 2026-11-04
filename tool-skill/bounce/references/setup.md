# Setting up a project: team, bindings, orchestrator

Where each setting lives, and how to check it took effect. Every change here applies to sessions
started afterwards; a running session keeps the roster it started with.

| Setting | Lives in | Scope |
|---|---|---|
| The team (agent files) | `<project>/.bounce/agents/*.md`, else `~/.bounce/agents/`, else the shipped team | one layer, whole |
| Who plays each agent | `<project>/.bounce/bindings.yml`, else `~/.bounce/bindings.yml` | one file, whole |
| What each alias means | `~/.bounce/models.yaml` | this machine |
| The orchestrator's model | `profiles.main` + `orchestrator` in `~/.bounce/config.json` | this machine |
| Local models on or off | `bounce local on\|off` | this machine |
| Cloud workers at once | `maxConcurrentCloud` in `~/.bounce/config.json` (default 3) | this machine, all sessions |

## 1. Give the project its own team

The team is the most specific layer that has any agent file. It is never merged with the layers below. As soon as
`<project>/.bounce/agents/` holds one file, the user's and the shipped agents are gone for that project.
So copy every agent the project needs, not only the one you are changing:

    mkdir -p .bounce/agents
    cp ~/.bounce/skills/agent-orchestrator/team/{analyst,builder,debugger,reviewer}.md .bounce/agents/
    # then edit the copies, or add new ones: bounce agents set NAME --scope project < NAME.md

Leave `debugger` out only if you mean to; the orchestrator's orders name it for failures that resisted a first try.

## 2. Bind agents to AIs

```yaml
# <project>/.bounce/bindings.yml
agents:
  builder: [auto, qwen_coder, claude/sonnet]   # auto = Jev picks within this chain
  reviewer: [codex/default, claude/default]    # no auto: always this order
  "*": [auto, claude/default, codex/default]   # every agent not named above
```

- Only one bindings file is read: the project's if it exists, else the user's. They are not merged.
- Entries are `provider/model`, `provider/default`, or an alias defined in `~/.bounce/models.yaml`.
  An alias another machine lacks is skipped there, and `bounce agents list` names it.
- Precedence per agent: its own entry in bindings → the agent file's `models:` → `"*"`. An agent
  file that still has `models:` ignores `"*"`. Once bindings exist, delete `models:` from the agent files
  (`bounce local setup` moves them for you).

## 3. Cloud only

    bounce local off        # every agent skips its local AIs; applies to sessions started afterwards (/local off in the TUI applies now)

and keep local aliases (`lmstudio/…`, or aliases that point to them) out of the bindings, so a later
`bounce local on` does not bring them back.

## 4. The orchestrator's model

Neither bindings nor anything in the project sets it. It is the `main` profile in `~/.bounce/config.json`:

```json
"profiles": {"main": {"adapter": "claude", "model": "opus"}},
"orchestrator": "main"
```

This file is for the whole machine, so changing it changes every project. Picking `/model` inside a session overrides it for that
session only. When you launch, read the model in the session header. Do not assume it matches the config.

## 5. Running several workspaces at once

`maxConcurrentCloud` caps cloud workers across all sessions on the machine (default 3). Three
workspaces each fanning out to three workers will queue. Raise it in `~/.bounce/config.json`, or
expect the wait. Local endpoints have their own limits (`local.endpoints.<name>.maxConcurrent`,
`slotsPerModel`).

## 6. Commit `.bounce/` or keep it local

- **Commit it**: everyone who clones the project gets the same team and chains. Aliases resolve per machine
  through each person's `models.yaml`, so name aliases rather than local model ids.
- **Gitignore it**: the team and bindings stay on this machine, and nothing about your models goes into the repo.
  Use this when the repository is shared with people who do not run bounce.

Follow what the repo already does. If its `.gitignore` lists `.bounce/`, keep it local.

## Verify

    bounce agents list      # the team in force, its source layer, the bindings + models files in use,
                            # where each agent's chain came from, and any alias this machine does not define
    bounce bindings         # the chains in the file in use
    bounce local            # whether local models are on, and which agents one may play

Then start a session in the project and read the header for the orchestrator model and the roster in its ORDERS.md.
