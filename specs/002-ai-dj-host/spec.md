# Feature Specification: AI DJ Host

**Feature Branch**: `002-ai-dj-host`

**Created**: 2026-10-06

**Status**: Draft

**Input**: User description: "I have this idea that in this music app we would like to introduce a DJ and the fun thing about this DJ is that he's going to be run with ElevenLabs. He would take information from the history and from the queue and then be able to do a DJ's job. I got quite inspired by the DJ feature in Spotify to build this here. I just want to make it more context-aware so it should also look into who is in the same voice channel as the SquareMusica, because then it can start building: "Oh Kasper is in this chat. Kasper usually plays this song a lot" (so it can be a little catchy and say, "Hey Kasper, this song is for you because you played that a lot"). Or you would have the possibility of context-aware DJing. It should just be short sentences, one or two sentences, because we don't want to disturb the music too much. It should be possible to set the interval for how often and, of course, also enable and disable it. Another feature that might be added is that I would love for it to have a DJ mode where you can give it a theme. Just describe a theme and then it would handle all that, like building your playlist and making sure the music goes. Again we can set up whether it queues only 5 songs ahead or 10 songs ahead. I think it should be the same interval as the assistant uses whenever it interrupts to do its little DJ interception. And when it comes to those that are not dependent on speaking, for using large language models to generate all this, we will use a litellm compatable api"

## Clarifications

### Session 2026-10-06

- Q: Who may change DJ settings and start or stop themed mode? → A: Any guild member, the same as skip and queue today.
- Q: Should personal shout-outs be on by default with an opt-out, or off by default with an opt-in? → A: On by default; each member can opt out.
- Q: During themed mode, where do member-queued songs go? → A: They play next, ahead of the DJ's upcoming picks.
- Q: When themed mode starts while the queue already has upcoming songs, what happens to them? → A: Keep them; they play first and themed picks are added behind them, not counting toward the lookahead.
- Q: Besides speaking in voice, should each DJ line also appear as text somewhere? → A: No — voice only; lines are never shown as text on the dashboard or in Discord text channels.
- Q: Should there be a limit on how much the DJ can use the paid voice and text services? → A: Yes — an operator-set daily cap on spoken lines and themed picks; when reached, the DJ goes silent and themed mode pauses until the next day, while music keeps playing.
- Q: When themed mode picks songs, where should they come from? → A: A mix — favour fitting songs from this server's play history (especially those of present members), and fill the rest with new songs that fit the theme.
- Q: How should the DJ's voice sound relative to the music? → A: Talk over the first seconds of the next song while the music is lowered ("ducked"), like a radio host.
- Q: When a member changes the DJ interval, does the count toward the next line start over from zero? → A: Yes — changing the interval or turning the DJ on restarts the count, so the next line comes at the Nth transition after the change.
- Q: Does the very first track starting (nothing played before it) count as a transition for the DJ interval? → A: No — a transition is one track ending (or being skipped) and the next one starting; the first track after an idle or empty queue is not a transition.
- Q: Should DJ lines recap the wider session or play history ("how the session has been going")? → A: No — v1 lines draw only on the previous and next track, present members' history with them, and the theme; session recaps are out of scope.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The DJ introduces songs out loud (Priority: P1)

Members are listening in a voice channel with SquareMusica. A member turns the DJ on.
From then on, as the next song begins, the DJ talks over its opening seconds — one or two
sentences in a consistent, recognisable voice — while the music is lowered underneath it,
like a radio host. The line is about the music: what just played or what is coming up,
drawn from the current queue (and, from Story 3, the present members' history). When
the DJ finishes, the music returns to its normal volume.

**Why this priority**: This is the heart of the idea and the smallest slice that delivers
the "radio host" experience. Everything else (personal shout-outs, themed sets) builds on
the DJ being able to speak at the right moments without getting in the way of the music.

**Independent Test**: With the DJ enabled and an interval of 1, queue three tracks and let
them play. A spoken line referencing the upcoming or previous track is heard at each
transition over the start of the next track with the music audibly lowered, each line is
no longer than two sentences, and the music returns to normal volume afterwards.

**Acceptance Scenarios**:

1. **Given** the DJ is enabled with an interval of every 1 track and the queue has a next
   track, **When** the current track ends, **Then** the DJ speaks one or two sentences
   that reference the next or previous track over the opening of the next track, with the
   music lowered while it speaks and restored to normal volume when it finishes.
2. **Given** the DJ is enabled with an interval of every 3 tracks, **When** seven tracks
   play back to back (six transitions), **Then** the DJ speaks at exactly two transitions.
3. **Given** the DJ is disabled, **When** tracks play, **Then** the DJ never speaks.
4. **Given** the DJ cannot produce a line in time (for example, the voice or text service
   is slow or unavailable), **When** a DJ transition is due, **Then** the next track starts
   on time at normal volume and the line for that transition is dropped (FR-008).
5. **Given** a member skips the current track while the DJ is speaking, **When** the skip
   is received, **Then** the DJ stops talking and the next track plays at normal volume.

---

### User Story 2 - Members control the DJ (Priority: P1)

Any member of the server can turn the DJ on or off and change how often it speaks, from
Discord or from the web dashboard. Everyone sees the same current setting on every
surface, and the setting survives a bot restart.

**Why this priority**: The user explicitly asked for enable/disable and an adjustable
interval. Without controls the DJ is either always on — which some sessions will not want
— or never usable. It ships alongside Story 1.

**Independent Test**: Enable the DJ from Discord, confirm the dashboard shows it enabled;
change the interval on the dashboard, confirm Discord reports the new interval; restart
the bot and confirm both values are unchanged.

**Acceptance Scenarios**:

1. **Given** the DJ is off, **When** a member enables it from either Discord or the
   dashboard, **Then** the DJ is on and every open surface shows it as on without refresh.
2. **Given** the DJ is on, **When** a member sets the interval to "every 4 tracks", **Then**
   the next DJ line is spoken at the fourth transition after the change.
3. **Given** a member enters an interval outside the allowed range (FR-012), **When** they
   submit it, **Then** the change is rejected with a message stating the allowed range and
   the previous interval stays in effect.
4. **Given** the DJ is enabled with a custom interval, **When** the bot restarts, **Then**
   the DJ is still enabled with the same interval.

---

### User Story 3 - The DJ gives personal shout-outs to people in the room (Priority: P2)

The DJ notices who is in the voice channel with the bot. When it speaks, it can address a
present member by name and connect the music to their listening habits — "Hey Kasper, this
one's for you, you've played it more than anyone" — or to the group as a whole ("Three of
you have queued this artist this week"). It only ever talks about people who are actually
in the channel at that moment.

**Why this priority**: This is what makes the DJ distinct from a generic radio host and is
the context-awareness the user asked for. It depends on Story 1 already working and adds
personalisation on top.

**Independent Test**: With two members present, one of whom has played the upcoming track
at least 3 times in their history, let the DJ speak before that track. The line names that
member and references their history with the track. Have that member leave the channel and
repeat: the line no longer names them.

**Acceptance Scenarios**:

1. **Given** member A is in the voice channel and has played the upcoming track 3 or more
   times, **When** the DJ speaks before that track, **Then** the DJ MAY address member A
   by name and reference that history, and every claim it makes is true per the history.
2. **Given** member B has left the voice channel, **When** the DJ next speaks, **Then** it
   does not mention member B by name.
3. **Given** a member has opted out of personal shout-outs, **When** the DJ speaks while
   that member is present, **Then** the DJ does not name them or reference their history.
4. **Given** nobody present has relevant history with the upcoming track, **When** the DJ
   speaks, **Then** it falls back to a general music line rather than inventing a
   connection.

---

### User Story 4 - Themed DJ mode builds and keeps the set going (Priority: P3)

A member describes a theme in free text — "90s eurodance for a Friday night", "rainy-day
lo-fi", "songs from movies" — and starts themed DJ mode. The DJ fills the queue with
tracks that fit the theme and keeps it topped up so there are always a chosen number of
upcoming tracks (for example 5 or 10). It introduces the set when it starts and keeps
speaking at the same interval as normal DJ commentary, tying its lines to the theme.
Members can still queue their own songs, and can stop themed mode at any time.

**Why this priority**: The user framed this as "another feature that might be added." It
is the largest slice, depends on Stories 1 and 2, and the core DJ is valuable without it.

**Independent Test**: Start themed mode with "classic rock road trip" and a lookahead of 5
on an empty queue. Within the time in SC-005, at least 5 theme-fitting tracks are queued
and playing begins; as tracks finish, the number of upcoming tracks returns to 5. Stop
themed mode: no further tracks are added, already queued tracks remain.

**Acceptance Scenarios**:

1. **Given** themed mode is off and the queue is empty, **When** a member starts themed
   mode with a theme and lookahead of 10, **Then** the DJ queues 10 tracks matching the
   theme, playback starts, and the DJ speaks a one-or-two-sentence intro to the set.
2. **Given** themed mode is on with lookahead 5, **When** a track finishes and fewer than 5
   upcoming tracks remain, **Then** the DJ adds tracks until 5 are upcoming again.
3. **Given** themed mode is on, **When** a member queues their own song, **Then** that song
   is placed ahead of the DJ's upcoming picks and plays next (after any earlier member
   requests); themed mode does not remove it.
4. **Given** themed mode is on, **When** a member stops it, **Then** no further tracks are
   added automatically, already-queued tracks remain, and DJ commentary continues only if
   the DJ itself is still enabled.
5. **Given** a theme for which the DJ cannot find any playable tracks, **When** a member
   starts themed mode, **Then** the member is told no tracks could be found for that theme
   and themed mode does not start.
6. **Given** the queue already has 3 upcoming member-queued tracks, **When** a member
   starts themed mode with lookahead 5, **Then** those 3 tracks stay in place and play
   first, and 5 themed picks are queued behind them.
7. **Given** themed mode is on, **When** a member changes the theme, **Then** tracks added
   from that point fit the new theme and previously queued themed tracks are left in place.

---

### Edge Cases

- **Bot alone in the channel**: when no members are present, the DJ stays silent (there
  is no one to talk to) and themed mode stops topping up the queue until someone returns.
- **Very short tracks or rapid skipping**: if members skip several tracks quickly, the DJ
  MUST NOT queue up a backlog of lines; at most one line is spoken per transition and a
  stale line (about a track that is no longer next) is discarded.
- **Queue empty after the current track**: there is no next track to talk over, so the
  DJ stays silent; it MUST NOT invent an upcoming track.
- **Loop mode**: when a track or the queue is looping, loop replays count as transitions
  for the interval, but the DJ MUST NOT repeat the same line it spoke on the previous
  replay of the same track.
- **Pause**: if playback is paused during a DJ line, the line stops and is not resumed,
  and the music is at normal volume when playback resumes; the DJ does not speak while
  paused.
- **Volume changes during a line**: not applicable in v1, because the bot has no volume
  control (research R1). If a volume control is added later, the new volume applies
  during a line, the music stays lowered relative to it until the line ends, and then
  returns to the new volume (follow-up recorded in ADR-002).
- **Short next track**: if the next track is shorter than the line, the line is cut off
  when that track ends rather than carrying over into the following track.
- **Bot leaves or is disconnected from voice**: themed mode stops topping up; the DJ
  setting itself (on/off, interval) is retained.
- **Service outage**: if the voice or text-generation service fails repeatedly, the DJ
  keeps the music playing silently, records the failure in logs, and resumes speaking
  automatically once the service recovers. Themed mode reports that it cannot add tracks
  rather than silently letting the queue run out.
- **Inappropriate theme or generated text**: themes and generated lines are subject to the
  same content limits as the rest of the server; the DJ MUST NOT speak slurs, harassment,
  or private information beyond the listening history described in FR-016.
- **Daily cap reached mid-session**: handled per FR-033–FR-034; already-queued tracks
  keep playing.
- **Member display names**: names that are unpronounceable, emoji-only, or very long are
  shortened or skipped rather than read out awkwardly.
- **DJ not configured**: if the operator has not configured the voice and text services,
  the DJ controls clearly report that the DJ is unavailable; music playback is unaffected.

## Requirements *(mandatory)*

### Functional Requirements

**DJ commentary**

- **FR-001**: The system MUST provide a DJ that, when enabled, speaks a short spoken line
  in the voice channel at track transitions, using a single consistent synthetic voice.
- **FR-001a**: DJ lines MUST be delivered as speech only. They MUST NOT be posted to a
  Discord text channel or displayed on the dashboard. (Settings and themed-mode state are
  still shown per FR-015.)
- **FR-002**: Each DJ line MUST be at most two sentences and MUST NOT exceed 15 seconds of
  speech; a generated line that would exceed this MUST be shortened or discarded.
- **FR-003**: DJ lines MUST be spoken over the opening of the next track, starting within
  the first 2 seconds of that track. While the DJ speaks, the music MUST be lowered so the
  voice is clearly intelligible but the music is still audible, and MUST return to the
  normal volume within 1 second of the line ending. The DJ MUST NOT speak at any other
  point in a track.
- **FR-004**: The content of a DJ line MUST be based only on this context: the track
  that just ended, the next track in the queue, the members present in the voice channel
  and their history with those tracks or that artist (FR-016–FR-018), and (when active)
  the theme. Lines MUST NOT summarise or recap the wider session or server history (for
  example "you've played eight rock songs tonight").
- **FR-005**: Every factual claim a DJ line makes about a member's listening history,
  play counts, or the queue MUST be true according to the recorded data. The DJ MUST NOT
  fabricate statistics or connections.
- **FR-006**: A transition is one track ending or being skipped and the next track
  starting; the first track to start after playback was idle or the queue was empty is
  not a transition. The DJ MUST speak only at transitions selected by the interval
  (FR-011): it speaks at the Nth transition after it last spoke, where N is the interval.
  Changing the interval or turning the DJ on restarts the count, so the next line comes at
  the Nth transition after that change. The themed-mode intro (FR-028) is the only
  exception: it is spoken over the opening of the next track to start after themed mode
  starts or the theme changes, even when that start is not a transition, and it does not
  reset the interval count.
- **FR-007**: The DJ MUST avoid repeating itself: it MUST NOT speak a line identical to any
  of its previous 20 lines.
- **FR-008**: The DJ MUST NOT delay the start of the next track at all. Lines SHOULD be
  prepared while the previous track is still playing; if a line is not ready within the
  window in FR-003, the track plays at normal volume and the line for that transition is
  dropped.
- **FR-009**: A skip, stop, pause, or queue clear issued while the DJ is speaking MUST
  interrupt the line immediately, restore the music to normal volume, and take effect as
  it would without the DJ.
- **FR-010**: The DJ MUST NOT speak when no member other than the bot is in the voice
  channel.

**Controls and settings**

- **FR-011**: Members MUST be able to enable and disable the DJ and set its interval, from
  both Discord and the web dashboard, with identical behavior on both.
- **FR-012**: The interval MUST be expressed as "speak every N tracks", with N a whole
  number from 1 to 10 inclusive; the default is 3. Values outside the range MUST be
  rejected with a message stating the allowed range.
- **FR-013**: The DJ MUST be disabled by default.
- **FR-014**: The DJ on/off state, interval, themed-mode lookahead, and per-member opt-out
  choices MUST persist across bot restarts. The active theme and whether themed mode is
  running are NOT required to persist; after a restart themed mode is off.
- **FR-015**: Any change to DJ settings or themed-mode state MUST be broadcast so every
  open surface reflects it without a manual refresh.
- **FR-015a**: Any member of the configured guild who may use the other playback
  controls MAY change DJ settings and start, stop, or change themed mode. No additional
  role or ownership check applies.

**Personal shout-outs**

- **FR-016**: The DJ MAY address members present in the voice channel by their server
  display name and MAY reference their listening history in this server (tracks they have
  queued, how often, and when). It MUST NOT reference any other personal information.
- **FR-017**: The DJ MUST only name or reference members who are in the voice channel at
  the moment the line is prepared.
- **FR-018**: A claim that a member "plays a track a lot" or similar MUST be backed by at
  least 3 qualifying plays, consistent with the 3-play floor used by DJ Stats awards.
  Loop replays MUST NOT count toward this, consistent with DJ Stats.
- **FR-019**: Personal shout-outs MUST be on by default for every member. Each member
  MUST be able to opt out (and later opt back in) for themselves, from Discord or the
  dashboard.
- **FR-020**: When a present member has opted out, the DJ MUST NOT name them or reference
  their history, but MAY still talk about the music and the group in general terms that do
  not identify them.

**Themed DJ mode**

- **FR-021**: Members MUST be able to start themed mode by giving a free-text theme of up
  to 200 characters, and to stop it or change the theme at any time.
- **FR-021a**: Starting themed mode MUST NOT remove upcoming tracks already in the queue.
  Those tracks play first, in their existing order, and themed picks are added behind
  them. Like member requests (FR-024), they do not count toward the lookahead.
- **FR-021b**: Themed picks MUST be a mix of (a) songs from this server's play history
  that fit the theme, preferring songs played by members currently in the voice channel
  (excluding members who opted out per FR-019), and (b) songs not in the history that fit
  the theme. When enough fitting history songs exist, roughly half of each batch of picks
  SHOULD come from history; when none fit, all picks are new songs.
- **FR-022**: While themed mode is on, the system MUST keep the number of upcoming
  DJ-added tracks in the queue at least equal to the lookahead, adding theme-fitting
  tracks whenever it falls below. Member-queued tracks are not counted (FR-021a, FR-024).
- **FR-023**: The lookahead MUST be selectable from 5 or 10 upcoming tracks; the default is
  5.
- **FR-024**: Tracks queued by members while themed mode is on MUST be kept and MUST be
  placed ahead of the DJ's upcoming picks, so they play before any not-yet-played
  DJ-added track. Multiple member requests keep the order in which they were queued.
  Member-queued tracks do not count toward the lookahead (FR-022).
- **FR-025**: Themed mode MUST NOT add a track that has already played or been queued
  during the current themed session, unless no other fitting tracks can be found.
- **FR-026**: Every track themed mode adds MUST be playable through the same search and
  playback path as a member-queued track; tracks that cannot be resolved MUST be skipped
  and replaced rather than left in the queue.
- **FR-027**: Tracks added by themed mode MUST be attributed to the DJ, not to a member,
  wherever "who queued this" is shown, and MUST be excluded from member stats on the DJ
  Stats page.
- **FR-028**: Themed mode MUST speak a one-or-two-sentence intro when it starts or the
  theme changes (if the DJ is enabled), timed by the intro exception in FR-006, and
  otherwise use the same interval as DJ commentary (FR-012). Themed mode MUST work even when DJ commentary is disabled: it then
  builds the queue silently.
- **FR-029**: If themed mode cannot find any playable tracks for a theme, it MUST NOT start
  and MUST tell the member why. If it later cannot add tracks (service outage, exhausted
  theme), it MUST tell members on the surface where themed mode was started.

**Configuration and availability**

- **FR-030**: The DJ MUST be an optional capability: the music service MUST start and work
  normally when the DJ's voice and text services are not configured, and DJ controls MUST
  then report the DJ as unavailable.
- **FR-031**: If the DJ's configuration is partially provided (some but not all required
  values), the system MUST refuse to start and report every missing value in one message.
- **FR-032**: Failures to prepare or speak a DJ line MUST be logged and MUST NOT interrupt
  or stop music playback.
- **FR-033**: The operator MUST be able to set a daily cap on the number of DJ lines
  spoken and a daily cap on the number of tracks themed mode adds. Days are counted in
  the server's configured timezone (the same one DJ Stats uses).
- **FR-034**: When the daily line cap is reached, the DJ MUST stop speaking until the next
  day; when the themed-track cap is reached, themed mode MUST stop adding tracks until the
  next day and tell members why (per FR-029). Music playback MUST continue in both cases,
  and DJ controls MUST show that the cap has been reached and when it resets.

### Key Entities

- **DJ Settings**: the single server-wide DJ configuration — enabled or not, interval (N
  tracks), themed-mode lookahead (5 or 10). One instance for the server.
- **Themed Session**: an active themed DJ run — the theme text, who started it, when, and
  the tracks it has added so far (used to avoid repeats). At most one at a time; not
  retained after it ends or the bot restarts.
- **Daily DJ Usage**: per-day counts of lines spoken and themed tracks added, compared
  against the operator's caps; resets each day.
- **DJ Line**: one spoken commentary — the text, the transition it was for, the members it
  referenced, and when it was spoken. Recent lines are kept to prevent repetition.
- **Shout-out Preference**: a member's choice about being named and having their history
  referenced by the DJ.
- **Listening Context**: the snapshot the DJ draws on for a line — previous and next
  track, present members and their history with those tracks or that artist, active
  theme. Derived from
  existing play history and queue; not stored separately.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With the DJ enabled, 100% of spoken lines are two sentences or fewer and no
  longer than 15 seconds.
- **SC-002**: The DJ never delays a track starting, and music is never left lowered after
  a line ends or is interrupted; in normal operation, at least 90% of due DJ lines are
  actually spoken.
- **SC-002a**: In a listening test, members can understand every DJ line over the lowered
  music and still hear the music underneath it.
- **SC-003**: 100% of claims about a member's listening history in DJ lines are verifiable
  against the recorded history, and no line names a member who was not in the voice
  channel or has opted out.
- **SC-004**: A change to DJ settings made on one surface is visible on every other open
  surface within 2 seconds.
- **SC-005**: Starting themed mode on an empty queue results in music playing within 30
  seconds and the queue reaching the chosen lookahead within 60 seconds.
- **SC-006**: During a 1-hour themed session the queue never runs out of upcoming tracks
  while the voice and text services are available.
- **SC-007**: In an informal listening session, members rate DJ lines as fitting the
  music or theme for at least 4 out of 5 lines.
- **SC-008**: When the voice or text services are unavailable, music playback continues
  with zero interruptions attributable to the DJ.

## Assumptions

- **Voice and text services**: per the user, the spoken voice is produced by ElevenLabs,
  and the text of DJ lines and theme-based track selection come from a large language
  model reached through a LiteLLM-compatible API. These are external dependencies the
  operator configures; their cost and rate limits are the operator's concern.
- **Interval unit**: "how often" is interpreted as "every N tracks" rather than minutes,
  because DJ lines are only spoken between tracks. The user's request that themed mode
  "use the same interval as the assistant" is satisfied by sharing the single DJ interval.
- **Spoken placement**: the DJ talks over the opening of the next track with the music
  lowered ("ducked"), as a radio host does. This requires mixing the DJ voice with the
  music into the bot's single audio output, which the bot does not do today; the plan
  must account for that. The exact lowered level is a tuning decision, bounded by
  FR-003 and SC-002a.
- **Language**: DJ lines are in English in v1.
- **Single DJ, single server**: there is exactly one DJ with one set of settings, matching
  the project's single-guild scope; one themed session at a time.
- **Data source**: listening history comes from the existing play history and DJ Stats
  data (including the 3-play floor and loop-replay exclusion from feature 001). No new
  tracking of members is introduced beyond who is currently in the voice channel.
- **Track sourcing**: themed mode finds new tracks through the existing search used when
  members queue songs, and draws familiar tracks from the existing play history; it does
  not need a new music catalogue. The "roughly half" history share in FR-021b is a target,
  not an exact ratio.
- **Out of scope for v1**: choosing among multiple DJ voices or personalities, DJ
  responding to spoken requests from members, scheduling themed sessions, saving a
  themed session as a playlist (a possible follow-up), and session-recap lines that
  summarise what has played so far (FR-004).
