// /btw — a one-shot, read-only side question about this session (Claude Code's own /btw): it
// forks a single call to the same provider/model the orchestrator (or, in classic mode, the
// active provider) runs on, answers from the conversation so far, and never touches the running
// turn. Contrast with /steer (src/cli.js's steerAside), which delivers into or queues for the
// live turn — /btw never does either; see CONTRACT U5a: this file adds no `submit(`/`router.run(`
// site of its own, it only ever runs from the existing command dispatch.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {invocation, runProcess} from './providers.js';
import {resolveExecutable} from './executable.js';
import {taskList} from './task-view.js';
import {formatTaskList} from './task-report.js';

// Newest kept: the whole blob (state note, task list, conversation) is built oldest-first and
// trimmed from the front when it overruns, so a long session loses its earliest context first.
export const BTW_CONTEXT_CHARS = 24000;
const BTW_TIMEOUT_MS = 120000;
const CONVO_KINDS = new Set(['user', 'assistant', 'main.terminal']);

// The context /btw answers from: the recent conversation, plus — in orchestrator mode — the
// orchestrator's own state note and a compact task list. Reuses task-view.js/task-report.js's
// bounded views rather than inventing a new shape (docs: "found live" reasons in task-view.js).
export function buildBtwContext(events, {orchestrating = false} = {}) {
  const sections = [];
  if (orchestrating) {
    const state = [...events].reverse().find(e => e.kind === 'state');
    if (state?.text) sections.push(`Orchestrator's latest state note:\n${state.text}`);
    const rows = taskList(events);
    if (rows.length) sections.push(`Tasks:\n${formatTaskList(rows)}`);
  }
  const convo = events
    .filter(e => CONVO_KINDS.has(e.kind) && typeof e.text === 'string' && e.text.trim())
    .map(e => `[${e.kind}${e.provider ? ':' + e.provider : ''}] ${e.text.trim()}`)
    .join('\n');
  if (convo) sections.push(`Recent conversation:\n${convo}`);
  const context = sections.join('\n\n');
  return context.length > BTW_CONTEXT_CHARS ? context.slice(-BTW_CONTEXT_CHARS) : context;
}

// The same provider/model the orchestrator runs on in orchestrator mode, else the classic
// session's active provider (or its first fallback order entry before any turn has run).
export function resolveBtwAgent({settings, orchestration, session}) {
  if (orchestration?.operation === 'orchestrator') {
    const profile = orchestration.profiles?.[orchestration.orchestrator] ?? {};
    return {adapter: profile.adapter ?? null, model: profile.model || settings?.models?.[profile.adapter] || ''};
  }
  const adapter = session?.active || settings?.order?.[0] || null;
  return {adapter, model: settings?.models?.[adapter] || ''};
}

export function buildBtwPrompt(question, context) {
  return [
    'This is a side question from the user about this bounce session, asked with /btw. It is not a new instruction and it does not continue or steer any turn in progress.',
    'Answer it concisely. Start from the context below; when it is not enough, read files in the working folder (the project, its docs and notes) to find the answer. Read only: never edit, run builds or change anything. If you still cannot tell, say so plainly instead of guessing.',
    '', 'Context:', context || '(no context available)', '', `Question: ${question}`,
  ].join('\n');
}

// The whole operation for one /btw: journal the question, build the context, ask, journal the
// answer or a failure reason. Never delivers into or queues for the main turn — `ask` is a plain
// one-shot call injected by the caller (see createBtwAsk below for the default).
export async function askBtw({session, settings, orchestration, ask, id, question}) {
  // `btw` pairs the answer with its question; the row's own `id` must stay unique (found live: sharing it,
  // the view deduped the answer away as a repeat of the question).
  session.append({kind: 'btw.asked', text: question, btw: id});
  const context = buildBtwContext(session.events, {orchestrating: orchestration?.operation === 'orchestrator'});
  const agent = resolveBtwAgent({settings, orchestration, session});
  try {
    if (!agent.adapter) throw new Error('no_agent');
    const answer = await ask({prompt: buildBtwPrompt(question, context), agent, settings, cwd: session.cwd});
    if (!answer?.text) throw new Error('no_answer');
    session.append({kind: 'btw.answered', btw: id, text: answer.text, model: answer.model ?? null});
  } catch (error) {
    const reason = ['no_agent', 'no_answer', 'cancelled'].includes(error.message) ? error.message : 'failed';
    session.append({kind: 'btw.failed', btw: id, reason});
  }
}

// The default `ask`: the same one-shot provider path session-title.js's askCloud uses (plan
// mode — read-only, no tools), on the caller's resolved agent rather than the first signed-in
// provider. Injectable so tests never spawn a real vendor CLI; the hermetic preload would refuse
// one anyway. Aborted if the TUI exits, exactly like session-title.js's createAsk.
const exitHook = fn => { process.once('exit', fn); return () => process.off('exit', fn); };

export function createBtwAsk({run = runProcess, executables = {}, onExit = exitHook} = {}) {
  return async function ask({prompt, agent, cwd}) {
    const dir = os.tmpdir();
    const promptFile = path.join(dir, `bounce-btw-${randomUUID()}.txt`);
    fs.writeFileSync(promptFile, prompt, {mode: 0o600});
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BTW_TIMEOUT_MS);
    const forget = onExit(() => controller.abort());
    const said = [], results = [];
    try {
      const result = await run({provider: agent.adapter, executable: resolveExecutable(agent.adapter, executables[agent.adapter]),
        args: invocation(agent.adapter, {model: agent.model, mode: 'plan'}, promptFile), prompt, cwd: cwd || dir, signal: controller.signal,
        emit: e => { if (e.kind === 'assistant') said.push(e.text); else if (e.kind === 'result' && e.success) results.push(e.text); }});
      if (controller.signal.aborted) throw new Error('cancelled');
      if (result.status !== 'completed') throw new Error('failed');
    } finally { clearTimeout(timer); forget(); fs.rmSync(promptFile, {force: true}); }
    const text = results.at(-1) ?? said.at(-1);
    if (!text) throw new Error('no_answer');
    return {text, model: `${agent.adapter}${agent.model ? `/${agent.model}` : ''}`};
  };
}
