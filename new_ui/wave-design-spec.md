# wave. — Design Spec & Feature Reference

## Core Design Philosophy

The player is built around one idea: the interface should never make you think about the interface. Everything is either finding music or managing what's playing. Those are two different jobs, so they live in two different places.

**Center panel = discovery.** You come here to find something to add.
**Right panel = playback.** Everything about what's currently happening lives here and only here.

This eliminates the main structural problem with most queue-based players — showing the same list of tracks in two places with slightly different controls on each. In wave, a track appears in exactly one column at a time.

---

## Layout

Three columns, one bottom bar. Fixed widths on left and right, fluid center.

```
[ Sidebar 220px ] [ Center — fluid ] [ Now Playing 300px ]
[              Bottom Bar — full width                    ]
```

The bottom bar is the only element that spans all three columns. It exists for quick transport control without looking away from whatever you're doing in the center.

---

## Sidebar

**Purpose:** Navigation and playlist access. Persistent, never scrolls away.

### Logo
Just the wordmark. No interactions.

### Navigation
Three views — Search, Playlists, History. Clicking switches the center panel content. The active item is highlighted in gold. The search bar placeholder text updates to match the current view context.

### My Playlists
A compact list of saved playlists with a color-coded dot thumbnail and track count. Clicking a playlist opens it directly in the center panel without navigating away from whatever view you're on. Should eventually support drag-to-reorder.

### User Area
Pinned to the bottom of the sidebar. Shows Discord avatar and display name. Logout button on the right. In a production build this would reflect the authenticated Discord session.

---

## Center Panel — Discovery

The center panel has a persistent hero section at the top (greeting + search bar) and a content area below that changes per view.

### Greeting
Time-aware: Good morning / afternoon / evening. First name pulled from auth session. Serif display font — this sets the tone of the product, not just a label.

### Search Bar
The most important element in the center panel. Behavior:
- Typing replaces the current content area with search results inline (no dropdown)
- 400ms debounce before firing
- Spinner appears during the simulated/real fetch
- Results render as a scrollable list with thumbnail, title, channel, duration, and an "+ Add" button
- Pressing Escape clears the input and restores the previous view
- Each result's "+ Add" appends the track to the live queue in the right panel

The placeholder text changes per view to hint at the scope of search (YouTube search, filter playlists, filter history).

---

### Browse View (default)

Shown when no search is active and the Search nav item is selected.

A two-column card grid giving quick access to:
- Liked Songs (future feature, currently placeholder)
- Recently Played (shortcut to History view)
- All saved playlists

Cards are touch-friendly and large enough to click without precision. This view should feel like a home screen — low friction, high scannability.

---

### Playlists View

A card grid showing all saved playlists. Each card shows:
- A color-coded artwork area (color derived from playlist index, consistent across sidebar and grid)
- Playlist name
- Track count

A "New Playlist" card sits first in the grid as a persistent dashed-border tile. Clicking it opens the modal. This avoids the need for a separate button in this view.

**New Playlist Modal** collects:
- Name (required, Enter key submits)
- Spotify playlist URL (optional — for future import support)

---

### History View

A chronological list of previously played tracks, most recent first. Same row layout as search results. Clicking the "+ Add" button re-queues the track without navigating away.

History is read-only — no remove or reorder controls. It's a record, not a queue.

---

## Right Panel — Now Playing + Queue

This panel owns everything related to active playback. It never changes based on center panel navigation.

### Album Art
Full-width square. Pulls thumbnail from yt-dlp metadata. Falls back to a music note glyph placeholder if no image is available. Aspect ratio is locked — no letterboxing.

### Track Metadata
Title in serif display font, channel name in muted text below. Title truncates with ellipsis if too long — no marquee or overflow scroll.

### Progress Bar
- Animates locally every second between server polls (or in demo mode, continuously)
- Shows elapsed and total time
- A scrubber handle appears on hover (visual only in demo; real implementation would seek on click)
- Thin 3px track — visually minimal, not a dominant element

### Playback Controls
Five controls in a row:

| Control | Behavior |
|---|---|
| Loop | Toggles loop mode on/off. Highlights gold when active. |
| Previous | Disabled in demo — would go to previous track or restart current if >3s in |
| Play/Pause | Toggles playback state. Icon swaps between play triangle and pause bars. Synced with bottom bar. |
| Skip | Advances to next track in queue. Promotes the first queued track to Now Playing. |
| Stop | Halts playback entirely. Distinct from Pause — clears the active playing state. |

### Queue (Up Next)

The full queue lives here and only here. This was a deliberate structural decision — see Design Choices below.

The list is scrollable and shows every track after the current one. The currently playing track appears at the top of the list with a gold highlight and an animated EQ icon.

**Per-track controls:**
- Remove button (✕) appears on row hover — removes that position from the queue
- Clicking the track itself is reserved for future jump-to functionality

**Queue-level controls** (in the section header):
- **Shuffle** — randomises the order of upcoming tracks, current track unaffected
- **Clear** — empties the queue after a confirm prompt, current track unaffected

---

## Bottom Bar

A compact persistent transport strip spanning the full width. It duplicates the minimum controls needed to manage playback without looking at the right panel.

**Left:** Mini track thumbnail, title, and channel. Stays in sync with Now Playing.

**Center:** Previous (disabled), Play/Pause, Skip. Same logic as right panel controls — they share state. Below the controls, a 2px progress bar animates in sync.

The bottom bar exists for flow — if you're browsing in the center panel, you shouldn't have to look right to pause a track.

---

## Key Design Choices

### Why the queue only lives in one place

The original design had the queue in the center panel as a track list, and an "Up Next" section in the right panel showing the next 5-6 tracks. That meant the same data appeared twice with slightly different presentation. It created confusion about which was the canonical view and which was the preview.

The solution: the center panel is for **finding music**, the right panel is for **what's playing**. The queue belongs to the right panel because it's part of playback state, not discovery. The center panel never shows queued tracks — it shows tracks you haven't added yet.

### Why search results are inline, not a dropdown

A dropdown over the search bar forces a small result area and competes visually with whatever's below it. Rendering results inline in the content area gives full vertical space, allows more results to be visible without scrolling, and feels more like a dedicated search experience than a typeahead widget.

The tradeoff is that it replaces your current view. Pressing Escape restores it, which is a fast enough escape hatch that the tradeoff is worth it.

### Why the bottom bar has limited controls

Deliberately minimal — only Previous, Play/Pause, Skip. No loop, no stop, no shuffle. The right panel is still one glance away and has the full control set. The bottom bar is for the moment when you're mid-flow in the center and want to pause without context-switching. Adding more controls would make it compete with the right panel rather than complement it.

### Color system

One accent color (`#e8c87a`, warm gold) used sparingly: active nav state, currently playing track, progress fill, loop active state, add buttons. Everything else is neutral dark surfaces. The accent only ever means "this is selected or active" — it's never decorative.

### Typography

Instrument Serif for display elements (logo, greeting, track title, modal title). DM Sans for all UI text. The combination creates clear hierarchy without needing font weight variation to carry all the work.

---

## What's Not Here Yet

- **Seek on click** — progress bar is visual only; clicking should seek to that position
- **Drag to reorder** — queue should support drag-and-drop reordering
- **Liked Songs** — heart button per track, feeds a Liked Songs playlist
- **Spotify import** — modal accepts a Spotify URL; backend resolves and imports tracks
- **Discord voice state** — join/leave channel button was removed from the bottom bar; needs a home (possibly sidebar user area)
- **Keyboard shortcuts** — Space for play/pause, arrow keys for skip, at minimum
