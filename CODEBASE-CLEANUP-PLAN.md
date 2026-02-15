# Codebase Cleanup Plan

This document outlines a comprehensive, phased approach to cleaning up the Discord Music Bot codebase. The plan is organized from highest to lowest priority, with each phase building on the previous.

---

## Executive Summary

After thorough analysis of the entire codebase, we identified:

| Category | Issues Found |
|----------|--------------|
| Dead/Unused Backend Code | 15 items |
| Unused Frontend Code | 5 items |
| Redundant/Duplicate Code | 6 patterns |
| Unused Dependencies | 3 packages |
| Orphaned/Legacy Files | 8 files/directories |
| Documentation Issues | 12 items |

---

## Phase 1: Remove Legacy/Orphaned Files (High Priority)

**Goal:** Remove files that are completely unused and remnants from old starter templates.

### 1.1 Delete Legacy RPS Game Files

These files are from an old rock-paper-scissors Discord bot template and are NOT used by the current music bot:

| File | Reason |
|------|--------|
| `/workspace/discord-music-app/app.js` | Legacy Express app with RPS game |
| `/workspace/discord-music-app/commands.js` | Legacy command registration for RPS |
| `/workspace/discord-music-app/game.js` | RPS game logic |
| `/workspace/discord-music-app/utils.js` | Utilities only used by legacy files |

**Action:** Delete all 4 files.

### 1.2 Delete Examples Directory

| Directory | Reason |
|-----------|--------|
| `/workspace/discord-music-app/examples/` | Tutorial/example files not used by app |

**Contents to delete:**
- `examples/app.js`
- `examples/button.js`
- `examples/command.js`
- `examples/modal.js`
- `examples/selectMenu.js`

**Action:** Delete entire `examples/` directory.

### 1.3 Delete Development/Archived Files

| File | Reason |
|------|--------|
| `/workspace/discord-music-app/ngrok` | Binary file (~30MB) shouldn't be in repo |
| `/workspace/discord-music-app/docs/YT-DLP-MIGRATION-PLAN.md.archived` | Archived planning doc |
| `/workspace/discord-music-app/renovate.json` | Unused Renovate bot config |

**Action:** Delete files and add `ngrok` to `.gitignore`.

---

## Phase 2: Remove Unused Dependencies (High Priority)

**Goal:** Clean up package.json files to remove unused packages.

### 2.1 Root package.json

| Package | Status | Action |
|---------|--------|--------|
| `ffmpeg-static` | Redundant - also in discord-music-app/package.json | Remove from root |

**Consider:** Whether to delete `/workspace/package.json` entirely or keep for monorepo structure.

### 2.2 discord-music-app/package.json

| Package | Status | Action |
|---------|--------|--------|
| `discord-interactions` | Only used by legacy files being deleted | **REMOVE** |

### 2.3 web/package.json

| Package | Status | Action |
|---------|--------|--------|
| `@types/react` | Unused - project uses JSX not TSX | **REMOVE** |
| `@types/react-dom` | Unused - project uses JSX not TSX | **REMOVE** |

---

## Phase 3: Remove Dead Backend Code (Medium Priority)

**Goal:** Remove functions, methods, exports, and variables that are defined but never used.

### 3.1 Unused Exports

| File | Export | Line | Action |
|------|--------|------|--------|
| `src/bot/commandHandler.js` | `commandHandlers` | 36 | Remove export (keep Map) |
| `src/bot/voiceManager.js` | `connections` | 53 | Remove export (keep Map) |
| `src/realtime/socketServer.js` | `getIO()` | 108-110 | Remove function |
| `src/index.js` | `app`, `httpServer` | 78 | Remove export |

### 3.2 Unused Functions/Methods

| File | Function/Method | Lines | Action |
|------|-----------------|-------|--------|
| `src/music/youtube.js` | `getStreamWithRetry()` | 165-174 | Remove |
| `src/music/queue.js` | `addMany()` | 34-36 | Remove |
| `src/music/queue.js` | `isEmpty()` | 175-177 | Remove |
| `src/music/player.js` | `getAudioPlayer()` | 166-168 | Remove |
| `src/state/musicManager.js` | `setVoiceManager()` | 30-32 | Remove |
| `src/database/db.js` | `deleteSession(id)` | 75-78 | Remove |
| `src/database/db.js` | `cleanExpiredSessions()` | 85-88 | Remove or implement scheduled task |

### 3.3 Unused Properties/Variables

| File | Item | Line | Action |
|------|------|------|--------|
| `src/state/musicManager.js` | `this.voiceManager` | 9 | Remove |
| `src/api/middleware/auth.js` | `decoded` variable | 15, 49 | Use or remove assignment |
| `src/realtime/events.js` | `CONNECTION_STATUS` | 11 | Remove |

### 3.4 Unused Event Emission

| File | Event | Line | Action |
|------|-------|------|--------|
| `src/state/musicManager.js` | `track:end` | 21 | Remove (never listened to) |

### 3.5 Unused Imports

| File | Import | Line | Action |
|------|--------|------|--------|
| `src/bot/client.js` | `Collection` | 1 | Remove |
| `src/bot/client.js` | `client.commands` | 11 | Remove assignment |

---

## Phase 4: Remove Dead Frontend Code (Medium Priority)

**Goal:** Clean up unused React code.

### 4.1 Unused Imports

| File | Import | Action |
|------|--------|--------|
| `web/src/hooks/useSocket.js` | `useRef` | Remove from import |

### 4.2 Unused State Properties

| File | Property | Action |
|------|----------|--------|
| `web/src/hooks/useSocket.js` | `playerState.paused` | Review if needed, otherwise remove |

### 4.3 Console.log Statements

| File | Lines | Action |
|------|-------|--------|
| `web/src/hooks/useSocket.js` | 29, 34 | Remove or wrap in dev-only conditional |

---

## Phase 5: Consolidate Duplicate Code (Medium Priority)

**Goal:** Reduce code duplication by extracting shared utilities.

### 5.1 Create Voice Connection Check Helper

**Problem:** Same voice check pattern duplicated 12 times across command files.

**Files affected:**
- `src/commands/playback.js` (4 instances)
- `src/commands/queue.js` (5 instances)
- `src/commands/settings.js` (2 instances)

**Solution:** Create shared utility:

```javascript
// src/commands/utils/checks.js
import { isConnected } from '../../bot/voiceManager.js';

export async function requireVoiceConnection(interaction) {
  if (!isConnected(interaction.guildId)) {
    await interaction.reply({
      content: "I'm not in a voice channel! Use `/join` to add me first.",
      ephemeral: true
    });
    return false;
  }
  return true;
}
```

### 5.2 Create Track Query Resolver Utility

**Problem:** Track resolution logic (URL vs search vs playlist) duplicated in 3 places.

**Files affected:**
- `src/commands/playback.js`
- `src/api/routes/queue.js`
- `src/realtime/handlers.js`

**Solution:** Create shared utility:

```javascript
// src/music/trackResolver.js
export async function resolveTrackQuery(query, requestedBy) {
  if (isPlaylist(query)) {
    const tracks = await getPlaylist(query);
    return tracks.map(t => ({ ...t, requestedBy }));
  } else if (isValidUrl(query)) {
    const track = await getInfo(query);
    return [{ ...track, requestedBy }];
  } else {
    const results = await search(query, 1);
    return results.map(t => ({ ...t, requestedBy }));
  }
}
```

### 5.3 Create Shared Token Validation Helper

**Problem:** JWT verification + session lookup duplicated in 3 places.

**Files affected:**
- `src/api/middleware/auth.js` (authMiddleware)
- `src/api/middleware/auth.js` (optionalAuth)
- `src/realtime/socketServer.js` (socket middleware)

**Solution:** Extract to shared helper.

### 5.4 Create Shared Time Formatting Utility (Frontend)

**Problem:** Nearly identical time formatting functions in 2 components.

**Files affected:**
- `web/src/components/NowPlaying.jsx` - `formatTime()`
- `web/src/components/QueueItem.jsx` - `formatDuration()`

**Solution:**

```javascript
// web/src/utils/formatTime.js
export function formatTime(seconds, emptyValue = '0:00') {
  if (!seconds || isNaN(seconds)) return emptyValue;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
```

---

## Phase 6: Code Quality Improvements (Lower Priority)

**Goal:** Address code quality issues that don't affect functionality but improve maintainability.

### 6.1 Frontend Error Handling

| Issue | File | Action |
|-------|------|--------|
| Missing Error Boundary | `web/src/App.jsx` | Add React Error Boundary component |
| Empty catch block | `web/src/context/AuthContext.jsx:64` | Add error logging |
| Missing useEffect dependency | `web/src/context/AuthContext.jsx` | Add `token` to deps or refactor |

### 6.2 Accessibility Improvements

| Issue | Files | Action |
|-------|-------|--------|
| Missing aria-labels on emoji buttons | `NowPlaying.jsx` | Add `aria-label` props |
| Missing label for volume slider | `VolumeSlider.jsx` | Add proper label association |
| Drag handle lacks accessible name | `QueueItem.jsx` | Add `aria-label` |

### 6.3 Potential Key Collision

| Issue | File | Action |
|-------|------|--------|
| Using `track.url` as key may collide | `Queue.jsx` | Use `${track.url}-${index}` or unique ID |

### 6.4 Consistent Export Patterns

**Issue:** Mix of default and named exports across frontend components.

**Recommendation:** Standardize on named exports throughout.

---

## Phase 7: Update Documentation (Final Phase)

**Goal:** Ensure all documentation is accurate and complete.

### 7.1 Fix Inaccurate Documentation in CLAUDE.md

| Issue | Action |
|-------|--------|
| Root directory named `discord-music-bot/` | Change to `discord-music-app/` |
| Claims `npm run dev` has hot reload | Update - it's identical to `npm start` |
| Lists non-existent `npm run start:all` | Remove reference |
| Missing env vars | Add `YT_DLP_PATH`, `YT_DLP_COOKIES` |
| Project structure incomplete | Add `bin/`, `scripts/`, `data/` directories |

### 7.2 Fix Inaccurate Documentation in README.md

| Issue | Action |
|-------|--------|
| References non-existent `npm run yt-dlp:update` | Remove or add script |
| Missing `DELETE /api/queue` endpoint | Add to API docs |
| Structure missing some directories | Update to include `bin/`, `scripts/` |

### 7.3 Add Missing Documentation

| Item | Action |
|------|--------|
| `npm run setup` script | Document in CLAUDE.md |
| `npm run postinstall` | Document what it does |
| Web frontend README | Consider adding `web/README.md` |
| Socket.io events | Consider documenting event names/payloads |

### 7.4 Remove Outdated Documentation

| File | Action |
|------|--------|
| `CLEANUP-PLAN.md` | Delete after this cleanup is complete |

---

## Implementation Order

For safest implementation, follow this order:

```
Phase 1 (Legacy Files)
    ↓
Phase 2 (Dependencies) → Run npm install after
    ↓
Phase 3 (Backend Dead Code)
    ↓
Phase 4 (Frontend Dead Code)
    ↓
Phase 5 (Consolidation) → Test thoroughly after each change
    ↓
Phase 6 (Code Quality)
    ↓
Phase 7 (Documentation) → Final step
```

---

## Testing Checklist

After each phase, verify:

- [ ] `npm install` completes without errors
- [ ] `npm run dev` starts the bot
- [ ] `cd web && npm run dev` starts the frontend
- [ ] Bot connects to Discord
- [ ] `/play <song>` works
- [ ] Web UI login works
- [ ] Queue updates in real-time
- [ ] All slash commands respond

---

## Summary Statistics

**Files to Delete:** 12
**Dependencies to Remove:** 4
**Dead Code Items:** 20+
**Duplicate Patterns to Consolidate:** 4
**Documentation Items to Fix:** 12+

**Estimated Impact:**
- Reduced codebase size by ~15-20%
- Clearer, more maintainable code
- Accurate documentation
- Faster onboarding for new contributors
