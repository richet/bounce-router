// The `/jev` (alias `/typesafe`) command surface, shared by the TUI and `bounce jev …`:
// status, the key (stored in the 0600 secrets file, never config.json or a journal), the
// on/off switches, the pinned model, the confidence threshold, the roster notes routing
// reads, and one live test call.
// Pure over its arguments: `settings` is the caller's mutable config object and `save`
// persists it; the caller renders `text` and, in the TUI, opens the masked prompt on `prompt`.
import {
  JEV_DEFAULT_MODEL, JEV_KEY_ENV, clearJevKey, createJevClient, jevStatusLine, normalizeJevSettings,
  persistedJevSettings, readJevKey, writeJevKey,
} from './jev.js';
import {createRosterSetup, readRosterNotes, rosterLines, setupAgent, undescribedModels, writeRosterNotes, modelKey} from './roster-notes.js';
import {validateOrchestration} from './profiles.js';
import {dataRoot} from './core.js';

export const JEV_HELP = [
  '/jev                 Status: enabled?, key present (last 4 chars only), model, review/routing flags',
  '/jev key [KEY]       Store the TypeSafe API key (0600 file under ~/.bounce; TYPESAFE_API_KEY overrides it); no KEY opens a masked prompt',
  '/jev key clear       Remove the stored key',
  '/jev on | off        Enable or disable everything Jev does (off by default; on means verdicts and routing)',
  '/jev review on|off   Completion verdicts: a fast accept/rework check on each root task without its own reviewer (default on)',
  '/jev routing on|off  Model routing for tasks submitted with "profile":"auto" (default on)',
  '/jev routing default PROFILE|none   Where auto falls back when routing is off or unconfident',
  '/jev routing local on|off   Prefer a local model of the needed tier for an `auto` agent\'s AI (default off: cloud AIs first)',
  '/jev roster          What routing knows about each worker profile\'s model: its tier and capabilities, and who described it',
  '/jev roster refresh  Describe the roster\'s models again (one read-only turn of a cloud agent from the roster; cached per model)',
  `/jev model ID        Pin the Jev version (default ${JEV_DEFAULT_MODEL}); avoid jev-latest — an alias moves between releases and shifts the calibrated confidence thresholds`,
  '/jev confidence N    Threshold (0–1, default 0.8) below which a verdict or route falls back to today\'s behaviour',
  '/jev test            One live noul call ("Is this a test?") — prints latency and the answer, or the error',
].join('\n');

const flag = value => value === 'on' ? true : value === 'off' ? false : null;

// The validated worker roster from the saved config, or null when nothing orchestrates.
function rosterOf(settings) {
  try {
    const orchestration = validateOrchestration(settings);
    return orchestration.operation === 'orchestrator' ? {profiles: orchestration.profiles, orchestrator: orchestration.orchestrator} : null;
  } catch { return null; }
}

export async function jevCommand(parts = [], {root = dataRoot(), settings = {}, save = () => {}, env = process.env, fetchImpl, interactive = false, run = null} = {}) {
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
      if (rest[0] === 'local') {
        const prefer = flag(rest[1]);
        if (prefer === null) throw new Error('Use /jev routing local on|off');
        return update({routing: {...current.routing, preferLocal: prefer}});
      }
      if (rest[0] === 'default') {
        const name = rest[1];
        if (!name) throw new Error('Use /jev routing default PROFILE|none');
        // Any routable name will do: the validated roster, so a shipped builder the config
        // never names (claude_haiku) is accepted, and one the overlay dropped (`null`) is not.
        if (name !== 'none') {
          const roster = rosterOf(settings);
          if (!roster) throw new Error('No worker roster: routing needs operation "orchestrator" with worker profiles in config.json');
          if (!Object.hasOwn(roster.profiles, name)) throw new Error(`Unknown profile ${name}; choose a worker profile from /jev roster or none`);
        }
        return update({routing: {...current.routing, default: name === 'none' ? null : name}});
      }
      const value = flag(rest[0]);
      if (value === null) throw new Error('Use /jev routing on|off, /jev routing default PROFILE|none, or /jev routing local on|off');
      return update({routing: {...current.routing, enabled: value}});
    }
    case 'roster': {
      const roster = rosterOf(settings);
      if (!roster) return {text: 'No worker roster: routing needs operation "orchestrator" with worker profiles in config.json', changed: false};
      const {profiles, orchestrator} = roster;
      if (rest[0] === 'refresh') {
        // Forget this roster's notes; the TUI's daemon rewrites them (control.jev refresh), headless
        // writes them here and now with the same agent the daemon would use.
        const keys = new Set(Object.values(profiles).map(modelKey));
        writeRosterNotes(Object.fromEntries(Object.entries(readRosterNotes(root)).filter(([key]) => !keys.has(key))), root);
        if (interactive) return {text: 'Roster notes cleared · describing the models again in the background; /jev roster shows them when written', changed: false, refresh: 'roster'};
        const agent = setupAgent({profiles, orchestrator, order: settings.order ?? [], models: settings.models ?? {}});
        const rows = [];
        const setup = createRosterSetup({root, profiles, agent, executables: settings.executables ?? {}, session: {append: row => rows.push(row)}, ...(run ? {run} : {})});
        await setup.ensure({force: true});
        return {text: [...rows.map(row => row.text), ...rosterLines(profiles, readRosterNotes(root))].join('\n'), changed: false};
      }
      if (rest[0]) throw new Error('Use /jev roster, or /jev roster refresh');
      const pending = undescribedModels(profiles, readRosterNotes(root));
      return {text: [`Jev roster · ${jevStatusLine(settings.jev, key()).split(' · ').find(part => part.startsWith('routing')) ?? 'routing off'}`,
        ...rosterLines(profiles, readRosterNotes(root)).map(line => `  ${line}`),
        ...(pending.length ? [`${pending.length} model${pending.length === 1 ? '' : 's'} not described yet: bounce describes them when routing is on and the daemon starts, or on /jev roster refresh`] : [])].join('\n'), changed: false};
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
