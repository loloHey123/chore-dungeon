// The clockwork behind the bot. Three cron jobs, all in the configured TZ:
//
//   Sunday  09:00 → settle last week, then post the PROPOSED rotation
//   Monday  08:00 → post the FINAL rotation (redistributed around anyone away)
//   Saturday 10:00 → remind anyone with unfinished chores
//
// Each job is also exported so the app can trigger it on demand (handy for
// testing from the website's "admin" panel).
import cron from 'node-cron';
import { db, logEvent, getKV, setKV } from './db.js';
import { mondayOf, nextMonday, shiftIso, prettyWeek, todayIso, hourInTZ, dowInTZ } from './util.js';
import { buildProposal, finalize, awayUserIds, userWeek, activeUsers } from './rotation.js';
import { announce, dm } from './messaging/index.js';
import { availabilityAsk, finalMessage, weekendReminder, recapMessage } from './messages.js';

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

// Sunday: report card on last week, then ask who'll be around next week.
// The rotation itself is built silently (so /out replies target next week and
// Monday has something to finalize) but assignments aren't revealed until Monday.
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
  announce(availabilityAsk(week));
  logEvent('rotation', `Asked who's home for the week of ${week} (rotation drafted silently).`);
  setKV('sunday_proposal_done', shiftIso(todayIso(), -dowInTZ()));
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
  const saturday = shiftIso(todayIso(), -((dowInTZ() - 6 + 7) % 7));
  setKV('saturday_reminder_done', saturday);
  if (count === 0) announce("Weekend check-in: every chore is done. Choremaster has no one to punish. Rare.");
  return count;
}

// True once we're actually past `hour` on `dateIso` in TZ — never run a job early.
function pastScheduledTime(dateIso, hour = 8) {
  return todayIso() > dateIso || (todayIso() === dateIso && hourInTZ() >= hour);
}

// Boot-time (and hourly) recovery: the whole process can be down when a job
// was due to fire — a crashed login session, a dead tunnel, whatever — and
// unlike a single failed send, a dead process never even attempts the job, so
// there's nothing in the event log to react to. Each job below is checked
// independently against its own last-run marker and re-run if it was missed.
export function catchUpIfMissed() {
  const monday = catchUpMondayFinal();
  const sunday = catchUpSundayProposal();
  const saturday = catchUpSaturdayReminders();
  return monday || sunday || saturday;
}

function catchUpMondayFinal() {
  const week = mondayOf();
  const hasFinal = db
    .prepare('SELECT COUNT(*) AS n FROM assignments WHERE week_start = ? AND is_final = 1')
    .get(week).n > 0;
  if (hasFinal || !pastScheduledTime(week)) return false;
  logEvent('system', `Missed the Monday finalize for the week of ${week} (server was down) — running it now.`);
  runMondayFinal();
  return true;
}

function catchUpSundayProposal() {
  const sunday = shiftIso(todayIso(), -dowInTZ());
  if (!pastScheduledTime(sunday) || getKV('sunday_proposal_done') === sunday) return false;
  const week = shiftIso(sunday, 1);
  // Once that week is already finalized, finalize() has its own fallback to
  // build a proposal from scratch — a late roll-call would just be noise.
  const hasFinal = db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE week_start = ? AND is_final = 1').get(week).n > 0;
  if (hasFinal) { setKV('sunday_proposal_done', sunday); return false; }
  logEvent('system', `Missed Sunday's roll call for the week of ${week} (server was down) — running it now.`);
  runSundayProposal();
  return true;
}

function catchUpSaturdayReminders() {
  const saturday = shiftIso(todayIso(), -((dowInTZ() - 6 + 7) % 7));
  if (!pastScheduledTime(saturday) || getKV('saturday_reminder_done') === saturday) return false;
  // Reminders are time-sensitive ("finish by Sunday") — once Sunday's roll
  // call is itself due, a late reminder for the week that's closing out is
  // just noise, not a recovery.
  if (dowInTZ() === 0 && hourInTZ() >= 8) { setKV('saturday_reminder_done', saturday); return false; }
  logEvent('system', `Missed Saturday's reminders for ${saturday} (server was down) — sending them now.`);
  runWeekendReminders();
  return true;
}

export function startScheduler() {
  const opts = { timezone: TZ };
  cron.schedule('0 8 * * 0', runSundayProposal, opts);   // Sun 8:00am
  cron.schedule('0 8 * * 1', runMondayFinal, opts);      // Mon 8:00am
  cron.schedule('0 8 * * 6', runWeekendReminders, opts); // Sat 8:00am
  logEvent('system', `Scheduler armed (TZ=${TZ}): Sun 8a proposal, Mon 8a final, Sat 8a reminders.`);
  console.log(`[scheduler] jobs armed in ${TZ}`);
  catchUpIfMissed();
  // Cron can silently miss a firing (e.g. a wedged event loop, DST edge)
  // without the process ever restarting, so boot-time recovery alone isn't
  // enough. Re-check hourly too.
  cron.schedule('0 * * * *', catchUpIfMissed, opts);
}
