import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {login} from '../src/login.js';

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bounce-login-'));
  t.after(() => fs.rmSync(cwd, {recursive: true, force: true}));
  return cwd;
}

for (const [provider, host] of [['claude', 'code.claude.com'], ['codex', 'learn.chatgpt.com'], ['muse', 'dev.meta.ai']]) {
  test(`missing ${provider} shows installation link and retry instructions`, async t => {
    const cwd = setup(t);
    await assert.rejects(login(provider, {executables: {[provider]: path.join(cwd, 'missing')}}, cwd), error => {
      assert.ok(error.message.includes(`https://${host}/`));
      assert.ok(error.message.includes(`/login ${provider}`));
      assert.ok(error.message.includes(`bounce login ${provider}`));
      assert.ok(error.message.includes(`executables.${provider}`));
      return true;
    });
  });
}

test('installed provider receives native login arguments; failures do not suggest installation', async t => {
  const cwd = setup(t);
  const executable = path.join(cwd, 'provider');
  fs.writeFileSync(executable, '#!/bin/sh\n[ "$1" = "auth" ] && [ "$2" = "login" ]\n', {mode: 0o755});
  await login('claude', {executables: {claude: executable}}, cwd);
  await assert.rejects(login('codex', {executables: {codex: executable}}, cwd), /^Error: Login exited 1$/);
});

test('invalid providers are rejected before spawning', async () => {
  for (const provider of ['invalid', 'toString', '__proto__', undefined]) {
    await assert.rejects(login(provider, {executables: {}}, process.cwd()), /Choose claude, codex, or muse/);
  }
});
