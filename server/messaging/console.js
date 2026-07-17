// Demo adapter: nothing is actually sent. Outgoing "texts" are written to the
// Tavern Board (events table) so you can see exactly what would have gone out.
import { logEvent } from '../db.js';

export const name = 'console';

export function init() {
  logEvent('system', 'Messaging running in CONSOLE (demo) mode — no real texts are sent.');
}

export async function sendGroup(text) {
  logEvent('message', `[group] ${text}`);
  console.log('\n[console messaging → GROUP]\n' + text + '\n');
}

export async function sendDirect(phone, text) {
  logEvent('message', `[→ ${phone || 'unknown'}] ${text}`);
  console.log(`\n[console messaging → ${phone}]\n` + text + '\n');
}
