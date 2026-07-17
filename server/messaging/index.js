// Messaging factory. Picks an adapter from the MESSAGING env var and exposes a
// tiny stable API the rest of the app uses:
//
//   announce(text)     → post to the whole house (Signal group / SMS broadcast)
//   dm(phone, text)    → message one person
//   deliverInbound(m)  → feed an incoming message to the command handler
//
import * as consoleAdapter from './console.js';
import * as signalAdapter from './signal.js';
import * as twilioAdapter from './twilio.js';
import * as telegramAdapter from './telegram.js';

const ADAPTERS = { console: consoleAdapter, signal: signalAdapter, twilio: twilioAdapter, telegram: telegramAdapter };

let adapter = consoleAdapter;
let inbound = async () => {};

export function initMessaging({ onInbound }) {
  inbound = onInbound || inbound;
  const kind = (process.env.MESSAGING || 'console').toLowerCase();
  adapter = ADAPTERS[kind] || consoleAdapter;
  adapter.init?.({ onInbound: (m) => inbound(m) });
  return adapter.name;
}

export const announce = (text) => adapter.sendGroup(text);
export const dm = (phone, text) => adapter.sendDirect(phone, text);
export const deliverInbound = (msg) => inbound(msg);
export const channelName = () => adapter.name;
