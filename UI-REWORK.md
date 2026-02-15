```markdown
# Discord Music Bot Web UI Overhaul (Spotify-Inspired)

Designer handoff document

## Goal

Redesign the current web control panel from a functional “control panel” into a Spotify-inspired music experience while keeping all existing bot capabilities intact.

The core shift is:

- From utility-first UI
- To music-first experience

This means stronger visual hierarchy, clearer states, and a more immersive playback view, without hiding functionality.

---

## Product Context

This is not a standalone streaming app. It is a collaborative music experience for a Discord server.

Users are not only controlling playback, they are:

- Adding tracks for a shared queue
- Listening together in a voice channel
- Negotiating control implicitly (who added what, what’s next)

The UI should express that multiplayer context, not just mimic Spotify.

---

## Existing Capabilities to Support

### Slash Commands (UI mapping)

| Command         | UI Equivalent                                |
| --------------- | -------------------------------------------- |
| /play <query>   | Search input + results                       |
| /pause, /resume | Play/Pause toggle                            |
| /skip           | Next button                                  |
| /stop           | Stop action (overflow menu or queue actions) |
| /queue          | Queue panel / queue page                     |
| /nowplaying     | Main Now Playing view                        |
| /volume <0-100> | Persistent volume slider                     |
| /join, /leave   | Voice channel controls                       |
| /shuffle        | Shuffle toggle                               |
| /loop <mode>    | Repeat/loop state toggle                     |
| /remove <pos>   | Remove action per queue row                  |
| /webui          | Not needed in UI (entrypoint command)        |

---

## Design Intent

### What we want the UI to feel like

- Like Spotify: calm, premium, consistent
- But clearly Discord-native: server, voice channel, multiple people contributing
- Minimal chrome: fewer borders, more spacing, soft shadows
- Strong hierarchy: album art + track title are the hero elements

### What we want to avoid

- “Admin panel” look
- Flat lists with no context
- Controls scattered across the page
- Overly prominent settings that compete with music experience

---

## Layout Overview (Desktop First)

Spotify-inspired 3-column layout:
```

| Sidebar (Nav + Session Controls) | Main Now Playing (Hero) | Queue / Context Panel |

```

Additionally:
- Sticky bottom mini-player dock for persistent control, even when switching pages/tabs

---

## Wireframe (High-Level)
```

┌────────────────────────────────────────────────────────────────────────────┐
│ Top Bar │
│ Logo Server Name Voice Channel Connected ● User Avatar │
└────────────────────────────────────────────────────────────────────────────┘

┌──────────────┬──────────────────────────────────────┬──────────────────────┐
│ Sidebar │ Now Playing View │ Queue Panel │
│ │ │ │
└──────────────┴──────────────────────────────────────┴──────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ Mini Player Dock (Sticky Bottom) │
└────────────────────────────────────────────────────────────────────────────┘

```

---

## Section Details

## 1) Top Bar (Session Context)
### Purpose
Top bar shows the environment the playback is happening inside.
This is session-level context, not song-level context.

### Contents
- Brand (Music Bot)
- Server name
- Voice channel name
- Connection status
- Logged-in user avatar/name

### Why it is placed here
Discord context belongs to the environment. Users should always know:
- Which server they are controlling
- Which voice channel is active
- If the UI is connected and live

Placing this at the top keeps it visible and prevents the player from feeling like a generic music app.

---

## 2) Left Sidebar (Navigation + Persistent Controls)
### Approx width
~220–260px fixed

### Wireframe
```

┌──────────────────────────────┐
│ 🎵 Music Bot │
│ │
│ ● Now Playing │
│ Queue │
│ History │
│ Settings │
│ │
│ ─────────────────────────── │
│ Voice Channel │
│ # Music Lounge │
│ [ Leave Channel ] │
│ │
│ ─────────────────────────── │
│ Volume │
│ [───────●──────] 62% │
│ Shuffle ☐ │
│ Loop Off / Track / Queue │
└──────────────────────────────┘

```

### Why these controls live here
These are session-level controls.
They should be accessible regardless of what view the user is in.

This reduces clutter in the central player and avoids a “button grid” feel.

---

## 3) Main Center (Now Playing View)
### Purpose
Make the music the hero.

### Key principle
Album art + title are the primary focus.
Controls are secondary but immediately accessible.

### Wireframe
```

┌──────────────────────────────────────────────────────┐
│ │
│ [ LARGE ALBUM ART ] │
│ │
│ Track Title (Large Bold) │
│ Artist Name │
│ Requested by: Avatar + Username │
│ │
│ 1:21 ────────────────●────────────── 3:50 │
│ │
│ ⟲ ⏮ ▶ / ⏸ ⏭ ⟲ │
│ │
└──────────────────────────────────────────────────────┘

```

### Why this structure
Spotify works because it is calm:
- One clear focus area
- Predictable control placement
- Plenty of breathing room

Users should understand state at a glance:
- What is playing
- Progress
- What’s next (right panel)

---

## 4) Right Panel (Queue + Social Context)
### Approx width
~300–360px

### Purpose
Queue is collaborative, so it should show social metadata.
This panel is where the “Discord-ness” is most visible.

### Wireframe
```

┌────────────────────────────────┐
│ Up Next (19) [Shuffle] │
│ │
│ ───────────────────────────── │
│ ▶ Track Title - Artist 4:19 │
│ Added by @kalle │
│ [drag] [remove] │
│ │
│ Track Title - Artist 3:07 │
│ Added by @mads │
│ │
│ ... scroll ... │
└────────────────────────────────┘

```

### Why “Added by” belongs in the queue rows
This is the biggest social/UX upgrade:
- Adds ownership
- Reduces conflict (“why is this here?”)
- Encourages participation
- Makes the queue feel like a group playlist

Now Playing is universal.
Queue is personal and social.

---

## 5) Sticky Mini Player Dock (Bottom)
### Purpose
Persistent control while navigating other views (Queue, History, Settings).

### Wireframe
```

┌───────────────────────────────────────────────────────────────┐
│ [Cover] Track Name – Artist │
│ 1:21 ────────────────●────────────── 3:50 │
│ ⏮ ▶ / ⏸ ⏭ Volume Loop Shuffle │
└───────────────────────────────────────────────────────────────┘

```

### Why this is valuable
It removes the need to return to Now Playing just to control playback.
This matches Spotify’s “always available” control model.

---

## Search Experience (Play)
### Current issue
Search field feels like a single input box, not a music search.

### Target behavior
Search field with suggestion dropdown:
- Works for YouTube search terms + YouTube URLs
- Future: Spotify URLs/playlists support can feel native here

### Wireframe
```

┌──────────────────────────────────────────────┐
│ 🔍 Search or paste YouTube / Spotify URL... │
└──────────────────────────────────────────────┘

Dropdown:
┌──────────────────────────────────────────────┐
│ [Thumb] Song Title – Artist │
│ [Thumb] Song Title – Artist │
│ [Thumb] Song Title – Artist │
└──────────────────────────────────────────────┘

```

---

## Visual Style Direction
### Tone
- Premium, calm, music-first
- Minimal borders
- Soft shadows
- Rounded corners (12–16px)

### Color direction
- Deep dark background
- Slightly lighter card surfaces
- One accent color (Spotify green or product accent)

### Typography direction
- Clean, modern sans-serif (Inter style)
- Track title: bold, large
- Metadata: smaller, muted

### Why this works
The UI should not shout. Music is the content.
Calm styling increases perceived quality and reduces fatigue.

---

## Advanced Features (Placement + Rationale)

## A) Playback Wave Animation (Playing State Indicator)
### What it is
Subtle animated bars indicating playback is active.

### Why include it
The UI currently feels static. This provides:
- Instant feedback that playback is running
- Clear difference between play vs pause
- A premium touch without adding clutter

### Where it should be placed
Best:
- Overlay on album art bottom corner
Alternative:
- Next to track title

### Why not elsewhere
Playback state is track-level, not navigation-level, so it should live near the artwork or track info.

---

## B) Discord Context Card (Server + Channel + Connected Users)
### What it is
A small context section showing:
- Server name
- Voice channel name
- Connected users count (optional: avatars)

### Why include it
This is what makes it feel Discord-native.
Without it, it feels like a generic Spotify clone.

### Where it should be placed
Top bar (session-level)
Optional: expandable card in sidebar

### Why this placement
This is environment/session info, so it belongs outside the player content hierarchy.

---

## C) Multi-User Activity (Avatars next to tracks)
### What it is
Small avatars in queue items showing who added the track.

### Why include it
High impact collaborative UX:
- Social ownership
- Encourages participation
- Reduces confusion and conflict

### Where it should be placed
Inside each queue row:
- Secondary line: “Added by” plus avatar

### Why this placement
Queue is where collaboration happens.
Now Playing is universal, queue is social.

---

## D) Dark / Light Toggle
### Why include it
- Accessibility
- Personal preference
- Signals product maturity

### Where it should be placed
Settings page or bottom of sidebar.
Optionally in top bar, but not prominent.

### Why not prominent
Theme selection is personalization, not primary playback interaction.
It should not compete with music controls.

---

## Responsive Behavior Notes
### Tablet
- Sidebar collapses to icon-only
- Queue becomes a toggleable slide-out panel

### Mobile
Stacked layout:
- Top bar
- Album art
- Track info
- Controls
- Collapsible queue
- Sticky mini player

---

## Priority Recommendation (If not building everything at once)
If implementing in phases, highest impact first:
1) Multi-user activity in queue rows (Added by avatars)
2) Discord context in top bar
3) Sticky mini player dock
4) Playback wave animation
5) Theme toggle (optional)

Rationale:
The strongest differentiator is collaborative music in Discord, not general music playback.

---

## Summary of the Core Design Logic
- Session context lives at the top (server + voice channel)
- Persistent controls live in the sidebar or bottom dock (volume, loop, shuffle, leave)
- The center is for the music (artwork + title + progress)
- The right side is for collaboration (queue + who added what)
- Advanced features are placed according to what they represent:
  - Track state near artwork
  - Session state in top bar
  - Social state in queue
  - Personal preference in settings

This keeps hierarchy clean and prevents feature clutter.
```
