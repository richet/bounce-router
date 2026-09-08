import {Marked} from 'marked';
import {markedTerminal} from 'marked-terminal';
import {highlight, supportsLanguage} from 'cli-highlight';
import {Chalk} from 'chalk';
import wrapAnsi from 'wrap-ansi';
import sliceAnsi from 'slice-ansi';
import stripAnsi from 'strip-ansi';

// Only renderer-owned terminal escapes may reach the display.
export const clean = text => stripAnsi(String(text ?? ''))
  .replace(/\r\n?/g, '\n')
  .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  .replace(/\t/g, '    ');

export function createFormatter({color = process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.TERM !== 'dumb'} = {}) {
  const c = new Chalk({level: color ? 1 : 0});
  const style = {
    title: c.bold.cyan, muted: c.gray, user: c.bold.cyan, assistant: c.bold.green,
    tool: c.magenta, error: c.bold.red, status: c.yellow, result: c.green,
    note: c.blue, diagnostic: c.yellow, selected: c.bold.inverse, prompt: c.cyan, quota: c.bold.blue,
    skills: c.bold.magenta,
  };
  function codeColors(text, language) {
    if (!color) return text;
    try {
      return highlight(text, {
        language: language && supportsLanguage(language) ? language : undefined,
        languageSubset: ['javascript', 'typescript', 'python', 'bash', 'json', 'css', 'xml', 'sql', 'diff', 'go', 'rust'],
        ignoreIllegals: true,
        theme: {keyword: c.magenta, string: c.green, number: c.yellow, literal: c.yellow,
          comment: c.gray, built_in: c.cyan, title: c.blue, attr: c.cyan,
          attribute: c.cyan, variable: c.cyan, type: c.yellow, regexp: c.red,
          symbol: c.magenta, meta: c.gray, addition: c.green, deletion: c.red},
      });
    } catch { return text; }
  }
  const parser = new Marked(markedTerminal({
    heading: c.bold.cyan, firstHeading: c.bold.cyan, strong: c.bold, em: c.italic,
    codespan: c.yellow, code: c.yellow, blockquote: c.gray.italic,
    html: c.gray, del: c.dim.strikethrough, link: c.blue, href: c.blue.underline,
    hr: c.gray, listitem: c.reset, table: c.reset, paragraph: c.reset,
    showSectionPrefix: false, emoji: false, unescape: true, tab: 2,
  }));
  parser.use({renderer: {
    heading({tokens}) { return c.bold.cyan(this.parser.parseInline(tokens)) + '\n\n'; },
    code({text, lang}) {
      const language = lang?.trim().split(/\s+/)[0].toLowerCase();
      const code = codeColors(text, language);
      return c.gray(`  ┌─ ${lang || 'code'}`) + '\n' + code.split('\n').map(line => '  ' + line).join('\n') + '\n\n';
    },
    link({href, tokens}) { return c.blue(this.parser.parseInline(tokens)) + c.underline(` (${clean(href)})`); },
    // marked-terminal's text renderer emits a token's raw source instead of parsing its
    // inline tokens, so bold, emphasis and code spans inside list items reach the display
    // as literal Markdown. Parse the nested tokens; leaf text tokens still pass through.
    text(token) { return token.tokens ? this.parser.parseInline(token.tokens) : token.text; },
  }});
  const wrap = (text, width) => wrapAnsi(color ? text : stripAnsi(text), Math.max(1, width), {hard: true, trim: false}).split('\n');
  const clip = (text, width) => sliceAnsi(color ? text : stripAnsi(text), 0, Math.max(0, width));
  function markdown(text, width) {
    const source = clean(text);
    try { return wrap(parser.parse(source).trimEnd(), width); }
    catch { return wrap(source, width); } // Partial/unknown Markdown must never hide a response.
  }
  // Claude sends tool calls as `Name: {json}`. Escaped newlines and quotes are unreadable,
  // so display the fields as lines. The journal keeps the original text for handoffs.
  const toolLines = text => {
    const match = /^([A-Za-z_][\w.-]*): (\{[\s\S]*\})$/.exec(text.trim());
    let input;
    try { input = match && JSON.parse(match[2]); } catch { return null; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const lines = [match[1]];
    for (const [key, value] of Object.entries(input)) {
      const rows = (typeof value === 'string' ? value : JSON.stringify(value ?? null)).split('\n');
      if (rows.length > 1) lines.push(`${key}:`, ...rows.map(row => '  ' + row));
      else lines.push(`${key}: ${rows[0]}`);
    }
    return lines.length > 40 ? [...lines.slice(0, 40), `… ${lines.length - 40} more lines`] : lines;
  };
  // Short bookkeeping events read as one line; only real content earns a block of its own.
  const inline = ['status', 'progress', 'route', 'cooldown', 'attempt', 'turn', 'diagnostic', 'note'];
  function event(e, width) {
    const names = {user: 'You', assistant: 'Response', delta: 'Response', result: 'Result',
      status: 'Activity', route: 'Agent selected', tool: 'Tool output', error: 'Error',
      diagnostic: 'Diagnostics', note: 'Saved note', cooldown: 'Retry delay', attempt: 'Agent finished',
      turn: 'Turn finished', quota: 'Reported quota', skills: 'Skills', review: 'Work Done review'};
    const label = e.kind === 'user' ? 'You' : `${e.provider || 'Bounce'} · ${names[e.kind] || e.kind}`;
    const paint = style[e.kind] || style.muted;
    if (inline.includes(e.kind)) return wrap(`${paint(clean(label))}  ${clean(e.text)}`, width);
    const source = e.kind === 'tool' ? (toolLines(clean(e.text)) ?? [clean(e.text)]).join('\n') : clean(e.text);
    const content = ['assistant', 'delta', 'result'].includes(e.kind)
      ? markdown(e.text, width) : wrap(e.kind === 'tool' ? codeColors(source) : source, width);
    return [clip(paint(clean(label)), width), ...content, ''];
  }
  return {style, wrap, clip, markdown, event};
}

// A provider may split a fence or even a word between adjacent output deltas.
export function displayEvents(events) {
  const result = [];
  for (const event of events) {
    if (['raw', 'usage', 'checkpoint', 'session'].includes(event.kind) || !event.text) continue;
    const previous = result.at(-1);
    if (event.kind === 'delta' && previous?.kind === 'delta' && previous.provider === event.provider) {
      previous.text += event.text;
    } else result.push({...event});
  }
  return result;
}

// Session journals are append-only. Keep one layout, replacing it on resize or
// session changes; typing and scrolling do no transcript formatting work.
export function createTranscriptRenderer(formatEvent) {
  let source, columns, consumed = 0, rows = [], tail, tailStart = 0;
  return (events, width) => {
    if (source !== events || columns !== width || events.length < consumed) {
      source = events; columns = width; consumed = 0; rows = []; tail = undefined;
    }
    let dirty = false;
    const flush = () => {
      if (!dirty) return;
      rows.length = tailStart;
      for (const row of formatEvent(tail, width)) rows.push(row);
      dirty = false;
    };
    for (; consumed < events.length; consumed++) {
      const event = events[consumed];
      if (['raw', 'usage', 'checkpoint', 'session'].includes(event.kind) || !event.text) continue;
      if (event.kind === 'delta' && tail?.kind === 'delta' && tail.provider === event.provider) {
        tail.text += event.text;
      } else {
        flush();
        tailStart = rows.length;
        tail = {...event};
      }
      dirty = true;
    }
    flush();
    return rows;
  };
}

// Only use model metadata from the latest attempt, never a previous turn's default.
export function activeModel(events, provider, configured) {
  const route = events.findLastIndex(e => e.kind === 'route');
  if (route >= 0 && events[route].provider === provider && events[route].model === (configured || 'default')) {
    const reported = events.slice(route + 1).findLast(e => e.kind === 'model' && e.provider === provider);
    if (reported) return clean(reported.model);
  }
  return configured ? clean(configured) : 'Default (not reported)';
}

// Derive a small, local recap from successful turns; never summarize tool intents
// as completed work. Incremental consumption keeps the activity timer inexpensive.
export function createWorkSummary() {
  let source, consumed = 0, items = [], response = '';
  return events => {
    if (source !== events || events.length < consumed) {
      source = events; consumed = 0; items = []; response = '';
    }
    for (; consumed < events.length; consumed++) {
      const event = events[consumed];
      if (event.kind === 'user' || event.kind === 'route') response = '';
      if (event.kind === 'assistant') response = event.text || '';
      if (event.kind === 'delta') response += event.text || '';
      if (event.kind === 'result' && event.success && event.text && event.text !== 'Turn completed') response = event.text;
      if (event.kind !== 'turn') continue;
      if (event.text === 'completed') {
        const lines = clean(response).split('\n').map(line => line
          .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*`_]/g, '').trim());
        const summary = lines.find(line => line && !/^(?:summary|changes|done|completed|tests|implementation)[:.!]?$/i.test(line));
        items.push(summary || 'Completed turn');
      }
      response = '';
    }
    return items;
  };
}

// Keep every item's text intact; the transcript renderer wraps to the terminal width.
export function workReview(items) {
  if (!items.length) return 'No completed turns yet.';
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n\n');
}
