// The clockwork behind the bot. Three cron jobs, all in the configured TZ:
//
//   Sunday  09:00 → settle last week, then post the PROPOSED rotation
//   Monday  08:00 → post the FINAL rotation (redistributed around anyone away)
//   Saturday 10:00 → remind anyone with unfinished chores
//
// Each job is also exported so the app can trigger it on demand (handy for
// testing from the website's "admin" panel).
import cron from 'node-cron';
import { db, logEvent } from './db.js';
import { mondayOf, nextMonday, shiftIso, prettyWeek } from './util.js';
import { buildProposal, finalize, awayUserIds, userWeek, activeUsers } from './rotation.js';
import { announce, dm } from './messaging/index.js';
import { proposalMessage, finalMessage, weekendReminder, recapMessage } from './messages.js';

const TZ = process.env.TZ || 'America/Los_Angeles';

// A report card for the week that's ending: who obeyed, who's on the naughty list.
export function weekRecap(week) {
  const rows = db
    .prepare(
      `SELECT u.name, SUM(a.status='done') AS done, COUNT(*) AS total
         FROM assignments a JOIN users u ON u.id = a.user_id
        WHERE a.week_start = ? AND a.is_final = 1 GROUP BY u.id ORDER BY u.id`
    )
    .all(week);
  if (!rows.length) return null;
  const awayIds = new Set(awayUserIds(week));
  const away = activeUsers().filter((u) => awayIds.has(u.id)).map((u) => u.name);
  const finishers = rows.filter((r) => r.done === r.total).map((r) => r.name);
  const naughty = rows.filter((r) => r.done < r.total).map((r) => ({ name: r.name, left: r.total - r.done }));
  return { finishers, naughty, away };
}

// Sunday: report card on last week, then propose next week's chores.
export function runSundayProposal() {
  const ending = mondayOf();          // the week Sunday closes out
  const recap = weekRecap(ending);
  if (recap) {
    announce(recapMessage(prettyWeek(ending), recap.finishers, recap.naughty, recap.away));
    logEvent('rotation', `Posted the report card for the week of ${ending}.`);
  }

  const week = nextMonday();          // the week we're planning
  const rows = buildProposal(week);
  if (!rows.length) { logEvent('system', 'Proposal skipped — add roommates and chores first.'); return; }
  announce(proposalMessage(rows, week));
  logEvent('rotation', `Posted the proposed rotation for the week of ${week}.`);
  return rows;
}

// Monday: lock it in, redistributing around anyone who called out.
export function runMondayFinal() {
  const week = mondayOf();            // the week starting today
  const rows = finalize(week);
  const awayIds = new Set(awayUserIds(week));
  const awayNames = activeUsers().filter((u) => awayIds.has(u.id)).map((u) => u.name);
  announce(finalMessage(rows, week, awayNames));
  logEvent('rotation', `Posted the final rotation for the week of ${week}.`);
  return rows;
}

// Saturday: private reminders to stragglers.
export function runWeekendReminders() {
  const week = mondayOf();
  let count = 0;
  for (const u of activeUsers()) {
    const todo = userWeek(week, u.id).filter((r) => r.status === 'todo');
    if (todo.length === 0) continue;
    const msg = weekendReminder(u.name, todo);
    if (u.phone) dm(u.phone, msg); else announce(msg);
    logEvent('message', `Weekend reminder sent to ${u.name} (${todo.length} left).`, u.id);
    count++;
  }
  if (count === 0) announce("Weekend check-in: every chore is done. Choremaster has no one to punish. Rare.");
  return count;
}

export function startScheduler() {
  const opts = { timezone: TZ };
  cron.schedule('0 8 * * 0', runSundayProposal, opts);   // Sun 8:00am
  cron.schedule('0 8 * * 1', runMondayFinal, opts);      // Mon 8:00am
  cron.schedule('0 8 * * 6', runWeekendReminders, opts); // Sat 8:00am
  logEvent('system', `Scheduler armed (TZ=${TZ}): Sun 8a proposal, Mon 8a final, Sat 8a reminders.`);
  console.log(`[scheduler] jobs armed in ${TZ}`);
}
