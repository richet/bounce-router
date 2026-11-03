// A classic turn on a provider's live adapter: the same app-server peer the
// orchestrator drives (main-service.js), one per turn, so the answer streams. Launched fresh, or resuming the thread
// Router.run hands over; the peer is stopped when the turn ends. Resolves like runProcess: {status}.
export async function runLiveTurn({adapter, provider, prompt, model, mode, resume = null, cwd, dir, images = [], executables = {}, signal, emit}) {
  const profile = {adapter: provider, model: model || undefined, mode, executables};
  const options = {peer: 'classic', profile, cwd, dir, userImages: images};
  let handle = null, status = null, started = false;
  const stop = () => handle ? adapter.cancel(handle).catch(() => {}) : null;
  signal?.addEventListener('abort', () => { status = 'cancelled'; void stop(); }, {once: true});
  if (signal?.aborted) return {status: 'cancelled'};
  try {
    handle = resume
      ? await adapter.resume({...options, native: {provider, sessionId: resume}, message: prompt})
      : await adapter.launch({...options, orders: prompt});
    started = true;
    for await (const event of adapter.events(handle)) {
      if (event.kind === 'native') { emit({kind: 'peer.native', provider, sessionId: event.sessionId}); continue; }
      if (event.kind === 'result') {
        status ??= event.status === 'interrupted' ? 'cancelled' : ['completed', 'limited'].includes(event.status) ? event.status : 'failed';
        if (status === 'failed' && event.text) emit({kind: 'error', text: event.text});
        break;
      }
      emit(event);
    }
  } catch (error) {
    // A fresh launch that never started is the peer itself not working (an older CLI without an app-server):
    // `unavailable` lets the caller fall back. A usage limit or a missing executable is not that.
    if (!resume && !started && status !== 'cancelled' && !['limited', 'ENOENT'].includes(error.code)) {
      await stop();
      return {status: 'unavailable', reason: error.message};
    }
    if (status !== 'cancelled') {
      emit({kind: 'error', text: error.message});
      status = error.code === 'limited' ? 'limited' : error.code === 'ENOENT' ? 'missing' : 'failed';
    }
    handle ??= error.handle ?? null;
  }
  await stop();
  return {status: signal?.aborted ? 'cancelled' : status ?? 'failed'};
}
