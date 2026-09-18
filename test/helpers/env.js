// Test-only setup: strips every inherited BOUNCE_* variable from this process's env so the
// suite is hermetic wherever it is started from. A bounce worker or orchestrator shell carries
// BOUNCE_DETACHED=1 / BOUNCE_VIEW_DAEMON=1 (plus BOUNCE_REPORT_BUS etc.); `node --test` runs
// each file in a child that inherits them, so an in-process supervise() call or a CLI child
// spawned with {...process.env} would behave like a detached daemon (src/reload.js
// detachedDaemon) instead of the foreground run the test expects. Imported first by every
// test file that spawns the CLI, calls supervise() or drives a live adapter, so the scrub runs
// before any child is created. Deliberately NOT wired through `node --test --import`: fork()
// forwards execArgv, so a preload would re-run inside the TUI children and strip the
// BOUNCE_SUPERVISED / BOUNCE_REMOTE_SESSION those tests set on purpose.
//
// BOUNCE_LIVE_DOCKER is the one deliberate opt-in (the *.live.test.js files) and is kept.
const KEEP = new Set(['BOUNCE_LIVE_DOCKER']);
for (const key of Object.keys(process.env)) {
  if (key.startsWith('BOUNCE_') && !KEEP.has(key)) delete process.env[key];
}
