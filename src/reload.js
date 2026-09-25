import fs from 'node:fs';
import {createClaudeLive} from './adapters/claude-live.js';
import {createCodexLive} from './adapters/codex-live.js';
import {createMuseLive} from './adapters/muse-live.js';
import {createOpencodeLive} from './adapters/opencode-live.js';
import {createTypesafeLive} from './adapters/typesafe-live.js';
import {JEV_REVIEWER, createJevActivation, createJevDecisions, jevReviewerProfile, readJevSettings, routingFallback} from './jev.js';
import {createRosterSetup, effectiveNotes, readRosterNotes, setupAgent} from './roster-notes.js';
import {modelCatalog} from './models.js';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {installUpdate} from './update.js';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import {Session, config, dataRoot, pidAlive} from './core.js';
import {loadQuota, recordQuota, quotaSnapshot} from './quota.js';
import {seedSkills, seedSummary} from './skills.js';
const SEED_NOTABLE = ['invalid', 'unmanaged', 'modified', 'withdrawn', 'failed'];
import {resolveSessionRef} from './sessions.js';
import {titleSession, createAsk} from './session-title.js';
export {pidAlive};
import {createBus, connectBus} from './bus.js';
import {validateOrchestration, LOCAL_ADAPTERS} from './profiles.js';
import {rolesFor} from './agents.js';
import {normalizeLocalSettings, discoverLocalModels, localCandidates} from './local-models.js';
import {createLocalActivation} from './local-activation.js';
import {providers} from './providers.js';
import {createScheduler} from './scheduler.js';
import {hostSession} from './remote.js';
import {createMainService} from './main-service.js';
import {campaignCommand, campaigns} from './orchestration.js';
import {tasks, TERMINAL as TASK_TERMINAL} from './reducers.js';
import {createViewServer, connectView, requestViewControl} from './view-transport.js';

const CHILD_KILL_GRACE_MS = 1500; // same grace as runProcess's cancel and live-common's verifiedCancel
const ROSTER_WAIT_MS = 30_000; // how long an `auto` route waits for roster notes still being written

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const cliPath = fileURLToPath(new URL('./cli.js', import.meta.url));

export function fingerprint(root = projectRoot) {
  const hash = createHash('sha256');
  function visit(dir) {
    for (const item of fs.readdirSync(dir, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir,item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) {hash.update(path.relative(root,file)); hash.update(fs.readFileSync(file));}
    }
  }
  visit(path.join(root,'src'));
  hash.update(fs.readFileSync(path.join(root,'package.json')));
  return hash.digest('hex');
}
export async function validate(root = projectRoot, emit = () => {}) {
  for (const script of ['check','test']) {
    emit(script === 'check' ? 'Checking syntax…' : 'Running tests…');
    await new Promise((resolve,reject) => {
      const child = spawn('npm',['run',script],{cwd:root,stdio:['ignore','pipe','pipe']});
      let output = '';
      const capture = d => { output = (output + d.toString()).slice(-32000); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error(`npm run ${script} timed out`));},120000);
      child.once('error', e => {clearTimeout(timer);reject(e);});
      child.once('close', code => {clearTimeout(timer); if (code !== 0 && output) emit(output); else if (code === 0) emit(script === 'check' ? 'Syntax checks passed.' : 'Tests passed.'); code === 0 ? resolve() : reject(new Error(`npm run ${script} failed; keeping this running version. Fix the code and /restart again.`));});
    });
  }
}

// ---- shared helpers -------------------------------------------------------


function daemonJsonPath(dir) { return path.join(dir, 'daemon.json'); }

function readDaemonJson(dir) {
  try { return JSON.parse(fs.readFileSync(daemonJsonPath(dir), 'utf8')); }
  catch { return null; }
}

// Written whole then renamed into place: `stop`, `attach`, `sessions` and the tests read this
// file while the daemon may be rewriting it (observed as a torn JSON.parse under six parallel D5 runs).
function writeDaemonJson(dir, info) {
  const tmp = `${daemonJsonPath(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(tmp, daemonJsonPath(dir));
}

function removeDaemonJson(dir) {
  try { fs.unlinkSync(daemonJsonPath(dir)); } catch {}
}

function formatRow(row, json) {
  if (row == null) return 'null';
  if (json) return JSON.stringify(row);
  return `[${row.from}:${row.kind}] ${row.text ?? ''}`;
}

// Derives Phase 2's single orchestration profile from legacy settings — real adapters
// arrive in Phase 3; see docs/local-orchestration.md "Process model".
// A session opened in the home folder: every worker — a local model with a shell included — runs
// from there. Said once, at the top of the session; null anywhere else.
export function homeSessionWarning(cwd, home = os.homedir()) {
  if (typeof cwd !== 'string' || path.resolve(cwd) !== path.resolve(home)) return null;
  return `This session is in your home folder (${path.resolve(home)}): every worker runs, reads and edits from here, not inside a project. Quit and start bounce from the project folder.`;
}

// How long ONE task runs before bounce looks at it (config.json `taskMinutes`): a lease, renewed
// while the worker makes progress, up to `taskCeilingMinutes`. Found live: a hard 15-minute cap
// killed every local reviewer mid-review, and the orchestrator answered by shrinking the next one.
// The ceiling is the only size limit: a longer deadline is refused before anything runs.
export const TASK_MINUTES = 15;
export const TASK_CEILING_MINUTES = 60;
const wholeMinutes = value => Number.isInteger(value) && value >= 1 && value <= 240;
export function taskLimits(settings = {}) {
  const minutes = settings.taskMinutes ?? TASK_MINUTES;
  if (!wholeMinutes(minutes)) throw new Error('taskMinutes must be a whole number of minutes from 1 to 240');
  const ceiling = settings.taskCeilingMinutes ?? Math.max(TASK_CEILING_MINUTES, minutes);
  if (!wholeMinutes(ceiling) || ceiling < minutes) throw new Error('taskCeilingMinutes must be a whole number of minutes from 1 to 240, and at least taskMinutes');
  return {minutes, ceiling};
}
// Who a task is submitted to. Found live: with Jev on, local on and every agent on `auto`, the
// orchestrator sent every task to a cloud profile by name — which skips Jev and the local models.
// Its orders offered agents, profiles and `auto` side by side with no default, so it picked a tier
// itself from the profile list. The default is the JOB; a named AI is the exception.
const isAgentHead = ([name, p]) => p?.derived === true && p.agent?.name === name;
export function defaultTarget(profiles = {}, orchestrator = 'main', {routingOn = false} = {}) {
  return Object.entries(profiles).find(isAgentHead)?.[0] ?? (routingOn ? 'auto' : null)
    ?? Object.keys(profiles).find(name => name !== orchestrator && name !== JEV_REVIEWER) ?? 'build';
}
export function choosingOrders({agents = false, routingOn = false, localOn = false} = {}) {
  if (!agents && !routingOn) return [];
  return ['Who to submit to — the job, not the AI:',
    ...(agents ? ['    1. An agent, by the job the task is: analyst to inspect and run checks, builder to implement (and, when its orders say so, to own shared files and run the full gate), reviewer to review, debugger to root-cause a failure that resisted a first attempt. Analysts and verifiers run commands in disposable workspaces by default. Explicit read-only profiles are for source-only inspection.'] : []),
    ...(routingOn ? [`    ${agents ? '2' : '1'}. \`auto\` when no agent is clearly the job: Jev routes it.`] : []),
    `    ${[agents, routingOn].filter(Boolean).length + 1}. A worker profile by name ONLY when the user asks for that specific AI, or an agent's own list has been exhausted.`,
    routingOn ? 'Do not pick a tier or a model yourself: for an agent or `auto`, Jev weighs the orders and picks the AI per task.'
      : 'An agent runs on the AIs in the order its file lists them; naming a profile skips that list.',
    'Every task.submitted and plan chunk must declare requires: ["read"], ["read", "exec"], or ["read", "exec", "write"] to match the actual deliverables. Command execution requires exec even when no source edits are allowed. Use command-capable analysts for audits; independent verification may be a separate probe task and required campaign gate. Probe tasks run in disposable copies so checks can write caches without changing source. Never ask a read-only analyst to run git, checks, lint or tests. A blocked completion review preserves the candidate: read task_get full and its reviewGate before deciding what work is missing. Never resubmit completed analysis just because its acceptance review is unavailable.',
    'Once you have dispatched a task, end your turn: say in a line what you dispatched and what comes next, then stop. bounce wakes you with each outcome as your next turn (a `handoff` row), so nothing is lost. Do not hold your turn open in `bounce wait` while workers run — a turn held open keeps its whole context live and idle (observed: 74% of a 35-minute turn spent waiting), and do not investigate the same question yourself in parallel — that spends the worker\'s whole slot for nothing. If you must take the work back, cancel the task first.',
    ...(localOn ? ['Local models are part of the normal path, not a special request: an agent runs on a local model when one fits the task, at no cost — do not wait for the user to ask for them, and do not route around them by naming a cloud profile.',
      'They are bounded by this machine\'s memory: bounce loads what fits, unloads an idle model to make room, and waits when nothing fits (it tells you if a task waits too long). While macOS reports memory pressure (warning or critical) it will not start a local worker: that task goes to the agent\'s next AI. You never manage memory yourself.'] : []),
    ''];
}

// The breakdown the orchestrator is held to, in its standing orders.
// Whose task is this, for the bus grant? A task the orchestrator submitted, or a replacement bounce made
// for one — a fallback is submitted `from: bounce`, but the work is still the orchestrator's and it must be
// able to submit under it. Found live: a rework under a fallback replacement was refused `-32001
// unauthorized` on both transports, and the campaign stopped with the fix already written. Cycle-guarded.
// Every task the orchestrator owns, for seeding its bus grant at startup. The grant is otherwise built
// empty and widened only by rows arriving live, so a restart disowned everything from before it — and a
// submit parented under earlier work was refused. Finished tasks are included: they can still be parents.
export function orchestratorTasks(events) {
  const owned = [];
  for (const e of events) if (e.kind === 'task.submitted' && orchestratorOwns(events, e.task)) owned.push(e.task);
  return owned;
}

export function orchestratorOwns(events, task) {
  const seen = new Set();
  let id = task;
  while (id && !seen.has(id)) {
    seen.add(id);
    const row = events.find(e => e.kind === 'task.submitted' && e.task === id);
    if (!row) return false;
    if (row.from === 'orchestrator') return true;
    id = row.replaces;
  }
  return false;
}

export const breakdownOrders = (minutes, {jevOn = false, ceiling = Math.max(TASK_CEILING_MINUTES, minutes)} = {}) => [
  'Break big work down: phases in sequence, each phase made of chunks that run in parallel.',
  `A task runs under a ${minutes}-minute lease that bounce renews while the worker makes progress, up to a ${ceiling}-minute ceiling; a deadline over the ceiling is refused (task.failed, reason size) before anything runs. Size a chunk by scope (one owner, one acceptance), not by minutes: long work is normal.`,
  'However large the request, never hand one worker the whole job. Plan the phases first; within a phase submit every chunk whose',
  'owned paths are disjoint at once, so they run in parallel; give a task that needs another\'s result depends_on with its task id, so',
  'phases run in sequence without you polling. Each chunk gets disjoint owned paths, its own acceptance and how to verify it.',
  'Before dispatching a phase, submit its plan with a stable plan id and wait for that exact decision:',
  `    bounce publish --event '{"kind":"plan.submitted","plan":"<plan id>","phase":"<phase name>","chunks":[{"id":"<short id>","profile":"<agent>","orders":"<goal, acceptance, how to verify>","requires":["read","exec"],"owns":["<path or glob>"],"depends_on":["<chunk id>"],"deadline":${minutes * 60000}}]}'`,
  'Use the `plan_wait` tool with that plan id. A timeout means the decision is still pending; it does not authorize dispatch.',
  `${jevOn ? 'Jev judges each chunk — phase-sized, no acceptance, overlapping paths, hidden dependency — and bounce' : 'bounce checks each chunk for overlapping owned paths and a deadline over the ceiling, and'} answers with plan.accepted`,
  'or plan.rejected (findings per chunk, with the fix). Fix a rejected plan and submit it again; submit the chunks of an accepted one',
  'with the same `requires`, `owns`, deadline, review constraints and `depends_on`, and copy the plan id and chunk id into each task as `planId` and `chunkId`.',
  'A review of a whole phase, or of more than one risk area, is heavy: split it into one reviewer per area (for example locking and journaling, ownership, the CLI), each with the verification commands for its area. Reviewers probe: they run commands but cannot change the tree.',
  'Review each phase before the next one starts: read what the chunks produced, integrate, run the gate, then submit the next',
  'phase. A chunk that stops making progress or reaches the ceiling is asked for its conclusion and reported as is: resubmit what is left with that progress in its orders, or record the concrete campaign blocker after bounded recovery.', ''];

export function buildProfiles(settings) {
  return {main: {adapter: settings.order[0], mode: settings.mode, fallback: settings.order.slice(1)}};
}

// The four rows that end a task, mirroring src/reducers.js's own switch — `timed_out` is a
// derived state, not a kind: the row that produces it is `task.deadline`.
const TERMINAL_KINDS = new Set(['task.completed', 'task.failed', 'task.cancelled', 'task.deadline']);
// Set explicitly on every spawned child, from the validated config alone: whatever the daemon's
// own environment carries, the child's operation mode is never inherited (T3b rework, item 1).
const ORCHESTRATOR_ENV = ['BOUNCE_BUS', 'BOUNCE_BUS_TOKEN_FILE', 'BOUNCE_SESSION', 'BOUNCE_ROLE', 'BOUNCE_ORCHESTRATOR_PROFILE'];

export function orchestratorBridgeEnv({session, bus, grant, profile}) {
  return {BOUNCE_BUS: bus.path, BOUNCE_BUS_TOKEN_FILE: grant.file, BOUNCE_SESSION: session.id,
    BOUNCE_ROLE: 'orchestrator', BOUNCE_ORCHESTRATOR_PROFILE: JSON.stringify(profile)};
}

const ACTIVE_CAMPAIGN_TASKS = new Set(['queued', 'running', 'waiting', 'reviewing']);

// A campaign action changes identity when its scope revision or latest scoped task evidence changes.
// Main narration is deliberately absent from the key: describing an obligation cannot satisfy it.
export function campaignContinuationState(events) {
  const campaignView = campaigns(events);
  const taskProjection = tasks(events);
  const result = [];
  for (const campaign of Object.values(campaignView)) {
    if (campaign.state !== 'active' || !campaign.remaining.length) continue;
    const scopedTasks = Object.values(taskProjection).filter(task => task.campaignId === campaign.id);
    if (scopedTasks.some(task => ACTIVE_CAMPAIGN_TASKS.has(task.state) && !TASK_TERMINAL.has(task.state))) continue;
    const taskIds = new Set(scopedTasks.map(task => task.id));
    const latest = events.findLast(row => row.campaignId === campaign.id
      || (row.kind?.startsWith('task.') && taskIds.has(row.task)));
    const seq = latest?.seq ?? 0;
    const remainingKey = createHash('sha256').update(campaign.remaining.join('\n')).digest('hex').slice(0, 12);
    result.push({kind: 'campaign.pending', campaignId: campaign.id, revision: campaign.revision, seq,
      remaining: [...campaign.remaining], actionId: `campaign:${campaign.id}:r${campaign.revision}:s${seq}:${remainingKey}`,
      text: `Campaign ${campaign.id} still requires gates: ${campaign.remaining.join(', ')}`});
  }
  return result;
}

// Exhausting the main continuation allowance is itself a campaign transition. Persist needs-input
// so restart and UI projections cannot mistake an exhausted active campaign for silent progress.
export function installCampaignContinuation({session}) {
  const persistBlocker = row => {
    if (row.kind !== 'main.blocked' || row.reason !== 'campaign_blocked') return;
    const blocked = new Set(row.actionIds ?? []);
    for (const pending of campaignContinuationState(session.events)) {
      if (!blocked.has(pending.actionId)) continue;
      campaignCommand(session, {kind: 'campaign.block', from: 'orchestrator', campaignId: pending.campaignId,
        reason: `Campaign continuation attempts exhausted with unmet gates: ${pending.remaining.join(', ')}`});
    }
  };
  const unsubscribe = session.subscribe(persistBlocker);
  for (const row of session.events) persistBlocker(row);
  return unsubscribe;
}

// The orchestrator profile's standing brief, written once per daemon start: where its skill
// lives and how to reach the bridge. The prompt line cli.js prepends points at this file.
function writeOrders({session, root, bus, grant, profiles = {}, orchestrator, jev = null, notes = {}, roles = null, settings = {}, adapterNames = []}) {
  const dir = path.join(session.dir, 'orchestrator');
  const autoFallback = routingFallback(profiles, jev?.routing?.default);
  const routingOn = Boolean(jev?.enabled && jev?.routing?.enabled);
  // What each profile's model is for, from the profile itself or the roster notes bounce wrote.
  const about = name => notes[name] ?? {};
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, 'ORDERS.md');
  fs.writeFileSync(file, [
    `# Orchestrator orders — session ${session.id}`, '',
    'You coordinate; workers implement. Delegate every implementation task to a worker profile below.',
    'Do not edit the repository yourself and do not read bounce\'s own source to learn the bridge — everything you need is here.',
    'Workers run ONLY through this bridge: never your own subagent/Agent/Task tools (they are switched off for you), and never',
    'do the work yourself when a dispatch fails — a task.failed row names the reason and the bounded recovery allowed for it.', '',
    'Brief from the request and what you already know; do not read the repository first to write a "precise" brief. The worker',
    'inspects the code itself at full speed and would only reread what you read (measured: 1–2 minutes of orchestrator reading per',
    'turn, then the same files again in the worker). State the goal, the acceptance, the paths you happen to know and how to verify,',
    'and submit — usually within a few seconds of the user\'s message. When a decision genuinely depends on a fact you lack, ask one',
    'read-only scout task for that fact rather than reading around it yourself. Give one builder the whole change (one brief, one',
    'worker, one review round) instead of splitting one bounded change into several workers that each reread the same files.', '',
    `Skill: ${path.join(root, 'skills', 'agent-orchestrator', 'SKILL.md')}`, '',
    'Bridge (already in your environment):',
    `    BOUNCE_BUS=${bus.path}`,
    `    BOUNCE_BUS_TOKEN_FILE=${grant.file}`,
    `    BOUNCE_SESSION=${session.id}`, '',
    // Two layers, both submit targets. AGENTS are jobs: one line each, the hidden backend chain folded in;
    // a model ref names its provider, and a local provider runs through opencode (said, not shown as the ref).
    'Agents you can submit to (a job: name → the AIs that may play it, in fallback order):',
    ...(() => {
      const ref = p => `${LOCAL_ADAPTERS.has(p.adapter) ? `${p.endpoint ?? 'lmstudio'}/${p.model || 'auto'} (via opencode)` : [p.adapter, p.model].filter(Boolean).join('/')}`;
      const seen = new Set(); const lines = [];
      for (const [name, p] of Object.entries(profiles)) {
        if (name === orchestrator || name === JEV_REVIEWER || seen.has(name) || !p.derived) continue;
        const chain = []; let current = name;
        while (current && !seen.has(current)) { seen.add(current); chain.push(profiles[current]); current = profiles[current].derived ? profiles[current].fallback[0] : null; }
        const head = chain[0];
        lines.push(`    ${name} → ${head.auto && routingOn ? 'Jev picks the AI per task, else ' : ''}${chain.map(ref).join(', ')}${head.agent ? ` · ${head.agent.policy} · ${head.agent.description}` : head.role ? ` (${head.role})` : ''}`);
      }
      return lines;
    })(),
    // The team block: what the roster is made of, which AIs exist here, and how to change it. The
    // orchestrator specialises the shipped defaults through the bridge; a definition takes effect
    // in the next session, so the block says so rather than letting it assume otherwise.
    ...(() => {
      const bySource = new Map();
      for (const role of roles?.values() ?? []) { if (role.error) continue; const key = role.source === 'skill' || role.source === 'installed-skill' ? 'skill agent-orchestrator' : role.source === 'user' ? path.join(root, 'agents') : path.join(session.cwd ?? '', '.bounce', 'agents'); bySource.set(key, [...(bySource.get(key) ?? []), role.name]); }
      const local = Object.keys(normalizeLocalSettings(settings.local).endpoints);
      const ais = [...(settings.order ?? []).filter(name => adapterNames.includes(name)).map(name => [name, settings.models?.[name]].filter(Boolean).join('/')),
        ...(adapterNames.includes('opencode') ? local.map(endpoint => `${endpoint}/<loaded model> (via opencode)`) : [])];
      return [
        ...[...bySource].map(([source, names]) => `Team: ${names.join(', ')} ← ${source}`),
        `AIs on this machine: ${ais.join(', ') || 'none signed in'}`,
        'Team setup: the shipped agents are generic. On your first task in a project, define the agents this repository actually needs',
        '(one per job; the same job on another AI is a `models:` entry, not another agent) with',
        '    bounce agents set NAME --scope project   # the agent file on stdin; format and fields in',
        `    ${path.join(root, 'skills', 'agent-orchestrator', 'references', 'team.md')}`,
        'It is validated against this machine before it lands. It applies to the NEXT session: say so to the user and continue on the current roster.',
        '`bounce agents` lists the team in force; `bounce agents show NAME` prints one.', '',
      ];
    })(),
    'Worker profiles (one AI each: name → adapter/model) — the exception: name one only when the user asks for that AI:',
    ...Object.entries(profiles).filter(([name, p]) => name !== orchestrator && name !== JEV_REVIEWER && !p.derived).map(([name, p]) => `    ${name} → ${[p.adapter, p.model].filter(Boolean).join('/')}${p.role ? ` (${p.role})` : ''}${about(name).tier ?? p.tier ? ` [tier ${about(name).tier ?? p.tier}]` : ''}${about(name).capabilities ?? p.capabilities ? ` — ${about(name).capabilities ?? p.capabilities}` : ''}`),
    ...(jev && autoFallback ? [`    auto → ${routingOn ? 'Jev (TypeSafe) routes each task: to the agent above whose job the orders clearly describe (that agent\'s own models then decide the AI), otherwise by the tier the orders need — the first fitting worker profile of that tier in the provider order; unconfident picks go to' : 'Jev routing is off (/jev routing on): resolves to'} ${autoFallback}`] : []),
    'Local discovery checks eligibility at dispatch. A downloaded model is not necessarily loaded or tool-capable.',
    'If the user asks for a LOCAL worker specifically and no agent can run on one, report that and point to /local on and /local setup; do not quietly substitute a cloud worker for that request.',
    'Capacity waits, progress and failures are journaled. Do not infer a worker crash from silence alone; inspect its latest task state.',
    'A local worker (… via opencode) uses the workspace and tools allowed by its policy: read-only agents read and search but cannot run commands; probe agents can run sandboxed verification commands; write agents edit files and run commands in their assigned workspace. Its answer is its report. Never ask a read-only analyst to claim it ran tests; delegate execution to a command-capable worker and cite its results.',
    'Require observed tests from local builders, and review their diff as you would any worker\'s.',
    // The view prefills the input from this line (src/tui/suggestion.js): Tab accepts it, Enter sends it.
    // Found live (session 159f4746): it sent a user-requested commit to workers seven times; none had git.
    'Workers run in copies of the repository without .git, so a worker cannot commit, push or open a PR yet. When the user asks for one, say so once and propose the split (paths and one-line messages) instead of dispatching git work that cannot succeed.',
    'When one prompt from the user would move the work forward (an approval, a decision, a follow-up request), end the answer with one line `Next: <the prompt, as the user would type it>` — the view offers it prefilled in the input. One concrete prompt, not a question or a list; omit the line when nothing is needed from the user.',
    ...(jev?.enabled && jev?.review ? ['Jev completion verdicts are on: a root task you submit without review.completion gets a fast Jev accept/rework check against its orders, report and diff before it is accepted; a confident rework sends the same worker one rework round. Name a review.completion profile yourself to replace it.'] : []),
    '',
    ...choosingOrders({agents: Object.entries(profiles).some(isAgentHead), routingOn, localOn: (() => { try { return normalizeLocalSettings(settings.local).enabled && adapterNames.includes('opencode'); } catch { return false; } })()}),
    'Submit work with `bounce publish --event <json>`; its outcome reaches you as a handoff when you end your turn.',
    'When bounce\'s MCP tools are available to you (submit, wait, report, task_get, tasks_list), use them instead of these commands: the answers come back structured and bounded. The commands stay as the fallback.',
    'For work with several required outcomes, call `campaign_start` first with the objective and every required gate. Put its `campaignId` and one `gate` on every task. The campaign stays active until every gate is satisfied; a status narration does not satisfy a gate.',
    'Use `campaign_extend` when authorized work adds a required gate, `campaign_complete` only after every gate is satisfied, and `campaign_block` with the exact blocker when bounded recovery is exhausted or progress needs user input. Only the user can reduce scope or pause/resume a campaign.',
    'After submitting a plan, call `plan_wait` with its exact plan id. Dispatch only accepted chunks, carrying `planId` and `chunkId` onto each task; a late decision is durable and wakes the main conversation after restart.',
    'End every turn by writing where the campaign is — the `state` tool, or `bounce publish --event \'{"kind":"state","text":"…"}\'`. It is one living note you rewrite each turn, not a log: the phase, what is done, what is next, and why you changed course. It is the first thing you are given when you wake, so write it for a reader who has nothing else. Keep it under 2000 characters; bounce tells you when it is too long and never cuts it for you.',
    'A task killed at its ceiling or for silence is not to be resubmitted unchanged: change the scope or the AI first. Bounce refuses a third identical attempt (task.failed, reason repeat), and each handoff tells you when a job has failed the same way before.',
    'To see what a task is doing or what it produced, ask `task_get` (or `bounce task <id>`), and `tasks_list` (or `bounce tasks`) for everything live. Never read a session journal with tail, cat, jq or grep: it is the raw log, it is what bounce already summarised for you, and one read of it has put 143 KB into a turn.',
    // Found live: the summary is cut at 1,200 characters, and with the journal forbidden the
    // orchestrator had no way to the rest of a 12 KB verdict — it hunted, gave up, and started redoing the
    // reviewer's work. The way exists now, so the orders are where it is named.
    'That view is bounded on purpose, so its summary is cut. When a task has finished and you need its verdict whole — every finding, its repro and its observed output — ask `task_get` with `full: true` (or `bounce task <id> --report`). That is the one way to the full text, and the reason you never need the journal.',
    'Example — submit one task, then end your turn:',
    `    bounce publish --event '{"kind":"task.submitted","parent":null,"campaignId":"<campaign id>","gate":"<required gate>","planId":"<plan id>","chunkId":"<chunk id>","profile":"${defaultTarget(profiles, orchestrator, {routingOn})}","orders":"<goal, owned paths, acceptance, how to verify>","deadline":${taskLimits(settings).minutes * 60000}}'`,
    '`bounce wait` is for a short wait only, at most 120 seconds, when the very next step depends on an outcome you expect within it:',
    `    bounce wait --match '{"kind":"task.completed","task":"<task id from the publish reply>"}' --timeout 120`,
    '`--timeout` is seconds. A `null` reply means it expired, not that the task ended — end your turn: every outcome of a task you',
    'submitted that no `wait` of yours returned is handed to you by bounce, as your next turn when you are idle (a `handoff` row in',
    'the journal) or in front of the next prompt, so you never need to poll. A `[bounce:wait.interrupted]` reply means the user sent',
    'you a message during the wait: it is in your turn now — read it and act on it before anything else.',
    'Fields: parent (null for a root task), profile (a name above), orders (the brief, required), deadline (ms, optional), campaignId and gate (the durable obligation), planId and chunkId (the accepted-plan correlation),',
    'jobId (stable logical job) and retryOf (the previous task attempt). A retry continues the same job; use retryOf rather than parent, which creates dependent work instead of retrying the job.',
    'depends_on (task ids, optional), review ({"prelaunch": <profile>, "completion": <profile>}, optional, review-role profiles only),',
    'steps (the verification steps, as text) — required when the completion reviewer is a verifier profile, refused with reason `steps` without it.',
    'A verifier is handed steps alone as its orders, so they must stand on their own. A strict session requires both review stages as well.',
    'The publish reply shows the task id as `task=<id>` (add --json for the whole row). Always match on kind AND task: a match on the task alone returns the task.submitted row at once.',
    'The publish reply carries the task id. `wait` on a task outcome follows replacements and waits for completion review when configured. Read the',
    'returned row\'s `kind`: task.completed or task.accepted is done. task.deadline (and the task.cancelled with reason `deadline` that',
    'follows it) means the worker ran out of time with the work unfinished: use its partial progress to submit a smaller continuation with retryOf; it is not a reason to stop the run.',
    'Recover by the typed failure and keep it bounded: repair validation/refusal input once; retry transient provider or infrastructure failure within the recorded allowance; rework a rejected result against its findings. Never resubmit an unchanged timed-out or repeated attempt.',
    'A user cancellation stops that work. When retries are exhausted, termination is unverified, or a decision truly requires the user, call campaign_block with the concrete blocker so the durable campaign enters needs-input instead of silently stopping.',
    'Terminal rows: task.completed, task.failed, task.cancelled, task.rejected. Steer a running worker with',
    `    bounce publish --event '{"kind":"message","to":"worker:<task id>","text":"..."}'`, '',
    ...breakdownOrders(taskLimits(settings).minutes, {jevOn: Boolean(jev?.enabled), ceiling: taskLimits(settings).ceiling}),
    'Progress is a durable contract, not a heartbeat. Publish task.milestone with task, phase, text, next, and evidence',
    'after initial inspection, every phase change, and before completion. Phases: inspect, plan, implement, test,',
    'verify, review, document, done. `text` says what changed, `next` says what happens next, and `evidence` names',
    'the concrete file, command, test result, or artifact. Publish task.blocked immediately when progress stops.',
    'Every task.* row you publish needs `task` (an id from your own publish replies): without it the bus refuses',
    `    bounce publish --event '{"kind":"task.milestone","task":"<task id>","phase":"inspect","text":"…","next":"…","evidence":["…"]}'`, '',
    'You may publish only: task.submitted, task.accepted, task.milestone, task.blocked, task.input_required, task.usage, task.activity, message.',
    'A task blocked at an unconfident review gate (reason review_not_accepted, review_uncertain or review_unavailable) waits for your decision: check the work yourself, then publish task.accepted with `text` naming what you checked and why, or send it back or resubmit. A confident review verdict, and work its worker reported unfinished, cannot be accepted by hand.',
    'When a worker is blocked or asks for input because it needs a decision, answer it by publishing a message to worker:<task id>: the same worker resumes with your answer. Do not re-dispatch the job as new work for that.',
    '`bounce agents set` journals agents.defined for you.',
    'A Codex worker calls its scoped `bounce_report` tool; other workers use `bounce report --report <json>`. Reports require op (milestone, blocked,',
    'input_required or final), phase, text and next;',
    'a final report additionally requires outcome (completed|failed|blocked|input_required) and summary. Do not use publish for a final report.',
    'Everything else is refused — `user`, `control.*`, and every other task lifecycle row the scheduler owns.',
  ].join('\n') + '\n', {mode: 0o600});
  return file;
}

// Enforces that only the `user` peer may publish control.* — src/bus.js has no notion
// of peer roles beyond task ownership, so this authority lives here (see T3b orders,
// "Prohibitions and open questions"). Exported so test/daemon.test.js can drive it
// directly without a real socket (D8).
export function installControlAuthority({session, scheduler, onStopped}) {
  return session.subscribe(row => {
    if (row.kind !== 'control.stop') return;
    if (row.from !== 'user') return; // control.* is publishable only by the user peer
    scheduler.stop().then(result => { onStopped(result); }).catch(() => {});
  });
}

// ---- legacy (no daemon) path: --help, sessions, models, quota, skills, doctor, login, update ----

async function legacySupervise(args, {spawnChild, updateInstall, resume = null}) {
  for (;;) {
    const outcome = await new Promise(resolve => {
      let request, update;
      const child = spawnChild(process.execPath,[cliPath,...args],{
        stdio:['inherit','inherit','inherit','ipc'],
        env:{...Object.fromEntries(Object.entries(process.env).filter(([key]) => !ORCHESTRATOR_ENV.includes(key))),
          BOUNCE_SUPERVISED:'1', BOUNCE_REMOTE_SESSION:'', BOUNCE_PERSISTENT_VIEW:'', BOUNCE_VIEW_DAEMON:'', BOUNCE_DETACHED:'', BOUNCE_RESTART:resume ? JSON.stringify(resume) : ''},
      });
      const terminate = () => child.kill('SIGTERM');
      const interrupt = () => {}; // Foreground process group delivers Ctrl+C to the child too.
      process.on('SIGTERM',terminate); process.on('SIGINT',interrupt);
      child.on('message', message => {if (message?.type === 'restart') {request = message.state; update = message.update === true;}});
      child.on('error', error => {console.error(error.message);});
      child.once('close', (code,signal) => {
        process.off('SIGTERM',terminate); process.off('SIGINT',interrupt);
        resolve({code:code ?? (signal ? 130 : 1),request,update});
      });
    });
    if (outcome.code !== 75 || !outcome.request) {process.exitCode=outcome.code;return;}
    resume=outcome.request;
    // /operation orchestrator: the child saved the config and asked to be restarted into the
    // other mode. That needs the daemon apparatus, which only supervise() can start — hand the
    // state back up rather than respawning a classic TUI that would still show workers as "off".
    if (resume.operation === 'orchestrator') return {reoperate: resume};
    if (outcome.update) {
      try {resume.updateNotice = await updateInstall();}
      catch (error) {resume.updateNotice = `Update failed: ${error.message}. Retry with /update.`;}
      console.log(resume.updateNotice);
    }
  }
}

// ---- daemon path: `run` (with or without --detach) and the bare/dev TUI ----

async function daemonSupervise(args, {spawnChild, updateInstall, adapters: extraAdapters = {}, profiles: profileOverride, strategy: strategyOverride, onReady} = {}) {
  const {values, positionals} = parseArgs({args, allowPositionals: true, strict: false, options: {
    cwd: {type: 'string'}, resume: {type: 'string'}, detach: {type: 'boolean'},
  }});
  const dev = positionals[0] === 'dev';
  // Set (only) by detachRun's spawned background process (BOUNCE_DETACHED=1): this
  // process is the backgrounded daemon, so it drains until every task is terminal
  // instead of cancelling the tree the moment its own `run` child exits. A test can
  // set the same env var around a direct, in-process supervise() call to get the same
  // drain semantics without actually forking a background process.
  const detachedDaemon = process.env.BOUNCE_DETACHED === '1' || process.env.BOUNCE_VIEW_DAEMON === '1';
  const root = dataRoot();
  const settings = config(root);
  // The live adapters are orchestrator mode's workers; a test may replace any of them by name.
  // Classic mode never dispatches, so registering them costs it nothing.
  const adapters = {claude: createClaudeLive(), codex: createCodexLive(), muse: createMuseLive(), opencode: createOpencodeLive(), typesafe: createTypesafeLive(), ...extraAdapters};
  // Validated once, before anything is created: an invalid orchestration config throws out of
  // supervise() (cli.js prints it and exits 1) with no session, daemon.json or socket behind it.
  // A profile whose vendor binary is absent fails at dispatch as task.failed{reason:'missing'}.
  // Roles are agent files: shipped with the orchestration skill, then <root>/agents, then <cwd>/.bounce/agents.
  const roles = rolesFor(root, {cwd: fs.realpathSync(values.cwd || process.cwd())});
  const orchestration = validateOrchestration(settings, [...new Set([...Object.keys(adapters), ...Object.keys(providers)])], {roles});
  const orchestrating = orchestration.operation === 'orchestrator';
  const cwd = fs.realpathSync(values.cwd || process.cwd());
  const session = new Session(cwd, {root, id: values.resume ? resolveSessionRef(root, values.resume) : undefined});
  session.lock();

  const profiles = profileOverride ?? (orchestrating ? orchestration.profiles : buildProfiles(settings));
  // Jev (src/jev.js): the read-only `jev` critic every root task may be reviewed by, registered
  // whenever orchestrating so `/jev on` mid-session needs no restart; inert until a row names it.
  // A user profile of the same name is left alone. Settings are re-read at each decision.
  if (orchestrating && !profileOverride && !Object.hasOwn(profiles, JEV_REVIEWER)) profiles[JEV_REVIEWER] = jevReviewerProfile(settings);
  // Roster notes (src/roster-notes.js): what each worker model is good for, described once by a
  // cloud agent from the roster and cached under the data root. The router waits briefly for a
  // description in flight (the first `auto` after a fresh model) and otherwise routes on what
  // is known. `orders` (ORDERS.md) is rewritten once notes land; it is bound below.
  // The local models Jev may pick as an `auto` agent's AI: discovered at decision time (no inference,
  // no loading), described by their roster note; none when local models are off or opencode is absent.
  const localAIs = async () => {
    const local = normalizeLocalSettings(settings.local);
    if (!local.enabled || !adapters.opencode || !Object.values(profiles).some(profile => profile.auto)) return [];
    return localCandidates(await discoverLocalModels(local), readRosterNotes(root));
  };
  const rosterSetup = orchestrating ? createRosterSetup({root, profiles, session,
    extra: async () => (await localAIs()).map(item => ({key: item.name, adapter: 'opencode', model: item.model, endpoint: item.endpoint})), executables: settings.executables,
    agent: setupAgent({profiles, orchestrator: orchestration.orchestrator, order: settings.order, models: settings.models}),
    catalogs: () => modelCatalog(settings), onChange: () => orders()}) : null;
  const rosterNotes = async () => {
    const pending = rosterSetup.pending();
    if (pending) await Promise.race([pending, new Promise(resolve => setTimeout(resolve, ROSTER_WAIT_MS).unref?.())]);
    return rosterSetup.notes();
  };
  const jev = orchestrating ? createJevDecisions({root, adapter: adapters.typesafe, notes: rosterNotes, order: () => settings.order ?? [], locals: localAIs}) : null;

  // Phase 8: the strategy seam, same shape as `adapters`/`profiles` above — a test (or, later, a
  // config-driven caller) may inject a strategy object directly; absent, the declarative
  // `strategy:` setting resolved by validateOrchestration (default: defaultStrategy) applies.
  let bus;
  const reportTokens = new Map();
  const scheduler = createScheduler({session, adapters, profiles, localSettings: settings.local, sessionMode: settings.mode, strict: orchestration.strict, limits: taskLimits(settings),
    requireFinalReport: orchestrating, reportGrant: ({task, attempt, context}) => {
      if (!orchestrating || !bus) return null;
      const peer = `report:${task}:${attempt}`;
      const grant = bus.grant({peer, tasks: [task], context, report: {task, attempt}});
      reportTokens.set(peer, true);
      return {BOUNCE_REPORT_BUS: bus.path, BOUNCE_REPORT_TOKEN_FILE: grant.file};
    }, strategy: strategyOverride ?? orchestration.strategy, jev});
  bus = await createBus({session, dir: session.dir, validate: scheduler.validate, prepare: scheduler.prepare, report: scheduler.report, accept: scheduler.acceptOverride});
  const userGrant = bus.grant({peer: 'user', canSubmit: true, tasks: [], context: session.id});
  // daemon.json is written AFTER the SIGTERM/SIGINT handlers are installed (below), never here:
  // it is the daemon's discovery record, so the moment it exists a `stop`/SIGTERM can arrive, and
  // a signal landing before the handler is installed would hit Node's default terminate — the
  // daemon dies with no cleanup, leaving the socket and daemon.json behind (the D10 flake).

  // Orchestrator mode: the main conversation is a peer, not a plain vendor session. It gets the
  // orchestrator grant (canSubmit, its own context, no tasks — never the user grant), its profile
  // to run on, and a standing brief on disk; classic mode reaches none of this.
  const orchestratorProfile = orchestrating ? orchestration.profiles[orchestration.orchestrator] : null;
  const orchestratorGrant = orchestrating ? bus.grant({peer: 'orchestrator', canSubmit: true, tasks: orchestratorTasks(session.events), context: session.id}) : null;
  // A read-only home or similar must not take the session down: the ORDERS.md pointer would
  // simply dangle, same as before this skill existed. Silence is the wrong answer for the
  // outcomes that leave the pointer dangling or the skill stale, though — those are said out
  // loud, because the orchestrator is about to be told to read a file that may not be there.
  if (orchestrating) {
    let notable = [];
    try { notable = seedSkills({root}).filter(row => SEED_NOTABLE.includes(row.action)); }
    catch (error) { notable = [{skill: 'bundled skills', action: 'failed', detail: error.message}]; }
    if (notable.length) session.append({kind: 'status', text: seedSummary(notable)});
  }
  // ORDERS.md mentions Jev (the `auto` roster line) only when config.json has a `jev` block at
  // all: without one the generated brief is exactly today's.
  const jevBlock = () => { try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).jev !== undefined; } catch { return false; } };
  const adapterNames = [...new Set([...Object.keys(adapters), ...Object.keys(providers)])];
  const readRoles = () => rolesFor(root, {cwd});
  const orders = () => writeOrders({session, root, bus, grant: orchestratorGrant, profiles, orchestrator: orchestration.orchestrator, jev: jevBlock() ? readJevSettings(root) : null,
    notes: effectiveNotes(profiles, readRosterNotes(root)), roles: readRoles(), settings, adapterNames});
  if (orchestrating) orders();
  // Routing on: describe the roster's models now so the first `auto` need not wait; the outcome
  // is journaled either way.
  if (orchestrating) { const jevNow = readJevSettings(root); if (jevNow.enabled && jevNow.routing.enabled) rosterSetup.ensure().catch(() => {}); }
  if (homeSessionWarning(session.cwd)) session.append({kind: 'status', text: homeSessionWarning(session.cwd)});
  if (orchestrating) session.append({kind: 'operation', operation: 'orchestrator', orchestrator: orchestration.orchestrator, shape: orchestration.shape, text: `Operation: orchestrator on ${orchestration.orchestrator} (${orchestration.shape})`});
  const bridgeEnv = orchestrating ? orchestratorBridgeEnv({session, bus, grant: orchestratorGrant, profile: orchestratorProfile}) : null;
  const main = orchestrating && positionals[0] !== 'run' ? createMainService({session, adapters, profile: orchestratorProfile, settings, profiles: orchestration.profiles, readRouting: () => config(root),
    orchestratorEnv: bridgeEnv, continuationState: () => campaignContinuationState(session.events),
    brief: `Read and follow ${path.join(session.dir, 'orchestrator', 'ORDERS.md')}.`,
    // Fire-and-forget: a new session's first prompt gets a model-given title once (src/session-title.js).
    onFirstUserPrompt: (s, cfg) => { titleSession({session: s, settings: cfg, ask: createAsk({executables: cfg.executables})}).catch(() => {}); }}) : null;
  const closeCampaignContinuation = main ? installCampaignContinuation({session}) : () => {};
  const closeLocalActivation = createLocalActivation({session, scheduler, profiles, settings, roles, readRoles,
    readSettings: () => config(root),
    refresh: orders});
  const closeJevActivation = orchestrating ? createJevActivation({session, readSettings: () => readJevSettings(root), refresh: orders, setup: options => rosterSetup.ensure(options)}) : () => {};
  if (values.resume) scheduler.reconcile().catch(error => session.append({kind: 'status', text: `Recovery failed: ${error.message}`}));

  // Worker grants are the dispatch policy expressed on the bus: a task that starts gets a grant
  // scoped to itself alone, and any terminal row revokes it. The orchestrator's own grant is
  // widened in place as it opens tasks, so it can report on its work and on nothing else. The
  // scheduler stays unaware of the bus; token paths are daemon-side state, never journaled.
  const workerTokens = new Map(); // peer -> token file, for the life of that worker's grant
  // The TUI records quota from the raw rows it renders (src/cli.js); a headless daemon never
  // opened one, so a worker's or the orchestrator's own turns went unrecorded until the next
  // `bounce quota` happened to query it. Raw rows only exist in orchestrator mode (main-service's
  // main turn, scheduler's worker turns) — same rows the TUI reads, recordQuota is idempotent.
  const quotas = orchestrating ? loadQuota(root) : null;
  const quotaUnsubscribe = orchestrating ? session.subscribe(row => {
    if (row.kind === 'raw') recordQuota(quotas, root, quotaSnapshot(row.provider, row.raw));
  }) : () => {};
  const grantsUnsubscribe = !orchestrating ? () => {} : session.subscribe(row => {
    if (row.kind === 'task.submitted' && orchestratorOwns(session.events, row.task)) bus.extendGrant('orchestrator', [row.task]);
    else if (row.kind === 'task.started') {
      const peer = `worker:${row.task}`;
      workerTokens.set(peer, bus.grant({peer, tasks: [row.task], context: row.context,
        report: {task: row.task, attempt: row.attempt}}).file);
    } else if (row.kind === 'task.attempt.ended') {
      const peer = `report:${row.task}:${row.attempt}`;
      if (reportTokens.delete(peer)) void bus.revoke(peer);
      if (workerTokens.delete(`worker:${row.task}`)) void bus.revoke(`worker:${row.task}`);
    } else if (TERMINAL_KINDS.has(row.kind)) {
      if (workerTokens.delete(`worker:${row.task}`)) void bus.revoke(`worker:${row.task}`);
      for (const peer of [...reportTokens.keys()]) if (peer.startsWith(`report:${row.task}:`)) {
        reportTokens.delete(peer); void bus.revoke(peer);
      }
    }
  });

  let unverifiedOnStop = [];
  let currentChild = null;
  // Teardown terminates the main child the way a vendor process is terminated (runProcess,
  // verifiedCancel): SIGTERM, then SIGKILL after a grace period. A child that never exits
  // would otherwise hold the IPC channel, and with it this daemon and whoever waits on its
  // pipes, forever (Phase 3 gate incident: D5's child survived SIGTERM under load).
  const terminateChild = () => {
    const child = currentChild;
    if (!child) return;
    try { child.kill('SIGTERM'); } catch {}
    const timer = setTimeout(() => { if (currentChild === child) try { child.kill('SIGKILL'); } catch {} }, CHILD_KILL_GRACE_MS);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  };
  const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
  const allRootsTerminal = () => Object.values(scheduler.tasks()).every(t => t.parent || TERMINAL.has(t.state));

  let finished = false;
  let finishPromise = null;
  let viewServer = null;
  let wakeViewDaemon;
  // Single-flight AND single-completion. Two teardown paths can fire together: the SIGTERM
  // handler's finish(143), and the run loop's finish() once a cancel makes the task tree
  // terminal and waitForDrain() resolves. The old `if (finished) return` guarded double-
  // EXECUTION but the second caller returned immediately, so the run loop could break and let
  // main() return — Node then empties the loop and exits between bus.close() (socket unlinked)
  // and removeDaemonJson (daemon.json left on disk): the intermittent D5/D10 flake. Memoizing
  // the promise makes every caller await the SAME completion, so no exit path proceeds until
  // removeDaemonJson has run. `finished` is still set synchronously for waitForDrain's check.
  const finish = code => {
    if (finishPromise) return finishPromise;
    finished = true;
    finishPromise = (async () => {
      process.exitCode = code;
      stopUnsubscribe();
      grantsUnsubscribe();
      quotaUnsubscribe();
      closeLocalActivation();
      closeJevActivation();
      closeCampaignContinuation();
      scheduler.close();
      const mainStopped = await main?.close().catch(() => ({verified: false}));
      if (mainStopped?.verified === false) unverifiedOnStop = [...unverifiedOnStop, 'orchestrator'];
      await viewServer?.close();
      process.off('SIGTERM', onSigterm); process.off('SIGINT', onSigterm);
      // Every grant this daemon minted goes away with it: the worker and orchestrator grants
      // explicitly here, the user grant with bus.close(), which unlinks every remaining token file.
      for (const peer of workerTokens.keys()) await bus.revoke(peer).catch(() => {});
      workerTokens.clear();
      for (const peer of reportTokens.keys()) await bus.revoke(peer).catch(() => {});
      reportTokens.clear();
      if (orchestratorGrant) await bus.revoke('orchestrator').catch(() => {});
      await bus.close().catch(() => {});
      session.unlock();
      if (unverifiedOnStop.length) writeDaemonJson(session.dir, {pid: process.pid, bus: bus.path, started: new Date().toISOString(), userToken: userGrant.file, unverified: unverifiedOnStop});
      else removeDaemonJson(session.dir);
      wakeViewDaemon?.();
    })();
    return finishPromise;
  };

  const stopUnsubscribe = installControlAuthority({
    session, scheduler,
    onStopped: ({cancelled, unverified}) => {
      unverifiedOnStop = unverified;
      if (unverified.length) console.error(`bounce: could not verify termination of: ${unverified.join(', ')}`);
      session.publish({kind: 'control.stopped', cancelled, unverified});
      terminateChild();
      // Give the just-published row's socket write a tick to actually flush to the
      // `stop` client before bus.close() destroys every open socket — publish() only
      // queues the write; destroying the socket immediately after can race it and
      // hand the client 'bus connection closed' instead of the control.stopped row.
      setTimeout(() => { void finish(unverified.length ? 1 : 0); }, 50);
    },
  });

  if (onReady) await onReady({scheduler, session, bus});

  // Attached (foreground `bounce run`, HEAD parity): forward SIGTERM/SIGINT to the
  // live child, exactly like the pre-Phase-2 supervisor — the child's own cancellation
  // (Router.cancel()) drives its exit code (130), which then flows through the normal
  // outcome.code !== 75 branch below (cancel the tree, log unverified, finish(130)).
  // Detached (backgrounded) daemon: there is no foreground child session to hand the
  // signal to in the same sense, so a direct SIGTERM/SIGINT tears the daemon down here.
  const onSigterm = () => {
    if (!detachedDaemon) { if (currentChild) try { currentChild.kill('SIGTERM'); } catch {} return; }
    void (async () => {
      const {unverified} = await scheduler.stop();
      unverifiedOnStop = unverified;
      if (unverified.length) console.error(`bounce: could not verify termination of: ${unverified.join(', ')}`);
      terminateChild();
      await finish(143);
      process.exit(143);
    })();
  };
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigterm);
  if (main && process.env.BOUNCE_VIEW_DAEMON === '1') {
    viewServer = await createViewServer({session, main, token: fs.readFileSync(userGrant.file, 'utf8').trim(), onControl: async message => {
      if (message.action === 'cancel' && message.task) await scheduler.cancel(message.task);
      else if (message.action === 'stop') await scheduler.stop();
      else if (message.action === 'quit') {
        const {unverified} = await scheduler.stop();
        const mainStopped = await main.cancel();
        if (unverified.length || mainStopped?.verified !== true) return {verified: false, reason: 'termination_unverified'};
        return {verified: true, afterAck: () => finish(0)};
      }
    }});
  }
  // Now discoverable: a signal from here on is caught by onSigterm and torn down cleanly.
  writeDaemonJson(session.dir, {pid: process.pid, bus: bus.path, started: new Date().toISOString(), userToken: userGrant.file,
    ...(viewServer ? {view: viewServer.path, protocol: 1, profile: orchestratorProfile} : {})});
  if (viewServer) {
    await new Promise(resolve => { if (finished) resolve(); else wakeViewDaemon = resolve; });
    return;
  }

  // Detached daemon only: waits for every root task to go terminal (or for `finish`
  // to already have run, via control.stop/SIGTERM) before the daemon is allowed to
  // exit — a headless `run --detach` whose child process already closed must still
  // stay up while a delegated task runs.
  function waitForDrain() {
    return new Promise(resolve => {
      if (finished || allRootsTerminal()) return resolve();
      const unsub = session.subscribe(() => { if (finished || allRootsTerminal()) { unsub(); resolve(); } });
    });
  }

  let resume = values.resume ? {id: session.id} : null;
  for (;;) {
    if (finished) break;
    const childArgs = args.filter(a => a !== '--detach');
    const childEnv = {
      ...process.env, BOUNCE_SUPERVISED: '1', BOUNCE_REMOTE_SESSION: '1',
      BOUNCE_RESTART: resume ? JSON.stringify(resume) : '',
    };
    // Removed first, then set only in orchestrator mode: a classic run must not inherit a stale
    // (or hostile) BOUNCE_ROLE/BOUNCE_BUS from whoever started the daemon.
    for (const key of ORCHESTRATOR_ENV) delete childEnv[key];
    if (orchestratorProfile) Object.assign(childEnv, bridgeEnv);
    const outcome = await new Promise(resolvePromise => {
      let request, update, switchTo;
      const child = spawnChild(process.execPath, [cliPath, ...childArgs], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: childEnv,
      });
      currentChild = child;
      const host = hostSession({session, child, main});
      child.on('message', message => {
        if (message?.type === 'restart') { request = message.state; update = message.update === true; }
        // /resume and /new in orchestrator mode: this daemon is bound to one session (its bus,
        // grants and journal), so switching means finishing here and letting supervise() start
        // a daemon for the other session. The TUI refuses the switch while workers still run.
        else if (message?.type === 'switch') { switchTo = typeof message.id === 'string' && message.id ? message.id : 'new'; }
        // Phase 9.3 steering: the interactive orchestrator child (the TUI) asks the daemon to
        // cancel one task or the whole tree over its own IPC channel — the scheduler owns cancel,
        // and the resulting task.cancelled rows flow back to the TUI's AGENTS pane.
        else if (message?.type === 'control') {
          if (message.action === 'stop') scheduler.stop().catch(() => {});
          else if (message.action === 'cancel' && message.task) scheduler.cancel(message.task).catch(() => {});
        }
      });
      // Every write to a child that already exited (IPC send, stdin) emits its own EPIPE 'error';
      // `once` handled the first and let the second crash the daemon mid-teardown, leaving
      // daemon.json behind after `bounce stop` (observed under a loaded full test run).
      child.on('error', error => { console.error(error.message); });
      child.once('close', (code, signal) => {
        currentChild = null;
        host.detach();
        resolvePromise({code: code ?? (signal ? 130 : 1), request, update, switchTo});
      });
    });
    if (finished) break;
    if (outcome.code === 76 && outcome.switchTo) {
      await finish(0);
      return {switchTo: outcome.switchTo};
    }
    // /operation classic: this daemon is the orchestrator apparatus, so leaving that mode means
    // finishing here (the TUI refused the switch while workers still ran) and letting supervise()
    // respawn the same session under the classic loop.
    if (outcome.code === 75 && outcome.request?.operation === 'classic') {
      await finish(0);
      return {reoperate: outcome.request};
    }
    if (outcome.code !== 75 || !outcome.request) {
      if (detachedDaemon) {
        await waitForDrain();
      } else {
        // Attached: a live task must not keep `bounce run` alive forever just because
        // its own child process exited — cancel the tree the same way `stop` does.
        const {unverified} = await scheduler.stop();
        unverifiedOnStop = unverified;
        if (unverified.length) console.error(`bounce: could not verify termination of: ${unverified.join(', ')}`);
      }
      await finish(outcome.code);
      break;
    }
    resume = outcome.request;
    if (outcome.update) {
      try { resume.updateNotice = await (updateInstall ?? installUpdate)(); }
      catch (error) { resume.updateNotice = `Update failed: ${error.message}. Retry with /update.`; }
    }
  }
}

async function detachRun(args, {spawnChild}) {
  const {values} = parseArgs({args, allowPositionals: true, strict: false, options: {
    cwd: {type: 'string'}, resume: {type: 'string'}, detach: {type: 'boolean'}, json: {type: 'boolean'},
  }});
  const root = dataRoot();
  const cwd = fs.realpathSync(values.cwd || process.cwd());
  // Minting (or reopening) the session here, in the foreground, is what lets us print
  // the id immediately; the detached daemon reopens the same session by id.
  const session = new Session(cwd, {root, id: values.resume ? resolveSessionRef(root, values.resume) : undefined});
  const id = session.id;
  const childArgs = args.filter(a => a !== '--detach').filter(a => a !== '--resume' && a !== id);
  if (!childArgs.includes('--json')) childArgs.push('--json');
  childArgs.push('--resume', id);
  const child = spawnChild(process.execPath, [cliPath, ...childArgs], {
    detached: true, stdio: 'ignore', env: {...process.env, BOUNCE_DETACHED: '1'},
  });
  child.unref();
  console.log(values.json ? JSON.stringify({id}) : id);
  process.exitCode = 0;
}

// attach/stop accept a name or id prefix; an unknown reference keeps its raw form so the
// commands' own "not running" path answers, as before.
function resolveOrRaw(ref) {
  if (!ref) return ref;
  try { return resolveSessionRef(dataRoot(), ref); } catch { return ref; }
}

async function interactiveView(args, {existing, restart} = {}) {
  const {values} = parseArgs({args, allowPositionals: true, strict: false, options: {cwd: {type: 'string'}, resume: {type: 'string'}}});
  const root = dataRoot();
  const session = existing ? {id: existing.id, dir: path.join(root, 'sessions', existing.id)}
    : new Session(fs.realpathSync(values.cwd || process.cwd()), {root, id: values.resume ? resolveSessionRef(root, values.resume) : undefined});
  let info = existing?.info ?? readDaemonJson(session.dir);
  if (!info || !pidAlive(info.pid)) {
    // The daemon is spawned with stdio:'ignore', so anything it throws is invisible and surfaces
    // only as "did not become ready". Configuration errors are deterministic and detectable here,
    // in the foreground, where the user can actually read them — a bad profile must name itself
    // rather than masquerade as a daemon that failed to start.
    validateOrchestration(config(root), undefined, {roles: rolesFor(root, {cwd: session.cwd ?? process.cwd()})});
    const daemonArgs = args.filter((value, index) => value !== '--resume' && args[index - 1] !== '--resume' && !value.startsWith('--resume='));
    const daemon = spawn(process.execPath, [cliPath, ...daemonArgs, '--resume', session.id], {
      detached: true, stdio: 'ignore', env: {...process.env, BOUNCE_VIEW_DAEMON: '1', BOUNCE_DETACHED: '1', BOUNCE_SUPERVISED: '', BOUNCE_REMOTE_SESSION: ''},
    });
    daemon.unref();
    let spawnError;
    daemon.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !spawnError) {
      info = readDaemonJson(session.dir);
      if (info?.view && pidAlive(info.pid)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (spawnError || !info?.view || !pidAlive(info.pid)) throw spawnError ?? new Error(`Daemon did not become ready for ${session.id}; inspect its session journal`);
  }
  if (!info.view || info.protocol !== 1) throw new Error('Running daemon uses an older view protocol; use bounce attach ID --json or stop it explicitly before restarting');
  const channel = await connectView({path: info.view, token: fs.readFileSync(info.userToken, 'utf8').trim()});
  const child = spawn(process.execPath, [cliPath, ...args], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: {...process.env, BOUNCE_SUPERVISED: '1', BOUNCE_REMOTE_SESSION: '1', BOUNCE_PERSISTENT_VIEW: '1', BOUNCE_VIEW_DAEMON: '',
      BOUNCE_SESSION: session.id, BOUNCE_ROLE: 'orchestrator', BOUNCE_ORCHESTRATOR_PROFILE: JSON.stringify(info.profile),
      BOUNCE_RESTART: restart ? JSON.stringify(restart) : ''},
  });
  let requestedQuit = false, requestedRestart = null, switchTo = null, quitRequest;
  channel.on('message', message => { if (child.connected) child.send(message, () => {}); });
  child.on('message', message => {
    if (message?.type === 'control' && message.action === 'quit') {
      requestedQuit = true;
      quitRequest = requestViewControl(channel, 'quit').catch(error => ({verified: false, reason: error.message}));
      return;
    }
    if (message?.type === 'restart') { requestedRestart = message; return; }
    if (message?.type === 'switch') { switchTo = message.id; return; }
    try { channel.send(message); } catch {}
  });
  channel.on('disconnect', () => {
    if (child.connected) child.send({type: 'main.event', event: {kind: 'main.disconnected', state: 'unavailable', text: 'Daemon disconnected; session journal is saved'}}, () => {});
  });
  // Detaching a view never cancels its provider. Explicit /quit is sent before the view exits.
  const code = await new Promise(resolve => { child.once('error', () => resolve(1)); child.once('close', value => resolve(value ?? 1)); });
  if ((code === 75 && requestedRestart) || (code === 76 && switchTo) || requestedQuit) {
    const stopped = await (quitRequest ?? requestViewControl(channel, 'quit'));
    if (stopped?.verified !== true) {
      channel.close();
      throw new Error(`Session ${session.id} remains running: ${stopped?.reason ?? 'termination unverified'}. Reattach with bounce attach ${session.id}`);
    }
    const deadline = Date.now() + 10000;
    while (readDaemonJson(session.dir) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (readDaemonJson(session.dir)) { channel.close(); throw new Error('Stopped daemon has not released its session; restart refused'); }
  }
  channel.close();
  if (code === 75 && requestedRestart) {
    // The daemon is stopped and has released the session above; a switch to classic hands the
    // state to supervise(), which resumes the same session id under legacySupervise.
    if (requestedRestart.state?.operation === 'classic') return {reoperate: requestedRestart.state};
    return interactiveView(args, {existing: {id: session.id}, restart: requestedRestart.state});
  }
  if (code === 76 && switchTo) {
    const next = args.filter((value, index) => value !== '--resume' && args[index - 1] !== '--resume' && !value.startsWith('--resume='));
    if (switchTo !== 'new') next.push('--resume', switchTo);
    return interactiveView(next);
  }
  process.exitCode = code === 80 ? 0 : code;
  if (!requestedQuit) console.log(`Session ${session.id} continues. Reattach: bounce attach ${session.id}`);
}

async function attachCommand(args) {
  const {values, positionals} = parseArgs({args: args.slice(1), allowPositionals: true, options: {json: {type: 'boolean'}}});
  const id = resolveOrRaw(positionals[0]);
  if (!id) { console.error('bounce: attach requires a session id'); process.exitCode = 2; return; }
  const root = dataRoot();
  const dir = path.join(root, 'sessions', id);
  const info = readDaemonJson(dir);
  if (!info || !pidAlive(info.pid)) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  if (!values.json && process.stdin.isTTY && info.view) return interactiveView(['--resume', id], {existing: {id, info}});
  let client;
  try { client = await connectBus({path: info.bus, token: fs.readFileSync(info.userToken, 'utf8').trim()}); }
  catch (error) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  const printRow = row => console.log(formatRow(row, values.json));
  const initial = await client.events({afterSeq: 0});
  for (const row of initial) printRow(row);
  let last = initial.at(-1)?.seq ?? 0;
  const DEAD = Symbol('dead');
  const watchPid = pid => {
    let timer;
    const promise = new Promise(resolve => { timer = setInterval(() => { if (!pidAlive(pid)) { clearInterval(timer); resolve(DEAD); } }, 200); });
    return {promise, cancel: () => clearInterval(timer)};
  };
  for (;;) {
    if (!pidAlive(info.pid)) break;
    const watcher = watchPid(info.pid);
    let row;
    try { row = await Promise.race([client.wait({match: {}, afterSeq: last, timeout: 30000}), watcher.promise]); }
    catch { watcher.cancel(); break; }
    watcher.cancel();
    if (row === DEAD) break;
    if (row) { printRow(row); last = row.seq ?? last; }
  }
  try { await client.close(); } catch {}
  process.exitCode = 0;
}

async function stopCommand(args) {
  const id = resolveOrRaw(args[1]);
  if (!id) { console.error('bounce: stop requires a session id'); process.exitCode = 2; return; }
  const root = dataRoot();
  const dir = path.join(root, 'sessions', id);
  const info = readDaemonJson(dir);
  if (!info || !pidAlive(info.pid)) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  let client;
  try { client = await connectBus({path: info.bus, token: fs.readFileSync(info.userToken, 'utf8').trim()}); }
  catch (error) { console.log(`session ${id} is not running`); process.exitCode = 1; return; }
  await client.publish({kind: 'control.stop'}).catch(() => {});
  let row = null;
  try { row = await client.wait({match: {kind: 'control.stopped'}, timeout: 30000}); }
  catch { row = null; } // the daemon may tear down its socket before this reply is flushed; fall back to daemon.json below
  try { await client.close(); } catch {}
  if (row) {
    console.log(JSON.stringify(row));
    process.exitCode = row.unverified?.length ? 1 : 0;
    if (row.unverified?.length) console.log(`unverified: ${row.unverified.join(', ')}`);
    return;
  }
  // No in-band reply (socket torn down first): daemon.json is authoritative — it is
  // removed on a fully verified stop, and kept (with `unverified`) otherwise.
  try {
    await waitFor(() => !pidAlive(info.pid), {timeout: 5000});
  } catch { /* fall through to whatever's on disk */ }
  const after = readDaemonJson(dir);
  if (!after) { console.log('stopped'); process.exitCode = 0; return; }
  if (after.unverified?.length) { console.log(`unverified: ${after.unverified.join(', ')}`); process.exitCode = 1; return; }
  console.log('stop timed out'); process.exitCode = 1;
}

async function waitFor(fn, {timeout = 5000, interval = 20} = {}) {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeout) throw new Error('timed out');
    await new Promise(r => setTimeout(r, interval));
  }
}

// ---- dispatcher -------------------------------------------------------

export async function supervise(args = process.argv.slice(2), {spawnChild = spawn, updateInstall = installUpdate, adapters, profiles, strategy, onReady} = {}) {
  const command = args[0];
  if (command === 'attach') return attachCommand(args);
  if (command === 'stop') return stopCommand(args);
  if (command === 'run' && args.includes('--detach')) return detachRun(args, {spawnChild});
  if (command === 'run') return daemonSupervise(args, {spawnChild, updateInstall, adapters, profiles, strategy, onReady});
  // Phase 9 (interactive orchestrator): the interactive TUI whose config is orchestrator gets the
  // full daemon apparatus (bus + scheduler + orchestrator grant) with an INTERACTIVE child — the
  // args carry no `run`, so cli.js enters its multi-turn TUI branch as the orchestrator peer and
  // each user turn delegates over the bridge. Classic config keeps the pre-Phase-2 legacySupervise
  // loop, byte-identical. We read only the raw `operation` field (not full validateOrchestration,
  // which would reject a `local` profile under the default adapter list) and let daemonSupervise
  // do the real validation and surface any error.
  // Only the interactive TUI itself (no subcommand, or `dev`) gets the apparatus. Every other
  // invocation — sessions, models, quota, skills, rename, task, --help, --version, the bridge
  // commands — is a plain command: routing those through daemonSupervise created a session, a
  // bus and an orchestrator grant per invocation (96 empty sessions were found this way).
  const {positionals, values: info} = parseArgs({args, allowPositionals: true, strict: false, options: {
    cwd: {type: 'string'}, resume: {type: 'string'}, provider: {type: 'string'}, model: {type: 'string'}, mode: {type: 'string'},
    image: {type: 'string', multiple: true}, scope: {type: 'string'}, help: {type: 'boolean', short: 'h'}, version: {type: 'boolean', short: 'v'},
  }});
  const interactive = !info.help && !info.version && (positionals.length === 0 || (positionals.length === 1 && positionals[0] === 'dev'));
  // The TUI needs a terminal; only the view daemon (spawned by interactiveView, BOUNCE_VIEW_DAEMON=1)
  // legitimately takes the interactive args without one. Any other headless `bounce` — typically a
  // worker or the orchestrator's CLI probing for usage from its shell — is refused here, before a
  // session, bus, roster setup or daemon exists for nobody to attach to. Same message as cli.js's
  // own check so the classic path reads identically. A test's injected spawnChild is exempt, as
  // it is for interactiveView below: it drives this path without a terminal by design.
  if (interactive && spawnChild === spawn && process.env.BOUNCE_VIEW_DAEMON !== '1' && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('TUI requires a terminal. Use bounce run "prompt" for headless execution, or bounce report/publish/wait from a worker shell.');
  }
  let operation = 'classic';
  if (interactive) { try { operation = config(dataRoot()).operation ?? 'classic'; } catch { /* a broken config surfaces in the classic TUI below */ } }
  // The mode is fixed per spawn (the daemon and its workers exist or they don't), so /operation
  // and Ctrl+O save the config and restart the session into the other mode: the TUI exits 75
  // with a state that names the mode, the hosting path returns `reoperate`, and the loop below
  // resumes the same session id under the other path. Both directions keep the transcript.
  let restart = null;
  for (;;) {
    let result;
    if (operation === 'orchestrator') {
      if (process.env.BOUNCE_VIEW_DAEMON !== '1' && spawnChild === spawn && process.stdin.isTTY) {
        result = await interactiveView(args, restart ? {existing: {id: restart.id}, restart} : {});
      } else {
        // A session switch (/resume, /new) ends one daemon and starts the next for the chosen
        // session — same args, only `--resume` replaced ('new' drops it).
        let current = restart?.id ? [...stripResume(args), '--resume', restart.id] : args;
        for (;;) {
          result = await daemonSupervise(current, {spawnChild, updateInstall, adapters, profiles, strategy, onReady});
          if (!result?.switchTo) break;
          current = result.switchTo === 'new' ? stripResume(current) : [...stripResume(current), '--resume', result.switchTo];
        }
      }
    } else result = await legacySupervise(args, {spawnChild, updateInstall, resume: restart});
    if (!result?.reoperate) return result;
    restart = result.reoperate;
    operation = restart.operation;
  }
}

function stripResume(args) {
  const stripped = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume') { i++; continue; }
    if (args[i].startsWith('--resume=')) continue;
    stripped.push(args[i]);
  }
  return stripped;
}
