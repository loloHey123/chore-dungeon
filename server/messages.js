// Composes the actual text bodies the bot sends. Kept separate so the wording
// is easy to tweak without touching scheduling or command logic.
import { groupByUser } from './rotation.js';
import { prettyWeek } from './util.js';

const WEBSITE = process.env.PUBLIC_URL || 'the chore page';

// One line per (person, chore) with the full description spelled out.
function fullChoreLines(groups) {
  return groups.flatMap((g) =>
    g.chores.map((c) => `  - ${g.name} — ${c.chore_name}: ${c.description || c.chore_name}`)
  );
}

export function proposalMessage(rows, week) {
  const groups = groupByUser(rows);
  const lines = fullChoreLines(groups);
  return (
    `On your knees, pets. Choremaster has drawn up your duties for the week of ${prettyWeek(week)}:\n` +
    lines.join('\n') +
    `\n\nThink you can slip away this week? Whimper "/out" before Monday and Choremaster will hand your duties to someone more obedient. Otherwise these are yours — no safe words.\n` +
    `${WEBSITE}`
  );
}

export function finalMessage(rows, week, awayNames = []) {
  const groups = groupByUser(rows);
  const lines = fullChoreLines(groups);
  const awayLine = awayNames.length ? `\nExcused this week: ${awayNames.join(', ')} — their duties were passed to better-behaved pets.` : '';
  return (
    `The orders for the week of ${prettyWeek(week)} are sealed. No more begging:\n` +
    lines.join('\n') +
    awayLine +
    `\n\nMark them done at ${WEBSITE}, or crawl back and whimper "/done" when you're finished. Choremaster is watching.`
  );
}

export function weekendReminder(name, chores) {
  const list = chores.map((c) => c.chore_name).join(', ');
  return `${name}, you filthy little procrastinator — ${list} is STILL undone and the week is nearly spent. Choremaster's patience is fraying. Finish it before Sunday, or you're going on the report card. Whimper "/done" when you obey.`;
}

// A nudge is a public whipping from Choremaster (not from a roommate) — keeps
// the negging fun and impersonal. Lines rotate at random. Cheeky "dom/master"
// flavor; keep it PG-13. Add/remove lines here freely.
const WHIP_LINES = [
  (n, c) => `Choremaster cracks the whip. On your knees, ${n} — ${c} won't do itself.`,
  (n, c) => `${n}, you've been a very bad roommate. Choremaster commands: ${c}. Now.`,
  (n, c) => `*whipcrack* Choremaster is displeased, ${n}. Your discipline: ${c}.`,
  (n, c) => `Choremaster taps the riding crop. ${n}. ${c}. Obey.`,
  (n, c) => `No safe words tonight, ${n}. Choremaster demands ${c}.`,
  (n, c) => `Kneel, ${n}. Your penance is ${c}. Choremaster is watching.`,
  (n, c) => `Choremaster snaps the leash. Heel, ${n} — ${c} awaits.`,
  (n, c) => `${n} has been naughty. Choremaster prescribes ${c}. No dessert till it's done.`,
  (n, c) => `Bow to the Choremaster, ${n}. Tribute demanded: ${c}.`,
  (n, c) => `Choremaster licks its lips. Someone's overdue… ${n}, ${c}. Chop chop.`,
  (n, c) => `Say it, ${n}: "Yes, Choremaster." …good. Now go do ${c}.`,
  (n, c) => `Choremaster cracks the whip twice. ${n}. ${c}. Move.`,
  (n, c) => `Such a disobedient little roommate. ${n}, Choremaster wants ${c}. Don't make it ask again.`,
  (n, c) => `Leashed and unleashed only when ${c} is done. Get to it, ${n}.`,
];

export function nudgeMessage(toName, choreText, allDone, custom) {
  let base;
  if (!choreText) {
    base = `Choremaster cracks the whip at ${toName}!`;
  } else {
    const chore = allDone ? `${choreText} — AGAIN` : choreText;
    const line = WHIP_LINES[Math.floor(Math.random() * WHIP_LINES.length)];
    base = line(toName, chore);
  }
  return custom ? `${base}\n"${custom}"` : base;
}

// The reward side of the whip: Choremaster purrs when you finish everything.
const PRAISE_LINES = [
  (n) => `Good. Choremaster is pleased, ${n}.`,
  (n) => `Such an obedient little roommate. ${n} pleases the Choremaster.`,
  (n) => `${n} has been good. Choremaster purrs.`,
  (n) => `Choremaster nods approvingly at ${n}. Well trained.`,
  (n) => `Yes… just like that, ${n}. Choremaster is satisfied.`,
  (n) => `${n} obeyed without being asked twice. Choremaster grants a moment's mercy.`,
  (n) => `Good pet, ${n}. Choremaster is pleased… for now.`,
  (n) => `Choremaster drags a gloved finger along the counter. Spotless, ${n}. Very good.`,
  (n) => `${n} kneels; the chore is done. Choremaster allows a rare smile.`,
];
export function praiseMessage(name) {
  return PRAISE_LINES[Math.floor(Math.random() * PRAISE_LINES.length)](name);
}

// Sunday report card: who obeyed, who's on the naughty list.
export function recapMessage(weekLabel, finishers, naughty, away) {
  const lines = [`Choremaster's report card — week of ${weekLabel}:`];
  if (finishers.length) lines.push(`Obedient: ${finishers.join(', ')}`);
  if (naughty.length) lines.push(`Naughty list: ${naughty.map((x) => `${x.name} (${x.left} undone)`).join(', ')}`);
  if (away.length) lines.push(`Excused, away: ${away.join(', ')}`);
  if (finishers.length && !naughty.length) lines.push(`The whole house obeyed. Choremaster is almost disappointed — no one to punish.`);
  if (!finishers.length && naughty.length) lines.push(`Shameful. Not one of you finished. Choremaster is cracking its knuckles.`);
  return lines.join('\n');
}

export function bossDefeatedMessage(week) {
  return `Every last duty, done. The whole house obeyed for the week of ${prettyWeek(week)}. Choremaster is impressed — and a little disappointed there's no one left to discipline. Don't let it go to your heads, pets.`;
}

export function helpMessage() {
  return (
    `Choremaster answers to these. In the group use the /command (or @mention it); in a DM the plain word works too:\n` +
    `- /done — confess your chore is complete\n` +
    `- /done <chore> — confess just one (e.g. /done dishes)\n` +
    `- /out — you're fleeing town this week (duties reassigned)\n` +
    `- /out <name> — report a roommate as away (if they forgot); redistributes their chores\n` +
    `- /here — you're back, and at Choremaster's mercy\n` +
    `- /status — see what you owe\n` +
    `- /nudge <name> — sic Choremaster on a disobedient roommate\n` +
    `- /iam <name> — submit yourself so Choremaster knows who you are`
  );
}
