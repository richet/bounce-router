// Bounce's own Codex home. Daniel, 2026-09-27: the Codex desktop app is off limits. Found live: bounce's
// Codex threads landed in ~/.codex, which the ChatGPT app lists; bounce's MCP entry lived in the app's
// config.toml, so the app started `bounce mcp-serve` itself; and without a standalone `codex` bounce ran
// the binary bundled inside ChatGPT.app. Every Codex process bounce starts uses this home instead: its
// own threads, config, MCP entry, skills and sign-in (`bounce login codex`), none of them the app's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withCodexEntry} from './mcp-install.js';

export const codexHome = (env = process.env) => path.join(env.BOUNCE_HOME || path.join(os.homedir(), '.bounce'), 'codex');

// Codex refuses a CODEX_HOME that does not exist. Created right before a Codex process starts, never
// on every bounce command (a command that writes nothing must leave the data root untouched).
export function prepareCodexHome(executable, env = process.env) {
  if (!env.CODEX_HOME || !/(^|\/)codex$/.test(String(executable))) return;
  fs.mkdirSync(env.CODEX_HOME, {recursive: true, mode: 0o700});
}

// Creates the home, keeps bounce's MCP entry in its config.toml current, and says whether Codex is signed in there.
export function ensureCodexHome({home = codexHome(), command = 'bounce'} = {}) {
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  const file = path.join(home, 'config.toml');
  let before = '';
  try { before = fs.readFileSync(file, 'utf8'); } catch {}
  const result = withCodexEntry(before, command);
  if (result.changed) fs.writeFileSync(file, result.text, {mode: 0o600});
  return {home, config: file, signedIn: fs.existsSync(path.join(home, 'auth.json'))};
}
