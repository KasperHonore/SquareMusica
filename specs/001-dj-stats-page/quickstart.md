# Quickstart: Validating DJ Stats

**Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md) | **Contract**: [contracts/stats-api.md](./contracts/stats-api.md)

How to prove the feature works end to end. Run these after implementation; they map
directly to the spec's Success Criteria.

## Prerequisites

- Node ≥ 22.12.0, `npm ci` at the repo root and in `web/`
- A `.env` with the usual required variables (`DISCORD_TOKEN`, `GUILD_ID`,
  `DISCORD_CLIENT_SECRET`, `JWT_SECRET`, …) — `validateEnv` will name any that are
  missing
- yt-dlp and FFmpeg available (`npm run setup` fetches yt-dlp)
- A voice channel you can join in the configured guild

## 1. Automated gates (what CI runs)

```bash
npm run lint && npm run format:check && npm test
cd web && npm run lint && npm run format:check && npm run build
```

`test/import-resolution.test.js` must stay green — it statically resolves every relative
import and is the only thing standing between a typo'd path and a runtime explosion,
since the app cannot be booted in CI.

## 2. Migration is additive and idempotent

```bash
cp data/music.db /tmp/music.db.bak          # keep a copy first
npm start                                   # boot once, then stop
sqlite3 data/music.db "PRAGMA table_info(history);" | grep requested_by
sqlite3 data/music.db ".schema events"
npm start                                   # boot a SECOND time
```

**Expected**: `requested_by_id` and `requested_by_avatar` appear; the `events` table and
its indexes exist; the second boot logs no migration and throws nothing. Pre-existing
history rows still have their `title`/`requested_by` intact, with NULL in the two new
columns — that NULL is the launch boundary (FR-005), not a bug.

## 3. Play attribution (FR-004, SC-007)

Queue and play one track, then:

```bash
sqlite3 data/music.db \
  "SELECT requested_by, requested_by_id, requested_by_avatar FROM history ORDER BY id DESC LIMIT 1;"
```

**Expected**: all three populated. A NULL `requested_by_id` here means the play will
never count toward any stat — treat it as a failure, not a warning.

## 4. Recording parity — the 18-combination matrix (SC-006)

This is the highest-risk area: a missed emit site fails **silently**, because the action
still works and nothing errors. Exercise each action on each surface.

```bash
sqlite3 data/music.db \
  "SELECT event_type, COUNT(*), SUM(actor_id IS NULL) AS missing_actor FROM events GROUP BY event_type;"
```

Perform, on **each** of the web dashboard, a Discord slash command, and the realtime
dashboard controls: skip, pause, resume, remove, shuffle, clear.

**Expected**: all six `event_type` values present with counts from all three surfaces,
and `missing_actor = 0` for every row except `track_complete`. Spot-check that a skip
recorded the track that was *playing at the time*, not the one that followed it —
capture-before-mutate is easy to get backwards.

## 5. Skip vs natural completion (FR-023)

Let one track play to its end, then skip another.

```bash
sqlite3 data/music.db \
  "SELECT event_type, track_title, actor_name FROM events ORDER BY id DESC LIMIT 2;"
```

**Expected**: one `track_complete` with a NULL actor, one `skip` with the actor who
pressed it. A `track_complete` for the skipped track, or a `skip` for the one that ended
naturally, means the emit sites are crossed.

## 6. Failure is best-effort, never fatal (FR-025, SC-008)

Temporarily make a stats write throw (e.g. rename the `events` table, or stub the
recorder's insert to throw), then skip a track.

**Expected**: playback skips normally, the UI shows **no** error, and the log carries an
error line naming what was lost. A user-visible error, or a skip that does not happen,
is a failure of this criterion. Restore the table afterwards.

## 7. API contract (FR-020, FR-009, FR-014, FR-002)

`/api/stats` is mounted behind `authMiddleware` (R7, FR-002), so **bare `curl` gets a
401, not a 200**. Get a token first. Sign in to the dashboard in a browser once, then
read the session token that login created straight out of the database:

```bash
TOKEN=$(sqlite3 data/music.db \
  "SELECT token FROM sessions WHERE expires_at > datetime('now') ORDER BY rowid DESC LIMIT 1;")
[ -n "$TOKEN" ] || echo 'No live session — sign in to the dashboard first'
```

`authMiddleware` accepts that token either as the `token` cookie or as a bearer header;
the header is used below because it needs no cookie jar. (If you prefer a jar, complete
the OAuth login with `curl -c cookies.txt` and pass `-b cookies.txt` instead of `-H`.)

```bash
# Unauthenticated MUST be rejected — this is FR-002 and Principle I, not a nicety
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/stats?period=all'

curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:3000/api/stats?period=all'   | jq '{period, n: (.leaderboard|length), truncated: .leaderboardTruncated, awards: (.awards|length)}'
curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:3000/api/stats?period=week'  | jq '.period'
curl -s -H "Authorization: Bearer $TOKEN" 'http://localhost:3000/api/stats?period=bogus' | jq '.'
```

**Expected**: the unauthenticated call returns **401** and no stats body; with the token,
`period` echoes the request; at most 10 leaderboard entries; **all eight** awards present
for every period, each with a winner or `winner: null`; `period=bogus` returns 400, not a
silent fall back to `all`.

**Do not run this step with `developerMode` enabled** — it makes `authMiddleware` attach a
stub user and wave every request through, so the 401 check passes vacuously and proves
nothing. Unset `developerMode`/`DEVELOPER_MODE` before the unauthenticated call.

## 8. Timezone correctness (R4, R10, FR-030, SC-013) — the subtle one

The trap worth testing deliberately: `played_at` is stored in **UTC**, while Night Owl
(22:00–04:00) and Early Bird (05:00–09:00) are defined in the configured `TZ`.

First, check that startup fails fast on a missing or bogus zone:

```bash
TZ=   npm start    # Expect: "Missing required environment variable(s): TZ"
TZ=Bogus/Zone npm start   # Expect: a clear error naming TZ=Bogus/Zone, not a silent UTC boot
```

Then check that the zone is honoured whatever the host is set to. This is what SC-013
asks for, and `test/services/statsQueries.test.js` pins it by running under
`TZ=Europe/Copenhagen`. Seed plays at `2026-07-15 21:30:00` UTC (23:30 CEST) and
`2026-01-15 22:30:00` UTC (23:30 CET). **Both** count toward Night Owl and toward the
15th as their local day.

```bash
sqlite3 data/music.db \
  "SELECT played_at, strftime('%H', played_at) AS utc_h, strftime('%H', played_at,'localtime') AS local_h
   FROM history WHERE requested_by_id IS NOT NULL ORDER BY id DESC LIMIT 5;"
```

In any non-UTC deployment `utc_h` and `local_h` differ. Confirm the award boundaries use
the **local** hour: seed a play at 22:30 local and check it counts toward Night Owl.
Getting this wrong yields plausible-looking winners that are simply the wrong people, so
a test that only asserts "Night Owl has a winner" will not catch it.

## 8a. Loop replays are not counted (FR-005a, SC-014)

Queue one track, set `/loop track`, and let it play through several times (or `/skip`
repeatedly: in track-loop a skip replays the same entry).

```bash
sqlite3 data/music.db \
  "SELECT id, title, is_loop_replay FROM history ORDER BY id DESC LIMIT 5;"
```

**Expected**: the first play has `is_loop_replay = 0` and every repeat has `1`. The History
page lists them all, while the DJ Stats leaderboard shows `trackCount` 1 for that member
and Most Played Song counts 1 play. Turn loop off and use **previous** on the realtime
dashboard to replay the same entry. That replay is `0` and counts.

## 9. Award minimum and empty states (FR-013, FR-014, SC-004)

With a member sitting at exactly 2 qualifying actions, then 3:

**Expected**: at 2, the award shows "no winner yet"; at 3, they win it. On a fresh
database every award still renders, all in their empty state, with no blank panels and
no errors.

## 10. The page itself (FR-028, FR-029, SC-001, SC-011)

```bash
npm start
cd web && npm run dev      # http://localhost:5173
```

- "DJ Stats" appears in the sidebar and opens in one click
- The page shows loading, then content; the header, subheader and body chrome are all
  correct — `CenterPanel` has **three** `activeView` switches and missing one leaves the
  page with the wrong surrounding UI
- Toggling period updates both sections without a full reload
- Your own row is visually distinct; if you rank outside the top 10 it is appended with
  your true rank
- At 400px width nothing scrolls horizontally and award cards reflow
- Reload twice: identical rankings and winners (SC-012)

## 11. Docker smoke (Principle V)

```bash
docker build -t kasperhonore/discord-music .
docker run --rm -p 3000:3000 --env-file .env kasperhonore/discord-music   # .env must set TZ
curl -s localhost:3000/api/health      # {"status":"ok"} — unauthenticated by design
```

`/api/health` is open, but `/api/stats` is not. The image runs with `NODE_ENV=production`,
where `developerMode` is explicitly ignored (`auth.js`, `isDeveloperModeEnabled`), so there
is no bypass here at all — a bare `curl` of the stats route returns 401 and tells you
nothing about whether the migration ran. Authenticate, exactly as in step 7:

```bash
# Expect 401 — the route is gated, and in production nothing waives that
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:3000/api/stats?period=all'

# Sign in to the dashboard against the container, then pull the session token it wrote
TOKEN=$(docker exec "$(docker ps -qf ancestor=kasperhonore/discord-music)" \
  sqlite3 /app/data/music.db \
  "SELECT token FROM sessions WHERE expires_at > datetime('now') ORDER BY rowid DESC LIMIT 1;")

curl -s -H "Authorization: Bearer $TOKEN" 'localhost:3000/api/stats?period=all' | jq '.period'
```

**Expected**: the image boots, native modules load, SQLite initialises in `/app/data` with
the migration applied, the unauthenticated call returns **401**, and the authenticated call
answers with `"all"`. A 401 on the authenticated call means the token did not come from
this container's database; a 500 means the migration did not run.
