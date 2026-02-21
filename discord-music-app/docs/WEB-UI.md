# Web UI Documentation

A comprehensive guide to the Discord Music Bot web interface, its design system, and component architecture.

---

## Table of Contents

1. [Overview](#overview)
2. [Design System](#design-system)
3. [Typography](#typography)
4. [Color Palette](#color-palette)
5. [Components](#components)
6. [Animations](#animations)
7. [Accessibility](#accessibility)
8. [File Structure](#file-structure)

---

## Overview

The web UI provides a browser-based control panel for the Discord Music Bot. Built with React and Vite, it features a Spotify-inspired dark theme with real-time updates via Socket.io.

**Key Features:**
- Real-time playback control and queue management
- Discord OAuth authentication
- Responsive design (desktop + mobile)
- Dark/light theme support
- WCAG AA accessibility compliance
- **Single-control-surface architecture** (all playback controls in bottom dock)

**Tech Stack:**
- React 18 with hooks
- Vite for development/build
- Tailwind CSS with custom design tokens
- Socket.io for real-time updates

### Architecture Principles

Following the Spotify-inspired single-control-surface model:

1. **Bottom Dock = Only Playback Control Surface**
   - All playback controls (play/pause, skip, shuffle, loop, progress) live exclusively in the MiniPlayer
   - No duplicate controls anywhere else in the UI

2. **Center Area = Informational & Immersive**
   - Large album artwork (hero element)
   - Track title and artist
   - Requested by information
   - No interactive playback controls

3. **Top Bar = Global Navigation**
   - Integrated search bar
   - Server/channel connection status
   - User info and logout

4. **Sidebar = Navigation Only**
   - View navigation (Now Playing, Queue, History, Settings)
   - Voice channel info and leave button
   - No loop controls (moved to bottom dock)

---

## Design System

The design system is built on CSS custom properties (variables) for consistent theming and easy customization.

### Design Tokens

All design tokens are defined in `web/src/index.css` and extended in `web/tailwind.config.js`.

```css
/* Core structure */
:root {
  /* Backgrounds */
  --color-bg: #121212;
  --color-bg-raised: #181818;
  --color-bg-elevated: #282828;
  --color-bg-overlay: rgba(0, 0, 0, 0.7);

  /* Text */
  --color-text-primary: #ffffff;
  --color-text-secondary: #b3b3b3;
  --color-text-muted: #6b7280;

  /* Accent (Spotify Green) */
  --color-accent: #1DB954;
  --color-accent-hover: #1ed760;
  --color-accent-muted: rgba(29, 185, 84, 0.2);

  /* Borders */
  --color-border: rgba(255, 255, 255, 0.1);
  --color-border-strong: rgba(255, 255, 255, 0.2);
}
```

### Elevation System

Background colors create visual depth through layering:

| Level | Variable | Color | Usage |
|-------|----------|-------|-------|
| Base | `--color-bg` | `#121212` | Page background |
| Raised | `--color-bg-raised` | `#181818` | Cards, sidebar |
| Elevated | `--color-bg-elevated` | `#282828` | Dropdowns, modals |
| Overlay | `--color-bg-overlay` | `rgba(0,0,0,0.7)` | Modal backdrops |

---

## Typography

### Font Stack

| Purpose | Font | Variable |
|---------|------|----------|
| Headings | Plus Jakarta Sans | `--font-heading` |
| Body | DM Sans | `--font-body` |
| Monospace | JetBrains Mono | `--font-mono` |

### Font Weights

```css
--font-weight-normal: 400;    /* Body text */
--font-weight-medium: 500;    /* Subtle emphasis */
--font-weight-semibold: 600;  /* H3-H6, buttons */
--font-weight-bold: 700;      /* H2, important text */
--font-weight-extrabold: 800; /* H1, hero text */
```

### Type Scale

| Class | Size | Line Height | Letter Spacing |
|-------|------|-------------|----------------|
| `text-xs` | 0.75rem | 1rem | 0.01em |
| `text-sm` | 0.875rem | 1.25rem | 0.005em |
| `text-base` | 1rem | 1.5rem | 0 |
| `text-lg` | 1.125rem | 1.75rem | -0.01em |
| `text-xl` | 1.25rem | 1.75rem | -0.015em |
| `text-2xl` | 1.5rem | 2rem | -0.02em |
| `text-3xl` | 1.875rem | 2.25rem | -0.025em |

### Text Utilities

```jsx
<h1 className="text-heading">Heading Text</h1>
<p className="text-body">Body paragraph</p>
<span className="text-label">UPPERCASE LABEL</span>
<code className="text-mono">monospace</code>
```

---

## Color Palette

### Dark Theme (Default)

| Token | Value | Usage |
|-------|-------|-------|
| `--color-accent` | `#1DB954` | Primary actions, active states |
| `--color-accent-hover` | `#1ed760` | Hover states |
| `--color-success` | `#1DB954` | Success messages |
| `--color-warning` | `#f59e0b` | Warnings |
| `--color-error` | `#ef4444` | Errors |
| `--color-info` | `#3b82f6` | Informational |

### Light Theme

Applied via `.light-theme` class on `:root`. All colors are adjusted for WCAG AA contrast compliance:

| Token | Light Value | Contrast Ratio |
|-------|-------------|----------------|
| `--color-text-primary` | `#0f172a` | 15.8:1 |
| `--color-text-secondary` | `#334155` | 8.1:1 |
| `--color-text-muted` | `#64748b` | 4.5:1 |
| `--color-accent` | `#16a34a` | 4.5:1+ |

---

## Components

### Layout Components

#### AppLayout (`components/layout/AppLayout.jsx`)
Main application shell with sidebar, content area, and queue panel.
- Responsive 3-column layout (sidebar, main, queue)
- Handles mobile/tablet slide-out panels

#### Sidebar (`components/layout/Sidebar.jsx`)
Navigation sidebar (navigation only, no playback controls).

**Features:**
- View navigation with active state indicator
- Voice channel status display
- Leave channel button
- No loop controls (moved to MiniPlayer)

#### TopBar (`components/layout/TopBar.jsx`)
Header with integrated search, server info, and user controls.

**Features:**
- Integrated search bar with live suggestions
- Connection status indicator
- Server/channel info display
- User avatar and logout

#### MiniPlayer (`components/layout/MiniPlayer.jsx`)
**The ONLY playback control surface** - Fixed bottom dock with all controls.

**Features:**
- Full-width interactive progress bar with seek
- Play/Pause, Skip Previous, Skip Next
- Shuffle and Loop toggle buttons
- Dynamic album art color extraction for theming
- Glassmorphism effect with backdrop blur
- Waveform visualization when playing
- Time display (current / total)
- Responsive design (controls adapt for mobile)

```jsx
// All playback controls consolidated here
<MiniPlayer
  currentTrack={track}
  playerState={playerState}
  onControl={playerControl}
/>
```

---

### Playback Components

#### NowPlaying (`components/NowPlaying.jsx`)
Immersive now-playing view with large album art. **Informational only - no playback controls.**

**Features:**
- Extra-large album art (420px on desktop, 340px on mobile) - 30-40% larger than before
- Ambient color glow extracted from thumbnail
- Vinyl record effect on hover
- Playback indicator overlay when playing
- Track title and artist display
- "Requested by" pill with user avatar
- Subtle floating animation when playing

**Empty State:**
- Animated floating music notes
- Pulsing accent rings
- Large placeholder artwork
- Engaging copy: "Ready when you are..."

**Note:** All playback controls (play/pause, skip, progress, shuffle, loop) have been moved to the MiniPlayer (bottom dock) following the single-control-surface architecture.

#### PlaybackIndicator (`components/PlaybackIndicator.jsx`)
Animated equalizer bars showing playback status.

```jsx
<PlaybackIndicator
  isPlaying={true}
  size="md"        // sm | md | lg | xl
  showGlow={true}
  glowColor="#1DB954"
/>
```

### Queue Components

#### Queue (`components/Queue.jsx`)
Queue list container with drag-and-drop reordering.

**Features:**
- Drag overlay for smooth drag ghost
- Empty state with animated vinyl record
- Shuffle button with accent hover

#### QueueItem (`components/QueueItem.jsx`)
Individual queue track item.

**Features:**
- Staggered fade-in animation (50ms delay per item)
- Slide-out animation on removal
- Hover lift effect with shadow
- "Up Next" styling with gradient border and badge
- Grip texture drag handle
- Alternating row backgrounds
- Drop zone indicator

```css
/* Stagger animation */
style={{ '--animation-delay': `${index * 50}ms` }}
className="animate-queue-item-in"
```

---

### Search Components

#### Integrated Search (in TopBar)
Search is now integrated directly into the TopBar component for a cleaner layout.

**Features:**
- Centered in top bar between connection status and user info
- Magnifying glass icon with animated focus state
- Live suggestions from API (debounced 300ms)
- Track thumbnails with duration badges
- Keyboard navigation (arrows, enter, escape)
- ARIA combobox pattern for accessibility
- URL detection (skips suggestions for direct URLs)
- Add button for quick submission

**Note:** The standalone SearchBar component (`components/SearchBar.jsx`) still exists but the primary search experience is now in the TopBar.

---

### Page Components

#### Login (`pages/Login.jsx`)
Authentication page with dramatic visuals.

**Features:**
- Animated mesh gradient background
- Floating music notes and vinyl decorations
- Staggered entrance animations
- Discord OAuth button with hover glow
- Glass card effect

#### History (`pages/History.jsx`)
Play history view.

**Empty State:**
- Animated spinning vinyl record
- Floating music notes
- Pulsing gradient orbs
- Timeline dots animation
- Personality-driven copy

---

## Animations

### Built-in Animations

| Class | Duration | Effect |
|-------|----------|--------|
| `animate-slide-in` | 0.3s | Slide from right |
| `animate-fade-in` | 0.2s | Fade in |
| `animate-scale-in` | 0.2s | Scale + fade |
| `animate-wave` | 1s | Equalizer wave |
| `animate-pulse-glow` | 2s | Pulsing glow |
| `animate-gradient` | 8s | Gradient shift |
| `animate-queue-item-in` | 0.3s | Queue item enter |
| `animate-queue-item-out` | 0.25s | Queue item exit |

### Stagger Delays

```jsx
// Use CSS variable for stagger timing
style={{ '--animation-delay': `${index * 50}ms` }}

// Or utility classes
className="delay-100 delay-200 delay-300"
```

### Transition Utilities

```css
.transition-smooth    /* cubic-bezier(0.4, 0, 0.2, 1) */
.transition-bounce    /* cubic-bezier(0.68, -0.55, 0.265, 1.55) */
```

### Reduced Motion

Animations respect `prefers-reduced-motion`:

```css
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Accessibility

### Focus States

All interactive elements have visible focus indicators:

```css
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.focus-ring:focus-visible {
  box-shadow: 0 0 0 4px var(--color-accent-muted);
}
```

### Touch Targets

Minimum 44x44px for all interactive elements:

```jsx
className="min-w-[44px] min-h-[44px]"
// Or utility class
className="touch-target"
```

### Skip Links

Skip navigation for keyboard users:

```jsx
<a href="#main-content" className="skip-link">
  Skip to main content
</a>
```

### Screen Reader Support

```jsx
// Hidden but accessible text
<span className="sr-only">Play track</span>

// Live regions for dynamic updates
<div aria-live="polite">Now playing: {track.title}</div>

// Proper ARIA roles
<div role="listbox" aria-label="Search suggestions">
  <div role="option" aria-selected={selected}>...</div>
</div>
```

### Keyboard Navigation

| Component | Keys | Action |
|-----------|------|--------|
| SearchBar | ↑/↓ | Navigate suggestions |
| SearchBar | Enter | Select suggestion |
| SearchBar | Escape | Close suggestions |
| NowPlaying | ←/→ | Seek 5 seconds |
| Queue | Tab | Navigate items |

---

## File Structure

```
web/
├── index.html              # Entry point, font imports
├── tailwind.config.js      # Extended theme configuration
├── src/
│   ├── index.css           # Design system, CSS variables
│   ├── App.jsx             # Root component, routing
│   ├── components/
│   │   ├── layout/
│   │   │   ├── AppLayout.jsx    # Main layout shell
│   │   │   ├── Sidebar.jsx      # Navigation only
│   │   │   ├── TopBar.jsx       # Search + user info
│   │   │   ├── MiniPlayer.jsx   # ALL playback controls
│   │   │   └── index.jsx        # Exports
│   │   ├── icons/
│   │   │   └── index.jsx
│   │   ├── NowPlaying.jsx       # Immersive display (no controls)
│   │   ├── PlaybackIndicator.jsx
│   │   ├── Queue.jsx
│   │   ├── QueueItem.jsx
│   │   └── SearchBar.jsx        # Standalone (legacy)
│   ├── pages/
│   │   ├── Dashboard.jsx        # Main dashboard
│   │   ├── Login.jsx
│   │   ├── History.jsx
│   │   └── Settings.jsx
│   ├── context/
│   │   ├── AuthContext.jsx
│   │   └── ThemeContext.jsx
│   ├── hooks/
│   │   └── useSocket.js
│   └── utils/
│       └── formatTime.js
└── dist/                   # Production build output
```

### Key Architectural Notes

- **MiniPlayer** is the single source of truth for all playback controls
- **NowPlaying** is purely informational - no interactive controls
- **TopBar** contains integrated search (not a separate component)
- **Sidebar** is navigation-only (loop moved to MiniPlayer)

---

## Utility Classes Reference

### Card Styles

```jsx
className="card-premium"  // Elevated card with shadow
className="card-glass"    // Glassmorphism effect
```

### Glow Effects

```jsx
className="glow-accent"     // Subtle accent glow
className="glow-accent-lg"  // Larger glow radius
```

### Interactive States

```jsx
className="interactive"   // Hover lift effect
className="btn-accent"    // Accent button style
```

### Background Utilities

```jsx
className="bg-surface"          // Base background
className="bg-surface-raised"   // Card background
className="bg-surface-elevated" // Dropdown background
className="bg-accent-muted"     // Subtle accent tint
```

### Text Utilities

```jsx
className="text-primary"    // Primary text color
className="text-secondary"  // Secondary text
className="text-muted"      // Muted/disabled text
className="text-accent"     // Accent color text
```

---

## Performance Considerations

1. **GPU Acceleration**: Animations use `transform` and `opacity` for 60fps
2. **Will-change**: Applied to animated elements, removed after completion
3. **Font Loading**: Non-blocking with `media="print"` pattern
4. **Reduced Motion**: Full support for users who prefer less animation
5. **Bundle Size**: ~327KB JS, ~40KB CSS (gzipped: ~99KB JS, ~8KB CSS)
