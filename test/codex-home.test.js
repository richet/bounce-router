// Daniel, 2026-09-27: the Codex desktop app is off limits. Every Codex process bounce starts uses
// bounce's own Codex home (threads, config, MCP entry, sign-in), never the app's ~/.codex.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {codexHome, ensureCodexHome, prepareCodexHome} from '../src/codex-home.js';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('bounce\'s Codex home lives under its data root, carries its MCP entry, and reports a missing sign-in', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-home-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  assert.equal(codexHome({BOUNCE_HOME: root}), path.join(root, 'codex'));
  const home = ensureCodexHome({home: codexHome({BOUNCE_HOME: root}), command: '/usr/local/bin/bounce'});
  assert.equal(home.signedIn, false);
  assert.match(fs.readFileSync(home.config, 'utf8'), /\[mcp_servers\.bounce\]\ncommand = "\/usr\/local\/bin\/bounce"\nargs = \["mcp-serve"\]\nenv_vars = \["BOUNCE_BUS", "BOUNCE_BUS_TOKEN_FILE"\]/);
  fs.writeFileSync(path.join(home.home, 'auth.json'), '{}');
  assert.equal(ensureCodexHome({home: home.home, command: '/usr/local/bin/bounce'}).signedIn, true);
});

test('bounce mcp install writes into bounce\'s Codex home and removes the entry an older bounce left in the app\'s ~/.codex', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-mcp-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  fs.mkdirSync(path.join(home, '.codex'), {recursive: true});
  const appConfig = path.join(home, '.codex', 'config.toml');
  fs.writeFileSync(appConfig, 'model = "x"\n\n# written by bounce (bounce mcp install)\n[mcp_servers.bounce]\ncommand = "bounce"\nargs = ["mcp-serve"]\n');
  // `mcp install` also asks claude's own CLI to register; a stand-in answers it here.
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const run = spawnSync(process.execPath, [cliPath, 'mcp', 'install'], {env: {...process.env, PATH: `${bin}:/usr/bin:/bin`, HOME: home, BOUNCE_HOME: data, BOUNCE_NO_UPDATE_CHECK: '1'}, encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.readFileSync(appConfig, 'utf8'), 'model = "x"\n', 'the desktop app\'s config keeps only what the user wrote');
  assert.match(fs.readFileSync(path.join(data, 'codex', 'config.toml'), 'utf8'), /env_vars = \["BOUNCE_BUS", "BOUNCE_BUS_TOKEN_FILE"\]/);
  assert.match(run.stdout, /codex desktop app: bounce's old entry removed/);
});

test('bounce\'s Codex home is created right before a Codex process starts, and never for another command', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-codex-prepare-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const env = {CODEX_HOME: path.join(root, 'codex')};
  prepareCodexHome('/usr/local/bin/claude', env);
  prepareCodexHome('opencode', env);
  assert.equal(fs.existsSync(env.CODEX_HOME), false);
  prepareCodexHome('/Users/x/.local/bin/codex', env);
  assert.equal(fs.statSync(env.CODEX_HOME).isDirectory(), true);
});
