# Quickstart: validating the AI DJ

**Feature**: [spec.md](./spec.md) | **Contracts**: [contracts/dj-api.md](./contracts/dj-api.md)

This is a run guide, not an implementation. Steps 1 and 9 run in CI. Steps 2–8 need a
live Discord guild, an ElevenLabs key, and a LiteLLM-compatible endpoint.

## Prerequisites

- Everything from the README: Discord app, `GUILD_ID`, `TZ`, yt-dlp, FFmpeg.
- An ElevenLabs API key and a voice id.
- A LiteLLM proxy (or any OpenAI-compatible endpoint) with a JSON-capable chat model.
- Two Discord accounts in the guild (A and B). A has at least 3 counted plays of one track
  ("track X") in history.

`.env` additions (see `.env.sample`):

```bash
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
DJ_LLM_BASE_URL=http://localhost:4000
DJ_LLM_MODEL=gpt-4o-mini        # any model name your proxy serves
# DJ_LLM_API_KEY=sk-...          # optional
# DJ_DAILY_LINE_CAP=150
# DJ_DAILY_THEME_TRACK_CAP=100
npm run register                 # new /dj command
npm run dev
```

## 1. Configuration gates (FR-030, FR-031): automated

- `npm test`. `test/config/env.test.js` covers three cases:
  - No DJ variables: boot validation passes.
  - Only `ELEVENLABS_API_KEY` set: one aggregated error names `ELEVENLABS_VOICE_ID`,
    `DJ_LLM_BASE_URL` and `DJ_LLM_MODEL` alongside any other missing variable.
  - A non-integer cap or a non-http base URL is rejected.
- Manually, with no DJ variables set: `GET /api/dj` returns `{ "available": false }`,
  `/dj on` replies "The DJ isn't set up…", and music plays exactly as before.

## 2. Audio path and ducking (FR-003, FR-009, SC-002a)

1. Join voice, `/play` a track, then `/dj on` and `/dj interval every:1`.
2. Let the track end naturally. **Expect**:
   - The next track starts with no extra silence.
   - Within about 2 s the DJ voice is heard over it.
   - The music is clearly lowered but audible.
   - It returns to full level within 1 s after the voice ends.
3. During a DJ line, `/pause`, then `/resume`. **Expect**: the line is gone and the music
   resumes at full level.
4. During a DJ line, `/skip`. **Expect**: the voice stops and the next track is at full
   level.
5. Check the logs for `pcm_48000` rejections. If the account tier rejects it, expect one
   `warn` and the `pcm_24000` fallback in use (R3).

## 3. Interval and content (US1, FR-002, FR-006, FR-007)

- `/dj interval every:3` and queue 6 short tracks. **Expect** exactly 2 spoken lines.
- Each line is at most 2 sentences and under 15 s, references the previous or next track,
  and isn't repeated.

## 4. Controls and parity (US2, FR-011–FR-015, SC-004)

- Toggle the DJ in Discord. **Expect** the dashboard DJ panel to flip within 2 s.
- Set the interval in the dashboard. **Expect** `/dj status` to show it.
- `PATCH /api/dj {"interval": 11}` gives 400 `INVALID_INTERVAL`, and the state is
  unchanged.
- Restart the bot. **Expect** enabled, interval and lookahead to be unchanged and the
  theme to be off.

## 5. Shout-outs (US3, FR-016–FR-020, SC-003)

- A and B in voice, interval 1, queue track X next. **Expect** a line that may name A
  together with a true count of A's plays of track X.
- A leaves voice and track X is queued again. **Expect** A is never named.
- A leaves voice in the last 30 s of the current track (after the line is prepared).
  **Expect** the line naming A is dropped (log reason `stale-member`), not spoken.
- A sets the opt-out from the dashboard, then checks `/dj shoutouts` in Discord. **Expect**
  Discord reports it off (same member id on both surfaces).
- A rejoins and runs `/dj shoutouts enabled:false`. **Expect** A is never named, while
  group lines still work.
- The bot alone in voice: no lines at all (FR-010).

## 6. Themed mode (US4, FR-021–FR-029, SC-005, SC-006)

- Empty queue: `/dj theme description:"classic rock road trip" lookahead:5`.
  - **Expect** music within 30 s and 5 upcoming DJ-attributed tracks within 60 s.
  - The first spoken line is an intro to the theme (if the DJ is on).
- As tracks finish, **expect** upcoming DJ picks to return to 5.
- B queues a song. **Expect** it to be inserted before the DJ picks and play next.
  A second request from A lands after B's.
- Queue 3 songs, then start a theme. **Expect** those 3 to play first, with 5 picks
  behind them.
- `/dj theme description:"rainy day lo-fi"`. **Expect** new picks to fit the new theme
  and old picks to stay.
- `/dj theme-stop`. **Expect** no more picks, the existing ones to stay, and new member
  songs to append.
- With themed mode on, `/shuffle` and the dashboard shuffle button. **Expect** "Shuffle is
  off while themed mode is running", no change in order, and no Shuffle Addict count.
- With themed mode on, `/clear`. **Expect** themed mode to end and no picks to reappear
  after a few seconds. Repeat with `/stop` and with the dashboard clear.
- Nonsense theme ("zzzzqqqq"): **expect** "couldn't find any tracks" and no themed state.
- DJ Stats page: picks don't appear in any member's stats.
- Leave themed mode running for 1 hour. **Expect** the upcoming queue never to empty.

## 7. Failure and caps (FR-032–FR-034, SC-008)

- Point `DJ_LLM_BASE_URL` at a dead port and restart. **Expect**:
  - Music plays uninterrupted.
  - Logs show `warn` failures.
  - After 3 failures the dashboard shows the DJ as degraded.
- Restore the endpoint. **Expect** lines to resume within about 5 minutes.
- Set `DJ_DAILY_LINE_CAP=2`. **Expect** 2 lines, then silence, and the controls to show
  "limit reached, resets at 00:00".

## 8. Voice member list freshness (R7)

- With the dashboard open, have B join and leave voice. **Expect** the listener list in
  the DJ panel to update within 2 s.

## 9. CI gates (Principle V): automated

`npm run lint && npm run format:check && npm test`, plus `cd web && npm run lint &&
npm run build`. The docker smoke test (no DJ variables) must still report
`/api/health` → `{"status":"ok"}`.
