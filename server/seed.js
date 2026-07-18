// Populates a fresh database with your 5 roommates and a starter chore list,
// then builds this week's rotation so there's something to look at immediately.
// Edit the NAMES / CHORES below, or just manage everything from the website's
// Admin panel later.
import 'dotenv/config';
import { db, logEvent } from './db.js';
import { mondayOf } from './util.js';
import { buildProposal, finalize } from './rotation.js';

// ⬇️  EDIT ME: your household. avatar_class can hold a photo URL (optional — set
//     it in Settings later); left null it shows a clean initials placeholder.
//     Phone numbers are optional now (add later in Settings) but required for
//     real Signal reminders — use E.164: +1 then the 10-digit number, no spaces.
const ROOMMATES = [
  { name: 'Laura',  phone: '+19728001488', avatar_class: null },
  { name: 'Emily',  phone: '+17638989518', avatar_class: null },
  { name: 'Bill',   phone: '+12672165524', avatar_class: null },
  { name: 'Raaj',   phone: '+12369963530', avatar_class: null },
  { name: 'Rishub', phone: '+12404461150', avatar_class: null },
];

const CHORES = [
  { name: 'Trash & Fridge',  icon: '', difficulty: 1, description: 'All trash (compost, recycling, bathroom trash) + clean out the fridge' },
  { name: 'Dishwasher',      icon: '', difficulty: 1, description: 'Load & unload the dishwasher and the dish holder' },
  { name: 'Kitchen',         icon: '', difficulty: 1, description: 'Wipe kitchen, counters, sink, and stovetop' },
  { name: 'Bathroom',        icon: '', difficulty: 1, description: 'Wipe shared bathroom counters and clean the toilet' },
  { name: 'Floors',          icon: '', difficulty: 1, description: 'Vacuum and mop all floors, including the bathroom' },
];

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount > 0) {
  console.log('Database already has users — skipping seed. (Delete chore-dungeon.db to reseed.)');
  process.exit(0);
}

const insUser = db.prepare('INSERT INTO users (name, phone, avatar_class, is_admin) VALUES (?,?,?,?)');
ROOMMATES.forEach((r, i) => insUser.run(r.name, r.phone, r.avatar_class, i === 0 ? 1 : 0));

const insChore = db.prepare('INSERT INTO chores (name, description, icon, difficulty, sort_order) VALUES (?,?,?,?,?)');
CHORES.forEach((c, i) => insChore.run(c.name, c.description, c.icon, c.difficulty, i));

const week = mondayOf();
buildProposal(week);
finalize(week); // make this week live immediately so the board isn't empty
logEvent('system', 'Seeded roommates, chores, and this week’s rotation.');

console.log('Seeded 5 roommates + 5 chores + this week’s rotation.');
console.log('   Start the server with:  npm start');
