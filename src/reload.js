import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export function fingerprint(root = projectRoot) {
  const hash = createHash('sha256');
  function visit(dir) {
    for (const item of fs.readdirSync(dir, {withFileTypes: true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir,item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile()) {hash.update(path.relative(root,file)); hash.update(fs.readFileSync(file));}
    }
  }
  visit(path.join(root,'src'));
  hash.update(fs.readFileSync(path.join(root,'package.json')));
  return hash.digest('hex');
}
export async function validate(root = projectRoot, emit = () => {}) {
  for (const script of ['check','test']) {
    emit(script === 'check' ? 'Checking syntax…' : 'Running tests…');
    await new Promise((resolve,reject) => {
      const child = spawn('npm',['run',script],{cwd:root,stdio:['ignore','pipe','pipe']});
      let output = '';
      const capture = d => { output = (output + d.toString()).slice(-32000); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      const timer = setTimeout(() => {child.kill('SIGKILL'); reject(new Error(`npm run ${script} timed out`));},120000);
      child.once('error', e => {clearTimeout(timer);reject(e);});
      child.once('close', code => {clearTimeout(timer); if (code !== 0 && output) emit(output); else if (code === 0) emit(script === 'check' ? 'Syntax checks passed.' : 'Tests passed.'); code === 0 ? resolve() : reject(new Error(`npm run ${script} failed; keeping this running version. Fix the code and /restart again.`));});
    });
  }
}
// Keep this supervisor independent of the agent/UI modules loaded by each child.
export async function supervise(args = process.argv.slice(2)) {
  let resume;
  for (;;) {
    const outcome = await new Promise(resolve => {
      let request;
      const child = spawn(process.execPath,[fileURLToPath(new URL('./cli.js',import.meta.url)),...args],{
        stdio:['inherit','inherit','inherit','ipc'],
        env:{...process.env,LOCALROUTER_SUPERVISED:'1',LOCALROUTER_RESTART:resume ? JSON.stringify(resume) : ''},
      });
      const terminate = () => child.kill('SIGTERM');
      const interrupt = () => {}; // Foreground process group delivers Ctrl+C to the child too.
      process.on('SIGTERM',terminate); process.on('SIGINT',interrupt);
      child.on('message', message => {if (message?.type === 'restart') request = message.state;});
      child.once('error', error => {console.error(error.message);});
      child.once('close', (code,signal) => {
        process.off('SIGTERM',terminate); process.off('SIGINT',interrupt);
        resolve({code:code ?? (signal ? 130 : 1),request});
      });
    });
    if (outcome.code !== 75 || !outcome.request) {process.exitCode=outcome.code;return;}
    resume=outcome.request;
  }
}
