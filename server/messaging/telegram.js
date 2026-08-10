// Telegram adapter — the easy one. No phone number: create a bot with @BotFather,
// paste its token into TELEGRAM_BOT_TOKEN, add the bot to your group, and it
// learns the group's chat id automatically the first time anyone posts there.
//
// Outgoing: Telegram Bot API over HTTPS (uses global fetch — no dependency).
// Incoming: long-polls getUpdates and forwards each message to onInbound, with
//           a `reply()` bound to the same chat.
import { db, logEvent, getKV, setKV } from '../db.js';
import { sendIMessage } from '../alert.js';

export const name = 'telegram';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Small gap between long-poll cycles. getUpdates already long-polls (returns the
// instant a message arrives), so this just needs to be short to catch messages
// that land during the brief gap between cycles.
const POLL_MS = (Number(process.env.TELEGRAM_POLL_SECONDS) || 0.3) * 1000;
const url = (method) => `https://api.telegram.org/bot${TOKEN}/${method}`;

async function tgOnce(method, payload) {
  const res = await fetch(url(method), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || `telegram ${method} failed`);
  return data.result;
}

// Telegram (or the network between us) blips occasionally — e.g. a bare
// "Bad Gateway" with no JSON body — and a single failed attempt used to just
// drop the message. Retry outbound sends a couple times with backoff before
// giving up; polling (which self-schedules its own retry loop) stays on tgOnce.
async function tg(method, payload, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await tgOnce(method, payload);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw lastErr;
}

// Something Choremaster itself needs a human to know about (a send that
// failed even after retries, a polling outage). iMessage is the primary
// channel because it works even when Telegram is the thing that's down; if
// iMessage itself can't send (Messages signed out, Mac mini asleep, etc.),
// fall back to a private Telegram DM — a different failure surface, so it
// may well succeed even when the original send didn't (e.g. bot kicked from
// the group but still reachable via DM). If both fail, it's at least in the
// events log for the admin panel.
async function alertLaura(context, err) {
  const text = `Choremaster alert: ${context}${err ? ` — ${err.message}` : ''}`;
  logEvent('system', text);
  console.error(`[alert] ${text}`);
  try {
    await sendIMessage(text);
  } catch (imsgErr) {
    console.error('[alert] iMessage failed, falling back to Telegram DM:', imsgErr.message);
    const laura = db.prepare("SELECT telegram_id FROM users WHERE lower(name) = 'laura'").get();
    if (!laura?.telegram_id) return;
    try {
      await tgOnce('sendMessage', { chat_id: laura.telegram_id, text: `[iMessage unavailable] ${text}` });
    } catch (tgErr) {
      console.error('[alert] Telegram DM fallback also failed:', tgErr.message);
    }
  }
}

// The group we post to: an explicit env override, otherwise the one the bot
// auto-discovered from an incoming group message.
function groupChatId() {
  return process.env.TELEGRAM_CHAT_ID || getKV('telegram_chat_id');
}

// The bot's own identity, filled in at init from getMe. Used to tell whether a
// group message is actually addressed to Choremaster.
let BOT_USERNAME = '';
let BOT_ID = null;

export function init({ onInbound }) {
  if (!TOKEN) {
    logEvent('system', 'TELEGRAM_BOT_TOKEN not set — Telegram messaging disabled.');
    return;
  }
  logEvent(
    'system',
    groupChatId()
      ? 'Telegram bot active (group linked).'
      : 'Telegram bot active — add it to your group and send any message so it can learn the group id.'
  );
  // Learn our own username/id, and give the group a slash-command menu.
  tg('getMe').then((me) => { BOT_USERNAME = (me.username || '').toLowerCase(); BOT_ID = me.id; }).catch(() => {});
  tg('setMyCommands', {
    commands: [
      { command: 'done', description: 'Confess a chore is complete' },
      { command: 'out', description: "You're away this week" },
      { command: 'here', description: "You're back this week" },
      { command: 'status', description: 'See what you owe' },
      { command: 'nudge', description: 'Whip a roommate: /nudge <name>' },
      { command: 'iam', description: 'Link yourself: /iam <name>' },
      { command: 'help', description: 'Show commands' },
    ],
  }).catch(() => {});
  poll(onInbound);
}

// In a group, only act when clearly addressed: a /command, an @mention of the
// bot, or a reply to one of the bot's messages. In a private DM, act on
// everything. This lets roommates chat freely without Choremaster butting in.
// Link a sender to a roommate whose name matches their Telegram first name or
// username — silently, no reply. Runs on every message so an unlinked roommate
// gets wired in the moment they type anything.
function silentAutoLink(from) {
  if (!from) return;
  if (db.prepare('SELECT 1 FROM users WHERE telegram_id = ?').get(String(from.id))) return;
  const candidates = db.prepare('SELECT id, name FROM users WHERE telegram_id IS NULL').all();
  const match = candidates.find((u) => {
    const n = u.name.toLowerCase();
    return n === (from.first_name || '').toLowerCase() || n === (from.username || '').toLowerCase();
  });
  if (match) {
    db.prepare('UPDATE users SET telegram_id = ? WHERE id = ?').run(String(from.id), match.id);
    logEvent('system', `${match.name} auto-linked their Telegram.`, match.id);
  }
}

function isAddressed(msg) {
  if (msg.chat.type === 'private') return true;
  const text = msg.text || '';
  if (text.trim().startsWith('/')) return true;
  if (BOT_USERNAME && text.toLowerCase().includes('@' + BOT_USERNAME)) return true;
  if (BOT_ID && msg.reply_to_message?.from?.id === BOT_ID) return true;
  // Also respond when addressed by name, e.g. "choremaster whip me".
  if (/\bchoremaster\b/i.test(text)) return true;
  return false;
}

let offset = Number(getKV('telegram_offset') || 0);
let consecutivePollFailures = 0;

async function poll(onInbound) {
  let delay = POLL_MS;
  try {
    // getUpdates has its own retry loop below (the outer catch backs off and
    // tries again), so use tgOnce here rather than stacking tg()'s retries on
    // top of a 20s long-poll timeout.
    const updates = await tgOnce('getUpdates', { offset: offset + 1, timeout: 20, allowed_updates: ['message'] });
    consecutivePollFailures = 0;
    for (const u of updates) {
      offset = Math.max(offset, u.update_id);
      const msg = u.message;
      if (!msg || !msg.text) continue;
      const chat = msg.chat;

      // Auto-discover the group chat id (unless one was pinned in .env) — do this
      // for any group message, even ones we won't act on.
      if ((chat.type === 'group' || chat.type === 'supergroup') && !process.env.TELEGRAM_CHAT_ID) {
        if (getKV('telegram_chat_id') !== String(chat.id)) {
          setKV('telegram_chat_id', chat.id);
          logEvent('system', `Linked Telegram group: ${chat.title || chat.id}.`);
        }
      }

      // Silently link a roommate the first time they say ANYTHING, if their
      // Telegram name matches their roommate name (no /iam needed).
      silentAutoLink(msg.from);

      // Ignore ordinary chatter — only respond when addressed.
      if (!isAddressed(msg)) continue;

      onInbound({
        from: String(msg.from.id),
        text: msg.text,
        telegram: { id: msg.from.id, username: msg.from.username, first_name: msg.from.first_name },
        reply: (text) => tg('sendMessage', { chat_id: chat.id, text }).catch((e) => console.error('[telegram] reply failed:', e.message)),
      });
    }
    setKV('telegram_offset', offset);
  } catch (e) {
    console.error('[telegram] poll error:', e.message);
    delay = 15000; // back off on errors (bad token, network) to avoid log spam
    consecutivePollFailures++;
    // A single blip isn't worth waking anyone up for; ~5 in a row (a bit over
    // a minute of sustained backoff) means inbound commands are actually down.
    if (consecutivePollFailures === 5) alertLaura('Telegram polling has been failing for over a minute', e);
  } finally {
    setTimeout(() => poll(onInbound), delay);
  }
}

export async function sendGroup(text) {
  const chat = groupChatId();
  if (!chat) return logEvent('system', 'No Telegram group yet — add the bot to your group and send a message there.');
  try {
    await tg('sendMessage', { chat_id: chat, text });
    logEvent('message', `[telegram group] ${text}`);
  } catch (e) {
    console.error('[telegram] group send failed:', e.message);
    logEvent('system', `Telegram group send failed: ${e.message}`);
    alertLaura('Telegram group send failed', e);
  }
}

// Telegram can't address by phone. Map phone → roommate → telegram_id and DM
// them privately if they've linked (and started the bot); otherwise fall back to
// the group so the reminder still lands.
export async function sendDirect(phone, text) {
  const user = phone ? db.prepare('SELECT name, telegram_id FROM users WHERE phone = ?').get(phone) : null;
  if (user?.telegram_id) {
    try {
      await tg('sendMessage', { chat_id: user.telegram_id, text });
      logEvent('message', `[telegram → ${user.name}] ${text}`);
      return;
    } catch { /* user hasn't started the bot; fall back to group */ }
  }
  const chat = groupChatId();
  if (chat) {
    try {
      await tg('sendMessage', { chat_id: chat, text: user ? `${user.name}: ${text}` : text });
      logEvent('message', `[telegram group] ${text}`);
    } catch (e) {
      console.error('[telegram] direct→group fallback failed:', e.message);
      alertLaura('Telegram direct-message fallback to group also failed', e);
    }
  }
}
