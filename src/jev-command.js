// The `/jev` (alias `/typesafe`) command surface, shared by the TUI and `bounce jev …`:
// status, the key (stored in the 0600 secrets file, never config.json or a journal), the
// on/off switches, the pinned model, the confidence threshold, and one live test call.
// Pure over its arguments: `settings` is the caller's mutable config object and `save`
// persists it; the caller renders `text` and, in the TUI, opens the masked prompt on `prompt`.
import {
  JEV_DEFAULT_MODEL, JEV_KEY_ENV, clearJevKey, createJevClient, jevStatusLine, normalizeJevSettings,
  persistedJevSettings, readJevKey, writeJevKey,
} from './jev.js';
import {dataRoot} from './core.js';

export const JEV_HELP = [
  '/jev                 Status: enabled?, key present (last 4 chars only), model, review/routing flags',
  '/jev key [KEY]       Store the TypeSafe API key (0600 file under ~/.bounce; TYPESAFE_API_KEY overrides it); no KEY opens a masked prompt',
  '/jev key clear       Remove the stored key',
  '/jev on | off        Enable or disable everything Jev does (off by default)',
  '/jev review on|off   Completion verdicts: a fast accept/rework check on each root task without its own reviewer (default on)',
  '/jev routing on|off  Model routing for tasks submitted with "profile":"auto" (default off)',
  '/jev routing default PROFILE|none   Where auto falls back when routing is off or unconfident',
  `/jev model ID        Pin the Jev version (default ${JEV_DEFAULT_MODEL}); avoid jev-latest — an alias moves between releases and shifts the calibrated confidence thresholds`,
  '/jev confidence N    Threshold (0–1, default 0.8) below which a verdict or route falls back to today\'s behaviour',
  '/jev test            One live noul call ("Is this a test?") — prints latency and the answer, or the error',
].join('\n');

const flag = value => value === 'on' ? true : value === 'off' ? false : null;

export async function jevCommand(parts = [], {root = dataRoot(), settings = {}, save = () => {}, env = process.env, fetchImpl, interactive = false} = {}) {
  const [sub = '', ...rest] = parts;
  const current = normalizeJevSettings(settings.jev);
  const key = () => readJevKey({root, env});
  const status = () => `${jevStatusLine(settings.jev, key())}${normalizeJevSettings(settings.jev).enabled && !key() ? ` · no key: /jev key <KEY> or set ${JEV_KEY_ENV}` : ''}`;
  const update = patch => {
    settings.jev = persistedJevSettings({...current, ...patch});
    save();
    return {text: status(), changed: true};
  };
  switch (sub) {
    case '': return {text: status(), changed: false};
    case 'help': return {text: JEV_HELP, changed: false};
    case 'on': case 'off': return update({enabled: sub === 'on'});
    case 'review': {
      const value = flag(rest[0]);
      if (value === null) throw new Error('Use /jev review on|off');
      return update({review: value});
    }
    case 'routing': {
      if (rest[0] === 'default') {
        const name = rest[1];
        if (!name) throw new Error('Use /jev routing default PROFILE|none');
        if (name !== 'none' && settings.profiles && !Object.hasOwn(settings.profiles, name)) throw new Error(`Unknown profile ${name}; choose a configured worker profile or none`);
        return update({routing: {...current.routing, default: name === 'none' ? null : name}});
      }
      const value = flag(rest[0]);
      if (value === null) throw new Error('Use /jev routing on|off, or /jev routing default PROFILE|none');
      return update({routing: {...current.routing, enabled: value}});
    }
    case 'model': {
      const id = rest.join(' ').trim();
      if (!id) throw new Error(`Use /jev model ID (default ${JEV_DEFAULT_MODEL})`);
      const result = update({model: id});
      if (/-(latest|preview)$/.test(id)) result.text += ` · note: ${id} is an alias that moves between releases; pin a version so confidence thresholds stay calibrated`;
      return result;
    }
    case 'confidence': {
      const value = Number(rest[0]);
      if (!rest[0] || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('Use /jev confidence N with N between 0 and 1');
      return update({confidence: value});
    }
    case 'key': {
      const value = rest.join(' ').trim();
      if (value === 'clear') {
        const removed = clearJevKey({root});
        const overridden = env?.[JEV_KEY_ENV] ? ` · ${JEV_KEY_ENV} is still set in this environment and will be used` : '';
        return {text: `${removed ? 'Stored TypeSafe key removed' : 'No stored TypeSafe key'}${overridden}`, changed: false};
      }
      if (!value) {
        if (interactive) return {text: 'Paste the TypeSafe API key and press Enter · Esc cancels', changed: false, prompt: 'key'};
        throw new Error(`Use bounce jev key <KEY>, or set ${JEV_KEY_ENV}`);
      }
      writeJevKey(value, {root});
      const overridden = env?.[JEV_KEY_ENV] ? ` · ${JEV_KEY_ENV} is set in this environment and overrides the stored key` : '';
      return {text: `TypeSafe key stored (…${value.slice(-4)}) in ${root}/secrets.json (0600)${overridden}`, changed: false};
    }
    case 'test': {
      const client = createJevClient({...(fetchImpl ? {fetchImpl} : {}), readKey: key});
      try {
        const result = await client.ask({
          state: 'This is a test message sent by bounce to check its TypeSafe API key and connectivity.',
          questions: {is_test: {type: 'noul', instructions: 'Is this a test?'}},
          model: current.model,
        });
        const noul = Number(result.answers?.is_test?.noul);
        const usage = result.usage ? ` · ${result.usage.input_tokens ?? '?'} in / ${result.usage.output_tokens ?? '?'} out tokens` : '';
        return {text: `Jev test ok · ${result.latencyMs} ms · ${result.model} · "Is this a test?" → ${Number.isFinite(noul) ? noul.toFixed(3) : JSON.stringify(result.answers?.is_test ?? null)}${usage}`, changed: false};
      } catch (error) {
        return {text: `Jev test failed · ${error.code ?? 'error'} · ${error.message}`, changed: false};
      }
    }
    default: throw new Error(`Unknown /jev subcommand ${sub}. /jev help lists them`);
  }
}
