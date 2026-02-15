# Discord Music Bot – UI Consolidation Update

Transition to Single-Control-Surface Architecture (Spotify Model)

## Purpose of This Document

This document describes the required changes to the current implementation in order to remove duplication, fix hierarchy issues, and fully commit to a Spotify-inspired single control surface layout.

The goal is to:

- Remove duplicated playback controls
- Reduce visual noise
- Eliminate unnecessary empty space
- Strengthen visual hierarchy
- Make the bottom dock the only operational control area

This document references the current implemented design and clearly outlines what must change and why.

---

# 1. Core Architectural Decision

We are committing to:

> Bottom Dock = Only Playback Control Surface

The center area becomes informational and immersive.
All playback interactions move to the sticky bottom dock.

This removes control duplication and creates a clear mental model.

---

# 2. Current Problems in the Old Design

### 2.1 Playback Controls Exist Twice

Currently:

- Play / Pause exists in the center
- Play / Pause exists in the bottom dock

This creates:

- Interaction confusion
- Competing focal points
- Unnecessary UI weight

---

### 2.2 Progress Bar Exists Twice

Currently:

- Progress bar under artwork
- Progress bar in bottom dock

This creates visual redundancy and dilutes hierarchy.

---

### 2.3 Volume Exists Twice

Currently:

- Volume in sidebar
- Volume in bottom dock

Persistent system controls should live in one place only.

---

### 2.4 Excess Vertical Empty Space

The center section has:

- Large vertical padding above album art
- Search bar visually pushing content downward
- Artwork not large enough to justify the empty space

This makes the layout feel sparse and disconnected.

---

### 2.5 Search Competes With Music

The search bar currently sits above the hero area.

It feels like:

- An admin input tool
- Not integrated into the layout
- Visually heavier than it should be

Music should be the hero. Not search.

---

# 3. Required Structural Changes

---

# 3.1 Remove All Center Playback Controls

REMOVE from center:

- Play / Pause button
- Skip button
- Shuffle icon
- Loop icon
- Progress bar

The center becomes:

```

[ Large Album Art ]

Track Title
Artist Name
Requested by: Avatar + Username

```

Nothing interactive remains in the center except optional click-to-open artwork.

---

# 3.2 Bottom Dock Becomes the Only Control Surface

The bottom dock must contain:

- Track thumbnail
- Track title + artist
- Full progress bar
- Play / Pause
- Previous
- Next
- Shuffle
- Loop
- Volume slider

Example structure:

```

[Cover] Track – Artist

1:26 ────────────────●────────────── 4:26

⏮   ▶ / ⏸   ⏭      Shuffle   Loop      Volume

```

This mirrors Spotify and eliminates duplication.

---

# 3.3 Remove Volume From Sidebar

DELETE:

- Volume slider in sidebar

Volume is now controlled only in bottom dock.

Sidebar becomes navigation + session controls only.

---

# 3.4 Increase Album Artwork Size

Artwork should dominate the center.

Current issue:
Artwork feels small relative to available space.

Required change:

- Increase artwork size by 30–40%
- Reduce top spacing
- Center vertically in available space

Artwork should feel immersive, not floating.

---

# 3.5 Move Search Into Top Bar

Currently:
Search sits above the center hero area.

Change:
Move search into top bar.

New Top Bar Layout:

```

Logo | Search Field | Server Name | User Avatar

```

Search becomes part of global navigation, not the hero section.

This:

- Reduces visual clutter
- Prevents pushing artwork down
- Feels more native to app layouts

---

# 3.6 Reduce Vertical Spacing Above Artwork

Currently:
There is excessive space between top bar and album art.

Required:

- Tighten vertical padding
- Align artwork closer to visual center of viewport

The center should feel balanced, not empty.

---

# 4. Final Layout After Changes

```

┌──────────────────────────────────────────────────────────────┐
│ Top Bar: Logo | Search | Server | User                      │
└──────────────────────────────────────────────────────────────┘

┌──────────────┬──────────────────────────────┬────────────────┐
│ Sidebar      │       Now Playing (Hero)     │ Queue Panel    │
│              │                              │                │
│ Navigation   │        [ Large Artwork ]     │ Up Next        │
│ Join/Leave   │                              │ Tracks         │
│ Loop Status  │        Track Title           │ Added by ...   │
│ Shuffle      │        Requested by ...      │                │
└──────────────┴──────────────────────────────┴────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ Sticky Bottom Dock (Only Playback Controls)                 │
└──────────────────────────────────────────────────────────────┘

```

No duplicated controls.
Clear hierarchy.

---

# 5. Visual Hierarchy Rules Going Forward

1. Album art is the visual anchor.
2. Track title is the primary text.
3. Queue is secondary context.
4. Controls live only in bottom dock.
5. Navigation lives in sidebar.
6. Search lives in top bar.

No feature should break these rules.

---

# 6. Why This Improves the Experience

### 6.1 Reduces Cognitive Load

Users know exactly where playback lives.
No scanning for which play button to press.

---

### 6.2 Improves Visual Calm

Fewer buttons in the center.
More breathing room.
Clear separation of concerns.

---

### 6.3 Matches User Expectations

Spotify-trained users expect:

- Persistent bottom controls
- Artwork-focused center
- Clean navigation

We are aligning with that mental model.

---

### 6.4 Removes “Dashboard” Feel

Old layout felt like:

- A control panel
- A utility interface

New layout feels like:

- A music experience
- A shared listening environment

---

# 7. What Stays the Same

- Sidebar navigation
- Queue panel
- Server/user info
- Collaborative features

Only duplication and hierarchy are being fixed.

---

# 8. Implementation Priority Order

1. Remove center playback controls
2. Remove sidebar volume
3. Expand bottom dock controls
4. Increase artwork size
5. Move search into top bar
6. Tighten vertical spacing

Do not implement partial duplication.  
Commit fully to the single-control-surface architecture.

---

# 9. Final Principle

If a user asks:
"Where do I control playback?"

There must be exactly one answer:

> The bottom dock.

Everything else supports that.
