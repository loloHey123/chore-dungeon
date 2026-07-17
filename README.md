# 🧼 Chores

A clean, modern chore board for a house of roommates. A simple white page of
cards — one per person, each showing their chore for the week and a big round
checkbox — backed by a bot that texts the group so nobody has to be the nag.

---

## What it does

| Feature | How |
|---|---|
| 🗂️ **A card per roommate** | Avatar, name, this week's chore, a giant round checkbox, and a Nudge button |
| 🖱️ **Full details on hover** | Hover a chore to see everything that person is responsible for |
| 🔁 **Weekly rotating chores** | Round-robin engine — a different person gets each chore every week |
| ✅ **Mark chores done** | Tap the checkbox on the site, or reply **DONE** to the bot |
| 👉 **Nudge a roommate** | Anyone can tap Nudge to send a reminder text |
| 📨 **Sunday proposal text** | Bot posts next week's proposed chores + "reply OUT if you're away" |
| 📋 **Monday final text** | Bot posts the finalized list, redistributed around anyone away |
| ⏰ **Weekend reminders** | Saturday, anyone with an unfinished chore gets a reminder |
| 🧳 **Out-of-town redistribution** | Mark yourself away → your card shows **OUT** and your chore is reassigned |

---

## The weekly rhythm

```
 SUNDAY 8am   → Bot posts the PROPOSED rotation for next week
                + "reply OUT if you're away."
 SUNDAY (all day) → People mark themselves away (website or reply OUT).
 MONDAY 8am   → Bot posts the FINAL rotation, redistributed around anyone away.
 (all week)   → Mark chores done on the site or reply DONE. Nudge freely.
 SATURDAY 8am → Reminders to anyone unfinished + names the current
                Keeper of the Grime.
```

All times are **8am Pacific** (set by `TZ` in `.env`).

Times and timezone are set in `.env` (`TZ`). Change the cron lines in
`server/scheduler.js` if you want different times.

---

## Quick start (5 minutes, no texting yet)

You need **Node 22.5+** (uses the built-in `node:sqlite` — no database to install).

```bash
cd chore-dungeon
cp .env.example .env        # edit HOUSE_PASSWORD if you like
npm install
npm run seed                # creates 5 roommates + 5 chores + this week's rotation
npm start
```

Open **http://localhost:8787**, leave *Server URL* blank, and enter the house
password (default `dungeonmaster`). You're in **demo mode** — no real texts are
sent, but every message the bot *would* send shows up on the **📜 Board** tab.

Edit your roommates and chores in the **⚙️ Admin** tab (or edit the lists at the
top of `server/seed.js` before seeding). The Admin tab also has buttons to fire
the Sunday/Monday/weekend jobs on demand so you can preview them.

---

## Turning on real texts

Pick **one** channel in `.env` via `MESSAGING=`.

### Option A — Telegram (recommended: no phone number) 📨

The easiest by far — Telegram has a real bot API, so there's no phone number,
SIM, or verification. Everyone just needs Telegram installed.

1. **Create the bot:** message **@BotFather** → `/newbot` → follow the prompts →
   copy the **token** it gives you (looks like `123456:ABC-DEF...`).
2. **Let it read group replies:** @BotFather → `/setprivacy` → select your bot →
   **Disable**. (Otherwise, in groups the bot only sees `/commands`, not plain
   words like "done".)
3. **Make a Telegram group**, add all your roommates, and add the bot.
4. **Fill in `.env`** and restart:
   ```
   MESSAGING=telegram
   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
   ```
   Leave `TELEGRAM_CHAT_ID` blank — the bot auto-learns the group the first time
   anyone posts a message there.
5. **Everyone links themselves once** by messaging the group `iam <their name>`
   (e.g. `iam Laura`). After that the bot knows who's who, so **DONE / OUT /
   HERE / STATUS / NUDGE <name>** replies just work. (If someone's Telegram name
   already matches their roommate name, they're linked automatically.)

### Option B — Signal (needs a phone number for the bot) 📡

A real group chat everyone's already in; the bot posts to it and reads replies.
Free, runs on your Mac mini.

1. **Install signal-cli:** `brew install signal-cli`
2. **Register a number for the bot** (a spare SIM or Google Voice number — *not*
   your personal Signal number):
   ```bash
   signal-cli -a "+1YOURBOTNUMBER" register        # then you'll get an SMS code
   signal-cli -a "+1YOURBOTNUMBER" verify 123456    # the code
   ```
3. **Create/find the group** and get its id:
   ```bash
   signal-cli -a "+1YOURBOTNUMBER" updateGroup -n "Chore Dungeon"   # or add the bot to an existing group
   signal-cli -a "+1YOURBOTNUMBER" listGroups                        # copy the "Id: ..." (base64)
   ```
   Add all your roommates to that group.
4. **Fill in `.env`:**
   ```
   MESSAGING=signal
   SIGNAL_NUMBER=+1YOURBOTNUMBER
   SIGNAL_GROUP_ID=<the base64 id from listGroups>
   ```
5. Restart the server. It now posts to the group and polls for **DONE / OUT /
   HERE / STATUS / NUDGE <name>** replies. Text **HELP** to the bot for the list.

> ⚠️ For the bot to recognize who's replying, each roommate's phone number in the
> Admin panel must match their Signal number, in `+1XXXXXXXXXX` form.

### Option C — Twilio (individual SMS) 📲

No true group chat — a "group" message is just sent to everyone individually.

1. Create a Twilio account + buy a number (free trial gives ~$15 credit).
2. `npm install twilio`
3. In `.env`:
   ```
   MESSAGING=twilio
   TWILIO_ACCOUNT_SID=ACxxxx
   TWILIO_AUTH_TOKEN=xxxx
   TWILIO_FROM=+1YOURTWILIONUMBER
   ```
4. For replies (DONE/OUT/etc.), point your Twilio number's **"A message comes
   in"** webhook to `https://<your-public-url>/webhook/twilio` (see the tunnel
   step below to get a public URL).

---

## Letting roommates use the website from anywhere

The website is static and lives on **GitHub Pages**; the backend + bot run on
your **Mac mini**. A free **Cloudflare Tunnel** connects them.

1. **Expose the Mac mini backend:**
   ```bash
   brew install cloudflared
   cloudflared tunnel --url http://localhost:8787
   ```
   It prints a URL like `https://random-words.trycloudflare.com`. That's your
   backend's public address. (For a *stable* URL that survives restarts, set up a
   named tunnel — see Cloudflare's docs.)

2. **Deploy the frontend to GitHub Pages:** push the `public/` folder to a repo
   and enable Pages (Settings → Pages → deploy from branch, `/public` or move its
   contents to the repo root). You'll get `https://youruser.github.io/chore-dungeon`.

3. **Tell the backend to trust the Pages origin** — in `.env`:
   ```
   CORS_ORIGINS=https://youruser.github.io
   PUBLIC_URL=https://youruser.github.io/chore-dungeon
   ```
   (`PUBLIC_URL` is the link the bot puts in its texts.)

4. Each roommate opens the Pages URL once, enters the **tunnel URL** in *Server
   URL* and the house password. It's remembered after that.

> Prefer not to bother with Pages? You can skip it entirely: just share the
> Cloudflare tunnel URL directly — the backend serves the same website at `/`.

---

## Keeping it running on the Mac mini

So the scheduled texts fire even after a reboot, keep both the server and the
tunnel alive with [pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start server/index.js --name chore-dungeon
pm2 start cloudflared --name cd-tunnel -- tunnel --url http://localhost:8787
pm2 save && pm2 startup     # follow the printed command to run on login
```

---

## The board

The whole app is one white page of cards — one per roommate. Each card shows:

- a round avatar (a clean initials placeholder, or a photo URL you set in Settings)
- their name
- their assigned chore for the week (**OUT** if they're away)
- a giant round checkbox — empty until done, then a green check
- a **Nudge** button anyone can tap to text that person a reminder

Hover a chore to see the full details of everything that person is responsible
for (useful when someone's covering two chores for a roommate who's away).

Chores are **mandatory** — everyone does theirs — so there's no scoreboard or
points. The ⚙️ **Settings** drawer (top-right) is where you manage roommates,
phone numbers, and the chore list, and where you can manually trigger any of
the scheduled texts to preview them.

---

## Project map

```
server/
  index.js        Express API + static site + Twilio webhook + boot
  db.js           node:sqlite schema + tiny transaction helper
  rotation.js     rotation engine + away redistribution
  gamification.js chore completion + whole-house "all done" tracker
  scheduler.js    Sun / Mon / Sat cron jobs (also callable from Settings)
  commands.js     parses inbound texts (DONE / OUT / HERE / STATUS / NUDGE)
  messages.js     the wording of every outbound text
  messaging/      swappable channel: console | signal | twilio
  seed.js         starter roommates + chores  ← edit your house here
public/
  index.html, styles.css, app.js   the card-board website
```

Everything's plain JavaScript and vanilla front-end — no build step.
