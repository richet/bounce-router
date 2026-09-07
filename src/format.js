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
    note: c.blue, diagnostic: c.yellow, selected: c.bold.inverse, prompt: c.cyan,
  };
  const parser = new Marked(markedTerminal({
    heading: c.bold.cyan, firstHeading: c.bold.cyan, strong: c.bold, em: c.italic,
    codespan: c.yellow, code: c.yellow, blockquote: c.gray.italic,
    html: c.gray, del: c.dim.strikethrough, link: c.blue, href: c.blue.underline,
    hr: c.gray, listitem: c.reset, table: c.reset, paragraph: c.reset,
    showSectionPrefix: false, emoji: false, unescape: true, tab: 2,
  }));
  parser.use({renderer: {
    code({text, lang}) {
      let code = text;
      if (color && lang && supportsLanguage(lang.split(/\s+/)[0])) {
        try { code = highlight(text, {language: lang.split(/\s+/)[0], ignoreIllegals: true,
          theme: {keyword: c.magenta, string: c.green, number: c.yellow, literal: c.yellow,
            comment: c.gray, built_in: c.cyan, title: c.blue, attr: c.cyan}}); }
        catch { /* Unknown languages remain readable plain code. */ }
      }
      return c.gray(`  ┌─ ${lang || 'code'}`) + '\n' + code.split('\n').map(line => '  ' + line).join('\n') + '\n\n';
    },
    link({href, tokens}) { return c.blue(this.parser.parseInline(tokens)) + c.underline(` (${clean(href)})`); },
  }});
  const wrap = (text, width) => wrapAnsi(color ? text : stripAnsi(text), Math.max(1, width), {hard: true, trim: false}).split('\n');
  const clip = (text, width) => sliceAnsi(color ? text : stripAnsi(text), 0, Math.max(0, width));
  function markdown(text, width) {
    const source = clean(text);
    try { return wrap(parser.parse(source).trimEnd(), width); }
    catch { return wrap(source, width); } // Partial/unknown Markdown must never hide a response.
  }
  function event(e, width) {
    const label = `${e.kind === 'user' ? 'YOU' : (e.provider || 'ROUTER').toUpperCase()} · ${e.kind}`;
    const paint = style[e.kind] || style.muted;
    const content = ['assistant', 'delta', 'result'].includes(e.kind)
      ? markdown(e.text, width) : wrap(clean(e.text), width);
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
