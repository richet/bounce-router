import {stripVTControlCharacters} from 'node:util';
import {runLocalSetup} from './local-wizard.js';

// Owns only setup input and output; never starts/cancels a conversation turn.
export function createLocalSetupView({onChange = () => {}, run = runLocalSetup, save, ...options}) {
  const controller = new AbortController();
  const state = {active: true, question: null, lines: [], result: null, error: null};
  let answer;
  const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, 16000);
  const view = {
    state,
    answer(value) {
      if (!state.active || !answer) return false;
      const resolve = answer; answer = null; state.question = null;
      resolve(value); onChange(); return true;
    },
    cancel() {
      state.active = false; state.question = null;
      controller.abort(new Error('Setup cancelled'));
      const resolve = answer; answer = null; resolve?.(null); onChange();
    },
  };
  view.done = (async () => {
    try {
      const result = await run({...options, signal: controller.signal,
        ask: question => {
          if (!state.active) return Promise.resolve(null);
          state.question = clean(question);
          const pending = new Promise(resolve => {answer = resolve;});
          onChange(); return pending;
        },
        write: text => {
          if (!state.active) return;
          state.lines.push(clean(text)); state.lines = state.lines.slice(-12); onChange();
        },
        save: settings => {controller.signal.throwIfAborted(); return save(settings);},
      });
      if (state.active) state.result = result;
    } catch (error) {
      if (state.active) state.error = clean(error.message);
    } finally {state.active = false; state.question = null; answer = null; onChange();}
    return state.result;
  })();
  return view;
}
