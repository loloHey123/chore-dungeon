// Turns an inbound message ("done", "out", "nudge alex"…) into an action.
// Works across channels: Signal/Twilio identify the sender by phone number,
// Telegram identifies by a linked Telegram account (see the linking flow below).
//
// Each inbound message carries a `reply(text)` bound to the right destination,
// so responses go back to whoever sent it. Group broadcasts use announce().
import { db, logEvent } from './db.js';
import { mondayOf, nextMonday } from './util.js';
import { redistributeUser, userWeek } from './rotation.js';

// What chore(s) does this person owe right now? Prefers unfinished ones; if
// they've done everything, returns those (a nudge = "do it again").
export function nudgeTarget(userId) {
  const rows = userWeek(mondayOf(), userId);
  const todo = rows.filter((r) => r.status === 'todo');
  if (!rows.length) return { choreText: '', allDone: false };
  if (todo.length) return { choreText: todo.map((r) => r.chore_name).join(', '), allDone: false };
  return { choreText: rows.map((r) => r.chore_name).join(', '), allDone: true };
}
import { completeAssignment, announceBossIfCleared } from './gamification.js';
import { announce } from './messaging/index.js';
import { nudgeMessage, helpMessage, praiseMessage } from './messages.js';
import { choremasterReply } from './ai.js';

const norm = (p) => (p || '').replace(/[^\d+]/g, '');

export function userByPhone(phone) {
  const n = norm(phone);
  return db.prepare('SELECT * FROM users WHERE replace(replace(phone, " ", ""), "-", "") = ? OR phone = ?').get(n, phone)
    || db.prepare('SELECT * FROM users').all().find((u) => norm(u.phone) === n);
}

export function userByTelegram(tgId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(tgId));
}

// Which week does an "out"/"done" refer to right now? If a Sunday proposal for
// next week is on the board, that's the one being planned; otherwise it's the
// current live week.
export function targetWeek() {
  const nm = nextMonday();
  const hasProposal = db.prepare("SELECT COUNT(*) AS n FROM assignments WHERE week_start=? AND is_final=0").get(nm).n;
  if (hasProposal) return { week: nm, isFinal: false };
  return { week: mondayOf(), isFinal: true };
}

// Central "mark away" used by both the API and inbound texts. Redistributes
// immediately if the week is already live.
export function markAway(userId, away, note = null, forceWeek = null) {
  const t = targetWeek();
  const week = forceWeek || t.week;
  const isFinal = forceWeek
    ? db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE week_start=? AND is_final=1').get(week).n > 0
    : t.isFinal;
  db.prepare(
    `INSERT INTO availability (week_start, user_id, status, note, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(week_start, user_id) DO UPDATE SET status=excluded.status, note=excluded.note, updated_at=datetime('now')`
  ).run(week, userId, away ? 'away' : 'home', note);

  const u = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
  let moved = [];
  if (away) {
    logEvent('away', `${u.name} is away for the week of ${week}.`, userId);
    if (isFinal) {
      moved = redistributeUser(week, userId);
      if (moved.length) {
        const summary = moved.map((m) => `${m.chore_name} → ${m.user_name}`).join(', ');
        announce(`${u.name} is fleeing town this week. Choremaster redistributes the spoils: ${summary}. Serve well, pets — or you'll be next.`);
        logEvent('rotation', `Reassigned ${u.name}'s chores: ${summary}`, userId);
      }
    }
  } else {
    logEvent('away', `${u.name} is home for the week of ${week}.`, userId);
  }
  return { week, isFinal, moved };
}

// Parse and act on an inbound message.
export async function handleInbound({ from, text, telegram, reply }) {
  reply = reply || (() => {});

  // Normalize how people address the bot:
  //   "@choremaster_bot done dishes" → "done dishes"
  //   "/done@ChoreBot dishes"        → "done dishes"
  let body = (text || '').trim();
  body = body.replace(/^@\S+\s*/, '');       // leading @mention
  if (body.startsWith('/')) body = body.slice(1);
  body = body.replace(/^(\S+?)@\S+/, '$1');  // "/done@bot" form
  const lower = body.toLowerCase();
  const parts = lower.split(/\s+/);
  const word = parts[0];

  // Resolve who is talking.
  let user = telegram ? userByTelegram(telegram.id) : userByPhone(from);

  // ── Telegram self-linking ("iam Laura" / "i am Laura" / "link Laura") ──
  if (telegram) {
    const isLink = word === 'iam' || word === 'link' || (word === 'i' && parts[1] === 'am');
    if (isLink) {
      const nameArg = body.replace(/^\s*(i\s*am|iam|link)\s*/i, '').trim();
      const target = db.prepare('SELECT * FROM users WHERE lower(name)=lower(?)').get(nameArg);
      if (!target) return reply(`No pet named “${nameArg}” in Choremaster's stable. Type it exactly, e.g. "iam Laura".`);
      db.prepare('UPDATE users SET telegram_id=? WHERE id=?').run(String(telegram.id), target.id);
      logEvent('system', `${target.name} linked their Telegram.`, target.id);
      return reply(`Bound. You belong to Choremaster now, ${target.name}. Use /done, /out, /status, or /nudge <name> whenever you're told.`);
    }
    // Auto-link if their Telegram name/username matches a roommate exactly.
    if (!user) {
      const guess = db.prepare('SELECT * FROM users').all().find((u) => {
        const n = u.name.toLowerCase();
        return n === (telegram.first_name || '').toLowerCase() || n === (telegram.username || '').toLowerCase();
      });
      if (guess) { db.prepare('UPDATE users SET telegram_id=? WHERE id=?').run(String(telegram.id), guess.id); user = guess; }
    }
  }

  if (!user) {
    return reply(telegram
      ? 'Choremaster doesn\'t know which pet you are yet. Submit yourself with "/iam <your name>" — e.g. /iam Laura.'
      : "Choremaster doesn't recognize this number. Have your keeper add you on the chore page.");
  }

  if (word === 'help' || word === 'commands' || word === 'start') return reply(helpMessage());

  if (word === 'out' || word === 'away') {
    markAway(user.id, true, body.replace(/^\w+\s*/, '') || null);
    return reply(`Fleeing already, ${user.name}? Fine. You're excused this week — your duties go to a more obedient pet. Don't get used to Choremaster's mercy.`);
  }

  if (word === 'here' || word === 'back' || word === 'in' || word === 'home') {
    markAway(user.id, false);
    return reply(`Back on your knees, ${user.name}. Choremaster has you home this week — and within reach.`);
  }

  if (word === 'status' || word === 'chores') {
    const { week } = targetWeek();
    const rows = userWeek(week, user.id);
    if (!rows.length) return reply(`No duties for you this week, ${user.name}. Choremaster will think of something.`);
    const todo = rows.filter((r) => r.status === 'todo');
    const list = rows.map((r) => `${r.status === 'done' ? '[x]' : '[ ]'} ${r.chore_name}`).join('\n');
    return reply(`${user.name}, here's what you owe Choremaster this week:\n${list}\n${todo.length ? `${todo.length} still undone — get on it, pet.` : 'All done. Choremaster is pleased.'}`);
  }

  if (word === 'nudge') {
    const targetName = body.replace(/^\w+\s*/, '').trim();
    const target = db.prepare('SELECT * FROM users WHERE lower(name)=lower(?)').get(targetName);
    if (!target) return reply(`No pet named “${targetName}” in the stable. Use their exact name.`);
    db.prepare('INSERT INTO nudges (from_user, to_user) VALUES (?, ?)').run(user.id, target.id);
    const info = nudgeTarget(target.id);
    announce(nudgeMessage(target.name, info.choreText, info.allDone, null));
    logEvent('nudge', `${user.name} whipped ${target.name}.`, user.id);
    return reply(`With pleasure. Choremaster is whipping ${target.name} in front of everyone as we speak.`);
  }

  if (word === 'done' || word === 'did' || word === 'finished' || word === 'complete') {
    const { week } = targetWeek();
    const rows = userWeek(week, user.id).filter((r) => r.status === 'todo');
    if (!rows.length) return reply(`Nothing left to confess, ${user.name} — you've already pleased Choremaster this week.`);

    const rest = body.replace(/^\w+\s*/, '').trim().toLowerCase();
    let targets = rows;
    if (rest) targets = rows.filter((r) => r.chore_name.toLowerCase().includes(rest));
    if (rest && targets.length === 0) {
      return reply(`Choremaster sees no “${rest}” on your list. You still owe: ${rows.map((r) => r.chore_name).join(', ')}.`);
    }

    const channel = process.env.MESSAGING || 'console';
    for (const r of targets) completeAssignment(r.id, channel);
    const names = targets.map((t) => t.chore_name).join(', ');
    const left = userWeek(week, user.id).filter((r) => r.status === 'todo').length;
    if (left === 0) { announce(praiseMessage(user.name)); announceBossIfCleared(week); }
    return reply(`Good pet, ${user.name}. Confession accepted: ${names}.${left ? ` ${left} still owed — Choremaster is waiting.` : " You're free of Choremaster… for now."}`);
  }

  // Not a recognized command — let Choremaster riff back in character if an AI
  // key is configured, otherwise fall back to the plain "didn't understand" line.
  const info = nudgeTarget(user.id);
  const aiReply = await choremasterReply(user.name, body, info);
  return reply(aiReply || `Choremaster doesn't understand “${body}”. Whimper HELP to see what you may ask.`);
}
