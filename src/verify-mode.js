// Who verifies, per session, changed live: some work is better verified by the orchestrator, to avoid collisions, and
// some by the worker. It only changes the orchestrator's verifying
// orders; bounce runs a task's check in the worker's copy in every mode. In every mode the gates pass on the final
// head and the final result names the commit each gate ran on.
export const VERIFY_MODES = ['orchestrator', 'worker', 'auto'];

// `verify=worker` (as sent with `bounce send`) or `/verify worker` (typed): the mode, or null for any other text.
export function parseVerify(text) {
  const match = /^\s*(?:\/verify\s+|verify\s*=\s*)(\w+)\s*$/i.exec(String(text ?? ''));
  const mode = match?.[1].toLowerCase();
  return VERIFY_MODES.includes(mode) ? mode : null;
}

// The last mode set in the session, else the config's, else auto.
export function verifyMode(events, fallback = 'auto') {
  return events.findLast(e => e.kind === 'control.verify' && VERIFY_MODES.includes(e.mode))?.mode
    ?? (VERIFY_MODES.includes(fallback) ? fallback : 'auto');
}

const CHECK = 'put every gate in the task\'s check (one command; chain them, or a script) and the review in review.completion; bounce runs both at once in the worker\'s copy and decides with both, so a task waits only for the slower of them. Do not rerun the gates yourself and then dispatch a reviewer.';
const ROUNDS = 'Between fix rounds, a builder\'s raw gate output that names the exact commit it ran on is enough to send the next round.';
const END = 'In every case, see every gate pass on the final head before you accept it, and in your final result name the commit each gate ran on, saying so plainly when one is not the delivered head.';
const ORDERS = {
  orchestrator: `Verifying work (mode: orchestrator): run the final gates yourself, in your own copy, one gate run at a time; this mode is for stacks that share resources or one branch at a time. Workers' checks still run, but take them as evidence, not as the final word. ${ROUNDS} ${END}`,
  worker: `Verifying work (mode: worker): ${CHECK} ${ROUNDS} At the end, accept on bounce's check when the delivery line says it passed on this tree; rerun only when it says NOT CHECKED AS DELIVERED, or the merged tree differs from the checked one. ${END}`,
  auto: `Verifying work (mode: auto): ${CHECK.replace('put every gate', 'put the gates')} ${ROUNDS} Before you accept the final head, run the final gates yourself on it, unless the handoff shows bounce's check passed on that same tree (a merged tree equal to it needs no rerun). ${END}`,
};
export const verifyingOrders = mode => ORDERS[VERIFY_MODES.includes(mode) ? mode : 'auto'];

// A sent or typed verify line: journals the mode and returns what the orchestrator's turn says instead of the bare
// line. Null when the text is not one.
export function applyVerify(session, text, {by = 'user'} = {}) {
  const mode = parseVerify(text);
  if (!mode) return null;
  session.append({kind: 'control.verify', mode, by, text: `Verification mode: ${mode}`});
  return `The user set the verification mode to ${mode}. From now on:\n${verifyingOrders(mode)}`;
}
