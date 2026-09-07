import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

export const providers = {
  claude: {login: ['auth', 'login']},
  codex: {login: ['login']},
  muse: {login: ['login']},
};
export const limitPattern = /rate[_ -]?limit|usage[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|insufficient_quota|too many requests|(?:hit|reached|exceeded) your (?:usage )?limit|out of (?:credits|tokens)|\b429\b/i;
export function invocation(provider, {model, mode, images = []}, promptFile) {
  const imageArgs = images.flatMap(image => ['--image', image.path]);
  const modelArgs = model ? ['--model', model] : [];
  switch (provider) {
    case 'claude': return ['-p', '--output-format', 'stream-json', '--verbose', ...modelArgs, ...(images.length ? ['--input-format', 'stream-json'] : []),
      ...(mode === 'yolo' ? ['--dangerously-skip-permissions'] : ['--permission-mode', 'plan'])];
    case 'codex': return ['exec', '--json', '--skip-git-repo-check', ...modelArgs, ...imageArgs,
      ...(mode === 'yolo' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'read-only']), '-'];
    case 'muse': return ['exec', '--json', '--prompt-file', promptFile, ...modelArgs, ...imageArgs,
      ...(mode === 'yolo' ? ['--yolo'] : ['--disable-write', '--disable-shell', '--approval-mode', 'never'])];
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
const describe = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
// Tool results arrive as content blocks; show their text rather than a JSON dump.
const contentText = value => Array.isArray(value)
  ? value.map(part => part?.type === 'text' ? part.text : part?.type === 'image' ? '[image]' : describe(part)).join('\n')
  : describe(value);
export function normalize(provider, raw) {
  const events = [];
  const add = (kind, text, extra = {}) => events.push({kind, text: describe(text), ...extra});
  const model = raw.message?.model ?? raw.model ?? raw.payload?.model;
  if (typeof model === 'string' && model.trim()) events.push({kind: 'model', model});
  if (provider === 'claude') {
    if (raw.type === 'assistant') for (const block of raw.message?.content ?? []) {
      if (block.type === 'text') add('assistant', block.text);
      if (block.type === 'tool_use') add('tool', `${block.name}: ${describe(block.input)}`);
    }
    if (raw.type === 'user') for (const block of raw.message?.content ?? []) {
      if (block.type === 'tool_result') add('tool', contentText(block.content));
    }
    if (raw.type === 'result') {
      if (raw.is_error) add('error', raw.errors ?? raw.result ?? raw.subtype);
      add('usage', raw.usage ?? {}, {usage: raw.usage});
      add('result', raw.result ?? raw.subtype, {success: !raw.is_error});
    }
    if (raw.type === 'rate_limit_event' && raw.rate_limit_info?.status === 'rejected') add('error', 'usage limit: ' + describe(raw.rate_limit_info));
    // Claude reports thinking token counts every few tokens. They are live progress,
    // not transcript: journaling them buries the conversation in "Activity" blocks.
    if (raw.type === 'system') {
      if (raw.subtype === 'thinking_tokens') add('progress', `Thinking · ~${raw.estimated_tokens ?? 0} tokens`);
      else if (raw.subtype === 'init') add('progress', `Ready · ${(raw.tools ?? []).length} tools`);
      else if (raw.subtype === 'task_started') add('status', `Task started · ${describe(raw.description ?? raw.task_id ?? '')}`);
      else if (raw.subtype === 'task_notification') add('status', `Task ${describe(raw.status ?? 'update')} · ${describe(raw.summary ?? raw.task_id ?? '')}`);
      else add('status', raw.subtype ?? 'system');
    }
    if (raw.type === 'tool_progress') add('progress', `${describe(raw.tool_name ?? 'Tool')} · ${raw.elapsed_time_seconds ?? 0}s`);
  } else if (provider === 'codex') {
    const item = raw.item;
    if (raw.type === 'item.completed' && item) {
      if (item.type === 'agent_message') add('assistant', item.text);
      else add('tool', item.command ? `${item.command}\n${item.aggregated_output ?? ''}` : item);
    }
    if (raw.type === 'item.started' && item?.command) add('progress', `Running · ${describe(item.command).split('\n')[0]}`);
    if (raw.type === 'error' || raw.type === 'turn.failed') add('error', raw.error?.message ?? raw.message ?? raw.error ?? raw);
    if (raw.type === 'turn.completed') {
      add('usage', raw.usage, {usage: raw.usage});
      add('result', 'Turn completed', {success: true});
    }
  } else if (provider === 'muse') {
    const p = raw.payload ?? raw;
    const type = raw.payload_type ?? raw.type ?? '';
    if (type === 'run.output.delta') add('delta', p.text);
    if (type.startsWith('run.terminal.')) {
      const success = p.terminal === 'completed';
      if (!success) add('error', p.reason ?? p);
      add('result', p.text ?? p.reason ?? p.terminal, {success});
    }
    if (type === 'task.lifecycle.side_effect_intent') add('tool', p.event?.operation ?? p);
    if (type.endsWith('.failed') || type === 'error') add('error', p);
  }
  return events;
}

// Only error channels are classified as exhaustion. Assistant/tool text can quote errors.
export function runProcess({provider, executable = provider, args, prompt, cwd, signal, emit}) {
  return new Promise(resolve => {
    let failed = false, limited = false, terminal = false, stderr = '', closed = false;
    const child = spawn(executable, args, {cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
    const finish = result => { if (!closed) { closed = true; clearTimeout(killTimer); signal?.removeEventListener('abort', cancel); resolve(result); } };
    let killTimer;
    const kill = sig => { try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); } catch {} };
    const cancel = () => { kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 1500); };
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    child.on('error', error => { emit({kind: 'error', text: error.message}); finish({status: error.code === 'ENOENT' ? 'missing' : 'failed'}); });
    child.stdin.on('error', () => {}); // EPIPE: the process may reject arguments before reading stdin.
    child.stdin.end(provider === 'muse' ? undefined : prompt);
    const out = createInterface({input: child.stdout});
    out.on('line', line => {
      let raw;
      try { raw = JSON.parse(line); } catch { emit({kind: 'status', text: line}); return; }
      emit({kind: 'raw', raw});
      for (const event of normalize(provider, raw)) {
        if (event.kind === 'error') { failed = true; limited ||= limitPattern.test(event.text); }
        if (event.kind === 'result') { terminal = true; failed ||= !event.success; }
        emit(event);
      }
    });
    createInterface({input: child.stderr}).on('line', line => {
      stderr = (stderr + '\n' + line).slice(-16000);
      emit({kind: 'diagnostic', text: line});
    });
    child.on('close', (code, sig) => {
      const status = signal?.aborted ? 'cancelled' : limited || ((code !== 0 || failed) && limitPattern.test(stderr)) ? 'limited' : code === 0 && !failed && terminal ? 'completed' : 'failed';
      finish({status, code, signal: sig});
    });
  });
}
