import net from 'node:net';
import fs from 'node:fs';
import {EventEmitter} from 'node:events';
import {timingSafeEqual} from 'node:crypto';
import {randomUUID} from 'node:crypto';
import {hostSession} from './remote.js';
import {socketPathFor} from './bus.js';

const VERSION = 1;
const MAX_BUFFER = 16 * 1024 * 1024;

function channelFor(socket) {
  const channel = new EventEmitter();
  let buffer = '', queued = [];
  channel.send = message => {
    if (socket.destroyed) throw new Error('View disconnected');
    if (socket.writableLength > MAX_BUFFER) { socket.destroy(); return; }
    socket.write(JSON.stringify(message) + '\n');
  };
  channel.close = () => socket.end();
  channel.flush = () => new Promise((resolve, reject) => socket.write('', error => error ? reject(error) : resolve()));
  channel.on('newListener', event => {
    if (event === 'message' && queued.length) queueMicrotask(() => {
      const pending = queued; queued = [];
      for (const message of pending) channel.emit('message', message);
    });
  });
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_BUFFER) { socket.destroy(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (channel.listenerCount('message')) channel.emit('message', message);
      else queued.push(message);
    }
  });
  socket.on('error', () => {});
  socket.once('close', () => channel.emit('disconnect'));
  return channel;
}

export async function createViewServer({session, main, token, onControl = () => {}}) {
  const socketPath = socketPathFor(session.dir).replace(/\.sock$/, '.view');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    const channel = channelFor(socket);
    let host = null, authenticated = false;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const receive = message => {
      if (authenticated) {
        if (message.type === 'control') void (async () => {
          const result = await onControl(message);
          if (message.requestId) {
            channel.send({type: 'control.result', requestId: message.requestId, ...result});
            await channel.flush();
          }
          await result?.afterAck?.();
        })().catch(error => {
          try { channel.send({type: 'control.result', requestId: message.requestId, verified: false, reason: error.message}); } catch {}
        });
        return;
      }
      const supplied = Buffer.from(typeof message.token === 'string' ? message.token : '');
      const expected = Buffer.from(token);
      if (message.type !== 'view.auth' || message.version !== VERSION || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        socket.end(JSON.stringify({type: 'view.error', message: 'View authentication or protocol version mismatch'}) + '\n');
        return;
      }
      authenticated = true;
      clearTimeout(timer);
      channel.send({type: 'view.ready', version: VERSION});
      host = hostSession({session, child: channel, main});
    };
    channel.on('message', receive);
    channel.once('disconnect', () => { clearTimeout(timer); host?.detach(); sockets.delete(socket); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  fs.chmodSync(socketPath, 0o600);
  return {
    path: socketPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function requestViewControl(channel, action) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const cleanup = () => { clearTimeout(timer); channel.off('message', receive); channel.off('disconnect', disconnected); };
    const disconnected = () => { cleanup(); reject(new Error('Daemon disconnected before acknowledging control')); };
    const receive = message => {
      if (message.type !== 'control.result' || message.requestId !== requestId) return;
      cleanup(); resolve(message);
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Daemon control timed out')); }, 10000);
    channel.on('message', receive); channel.once('disconnect', disconnected);
    try { channel.send({type: 'control', action, requestId}); } catch (error) { cleanup(); reject(error); }
  });
}

export function connectView({path, token}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const channel = channelFor(socket);
    const timer = setTimeout(() => { reject(new Error('View connection timed out')); socket.destroy(); }, 5000);
    const ready = message => {
      if (message.type === 'view.ready' && message.version === VERSION) {
        clearTimeout(timer); channel.off('message', ready); resolve(channel);
      } else if (message.type === 'view.error') {
        clearTimeout(timer); reject(new Error(message.message)); socket.destroy();
      }
    };
    channel.on('message', ready);
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('connect', () => channel.send({type: 'view.auth', token, version: VERSION}));
  });
}
