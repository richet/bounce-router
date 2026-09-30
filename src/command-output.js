// How bounce says what a command did: one wording for a command it watched a worker run, for a
// task's check it ran itself, and for what either printed.
const COMMAND_OUTPUT_MAX = 2000; // the end of a command's output is where its result is

export const outputTail = value => {
  const text = String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (text.length <= COMMAND_OUTPUT_MAX) return text;
  return `[… the first ${text.length - COMMAND_OUTPUT_MAX} characters are left out …]\n${text.slice(-COMMAND_OUTPUT_MAX)}`;
};

const printed = output => (output ? ` The end of its output:\n${output}` : ' It printed nothing.');
const joined = output => (output ? '\n' : ' ');

const ending = ({exit, timedOut = false, minutes = null}) => {
  if (timedOut) return `it did not finish in ${minutes} minutes and was stopped`;
  return exit === null || exit === undefined ? 'no exit code reported' : `exit code ${exit}`;
};

// Evidence for a report bounce had to write: a command the worker ran, as bounce saw it.
export function seenRun({command, exit, output}) {
  const ended = exit === null || exit === undefined ? 'ended (no exit code reported)' : `ended with exit code ${exit}`;
  return `Seen by bounce, not reported by the worker: \`${command}\` ${ended}.${printed(output)}`;
}

export const NO_RUN_AFTER_CHANGE = 'Seen by bounce: the worker ran no command after its last file change, so nothing it ran checked the final state.';
export const NO_RUN = 'Seen by bounce: the worker ran no command.';

// Evidence for the review: the task's check, which passed.
const ONLY_LOOKS = 'This check only looks for files or text';

export function checkPassed(check) {
  const ran = `bounce ran the task's check \`${check.command}\` in the worker's copy: ${ending(check)}.${printed(check.output)}`;
  return check.weak ? `${ran}${joined(check.output)}${ONLY_LOOKS}; it did not run the work.` : ran;
}

// What the orchestrator is told when it submits such a check.
export function weakCheckNotice(command) {
  return `check: \`${command}\` only looks for files or text; it does not run the work, so passing it will not count as verification. Name a check that runs the work (its tests, its script) and fails when the result is wrong.`;
}

// What a worker is told when the task's check fails.
export function checkFinding(check) {
  // Found live (ACE e3bd01d5): all 6 false reports were written in the round after this message, which
  // then said "Fix what it reports"; and 18 first checks failed because the evidence was saved outside
  // the working copy.
  if (check.weak) {
    return `The task's check failed. bounce ran \`${check.command}\` in your working copy: ${ending(check)}.${printed(check.output)}${joined(check.output)}${ONLY_LOOKS}, and only inside your working copy: what you saved elsewhere on disk does not count. Put the real results where it looks. If the work could not be done, or its result is a failure, say so in your report; never write what the check looks for to make it pass.`;
  }
  return `The task's check failed. bounce ran \`${check.command}\` in your working copy: ${ending(check)}.${printed(check.output)}${joined(check.output)}Fix what it reports, and run it yourself before you finish.`;
}

export const HELD_WORK = 'The work is kept. Decide: send it back (task.rework with what to fix), retry it on another AI (retryOf), or accept it as it is (task.accepted with what you checked).';

export function checkStillFails(check) {
  return `The task's check still fails after its one rework round, so the work was not put in the checkout. bounce ran \`${check.command}\` in the worker's copy: ${ending(check)}.${printed(check.output)}${joined(check.output)}${HELD_WORK}`;
}

// Found on the real path (2026-09-28): a check naming a tool that was not on the path was read as
// failing work, and the worker sent back for it rewrote the project's task commands.
export function checkCouldNotRun(check) {
  return `The task's check could not be run, so nothing verified this work and it was not put in the checkout. bounce ran \`${check.command}\` in the worker's copy: ${ending(check)}.${printed(check.output)}${joined(check.output)}The check runs in a plain shell with bounce's own environment: name the tool by its full path, or set PATH inside the check. The work is kept. Decide: accept it with what you checked yourself (task.accepted), or retry it with a check that runs (retryOf).`;
}

// Work that changed files and that no check has run waits for the orchestrator (Daniel, 2026-09-29).
// Found live (ACE e3bd01d5): 6 wrong results were put in the checkout as soon as their worker finished,
// and corrected afterwards by the orchestrator, who had caught every one of them by reading it.
export function heldForAccept({check = null, byBounce = false, said = '', copy = null} = {}) {
  const why = `${check?.weak ? 'the task\'s check only looks for files or text' : 'the task names no check'}${byBounce ? ', and the worker wrote no report (bounce wrote one from what it saw)' : ''}`;
  return `Nothing that runs this work has verified it, so it waits for you and is not in the checkout: ${why}. ${said}${said ? ' ' : ''}${copy ? `The work is in ${copy}. ` : ''}Decide: accept it (task.accepted with what you checked), send it back (task.rework with what to fix), or retry it on another AI (retryOf).`;
}
