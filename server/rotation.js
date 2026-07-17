// The rotation engine.
//
//   buildProposal(week)  → round-robin assigns every active chore to a roommate
//                          for `week`, as a NON-final proposal (Sunday).
//   finalize(week)       → redistributes any away roommate's chores among the
//                          people who are home, then marks the week final (Monday).
//
// Weeks rotate: the same chore lands on a different person each week, so nobody
// is stuck scrubbing the toilet forever.
import { db, tx } from './db.js';
import { weekIndex } from './util.js';

export function activeUsers() {
  return db.prepare('SELECT * FROM users ORDER BY id').all();
}

export function activeChores() {
  return db.prepare('SELECT * FROM chores WHERE active = 1 ORDER BY sort_order, id').all();
}

// Away roommates for a week (those who explicitly set status='away').
export function awayUserIds(week) {
  return db
    .prepare("SELECT user_id FROM availability WHERE week_start = ? AND status = 'away'")
    .all(week)
    .map((r) => r.user_id);
}

// Build (or rebuild) the Sunday proposal for `week`. Idempotent: wipes any
// existing non-final rows for that week first, so re-running is safe.
export function buildProposal(week) {
  const users = activeUsers();
  const chores = activeChores();
  if (users.length === 0 || chores.length === 0) return [];

  db.prepare('DELETE FROM assignments WHERE week_start = ? AND is_final = 0').run(week);

  const offset = weekIndex(week) % users.length;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO assignments (week_start, user_id, chore_id, status, is_final) VALUES (?, ?, ?, \'todo\', 0)'
  );
  tx(() => {
    chores.forEach((chore, i) => {
      const user = users[(i + offset) % users.length];
      insert.run(week, user.id, chore.id);
    });
  });
  return proposalFor(week);
}

export function proposalFor(week) {
  return db
    .prepare(
      `SELECT a.*, u.name AS user_name, c.name AS chore_name, c.icon, c.difficulty
         FROM assignments a
         JOIN users u ON u.id = a.user_id
         JOIN chores c ON c.id = a.chore_id
        WHERE a.week_start = ?
        ORDER BY u.id, c.sort_order`
    )
    .all(week);
}

// Turn the proposal into the final list, redistributing chores owned by away
// roommates to whoever is home (spreading them to the least-loaded person).
export function finalize(week) {
  // If no proposal exists yet (e.g. app was down Sunday), build one now.
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM assignments WHERE week_start = ?')
    .get(week).n;
  if (existing === 0) buildProposal(week);

  const away = new Set(awayUserIds(week));
  const users = activeUsers();
  const homeUsers = users.filter((u) => !away.has(u.id));

  // Promote everything to final; we'll rewrite ownership below.
  db.prepare('UPDATE assignments SET is_final = 1 WHERE week_start = ?').run(week);

  if (away.size === 0 || homeUsers.length === 0) return finalFor(week);

  // Chores currently owned by away roommates need new homes.
  const orphaned = db
    .prepare(
      `SELECT a.id, a.chore_id FROM assignments a
        WHERE a.week_start = ? AND a.user_id IN (${[...away].map(() => '?').join(',')})`
    )
    .all(week, ...away);

  // Current load per home user, so we hand extra chores to the least busy.
  const load = new Map(homeUsers.map((u) => [u.id, 0]));
  for (const u of homeUsers) {
    load.set(
      u.id,
      db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE week_start = ? AND user_id = ?').get(week, u.id).n
    );
  }

  const reassign = db.prepare(
    'UPDATE assignments SET user_id = ?, status = \'todo\', completed_at = NULL, completed_via = NULL WHERE id = ?'
  );
  tx(() => {
    for (const orphan of orphaned) {
      // pick home user with the smallest current load
      let best = homeUsers[0].id;
      for (const [uid, n] of load) if (n < load.get(best)) best = uid;
      reassign.run(best, orphan.id);
      load.set(best, load.get(best) + 1);
    }
  });
  return finalFor(week);
}

export function finalFor(week) {
  return db
    .prepare(
      `SELECT a.*, u.name AS user_name, u.avatar_class, c.name AS chore_name, c.icon, c.difficulty, c.description
         FROM assignments a
         JOIN users u ON u.id = a.user_id
         JOIN chores c ON c.id = a.chore_id
        WHERE a.week_start = ?
        ORDER BY u.id, c.sort_order`
    )
    .all(week);
}

// Mid-week redistribution: when someone marks away AFTER Monday, hand their
// still-unfinished (todo) chores to whoever's home and least loaded. Returns
// the chores that were moved (for a nice announcement).
export function redistributeUser(week, userId) {
  const away = new Set(awayUserIds(week));
  away.add(userId);
  const homeUsers = activeUsers().filter((u) => !away.has(u.id));
  if (homeUsers.length === 0) return [];

  const todos = db
    .prepare("SELECT id, chore_id FROM assignments WHERE week_start=? AND user_id=? AND status='todo'")
    .all(week, userId);

  const load = new Map(
    homeUsers.map((u) => [
      u.id,
      db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE week_start=? AND user_id=?').get(week, u.id).n,
    ])
  );
  const reassign = db.prepare('UPDATE assignments SET user_id=? WHERE id=?');
  const moved = [];
  tx(() => {
    for (const t of todos) {
      let best = homeUsers[0].id;
      for (const [uid, n] of load) if (n < load.get(best)) best = uid;
      reassign.run(best, t.id);
      load.set(best, load.get(best) + 1);
      const info = db
        .prepare(
          `SELECT c.name AS chore_name, c.icon, u.name AS user_name FROM assignments a
             JOIN chores c ON c.id=a.chore_id JOIN users u ON u.id=a.user_id WHERE a.id=?`
        )
        .get(t.id);
      moved.push(info);
    }
  });
  return moved;
}

export function userWeek(week, userId) {
  return db
    .prepare(
      `SELECT a.*, c.name AS chore_name, c.icon, c.difficulty, c.description FROM assignments a
         JOIN chores c ON c.id=a.chore_id WHERE a.week_start=? AND a.user_id=? ORDER BY c.sort_order`
    )
    .all(week, userId);
}

// Group a flat assignment list into { userId, name, chores:[...] } for the UI/texts.
export function groupByUser(rows) {
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, {
        user_id: r.user_id,
        name: r.user_name,
        avatar_class: r.avatar_class,
        chores: [],
      });
    }
    byUser.get(r.user_id).chores.push(r);
  }
  return [...byUser.values()];
}
