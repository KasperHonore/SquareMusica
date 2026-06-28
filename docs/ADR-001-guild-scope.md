# ADR-001: Single-guild vs Multi-guild Scope

- Status: Accepted
- Date: 2026-06-28
- Deciders: maintainers

## Context

The bot's runtime state is split across two layers that disagree about how many
guilds the bot serves.

**Single-guild state model (the source of truth for playback):**

- `src/services/playback.js:12-13` declares module-level `let player = null;` and
  `let queue = null;` — exactly ONE player and ONE queue for the whole process.
  `getPlayer()` and `getQueue()` lazily create those singletons; neither takes nor
  keys by a guildId.
- `src/core/musicManager.js` exports `const musicManager = new MusicManager()`,
  a singleton whose playback state is scalar: `this.player`, `this.queue`,
  `this.guildId`. `setGuildId()` is a global, last-writer-wins pointer.
- `src/index.js:8-15` requires `GUILD_ID` at boot (`validateEnv([... 'GUILD_ID' ...])`);
  the process will not start without it.
- The configured guild is treated as the implicit default everywhere via the
  `musicManager.guildId || process.env.GUILD_ID` idiom: `musicManager.js`,
  `transports/realtime/handlers.js`, `transports/http/routes/queue.js`,
  `transports/http/routes/playback.js`.
- `src/transports/http/routes/auth.js` gates web login on membership of the one
  `process.env.GUILD_ID` — only members of that single guild can use the UI at all.
- `musicManager.clearHistory(guildId)` ignores its `guildId` argument and calls
  `db.clearAllHistory()`, wiping history across every guild. A guild-scoped
  `db.clearHistoryByGuild(guildId)` exists but is never called — dead code that hints
  at an abandoned multi-guild intent.

**Multi-guild-looking seams (connection layer only):**

- `src/transports/discord/voiceManager.js` keeps `connections` (and `channelCache`)
  Maps keyed by guildId; likewise the inactivity `timers` Map. These genuinely
  support N concurrent guilds.
- Discord slash commands key off `interaction.guildId` and blindly repoint global
  state (`musicManager.setGuildId(interaction.guildId)` in `commands/voice.js`,
  `commands/playback.js`).
- `transports/realtime/handlers.js` carries a stale docstring claiming
  `handleVoiceJoin` "Searches across all guilds the bot is in," but the code below it
  fetches only the configured `GUILD_ID`. The comment is an artifact of an earlier
  cross-guild approach the code no longer implements.

**The precise inconsistency:** the connection/cache/timer layer is per-guild
(Map-keyed, N-guild capable), while the playback state it feeds — player, queue,
now-playing track, history-clear, and the "current" guildId — is a single global cell.
If the bot were active in two guilds at once, both would share one player/queue, and a
slash command in guild B would silently repoint `musicManager.guildId` at B while
guild A's connection stayed alive in the Map: a state-corruption hazard. The only
reason this never happens today is the single required `GUILD_ID` plus the auth gate,
which ensure the Maps are only ever populated with one key. The Maps are multi-guild
machinery driving single-guild state.

## Decision Drivers

- The bot requires exactly one `GUILD_ID` at boot and refuses to start otherwise —
  strong evidence of single-guild operational intent.
- Web access is already restricted to members of that one guild.
- Multi-guild correctness would require partitioning all playback state, a large,
  invasive change with no current product requirement.
- The existing per-guild Maps create a false impression of multi-guild support and a
  latent corruption risk if the bot is ever added to a second guild.

## Options

### Option A — Commit to single-guild

Treat the configured `GUILD_ID` as the single source of truth. Remove/guard the
multi-guild seams: reject commands from other guilds, fix the stale cross-guild
docstring, centralize the guildId fallback, and drop the unused per-guild history
path. Player/queue stay singletons.

### Option B — Go multi-guild

Make player and queue per-guild maps keyed by guildId; partition all mediator state
(`musicManager` becomes a registry of per-guild sessions); thread guildId through every
transport call (HTTP routes, socket handlers, Discord commands); scope history,
resolution, and now-playing per guild; relax the boot-time single-`GUILD_ID`
requirement and the auth gate. Large rewrite touching `playback.js`, `musicManager.js`,
all of `transports/`, and `persistence/db.js`.

## Decision

**Adopt Option A — commit to single-guild.** Every piece of load-bearing evidence
(required single `GUILD_ID`, single player/queue singletons, guild-restricted auth,
`clearAllHistory`) shows the system is single-guild in fact; the multi-guild seams are
unused machinery and a latent hazard, not a delivered capability. Option B is a
substantial rewrite with no stated need, and choosing A now does not foreclose B later
(the per-guild work is identical whenever it is actually wanted).

## Consequences

Positive: removes a state-corruption footgun, clarifies intent, simplifies reasoning,
deletes dead code. Negative: forecloses the bot serving multiple guilds simultaneously
until/unless Option B is implemented (acceptable given current usage).

### Follow-up task list (actionable)

1. **Fix stale cross-guild docstring** — `transports/realtime/handlers.js`
   (`handleVoiceJoin`). Reword to "joins the bot to the user's voice channel in the
   configured guild." Effort: trivial. Risk: none.
2. **Centralize the guildId source of truth** — add an exported `GUILD_ID` constant in
   `config/env.js` and replace every `musicManager.guildId || process.env.GUILD_ID`
   read (`musicManager.js`; `handlers.js`; `routes/queue.js`; `routes/playback.js`).
   Effort: medium. Risk: low (mechanical).
3. **Assert configured guild in Discord commands** — guard against
   `interaction.guildId !== GUILD_ID` (centralize in `commands/utils/checks.js`)
   instead of blindly calling `musicManager.setGuildId(interaction.guildId)`
   (`commands/voice.js`, `commands/playback.js`). Reject foreign-guild interactions.
   Effort: medium. Risk: low. Verify slash-command registration registers as
   guild-scoped commands for `GUILD_ID`.
4. **Make guildId read-only** — once (3) lands, consider removing `setGuildId`/the
   mutable `musicManager.guildId` entirely and reading the constant from (2). Effort:
   low-medium. Risk: low.
5. **Resolve history dead code** — `musicManager.clearHistory` already calls
   `db.clearAllHistory()`, which is correct for single-guild; delete the unused
   `db.clearHistoryByGuild` or document why it stays. Effort: trivial.
6. **(Optional) Simplify the connection layer** — the per-guild `connections`,
   `channelCache`, and inactivity `timers` Maps are harmless when only ever holding one
   key; collapsing them to single-value holders is optional cleanup, not required for
   correctness. Defer unless doing a broader simplification pass.
