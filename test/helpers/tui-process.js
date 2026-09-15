// The subprocess has real streams and Ink; only the terminal capability boundary is supplied.
Object.defineProperty(process.stdin, 'isTTY', {value: true});
Object.defineProperty(process.stdout, 'isTTY', {value: true});
Object.defineProperty(process.stdout, 'columns', {value: 120, configurable: true});
Object.defineProperty(process.stdout, 'rows', {value: 35, configurable: true});
process.stdin.setRawMode = () => process.stdin;
await import('../../src/cli.js');
