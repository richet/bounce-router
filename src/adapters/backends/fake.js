// The third backend (CONTRACT.md B2): proves the backend abstraction is real, drives every
// local-live test without ever touching a network or a real model. Scripted per launch via
// `profile.script`, an array of "turns" — one array of items per `generate()` call. Each item
// is one of the backend's own yielded shapes ({kind:'delta'|'tool_call'|'usage'|'done'}), plus
// two test-only control items consumed here and never yielded onward: {kind:'wait', wait} pauses
// mid-turn until `wait()` resolves (used to hold the adapter at a tool boundary), and
// {kind:'throw', text} raises mid-stream (L3). `script` is mutated (shift()) so each launch's own
// array, passed fresh per test, is consumed exactly once regardless of how many turns it takes.
export function createFakeBackend({healthy = true} = {}) {
  return {
    name: 'fake',
    async health() {
      if (!healthy) throw new Error('fake backend unhealthy');
      return true;
    },
    async *generate({script = [], signal} = {}) {
      const abortError = () => { const error = new Error('aborted'); error.name = 'AbortError'; return error; };
      const turn = script.shift() ?? [{kind: 'done', text: ''}];
      for (const item of turn) {
        if (signal?.aborted) throw abortError();
        if (item.kind === 'wait') {
          // A real fetch/stream rejects the moment its signal aborts, even mid-wait for the
          // vendor — race the test's own gate against that so cancel() is never left hanging.
          await new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(abortError());
            const onAbort = () => reject(abortError());
            signal?.addEventListener('abort', onAbort, {once: true});
            item.wait().then(resolve, reject).finally(() => signal?.removeEventListener('abort', onAbort));
          });
          continue;
        }
        if (item.kind === 'throw') throw new Error(item.text ?? 'fake backend error');
        yield item;
      }
    },
  };
}
