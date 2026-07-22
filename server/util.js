// Small date helpers. All "weeks" are keyed by the ISO date (YYYY-MM-DD) of
// their Monday, computed in the configured TZ so scheduling lines up with when
// people actually wake up.

const TZ = process.env.TZ || 'America/Los_Angeles';

// Returns a Date's Y/M/D as seen in the configured timezone.
function ymdInTZ(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get('year')),
    m: Number(get('month')),
    d: Number(get('day')),
    dow: weekdayMap[get('weekday')],
  };
}

function iso(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ISO date of the Monday of the week containing `date` (in TZ).
export function mondayOf(date = new Date()) {
  const { y, m, d, dow } = ymdInTZ(date);
  // days since Monday: Sun(0)->6, Mon(1)->0, ... Sat(6)->5
  const offset = (dow + 6) % 7;
  return shiftIso(iso(y, m, d), -offset);
}

// ISO date of the NEXT Monday (the upcoming week we plan on Sunday).
export function nextMonday(date = new Date()) {
  return shiftIso(mondayOf(date), 7);
}

// Add `days` to an ISO date string; returns a new ISO string. Uses UTC math on
// the date-only value, which is timezone-safe for whole-day arithmetic.
export function shiftIso(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// Current hour of day (0-23) in the configured timezone.
export function hourInTZ(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' })
      .formatToParts(date).find((p) => p.type === 'hour').value
  );
}

export function todayIso() {
  const { y, m, d } = ymdInTZ();
  return iso(y, m, d);
}

// Integer index of a week for round-robin rotation (weeks since an epoch Monday).
export function weekIndex(isoMonday) {
  const [y, m, d] = isoMonday.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) - Date.UTC(2024, 0, 1);
  return Math.round(ms / (7 * 24 * 3600 * 1000));
}

export function prettyWeek(isoMonday) {
  const [y, m, d] = isoMonday.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
