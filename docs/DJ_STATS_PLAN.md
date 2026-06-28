# DJ Statistics & Awards Feature

## Context

The app is a Discord music bot with a web dashboard. It already tracks every song played in a `history` table (title, url, duration, requested_by, played_at). The goal is to add a **DJ Stats** page to the web dashboard featuring a **DJ Leaderboard**, **fun awards/superlatives**, and a **time-period toggle** (All Time / This Week / This Month). We'll also add full event tracking (skips, pauses, removes, shuffles, clears) from day one so award data starts accumulating immediately.

---

## Phase 1: Database Foundation

### 1a. New `events` table — `src/database/schema.sql`

```sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT,
  event_type TEXT NOT NULL,     -- skip, pause, resume, remove, shuffle, clear_queue, track_complete
  user_id TEXT NOT NULL,        -- actor's Discord ID
  username TEXT NOT NULL,       -- actor's username
  target_user_id TEXT,          -- whose track was affected (for skip/remove)
  target_username TEXT,
  track_title TEXT,
  track_url TEXT,
  metadata TEXT,                -- JSON for extra context
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
```

### 1b. Migration: add `requested_by_id` to `history` — `src/database/db.js`

In `migrate()`, after the existing `guild_id` migration:

- Check if `requested_by_id` column exists via `pragma('table_info(history)')`
- If not, `ALTER TABLE history ADD COLUMN requested_by_id TEXT` + index

### 1c. Update `addToHistory()` — `src/database/db.js`

Save `track.requestedById` into the new `requested_by_id` column. Tracks already carry `requestedById` (set in `trackResolver.js:81` and `resolutionManager.js:290`).

### 1d. Add `logEvent()` method — `src/database/db.js`

```js
logEvent(eventType, userId, username, options = {})
```

Inserts into `events` table with guild_id, target user info, track info, and metadata.

---

## Phase 2: Event Logging

### New file: `src/database/eventLogger.js`

Thin convenience wrappers around `db.logEvent()`:

- `logSkip(userId, username, skippedTrack, guildId)`
- `logPause(userId, username, currentTrack, guildId)`
- `logResume(userId, username, currentTrack, guildId)`
- `logRemove(userId, username, removedTrack, guildId)`
- `logShuffle(userId, username, guildId)`
- `logClearQueue(userId, username, guildId, queueLength)`
- `logTrackComplete(track, guildId)`

### Hook into socket handlers — `src/realtime/handlers.js`

- `**handlePlayerControl**`: Before `musicManager.skip()`, capture `musicManager.getCurrentTrack()` as the skipped track. Log skip/pause/resume/shuffle/clear using `socket.user.discord_id` and `socket.user.username`.
- `**handleQueueRemove**`: Before `musicManager.removeFromQueue(position)`, capture the track at that position from `musicManager.getQueue()[position]`, then log.

### Hook into REST routes — `src/api/routes/playback.js` and `src/api/routes/queue.js`

Same logging for skip/pause/play/remove/shuffle/clear actions. User identity from `req.user.discord_id` / `req.user.username`.

### Track completion — `src/commands/playback.js` (trackEnd handler)

The `trackEnd` handler at line 20 auto-advances to the next track. Add `logTrackComplete()` call here for natural endings. Use a `_skipping` flag on `musicManager` (set in `skip()`, cleared after) to distinguish skips from natural completions.

---

## Phase 3: Stats API

### New file: `src/api/routes/stats.js`

All endpoints accept `?period=week|month|all` query param.

`**GET /api/stats/leaderboard**` — Top DJs ranked by total songs, with per-user metrics:

- Total songs queued (from `history`)
- Total listening time (SUM of duration)
- Unique songs / variety score
- Group by `COALESCE(requested_by_id, requested_by)` to handle old rows

`**GET /api/stats/awards**` — Array of award objects, each with name, description, winner, value:


| Award            | Source  | Logic                                                                                  |
| ---------------- | ------- | -------------------------------------------------------------------------------------- |
| Most Played Song | history | `GROUP BY url ORDER BY COUNT(*) DESC`                                                  |
| Night Owl        | history | Songs played 10pm–4am, `strftime('%H', played_at)`                                     |
| Early Bird       | history | Songs played 5am–9am                                                                   |
| The Hog          | history | Most songs in a single day, `GROUP BY user, DATE(played_at)`                           |
| The Closer       | history | Last song before 30+ min gap (window function with LEAD)                               |
| DJ Skip          | events  | `WHERE event_type='skip' AND target_user_id != user_id` — whose songs get skipped most |
| Self-Skip King   | events  | `WHERE event_type='skip' AND target_user_id = user_id`                                 |
| Queue Yeeter     | events  | Most `remove` events                                                                   |
| Shuffle Addict   | events  | Most `shuffle` events                                                                  |


Awards from the `events` table will return `null` winner until data accumulates.

### Register route — `src/api/index.js`

Add `app.use('/api/stats', statsRoutes)`.

---

## Phase 4: Frontend

### 4a. Trophy icon — `web/src/components/icons/index.jsx`

Add a `Trophy` SVG icon following the existing pattern.

### 4b. Sidebar nav — `web/src/components/layout/Sidebar.jsx`

Add to `navItems`: `{ id: 'stats', label: 'DJ Stats', icon: Trophy }`

### 4c. Dashboard routing — `web/src/pages/Dashboard.jsx`

Import `Stats` page, add `case 'stats': return <Stats />` in `renderMainContent()`.

### 4d. Stats page — `web/src/pages/Stats.jsx` (new)

Layout:

```
┌──────────────────────────────────────┐
│ DJ Stats            [All|Week|Month] │  ← period toggle
├──────────────────────────────────────┤
│ LEADERBOARD                          │
│ #1  avatar  Username  120 songs 8.5h │
│ #2  avatar  Username   95 songs 6.2h │
│ ...                                  │
├──────────────────────────────────────┤
│ AWARDS                               │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ │
│ │Night Owl│ │The Hog  │ │DJ Skip  │ │  ← responsive grid
│ │ winner  │ │ winner  │ │ winner  │ │
│ └─────────┘ └─────────┘ └─────────┘ │
└──────────────────────────────────────┘
```

Components:

- `Stats.jsx` — page container, fetches `/api/stats/leaderboard` and `/api/stats/awards`, manages period state
- `StatsLeaderboard.jsx` — ranked DJ table with avatar, username, songs, duration, variety score
- `StatsAwards.jsx` — responsive grid of award cards with emoji, name, winner, value
- `StatsPeriodToggle.jsx` — segmented button: All Time / This Week / This Month

Styling: follow existing dark theme with CSS custom properties (`--color-bg-raised`, `--color-text-primary`, `--color-accent`, etc.) and Tailwind classes matching the rest of the app.

---

## Files Changed


| File                                             | Type    | What                                                                     |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------ |
| `src/database/schema.sql`                        | Modify  | Add `events` table + indexes                                             |
| `src/database/db.js`                             | Modify  | Migration, update `addToHistory`, add `logEvent()` + stats query methods |
| `src/database/eventLogger.js`                    | **New** | Event logging helpers                                                    |
| `src/api/routes/stats.js`                        | **New** | Stats API endpoints                                                      |
| `src/api/index.js`                               | Modify  | Register `/api/stats`                                                    |
| `src/realtime/handlers.js`                       | Modify  | Add event logging to player/queue handlers                               |
| `src/api/routes/playback.js`                     | Modify  | Add event logging to REST handlers                                       |
| `src/api/routes/queue.js`                        | Modify  | Add event logging to remove/shuffle/clear                                |
| `src/state/musicManager.js`                      | Modify  | Add `_skipping` flag for skip vs natural end                             |
| `src/commands/playback.js`                       | Modify  | Add `logTrackComplete` in `trackEnd` handler                             |
| `web/src/components/icons/index.jsx`             | Modify  | Add `Trophy` icon                                                        |
| `web/src/components/layout/Sidebar.jsx`          | Modify  | Add Stats nav item                                                       |
| `web/src/pages/Dashboard.jsx`                    | Modify  | Add stats case                                                           |
| `web/src/pages/Stats.jsx`                        | **New** | Stats page                                                               |
| `web/src/components/stats/StatsLeaderboard.jsx`  | **New** | Leaderboard component                                                    |
| `web/src/components/stats/StatsAwards.jsx`       | **New** | Awards grid component                                                    |
| `web/src/components/stats/StatsPeriodToggle.jsx` | **New** | Period toggle component                                                  |


## Implementation Order

1. Database changes (schema, migration, logEvent, addToHistory update)
2. Event logger module
3. Hook event logging into handlers (socket + REST + trackEnd)
4. Stats API endpoints
5. Frontend components (icon, sidebar, dashboard routing, stats page + sub-components)

## Verification

1. Start the bot, play a few songs, skip some, shuffle, remove from queue
2. Check `events` table in SQLite: `sqlite3 data/music.db "SELECT * FROM events;"`
3. Check `history` has `requested_by_id` populated: `sqlite3 data/music.db "SELECT requested_by_id FROM history ORDER BY id DESC LIMIT 5;"`
4. Hit API endpoints: `curl localhost:3000/api/stats/leaderboard` and `curl localhost:3000/api/stats/awards?period=week`
5. Open web dashboard, click "DJ Stats" in sidebar, verify leaderboard renders with existing history data
6. Verify period toggle filters results correctly
7. Verify awards show "no data yet" gracefully for event-based awards until data accumulates

