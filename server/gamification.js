// Chore completion + the house-wide "did everyone finish?" tracker.
//
// Chores are MANDATORY here — there's no XP/points economy. Marking a chore done
// just records it and (when the whole house finishes) fires a group message.
import { db, logEvent, getKV, setKV } from './db.js';
import { announce } from './messaging/index.js';
import { bossDefeatedMessage } from './messages.js';

export function completeAssignment(assignmentId, via = 'web') {
  const a = db
    .prepare(
      `SELECT a.*, c.name AS chore_name, c.icon, u.name AS user_name
         FROM assignments a JOIN chores c ON c.id = a.chore_id JOIN users u ON u.id = a.user_id
        WHERE a.id = ?`
    )
    .get(assignmentId);
  if (!a) return { ok: false, error: 'assignment not found' };
  if (a.status === 'done') return { ok: true, alreadyDone: true, assignment: a };

  db.prepare("UPDATE assignments SET status='done', completed_at=datetime('now'), completed_via=? WHERE id=?").run(via, assignmentId);
  logEvent('done', `${a.user_name} finished “${a.chore_name}”.`, a.user_id);
  return { ok: true, assignment: a };
}

export function uncomplete(assignmentId) {
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignmentId);
  if (!a || a.status !== 'done') return { ok: false };
  db.prepare("UPDATE assignments SET status='todo', completed_at=NULL, completed_via=NULL WHERE id=?").run(assignmentId);
  return { ok: true };
}

// House progress this week: the Grime Golem's HP is the pile of unfinished
// chores. Everyone finishing = the whole house wins (and nobody earns a shame
// title). Kept as a shared goal, not a points system.
export function houseBoss(week) {
  const row = db
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(status='done'),0) AS done FROM assignments WHERE week_start=? AND is_final=1")
    .get(week);
  const total = row.total || 0;
  const done = row.done || 0;
  const maxHp = Math.max(total, 1);
  return { name: 'The Grime Golem', icon: '👹', maxHp, hp: maxHp - done, done, total, defeated: total > 0 && done === total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// Announce a whole-house victory exactly once per week.
export function announceBossIfCleared(week) {
  const boss = houseBoss(week);
  const flagKey = `boss_cleared:${week}`;
  if (boss.defeated && getKV(flagKey) !== '1') {
    setKV(flagKey, '1');
    logEvent('system', `The whole house finished every chore for the week of ${week}!`);
    announce(bossDefeatedMessage(week));
    return true;
  }
  return false;
}
