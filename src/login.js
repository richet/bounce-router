import {spawn} from 'node:child_process';
import {resolveExecutable} from './executable.js';
import {providers} from './providers.js';

const installationUrls = {
  claude: 'https://code.claude.com/docs/en/quickstart',
  codex: 'https://learn.chatgpt.com/docs/codex/cli',
  muse: 'https://dev.meta.ai/',
};

// Shared by shell login and /login; the TUI retains errors in its transcript.
// Inherit stdio so the vendor's browser/device prompt owns the real terminal.
export function login(provider, settings, cwd) {
  return new Promise((resolve, reject) => {
    if (!Object.hasOwn(providers, provider)) return reject(new Error('Choose claude, codex, or muse'));
    const override = settings.executables[provider];
    const child = spawn(resolveExecutable(provider, override), providers[provider].login, {cwd, stdio: 'inherit'});
    child.once('error', error => {
      if (error.code !== 'ENOENT') return reject(error);
      reject(new Error([
        `${provider} CLI could not be started.`,
        ...(override ? [`Check the configured executables.${provider} path: ${override}.`] : []),
        `If it is not installed, open this link in your browser and follow the installation instructions: ${installationUrls[provider]}`,
        `Then retry /login ${provider} inside bounce, or bounce login ${provider} in your terminal.`,
        'If already installed, check its executable path and that the working directory exists.',
      ].join('\n')));
    });
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Login ${signal ? `interrupted by ${signal}` : `exited ${code}`}`)));
  });
}
