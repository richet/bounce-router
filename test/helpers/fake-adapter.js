// A fake adapter for scheduler tests. launch({peer, profile, orders, cwd}) calls
// script({peer, profile, orders, cwd}) to decide the task's fate. script's return value is
// awaited, so it may itself be a promise — this is how tests defer a launch under control
// (e.g. Promise.withResolvers()). Once resolved, the outcome may be:
//   - an array of adapter events (the task runs them in order, then ends)
//   - {events: [...], cancel: {verified}} to also control what cancel() reports
//   - {launchError: 'missing' | 'backend_unavailable' | <any code>} to make launch() reject
//   - {never: true, cancel: {verified}} for a controllable never-ending task: events()
//     blocks until cancel() is called, then ends with no further events.
// An event shaped {kind: '__throw', message} makes events() throw mid-stream instead of
// yielding, for testing a broken adapter stream.
// calls.launch / calls.cancel / calls.events count invocations for assertions.
// resume({peer, profile, native, message, cwd, dir, checkpoint}) calls the same `script` (so
// a rework round can hand back a fresh sequence of events, e.g. an accept after a rework) and
// produces a handle the same shape launch() does. calls.resume counts invocations; resumeCalls
// records each call's full args for assertion (native, message, dir, checkpoint).
export function fakeAdapter(script) {
  const calls = {launch: 0, cancel: 0, events: 0, resume: 0, deliver: 0};
  const resumeCalls = [];
  const deliveries = [];
  return {
    calls,
    resumeCalls,
    deliveries,
    // Default delivery contract: records the call and reports 'live'. Tests that need a
    // different tier or a throwing deliver override this property directly on the returned
    // adapter (see test/scheduler.test.js's deliveringAdapter for the pattern).
    async deliver(handle, event) {
      calls.deliver++;
      deliveries.push({handle, event});
      return 'live';
    },
    async launch(args) {
      calls.launch++;
      const outcome = await script(args);
      if (outcome && !Array.isArray(outcome) && outcome.launchError) {
        const error = new Error(`fake adapter launch failed: ${outcome.launchError}`);
        error.code = outcome.launchError;
        throw error;
      }
      const never = !Array.isArray(outcome) && outcome?.never === true;
      const events = Array.isArray(outcome) ? outcome : outcome?.events ?? [];
      const cancelResult = (!Array.isArray(outcome) && outcome?.cancel) ?? {verified: true};
      return {events, never, cancelResult, ended: false, waiters: []};
    },
    async resume(args) {
      calls.resume++;
      resumeCalls.push(args);
      const outcome = await script(args);
      if (outcome && !Array.isArray(outcome) && outcome.launchError) {
        const error = new Error(`fake adapter resume failed: ${outcome.launchError}`);
        error.code = outcome.launchError;
        throw error;
      }
      const never = !Array.isArray(outcome) && outcome?.never === true;
      const events = Array.isArray(outcome) ? outcome : outcome?.events ?? [];
      const cancelResult = (!Array.isArray(outcome) && outcome?.cancel) ?? {verified: true};
      return {events, never, cancelResult, ended: false, waiters: []};
    },
    async *events(handle) {
      calls.events++;
      if (handle.never) {
        while (!handle.ended) await new Promise(resolve => handle.waiters.push(resolve));
        return;
      }
      for (const event of handle.events) {
        if (event.kind === '__throw') throw new Error(event.message);
        yield event;
      }
    },
    async cancel(handle) {
      calls.cancel++;
      handle.ended = true;
      for (const waiter of handle.waiters.splice(0)) waiter();
      return handle.cancelResult;
    },
  };
}
