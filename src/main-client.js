import {randomUUID} from 'node:crypto';
import {cooldowns} from './reducers.js';

// Provider ownership stays in the daemon; this facade only waits for its events.
// `selection` says what the next turn runs on (adapter and model); the default is the classic
// reading. In orchestrator mode the TUI passes the orchestrator profile's (src/cli-view.js).
export function createMainClient(session, settings, {selection = null} = {}) {
  let activeRequest = null;
  return {
    get cooldowns() { return cooldowns(session.events ?? [], Date.now()); },
    set cooldowns(value) { /* /retry journals the authoritative reset rows. */ },
    select(provider) { session.active = provider; },
    async run(text, files = [], {typed} = {}) {
      if (activeRequest) throw new Error('A main turn is already active');
      const id = randomUUID();
      activeRequest = id;
      const chosen = selection?.() ?? {provider: session.active || settings.order[0]};
      const provider = chosen.provider;
      const model = chosen.model ?? (settings.models[provider] || '');
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
        // A queued prompt withdrawn before it ran (cli.js's Up-arrow handling) never reaches
        // main.terminal — settle the same call the same way, so `activeRequest` frees and a
        // resend is not refused as "already active".
        if (event.kind === 'main.withdrawn' && event.requestId === id) resolve('withdrawn');
      });
      try {
        const ack = await session.runMain({id, text, files, provider, model, mode: settings.mode, routing: {order: [...settings.order], models: {...settings.models}}, ...(typed ? {typed} : {})});
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
    withdraw(id) {
      return session.withdrawMain({id});
    },
  };
}
