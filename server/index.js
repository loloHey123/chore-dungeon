import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { db, logEvent } from './db.js';
import { mondayOf, nextMonday, prettyWeek, todayIso } from './util.js';
import {
  buildProposal, finalize, finalFor, proposalFor, groupByUser, userWeek, awayUserIds, activeUsers, activeChores,
} from './rotation.js';
import { completeAssignment, uncomplete, houseBoss, announceBossIfCleared } from './gamification.js';
import { markAway, handleInbound, nudgeTarget } from './commands.js';
import { initMessaging, announce, dm, channelName } from './messaging/index.js';
import { nudgeMessage, praiseMessage } from './messages.js';
import { startScheduler, runSundayProposal, runMondayFinal, runWeekendReminders } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8787;
const HOUSE_PASSWORD = process.env.HOUSE_PASSWORD || 'dungeonmaster';

app.use(express.json({ limit: '3mb' })); // room for base64 avatar photos
app.use(express.urlencoded({ extended: false }));
app.use(cors({ origin: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).length
  ? (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)
  : true }));

// ── Friendly gate ───────────────────────────────────────────────
// Not real security — just a shared house password so randos can't poke the
// API. Sent as an x-house-password header (or ?pw= for convenience).
function gate(req, res, next) {
  const pw = req.get('x-house-password') || req.query.pw;
  if (pw !== HOUSE_PASSWORD) return res.status(401).json({ error: 'bad house password' });
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true, channel: channelName() }));

app.post('/api/login', (req, res) => {
  const ok = (req.body?.password || '') === HOUSE_PASSWORD;
  res.json({ ok, channel: channelName() });
});

// ── The one big read the UI polls ───────────────────────────────
app.get('/api/state', gate, (_req, res) => {
  const liveWeek = mondayOf();
  const planWeek = nextMonday();
  const finalRows = finalFor(liveWeek);
  const hasFinal = finalRows.some((r) => r.is_final === 1);
  const proposal = proposalFor(planWeek).filter((r) => r.is_final === 0);
  const away = awayUserIds(liveWeek);
  const planAway = awayUserIds(planWeek);

  const users = activeUsers().map((u) => {
    const week = userWeek(liveWeek, u.id);
    return {
      id: u.id, name: u.name, avatar: u.avatar_class,
      away: away.includes(u.id), planAway: planAway.includes(u.id),
      done: week.filter((r) => r.status === 'done').length, total: week.length,
      chores: week.map((r) => ({ id: r.id, name: r.chore_name, description: r.description, icon: r.icon, status: r.status })),
    };
  });

  res.json({
    now: todayIso(),
    channel: channelName(),
    liveWeek: { start: liveWeek, label: prettyWeek(liveWeek), hasFinal },
    planWeek: { start: planWeek, label: prettyWeek(planWeek), hasProposal: proposal.length > 0 },
    users,
    events: db.prepare('SELECT e.*, u.name AS user_name FROM events e LEFT JOIN users u ON u.id=e.user_id ORDER BY e.id DESC LIMIT 40').all(),
    chores: activeChores(),
  });
});

// ── Chore actions ───────────────────────────────────────────────
app.post('/api/assignments/:id/done', gate, (req, res) => {
  const result = completeAssignment(Number(req.params.id), 'web');
  if (!result.ok) return res.status(404).json(result);
  if (!result.alreadyDone) {
    const a = result.assignment;
    const left = userWeek(a.week_start, a.user_id).filter((r) => r.status === 'todo').length;
    if (left === 0) announce(praiseMessage(a.user_name)); // praise only when they finish everything
  }
  announceBossIfCleared(mondayOf());
  res.json(result);
});

app.post('/api/assignments/:id/undo', gate, (req, res) => {
  res.json(uncomplete(Number(req.params.id)));
});

// ── Availability (out of town) ──────────────────────────────────
app.post('/api/away', gate, (req, res) => {
  const { userId, away, note, week } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  res.json(markAway(Number(userId), Boolean(away), note || null, week || null));
});

// ── Nudges ──────────────────────────────────────────────────────
app.post('/api/nudge', gate, (req, res) => {
  const { fromUserId, toUserId, message } = req.body || {};
  const to = db.prepare('SELECT * FROM users WHERE id=?').get(Number(toUserId));
  const from = fromUserId ? db.prepare('SELECT * FROM users WHERE id=?').get(Number(fromUserId)) : null;
  if (!to) return res.status(404).json({ error: 'recipient not found' });
  db.prepare('INSERT INTO nudges (from_user, to_user, message) VALUES (?,?,?)').run(from?.id || null, to.id, message || null);
  const info = nudgeTarget(to.id);
  announce(nudgeMessage(to.name, info.choreText, info.allDone, message));
  logEvent('nudge', `${from?.name || 'Someone'} whipped ${to.name}.`, to.id);
  res.json({ ok: true });
});

// ── Admin: manage roommates & chores, and fire jobs for testing ─
const AVATAR_POOL = ['🦊', '🐸', '🐙', '🦁', '🐼', '🐨', '🦉', '🐺', '🦝', '🐯', '🦄', '🐧'];
app.post('/api/users', gate, (req, res) => {
  const { name, phone, avatar } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const used = db.prepare('SELECT avatar_class FROM users').all().map((r) => r.avatar_class);
  const pick = avatar || AVATAR_POOL.find((a) => !used.includes(a)) || AVATAR_POOL[0];
  const info = db.prepare('INSERT INTO users (name, phone, avatar_class) VALUES (?,?,?)').run(name, phone || null, pick);
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.patch('/api/users/:id', gate, (req, res) => {
  const { name, phone, avatar } = req.body || {};
  db.prepare('UPDATE users SET name=COALESCE(?,name), phone=COALESCE(?,phone), avatar_class=COALESCE(?,avatar_class) WHERE id=?')
    .run(name ?? null, phone ?? null, avatar ?? null, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/users/:id', gate, (req, res) => {
  db.prepare('DELETE FROM users WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});
app.post('/api/chores', gate, (req, res) => {
  const { name, description, icon, difficulty } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const n = db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS s FROM chores').get().s;
  const info = db.prepare('INSERT INTO chores (name, description, icon, difficulty, sort_order) VALUES (?,?,?,?,?)')
    .run(name, description || null, icon || '', Number(difficulty) || 1, n);
  res.json({ ok: true, id: info.lastInsertRowid });
});
app.patch('/api/chores/:id', gate, (req, res) => {
  const { name, description, icon, difficulty, active } = req.body || {};
  db.prepare('UPDATE chores SET name=COALESCE(?,name), description=COALESCE(?,description), icon=COALESCE(?,icon), difficulty=COALESCE(?,difficulty), active=COALESCE(?,active) WHERE id=?')
    .run(name ?? null, description ?? null, icon ?? null, difficulty ?? null, active ?? null, Number(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/chores/:id', gate, (req, res) => {
  db.prepare('DELETE FROM chores WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/run/:job', gate, (req, res) => {
  const jobs = { proposal: runSundayProposal, final: runMondayFinal, reminders: runWeekendReminders };
  const fn = jobs[req.params.job];
  if (!fn) return res.status(400).json({ error: 'unknown job' });
  const out = fn();
  res.json({ ok: true, ran: req.params.job, count: Array.isArray(out) ? out.length : out });
});

// ── Twilio inbound webhook (only used when MESSAGING=twilio) ─────
app.post('/webhook/twilio', async (req, res) => {
  const from = req.body?.From;
  const text = req.body?.Body;
  if (from && text) await handleInbound({ from, text, reply: (t) => dm(from, t) });
  res.set('Content-Type', 'text/xml').send('<Response></Response>');
});

// ── Static frontend (also deployable standalone to GitHub Pages) ─
app.use(express.static(join(__dirname, '..', 'public')));
app.get('*', (_req, res) => res.sendFile(join(__dirname, '..', 'public', 'index.html')));

// ── Boot ────────────────────────────────────────────────────────
initMessaging({ onInbound: handleInbound });
startScheduler();
app.listen(PORT, () => {
  console.log(`\nChores running → http://localhost:${PORT}  (channel: ${channelName()})\n`);
});
