// Signal adapter — talks to a locally installed `signal-cli`.
//
// Outgoing: shells out to `signal-cli send`.
// Incoming: runs `signal-cli receive` on a timer and forwards each message to
//           the onInbound handler ({ from, text, isGroup }).
//
// Setup is documented in the README ("Setting up Signal").
import { execFile } from 'node:child_process';
import { logEvent } from '../db.js';

export const name = 'signal';

const NUMBER = process.env.SIGNAL_NUMBER;
const GROUP = process.env.SIGNAL_GROUP_ID;
const POLL_MS = (Number(process.env.SIGNAL_POLL_SECONDS) || 15) * 1000;

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('signal-cli', ['-a', NUMBER, ...args], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

export function init({ onInbound }) {
  if (!NUMBER) {
    logEvent('system', 'SIGNAL_NUMBER not set — Signal messaging disabled.');
    return;
  }
  logEvent('system', `Signal messaging active as ${NUMBER}` + (GROUP ? ' (group linked).' : ' (no group id set!).'));
  poll(onInbound);
}

async function poll(onInbound) {
  try {
    const out = await run(['-o', 'json', 'receive', '-t', '1']);
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let env;
      try { env = JSON.parse(trimmed).envelope; } catch { continue; }
      const data = env?.dataMessage;
      if (!data?.message) continue;
      const sender = env.sourceNumber || env.source;
      onInbound({
        from: sender,
        text: data.message,
        isGroup: Boolean(data.groupInfo),
        reply: (t) => sendDirect(sender, t),
      });
    }
  } catch (e) {
    // Transient signal-cli hiccups shouldn't crash the loop.
    console.error('[signal] receive error:', e.message);
  } finally {
    setTimeout(() => poll(onInbound), POLL_MS);
  }
}

export async function sendGroup(text) {
  if (!GROUP) return sendFallbackLog('group', text);
  try {
    await run(['send', '-g', GROUP, '-m', text]);
    logEvent('message', `[signal group] ${text}`);
  } catch (e) {
    console.error('[signal] group send failed:', e.message);
    logEvent('system', `Signal group send failed: ${e.message}`);
  }
}

export async function sendDirect(phone, text) {
  if (!phone) return;
  try {
    await run(['send', phone, '-m', text]);
    logEvent('message', `[signal → ${phone}] ${text}`);
  } catch (e) {
    console.error('[signal] direct send failed:', e.message);
  }
}

function sendFallbackLog(kind, text) {
  logEvent('system', `No SIGNAL_GROUP_ID set; would have sent to ${kind}: ${text}`);
}
