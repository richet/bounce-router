import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {handoff} from './core.js';
import {imagePaths, saveImages, providerInput} from './images.js';
import {tasks} from './reducers.js';

export function createMainService({session, adapters, profile, settings, orchestratorEnv = {}, brief = ''}) {
  const listeners = new Set(), native = new Map();
  for (const event of session.events) {
    if (event.kind === 'peer.native' && event.from === 'main') native.set(event.provider, {provider: event.provider, sessionId: event.sessionId});
  }
  let current = null, closed = false;
  const previousState = session.events.findLast(event => ['main.starting', 'main.started', 'main.terminal', 'main.blocked'].includes(event.kind));
  if (previousState && previousState.kind !== 'main.terminal') {
    current = {id: previousState.requestId, turnId: previousState.turnId, unverified: true, orphaned: true};
    session.append({kind: 'main.blocked', from: 'main', requestId: current.id, turnId: current.turnId, state: 'blocked', reason: 'orphaned', text: 'Termination unverified after daemon restart; inspect the previous orchestrator process before continuing'});
  }
  const state = () => ({state: current?.unverified ? 'blocked' : current ? current.handle ? 'running' : 'starting' : 'idle',
    currentTurnId: current?.turnId ?? null, requestId: current?.id ?? null});
  function emit(event) {
    const row = session.append({...event, from: 'main', context: session.id});
    for (const listener of listeners) listener(row);
  }
  function finish(run, status, reason) {
    if (run.finished) return;
    run.finished = true;
    if (current === run) current = null;
    session.append({kind: 'turn', provider: run.provider, text: status === 'interrupted' ? 'cancelled' : status, status: status === 'interrupted' ? 'cancelled' : status});
    emit({kind: 'main.terminal', requestId: run.id, turnId: run.turnId, state: 'idle', status, ...(reason ? {reason, text: reason} : {})});
  }
  async function execute(run, params) {
    const adapter = adapters[run.provider];
    const dir = path.join(session.dir, 'orchestrator', run.provider);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const selectedProfile = {...profile, adapter: run.provider, model: params.model ?? profile.model ?? '',
      mode: params.mode ?? profile.mode, executables: settings.executables ?? {}, orchestratorEnv};
    let result;
    try {
      const previous = native.get(run.provider);
      const options = {peer: 'orchestrator', profile: selectedProfile, cwd: session.cwd, dir, userImages: run.images};
      const roster = session.events.findLast(event => event.kind === 'local.profiles.activated')?.text;
      const prompt = [brief, roster, previous && run.previousProvider === run.provider ? params.text : handoff(session, params.text)].filter(Boolean).join('\n');
      const text = providerInput(run.provider, prompt, run.images);
      run.handle = previous && adapter.resume
        ? await adapter.resume({...options, native: previous, message: text})
        : await adapter.launch({...options, orders: text});
      if (run.cancelled || closed) {
        const stopped = await adapter.cancel(run.handle);
        if (!stopped?.verified) throw new Error('Main provider termination unverified');
        finish(run, 'interrupted'); return;
      }
      run.turnId = run.handle.turnId ?? run.id;
      emit({kind: 'main.started', requestId: run.id, turnId: run.turnId, state: 'running'});
      for await (const event of adapter.events(run.handle)) {
        if (event.kind === 'native') {
          native.set(run.provider, {provider: run.provider, sessionId: event.sessionId});
          session.append({kind: 'peer.native', provider: run.provider, sessionId: event.sessionId, from: 'main', context: session.id});
          continue;
        }
        if (event.kind === 'result') { result = event; break; }
        const row = {...event, provider: run.provider, from: 'main', context: session.id};
        if (['delta', 'progress', 'activity'].includes(event.kind)) session.publish(row);
        else session.append(row);
      }
      // A terminal message ends the model turn, but the process must also stop before a new
      // writer is admitted. Native identity survives separately for the next turn's resume.
      const stopped = await adapter.cancel(run.handle);
      if (!stopped?.verified) throw new Error('Main provider termination unverified');
      const status = run.cancelled ? 'interrupted' : result?.status;
      finish(run, ['completed', 'failed', 'limited', 'interrupted'].includes(status) ? status : 'failed',
        result ? result.text : 'Provider exited without a terminal result');
    } catch (error) {
      if (run.handle) {
        const stopped = await adapter.cancel(run.handle).catch(() => ({verified: false}));
        if (!stopped?.verified) {
          run.unverified = true;
          emit({kind: 'main.blocked', requestId: run.id, turnId: run.turnId, state: 'blocked', text: 'Main provider termination unverified'});
          return;
        }
      }
      finish(run, run.cancelled ? 'interrupted' : 'failed', error.message);
    }
  }
  const service = {
    state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    run(params) {
      if (closed) return {accepted: false, reason: 'daemon_closed'};
      if (current) return {accepted: false, reason: current.unverified ? 'termination_unverified' : 'busy'};
      if (Object.values(tasks(session.events)).some(t => t.state === 'blocked' && session.events.findLast(e => e.task === t.id && e.kind === 'task.blocked')?.reason === 'orphaned')) return {accepted: false, reason: 'termination_unverified'};
      if (typeof params?.text !== 'string' || !params.text.trim()) return {accepted: false, reason: 'empty_prompt'};
      if (params.files !== undefined && (!Array.isArray(params.files) || params.files.some(file => typeof file !== 'string'))) return {accepted: false, reason: 'invalid_attachments'};
      if (params.mode !== undefined && !['yolo', 'plan'].includes(params.mode)) return {accepted: false, reason: 'invalid_mode'};
      const provider = params.provider ?? profile.adapter;
      if (!adapters[provider]) return {accepted: false, reason: 'unknown_provider'};
      let images;
      try { images = saveImages([...new Set([...(params.files ?? []), ...imagePaths(params.text, session.cwd)])], session); }
      catch (error) { return {accepted: false, reason: error.message}; }
      const run = {id: params.id ?? randomUUID(), provider, images,
        previousProvider: session.events.findLast(event => event.kind === 'main.starting')?.provider,
        handle: null, turnId: null, cancelled: false, finished: false};
      current = run;
      session.active = provider;
      session.append({kind: 'user', text: params.text, ...(images.length ? {images} : {})});
      emit({kind: 'main.starting', provider, requestId: run.id, state: 'starting'});
      run.done = Promise.resolve().then(() => execute(run, {...params}));
      return {accepted: true, requestId: run.id, state: 'started'};
    },
    async deliver({id = randomUUID(), text, expectedTurnId}) {
      const run = current;
      if (!run?.handle || run.finished || run.cancelled) return {state: 'failed', reason: 'no_active_turn'};
      if (expectedTurnId !== run.turnId) return {state: 'failed', reason: 'turn_changed'};
      if (typeof text !== 'string' || !text.trim()) return {state: 'failed', reason: 'empty_message'};
      emit({kind: 'main.delivery', messageId: id, requestId: run.id, turnId: run.turnId, state: 'accepted'});
      try {
        const tier = await adapters[run.provider].deliver(run.handle, {text, expectedTurnId: run.handle.turnId ?? run.turnId});
        const result = {messageId: id, turnId: run.turnId, state: tier === 'live' ? 'acknowledged' : tier === 'queued' || tier === 'next-turn' ? 'queued' : 'failed', tier};
        emit({kind: 'main.delivery', requestId: run.id, ...result});
        return result;
      } catch (error) {
        const result = {messageId: id, turnId: run.turnId, state: 'failed', reason: error.message};
        emit({kind: 'main.delivery', requestId: run.id, ...result}); return result;
      }
    },
    async cancel({id} = {}) {
      const run = current;
      if (!run) return {accepted: true, verified: true};
      if (run.orphaned) return {accepted: false, verified: false, reason: 'termination_unverified'};
      if (id && id !== run.id) return {accepted: false, reason: 'turn_changed'};
      run.cancelled = true;
      if (!run.handle) return {accepted: true, state: 'cancelling'};
      const stopped = await adapters[run.provider].cancel(run.handle);
      if (stopped?.verified) finish(run, 'interrupted');
      else { run.unverified = true; emit({kind: 'main.blocked', requestId: run.id, state: 'blocked', text: 'Main provider termination unverified'}); }
      return {accepted: true, ...stopped};
    },
    async close() {
      closed = true;
      unsubscribeRoster();
      const run = current;
      if (!run) return {verified: true};
      if (run.orphaned) return {verified: false};
      run.cancelled = true;
      if (run.handle) {
        const stopped = await adapters[run.provider].cancel(run.handle).catch(() => ({verified: false}));
        if (stopped?.verified !== true) return {verified: false};
      }
      await run.done;
      return {verified: !run.unverified};
    },
  };
  const unsubscribeRoster = session.subscribe(row => {
    if (row.kind !== 'local.profiles.activated' || !current?.handle || current.cancelled) return;
    void service.deliver({text: row.text, expectedTurnId: current.turnId}).then(result => {
      session.append({kind: 'status', text: `Worker roster notification: ${result.state}; available in the next orchestrator prompt regardless of live-delivery support`});
    });
  });
  return service;
}
