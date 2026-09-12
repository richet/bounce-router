// Real child process for remote.test.js: creates a RemoteSession over `process`'s
// own ipc channel (as a genuine forked child would) and answers test-driver
// commands sent as {cmd, reqId, ...} messages, echoing results back as
// {type:'cmd.result', reqId, ...}. This file has no relation to remote.js's own
// internal {type:'session.*'} protocol beyond sharing the same channel: it reads
// only messages carrying a `cmd`, and createRemoteSession reads only messages
// carrying a `type` starting with 'session.', so both listeners coexist quietly.
import {createRemoteSession} from '../../src/remote.js';

// node --test also scans this directory and loads this file directly (see
// test/helpers/fake-adapter.js, which is inert as a plain export). Only run the
// child logic when actually forked with an ipc channel, so a direct load here
// is a no-op instead of hanging forever awaiting a replay that never comes.
if (typeof process.send === 'function') await main();

async function main() {
  const deliveries = [];
  const session = await createRemoteSession(process);
  session.onEvent = row => deliveries.push(row);

  process.send({type: 'ready', id: session.id, context: session.context, cwd: session.cwd, eventsLength: session.events.length});

  function waitForSettled(id) {
    return new Promise(resolve => {
      const unsubscribe = session.subscribe(row => {
        if (row.id === id && (typeof row.seq === 'number' || row.error !== undefined)) { unsubscribe(); resolve(row); }
      });
    });
  }

  process.on('message', async msg => {
    if (!msg || typeof msg.cmd !== 'string') return;
    const {cmd, reqId} = msg;
    if (cmd === 'append' || cmd === 'publish') {
      const provisional = session[cmd](msg.event);
      process.send({type: 'cmd.result', reqId, row: provisional});
    } else if (cmd === 'appendAwaitSettle') {
      const provisional = session.append(msg.event);
      // `provisional` is non-enumerable by contract, so it (and any other hidden
      // marker) would vanish once this message is JSON-serialized over IPC back to
      // the test process; check it, and check the row's own JSON form, in here.
      const provisionalFlag = provisional.provisional === true;
      const provisionalJSON = JSON.stringify(provisional);
      const settled = provisionalFlag ? await waitForSettled(provisional.id) : provisional;
      process.send({type: 'cmd.result', reqId, provisional, provisionalFlag, provisionalJSON, settled});
    } else if (cmd === 'setActive') {
      session.active = msg.value;
      process.send({type: 'cmd.result', reqId, ok: true});
    } else if (cmd === 'lock') {
      session.lock();
      session.unlock();
      process.send({type: 'cmd.result', reqId, ok: true});
    } else if (cmd === 'snapshot') {
      process.send({type: 'cmd.result', reqId, snapshot: {
        id: session.id, dir: session.dir, file: session.file, cwd: session.cwd,
        context: session.context, active: session.active, events: session.events,
      }, deliveries});
    }
  });
}
