import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// A directory containing an executable named `opencode`, backed by the one-shot fake, for
// tests that drive the REAL CLI as a subprocess and therefore cannot inject a JS double.
// resolveExecutable() searches PATH, so prepending this directory is enough — no test-only flag
// has to exist in the shipped code.
export function fakeOpencodeBin(t, {model = 'bounce-scout'} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-oc-bin-'));
  const server = fileURLToPath(new URL('./fake-opencode.js', import.meta.url));
  const shim = path.join(dir, 'opencode');
  fs.writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${server} "$@"\n`, {mode: 0o755});
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return {dir, env: {PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_OC_MODEL: model}};
}
