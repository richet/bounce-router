// The prompt editor in the real CLI: keys typed into a forked TUI in
// classic mode, with a fake claude answering, and the draft read back from the frames it draws.
import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import stripAnsi from 'strip-ansi';

const helper = name => fileURLToPath(new URL(`./helpers/${name}`, import.meta.url));

async function classic(t, {root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-editor-')), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-editor-cwd-'))} = {}) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({order: ['claude'], mode: 'plan', models: {}, executables: {claude: helper('fake-claude.js')}, skills: {scope: 'user', autoSync: false}, jev: {enabled: false}}));
  const child = fork(helper('tui-process.js'), [], {cwd, env: {...process.env, BOUNCE_HOME: root, BOUNCE_SUPERVISED: '1', BOUNCE_NO_UPDATE_CHECK: '1'}, stdio: ['pipe', 'pipe', 'pipe', 'ipc']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));
  const waitFor = async (check, ms = 8000) => { const start = Date.now(); while (!check()) { if (Date.now() - start > ms) throw new Error(`timed out; screen:\n${stripAnsi(output).slice(-1500)}`); await settle(30); } };
  const draft = () => { const rows = stripAnsi(output).split(/\r?\n/).filter(row => row.startsWith('❯ ')); return (rows.at(-1) ?? '').split('│')[0].slice(2).replace(/▏/g, '').trimEnd(); };
  const type = async text => { child.stdin.write(text); await settle(); };
  await waitFor(() => stripAnsi(output).includes('Ready.'));
  return {child, root, type, draft, waitFor, screen: () => stripAnsi(output), settle};
}

test('Ctrl+W kills a word, Ctrl+Y puts it back, Ctrl+_ undoes, Ctrl+K kills to the line end', async t => {
  const {type, draft} = await classic(t);
  await type('run npm test');
  assert.equal(draft(), 'run npm test');
  await type('\x17');
  assert.equal(draft(), 'run npm');
  await type('\x19');
  assert.equal(draft(), 'run npm test');
  await type('\x1f');
  assert.equal(draft(), 'run npm', 'undo takes the yank back');
  await type('\x01\x0b');
  assert.equal(draft(), '', 'Ctrl+A then Ctrl+K empties the line');
});

test('Ctrl+C clears a draft first, warns on an empty one, and quits only on a second press', async t => {
  const {child, type, draft, screen, settle} = await classic(t);
  await type('half a thought');
  await type('\x03');
  assert.equal(draft(), '');
  assert.match(screen(), /Draft cleared · Ctrl\+_ brings it back/);
  await type('\x1f');
  assert.equal(draft(), 'half a thought');
  await type('\x15\x03');
  assert.match(screen(), /Ctrl\+C again to quit/);
  assert.equal(child.exitCode, null, 'one press on an empty draft does not quit');
  child.stdin.write('\x03');
  await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
  await settle(10);
});

test('a backslash before Enter makes a newline; Tab with no menu changes nothing', async t => {
  const {type, screen} = await classic(t);
  await type('first\\\r');
  await type('second\t');
  assert.match(screen(), /❯ first[^\n]*\n\s+second/);
  assert.doesNotMatch(screen(), /Agent selected|Using codex/);
});

test('a large paste shows as a placeholder; prompts are remembered for the next session and found by Ctrl+R', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-editor-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-editor-cwd-'));
  t.after(() => { fs.rmSync(root, {recursive: true, force: true}); fs.rmSync(cwd, {recursive: true, force: true}); });
  const first = await classic(t, {root, cwd});
  const big = Array.from({length: 40}, (_, n) => `row ${n}`).join('\n');
  await first.type(`\x1b[200~${big}\x1b[201~`);
  assert.equal(first.draft(), '[Pasted text #1 · 40 lines]');
  await first.type('\x15deploy the importer\r');
  await first.waitFor(() => fs.existsSync(path.join(root, 'history')) && fs.readdirSync(path.join(root, 'history')).length > 0);
  first.child.kill('SIGKILL');
  const second = await classic(t, {root, cwd});
  await second.type('\x12imp');
  assert.equal(second.draft(), 'deploy the importer');
  assert.match(second.screen(), /Search history: imp · 1 of 1/);
  await second.type('\x1b');
  await second.settle(300);
  assert.equal(second.draft(), '');
});

// Found in the real-console pass 2026-10-21: a command that answers in the transcript left the previous command's
// notice standing, so "Use /mode yolo or /mode plan" sat under a later, successful command.
test('each command starts with a clean notice: an earlier error does not stand under a later answer', async t => {
  const {type, screen, waitFor} = await classic(t);
  const notice = () => { const rows = screen().split(/\r?\n/); const at = rows.findLastIndex(row => row.startsWith('❯ ')); return (rows[at + 1] ?? '').split('│')[0].trim(); };
  await type('/mode banana\r');
  await waitFor(() => notice() === 'Use /mode yolo or /mode plan');
  await type('\x15/continue nobody\r');
  await waitFor(() => notice() === '/continue needs the orchestrator: /operation orchestrator');
  assert.equal(notice().includes('Use /mode'), false, `the stale notice stood: ${notice()}`);
});

test('the "Draft cleared" hint goes once you type or take the draft back', async t => {
  const {type, screen} = await classic(t);
  const notice = () => { const rows = screen().split(/\r?\n/); const at = rows.findLastIndex(row => row.startsWith('❯ ')); return (rows[at + 1] ?? '').split('│')[0].trim(); };
  await type('half a thought');
  await type('\x03');
  assert.equal(notice(), 'Draft cleared · Ctrl+_ brings it back');
  await type('n');
  assert.equal(notice().includes('Draft cleared'), false, `typing kept the hint: ${notice()}`);
  await type('\x15half\x03\x1f');
  assert.equal(notice().includes('Draft cleared'), false, `undo kept the hint: ${notice()}`);
});

// Found in the real-console pass 2026-10-21: in classic, /local activate blamed a daemon that classic never has, and
// /local cancel with no setup open said it had cancelled one.
test('in classic, /local activate and a /local cancel with nothing open say what is actually so', async t => {
  const {type, screen, waitFor} = await classic(t);
  const notice = () => { const rows = screen().split(/\r?\n/); const at = rows.findLastIndex(row => row.startsWith('❯ ')); return (rows[at + 1] ?? '').split('│')[0].trim(); };
  await type('/local activate\r');
  await waitFor(() => notice() === '/local activate re-reads agents into a running orchestrator · this session is classic');
  await type('\x15/local cancel\r');
  await waitFor(() => notice() === 'No local setup is running');
});

// Found in the real-console pass 2026-10-21: with opencode selected, `/model sonnet` saved "sonnet" as its model,
// which no opencode turn can run: its models are an endpoint's, named <endpoint>/<id>.
test('an opencode model is named by its endpoint; a bare name is refused and nothing is saved', async t => {
  const {root, type, screen, waitFor} = await classic(t);
  const notice = () => { const rows = screen().split(/\r?\n/); const at = rows.findLastIndex(row => row.startsWith('❯ ')); return (rows[at + 1] ?? '').split('│')[0].trim(); };
  await type('/provider opencode\r');
  await waitFor(() => /opencode/.test(notice()) || /Updated/.test(notice()));
  await type('\x15/model sonnet\r');
  await waitFor(() => notice() === 'OpenCode runs a local model, named <endpoint>/<id> like lmstudio/qwen3 · /model lists them');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).models?.opencode, undefined);
});
