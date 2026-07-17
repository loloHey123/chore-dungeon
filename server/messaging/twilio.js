// Twilio adapter — individual SMS (no true group chat; a "group" message is
// just sent to everyone). Incoming replies arrive via the /webhook/twilio
// route in server/index.js, which calls the shared inbound handler directly, so
// this adapter has no polling loop.
import { db, logEvent } from '../db.js';

export const name = 'twilio';

let client = null;
const FROM = process.env.TWILIO_FROM;

export async function init() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    logEvent('system', 'Twilio credentials missing — SMS disabled.');
    return;
  }
  try {
    const twilioLib = (await import('twilio')).default;
    client = twilioLib(sid, token);
    logEvent('system', `Twilio SMS active from ${FROM}.`);
  } catch (e) {
    logEvent('system', `Could not load twilio package (run: npm i twilio). ${e.message}`);
  }
}

export async function sendDirect(phone, text) {
  if (!phone) return;
  if (!client) return logEvent('system', `(twilio off) would text ${phone}: ${text}`);
  try {
    await client.messages.create({ from: FROM, to: phone, body: text });
    logEvent('message', `[sms → ${phone}] ${text}`);
  } catch (e) {
    console.error('[twilio] send failed:', e.message);
    logEvent('system', `SMS to ${phone} failed: ${e.message}`);
  }
}

// No real group — fan out to everyone who has a phone number.
export async function sendGroup(text) {
  const users = db.prepare("SELECT phone FROM users WHERE phone IS NOT NULL AND phone != ''").all();
  logEvent('message', `[sms broadcast to ${users.length}] ${text}`);
  for (const u of users) await sendDirect(u.phone, text);
}
