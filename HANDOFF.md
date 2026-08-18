# Chore Dungeon — AI Assistant Handoff

This document is for the next AI assistant (or human) picking up work on this project. It captures everything that is not obvious from the code: decisions already made, hard-won lessons, live deployment details, and the one piece of unfinished work. Read this before touching anything.

## What this is

Chore Dungeon is a chore tracker for a house of 5 roommates: **Laura (the user you're working with), Emily, Bill, Raaj, and Rishub**. It has three parts:

1. A **web board** (static frontend in `public/`, vanilla JS) — one horizontal white card per roommate showing their chore this week, a big round checkbox, and a Nudge button.
2. A **Telegram bot** named **Choremaster** (@choremaster_1105_bot) that posts to the house group chat: weekly announcements, reminders, nudges, and natural-language command handling.
3. A **Node/Express backend** with a weekly rotation scheduler and SQLite database, running 24/7 on Laura's Mac mini.

There are 5 chores rotating round-robin on a 5-week cycle: Trash & Fridge, Dishwasher, Kitchen Wipe, Bathroom, Floors.

## Design decisions that are settled — do not relitigate

- **The UI is a clean, modern, white card board — NOT game-styled.** The project started as a pixel-RPG ("Habitica-style") and Laura explicitly rejected all of it: no XP, levels, coins, streaks, badges, titles, or RPG classes. `titles.js` was deleted. `gamification.js` survives only to record completions and fire the whole-house "all done" message. Keep all UI and outbound text plain and modern.
- **Bot wording is as concise as possible**: one short punchy sentence per message, no flavor padding. The only exception is Monday's announcement, which may include full chore descriptions.
- **Nudges are public, playful negging.** A nudge posts to the *group* (not a DM) with a rotating cheeky dom/master line from `WHIP_LINES` in `server/messages.js`, PG-13. Laura loves this tone — keep it, but keep it short. The Nudge button stays available even after a chore is checked off (the line gets "— AGAIN" appended).
- **Telegram is the chosen channel.** Signal was rejected (needs a phone number; no spare SIM) and Twilio is legacy. Messaging is a swappable adapter (`server/messaging/`, selected by the `MESSAGING` env var) — keep new outbound features channel-agnostic through that interface.
- **No sign-in on the frontend.** `public/config.js` holds the backend URL and house password, sent automatically with API calls.

## Live deployment (this is running in production for real people)

- **Backend**: Mac mini, managed by **pm2** as app `chore-dungeon` (`server/index.js`). Node is at `/opt/homebrew/bin/node` and is **not on PATH in non-login shells** — prefix commands with `export PATH="/opt/homebrew/bin:$PATH"`.
- **Tunnel**: pm2 app `cd-tunnel` runs `scripts/tunnel.mjs`, a self-healing wrapper around a **Cloudflare quick tunnel**. The trycloudflare.com URL is ephemeral; when it changes, the wrapper rewrites `public/config.js`, auto-commits ("Auto-update tunnel URL"), and pushes, which redeploys the frontend. **Consequence: always `git pull` before pushing your own changes** — the repo gets commits you didn't make.
- **Frontend**: GitHub Pages at https://lolohey123.github.io/chore-dungeon/ (repo github.com/loloHey123/chore-dungeon, account loloHey123), auto-deployed from `public/` via `.github/workflows/pages.yml`.
- **Schedule** (all 8am Pacific, cron in `server/scheduler.js`):
  - **Sunday**: recap + roll call only (asks who's away; the rotation is drafted silently — Laura removed the assignment-proposal text, don't re-add it).
  - **Monday**: finalize + redistribute + announce assignments.
  - **Saturday**: reminders to anyone not done.
- **Self-healing**: `catchUpIfMissed()` in `server/scheduler.js` runs at boot and hourly, and independently self-heals all three weekly jobs if they were missed (KV markers `sunday_proposal_done`, `saturday_reminder_done`, plus DB state for Monday finalize). This exists because of real multi-day outages — do not remove it.
- **Alerting**: `server/alert.js` pages Laura via **iMessage** (Messages.app AppleScript, already permission-granted on the mini) when a Telegram send fails after 3 retries or when bot polling is down >1 minute; falls back to a Telegram DM. Target number in `ALERT_IMESSAGE_TARGET`.
- **Boot persistence**: pm2 is resurrected by a **user LaunchAgent** (`~/Library/LaunchAgents/com.chore-dungeon.pm2.plist`), which only runs while someone is logged into the GUI session. FileVault is on, so after a reboot someone must type the password once. `pmset` is set to never sleep + auto-restart on power failure.
- **AI**: natural-language commands are classified by a Claude model via `server/ai.js`; `ANTHROPIC_API_KEY` is in `.env` (gitignored).

## The one piece of unfinished work

**Convert pm2 boot persistence from the user LaunchAgent to a system-level LaunchDaemon.** The LaunchAgent dies with the GUI login session — that already caused a silent 3-day outage. A LaunchDaemon would survive without any GUI login. Blocked because it needs interactive `sudo` and Laura's sudo attempts kept failing last time. If you pick this up, walk her through it interactively.

Everything else was in a good, shipped state as of 2026-08-18 (clean working tree at commit `62de6f4`).

## Hard rules learned from production incidents

These come from three real incidents (a 3-day silent outage; a bot that silently ignored every @mention; wrong-week data writes). Treat them as requirements:

1. **Never let an addressed message fail silently.** If the bot is @mentioned, replied-to, or named ("choremaster") in a message, it must always respond — if intent classification and the in-character riff both fail, send a generic fallback reply. Wrap inbound handlers, cron jobs, and scheduled sends so any throw still produces a user-visible reply, a `logEvent` row, and an alert via `server/alert.js`.
2. **Add guardrails proactively**, not only when asked. Laura has explicitly said she wants defensive failsafes added whenever the code is touched.
3. **Strip markdown code fences before `JSON.parse`** on any AI output — models (especially Haiku) wrap JSON in ```` ```json ```` fences despite instructions not to.
4. **Verify a column exists before shipping a query.** A `WHERE active=1` on a table without an `active` column caused total bot silence (`active` exists on `chores`, not `users`).
5. **Any AI-extracted command involving a date/week must extract that dimension explicitly.** The classifier schema has a `"week": "current"|"next"|null` field for this. Keep AI fields as pure signal of what was *said* (`null` when unstated); apply defaults in the calling code per call site, never in the prompt.
6. **The database is live and in WAL mode.** A plain `cp chore-dungeon.db copy.db` gives a stale snapshot (recent writes live in the `-wal` file). To test safely: run `PRAGMA wal_checkpoint(TRUNCATE)` on the source (safe), copy the file, and point your test at it with `DB_PATH=/path/to/copy.db`. Standalone scripts write to the **real** DB even though messaging falls back to console — any accidental mutation must be reverted, and when verifying week-targeted commands, check *which week* got written, not just that the right command fired.

## Codebase gotchas

- **SQLite is Node's built-in `node:sqlite` (`DatabaseSync`), NOT better-sqlite3** — better-sqlite3's native build fails on Laura's Node 26.5. `server/db.js` provides a `tx()` helper because `node:sqlite` has no `.transaction()`.
- Roommate ↔ Telegram linking: `users.telegram_id`, set by a one-time `iam <name>` message or auto-linked when the Telegram display name matches. Everyone is already linked.
- **Fair cover redistribution**: when someone is away, `assignments.is_cover` marks the extra chore; `coverBurden()`/`pickCoverer()` in `server/rotation.js` pick the roommate with the fewest *lifetime* covers first, so covering evens out over the year. Multi-week away ranges ("out until Sept 6") are supported, and a pending "when will you be back?" question is stored per-user in the `kv` table (`pending_return_<userId>`, 15-minute TTL) so a bare follow-up reply extends from the correct starting week.

## Running locally

```
npm install && npm run seed && npm start
```

Then open http://localhost:8787, house password `dungeonmaster`. Household is defined in `server/seed.js`. Default messaging adapter for local work is `console` (logs to the Activity feed); production runs `MESSAGING=telegram`.

## About working with Laura

- She responds well to proactive reliability work — every alerting/self-heal feature in this codebase came from her wanting the system to never fail silently again.
- She prefers short, punchy copy in everything user-facing.
- She will test things in the real group chat, so assume every deployed change is immediately live for 5 real people.
