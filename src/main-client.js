import {randomUUID} from 'node:crypto';

// Provider ownership stays in the daemon; this facade only waits for its events.
export function createMainClient(session, settings) {
  let activeRequest = null;
  return {
    cooldowns: {},
    select(provider) { session.active = provider; },
    async run(text, files = [], {typed} = {}) {
      if (activeRequest) throw new Error('A main turn is already active');
      const id = randomUUID();
      activeRequest = id;
      const provider = session.active || settings.order[0];
      let resolve, reject;
      const terminal = new Promise((yes, no) => { resolve = yes; reject = no; });
      // A disconnect can arrive while the RPC acknowledgement is still pending.
      terminal.catch(() => {});
      const unsubscribe = session.subscribe(row => {
        const event = row;
        if (event.kind === 'main.disconnected') reject(new Error(event.text || 'Daemon disconnected'));
        if (event.kind === 'main.blocked' && event.requestId === id) reject(new Error(event.text || 'Main provider blocked'));
        if (event.kind === 'main.terminal' && event.requestId === id) {
          resolve(event.status === 'interrupted' ? 'cancelled' : event.status);
        }
      });
      try {
        const ack = await session.runMain({id, text, files, provider, model: settings.models[provider] || '', mode: settings.mode, ...(typed ? {typed} : {})});
        if (ack.accepted === false) throw new Error(ack.reason || 'Main turn refused');
        return await terminal;
      } finally {
        unsubscribe();
        if (activeRequest === id) activeRequest = null;
      }
    },
    deliver(text) {
      const state = session.main ?? session.mainState;
      return session.deliverMain({id: randomUUID(), text, expectedTurnId: state?.currentTurnId ?? state?.turnId ?? null});
    },
    cancel() {
      return session.cancelMain({id: activeRequest, reason: 'user'});
    },
  };
}
