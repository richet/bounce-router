import {mapUsage, toolsFor, nativeConfig} from './opencode-common.js';
import {opencodeProviderConfig} from '../local-opencode-provider.js';
import {normalizeLocalSettings, discoverLocalModels} from '../local-models.js';
import {outputTail} from '../command-output.js';
import {opencodeVersion} from '../opencode-version.js';
import {listenToServer, serveForTurn} from '../opencode-server.js';

// OpenCode as a classic provider: a local model (LM Studio) is the one agent answering the conversation,
// picked and ordered like claude or codex. Same command the worker
// runtime uses (opencode-live.js: `opencode run --pure --format json`, prompt on stdin, JSON lines out,
// `-s` continues the session), same containment: OpenCode's config travels in OPENCODE_CONFIG_CONTENT and
// the user's Claude Code prompt and skills are kept out of a local model. What differs is the shape — this
// is the one-shot adapter contract (invocation/stdin/normalize) that Router.run drives through runProcess.
// On opencode 2.x, as for workers: `--standalone` (a private server, not the user's background service),
// no --dir or --pure (the directory is $PWD), and the config in 2.x's own shape (nativeConfig).
const describe = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const RUN_ARGS = ['run', '--pure', '--format', 'json'];
const RUN_ARGS_V2 = ['run', '--standalone', '--format', 'json'];
const AGENT = 'bounce';
const MAX_STEPS = 30;
const DEFAULT_ENDPOINT = 'lmstudio';
// Sessions whose id has been announced; `run` repeats sessionID on every line.
const announced = new Set();

// `settings.models.opencode` is a pin, `<endpoint>/<model>` as the roster spells it; a bare model id
// means the default endpoint.
export function splitPin(pin) {
  const text = String(pin ?? '');
  const slash = text.indexOf('/');
  return slash < 0 ? {endpoint: DEFAULT_ENDPOINT, model: text} : {endpoint: text.slice(0, slash), model: text.slice(slash + 1)};
}

export default {
  name: 'opencode',
  // How the binary's major is read; a binary whose version cannot be read is driven as 1.x, and a
  // missing one is reported by the spawn, as for workers. Replaceable in tests.
  versionOf: opencodeVersion,
  isV2(executable) { return (this.versionOf(executable ?? 'opencode').major ?? 1) >= 2; },
  // Nothing to sign in to: the model is a local server (login.js says so).
  login: null,
  resumes: true,
  // `opencode run` with bounce's config and no `-m` has no model to run: a turn without a pin is refused
  // before launch (Router.run), with the picker named.
  requiresModel: true,
  // `run --format json` prints no result line: the process exiting is the turn ending (runProcess).
  resultOnExit: true,
  invocation({model, resume = null, cwd = process.cwd(), executable}) {
    const pin = splitPin(model);
    const modelArgs = pin.model ? ['-m', `${pin.endpoint}/${pin.model}`] : [];
    const session = resume ? ['-s', resume] : [];
    if (this.isV2(executable)) return [...RUN_ARGS_V2, '--agent', AGENT, ...modelArgs, ...session];
    return [...RUN_ARGS, '--agent', AGENT, ...modelArgs, '--dir', cwd, ...session];
  },
  stdin: prompt => prompt,
  // On 2.x the turn runs on a server bounce starts (`run --server`), whose event stream carries the answer and the
  // thinking as they are written; `run` itself prints a text part only once it is whole (measured: one row at
  // 12.8 s of a 12.9 s turn). `env` is the run's whole environment. The answer then comes from the stream
  // (`ownsText`): the run's own copy of it is dropped. 1.x: nothing to prepare.
  async prepareTurn({args, env, cwd, executable, emit}) {
    if (!this.isV2(executable)) return null;
    const server = await serveForTurn({executable: executable ?? 'opencode', cwd, env});
    const listener = listenToServer({url: server.url, password: server.password, cwd, emit});
    const at = args.indexOf('--standalone');
    return {
      args: at < 0 ? args : [...args.slice(0, at), '--server', server.url, ...args.slice(at + 1)],
      env: {OPENCODE_PASSWORD: server.password},
      ownsText: true,
      async close() { await listener.close(); server.stop(); },
    };
  },
  // The config OpenCode runs with, as for workers (opencode-live.js start()): the endpoint as a provider,
  // one primary agent whose tools follow the mode (yolo edits and runs commands; plan reads), any path
  // reachable (opencode otherwise rejects the first path outside --dir and ends the turn), and nothing of
  // the user's Claude Code setup. No `mcp`: classic has no bus.
  env({model, mode, settings, cwd = process.cwd(), executable}) {
    const pin = splitPin(model);
    const local = normalizeLocalSettings(settings?.local ?? {});
    const {config} = opencodeProviderConfig({settings: local, endpoint: pin.endpoint, model: pin.model});
    const content = {...config, permission: {external_directory: 'allow'},
      agent: {[AGENT]: {description: 'The bounce conversation.', mode: 'primary', maxSteps: MAX_STEPS, tools: toolsFor(mode === 'yolo' ? 'yolo' : 'plan')}}};
    const v2 = this.isV2(executable);
    return {OPENCODE_CONFIG_CONTENT: JSON.stringify(v2 ? nativeConfig(content) : content), OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      // 2.x runs where $PWD says, not where it was spawned: an inherited PWD would be bounce's own.
      ...(v2 ? {PWD: cwd} : {})};
  },
  // Line shapes as opencode-live.js reads them (measured against opencode 1.18.31): `text` parts are the
  // answer, `tool_use` parts carry the call and its state, `step_finish` the tokens, `error` an error.
  normalize(raw) {
    const events = [];
    const add = (kind, text, extra = {}) => events.push({kind, text: describe(text), ...extra});
    const part = raw.part ?? {};
    if (raw.type === 'text' && typeof part.text === 'string' && part.text.trim()) add('assistant', part.text);
    if (raw.type === 'tool_use') {
      const status = part.state?.status ?? '';
      if (status === 'completed' || status === 'error') {
        const input = part.state?.input ?? {};
        const target = input.filePath ?? input.path ?? input.pattern ?? input.command ?? describe(input);
        const output = part.tool === 'bash' || part.tool === 'shell' ? `\n${outputTail(part.state?.output ?? part.state?.error ?? '')}` : status === 'error' ? `\n${describe(part.state?.error ?? '')}` : '';
        add('tool', `${part.tool ?? 'tool'} ${describe(target)}${status === 'error' ? ' · error' : ''}${output}`);
      }
    }
    if (raw.type === 'step_finish') {
      const usage = mapUsage(part.tokens);
      // The step's thinking rides beside the four counts (CONTRACT §5), for the turn footer.
      const thinking = Number.isInteger(part.tokens?.reasoning) && part.tokens.reasoning > 0 ? {thinking: part.tokens.reasoning} : {};
      if (Object.keys(usage).length) add('usage', usage, {usage, ...thinking});
    }
    if (raw.type === 'error') add('error', raw.error?.data?.message ?? raw.error?.message ?? raw.error?.name ?? 'opencode error');
    if (typeof raw.sessionID === 'string' && raw.sessionID && !announced.has(raw.sessionID)) {
      announced.add(raw.sessionID);
      events.push({kind: 'peer.native', provider: 'opencode', sessionId: raw.sessionID});
    }
    return events;
  },
  // The picker's list is what LM Studio reports, not a CLI protocol (models.js queryCatalog): every
  // tool-capable model on every configured endpoint, loaded ones first, pinned as `<endpoint>/<id>`.
  catalog: {
    hint: 'start LM Studio and load a model, or /local setup',
    async list({settings, discover = discoverLocalModels} = {}) {
      const local = normalizeLocalSettings(settings?.local ?? {});
      if (local.enabled === false) return {models: [], account: null, error: 'local models are off (/local on)'};
      const catalogs = await discover(local, {maxAge: 0});
      const models = [];
      for (const catalog of catalogs) for (const model of catalog.models ?? []) {
        if (model.tools === false || model.type === 'embedding') continue;
        models.push({id: `${catalog.endpoint}/${model.id}`, label: model.id,
          description: `${catalog.endpoint}${model.ready === true ? ' · loaded' : ' · loads on demand'}`, loaded: model.ready === true});
      }
      models.sort((a, b) => Number(b.loaded) - Number(a.loaded));
      const errors = catalogs.filter(catalog => catalog.error).map(catalog => `${catalog.endpoint}: ${catalog.error}`);
      return {models: models.map(({loaded, ...model}) => model), account: null, error: models.length ? null : errors.join(' · ') || 'no local models reported'};
    },
  },
};
