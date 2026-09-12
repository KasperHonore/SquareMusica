# SquareMusica Constitution

## Core Principles

### I. Single-Guild Scope (NON-NEGOTIABLE)

The bot serves exactly one Discord guild, identified by the `GUILD_ID` environment
variable. This is the accepted decision of `docs/ADR-001-guild-scope.md` (Option A,
Accepted 2026-06-28) and MUST NOT be reversed without superseding that ADR.

- `GUILD_ID` MUST be required at boot; the process MUST refuse to start without it.
- Playback state — the `player` and `queue` singletons in `src/services/playback.js`
  and the scalar state on the `musicManager` singleton — MUST remain single-instance.
  New code MUST NOT introduce per-guild partitioning of playback state.
- Web access MUST remain gated on membership of the configured guild.

Rationale: the connection layer (`voiceManager` connection, channel-cache, and
inactivity Maps) is keyed by guildId and is N-guild capable, while the playback state
it feeds is a single global cell. Two active guilds would share one player and queue,
and a command in guild B would silently repoint `musicManager.guildId`. The single
required `GUILD_ID` plus the auth gate are what keep those Maps at one key, and are
therefore load-bearing safety properties, not incidental configuration.

**Accepted decision vs. outstanding work.** The single-guild *decision* is settled and
binding. Its *remediation* is not yet done. The following ADR-001 follow-ups remain
open in the current code and are acknowledged debt, not violations to be "fixed" as a
side effect of unrelated work:

1. The `handleVoiceJoin` docstring in `transports/realtime/handlers.js` still claims it
   "Searches across all guilds the bot is in"; the code fetches only the configured guild.
2. The `musicManager.guildId || process.env.GUILD_ID` idiom is still duplicated across
   `handlers.js` (×3), `routes/playback.js`, and `routes/queue.js`; no exported
   `GUILD_ID` constant exists in `config/env.js`.
3. Discord commands (`commands/voice.js`, `commands/playback.js`) still call
   `musicManager.setGuildId(interaction.guildId)` without asserting the configured guild;
   `commands/utils/checks.js` has no such guard.
4. `setGuildId` and the mutable `musicManager.guildId` still exist (blocked on 2 and 3).
5. `db.clearHistoryByGuild` remains dead code; `clearHistory` calls `db.clearAllHistory()`.

Closing these items MUST move toward single-guild, never away from it.

### II. Layered Dependency Direction

The layout under `src/` (`config`, `core`, `events`, `integrations`, `persistence`,
`services`, `shared`, `transports`, `utils`) is a dependency ordering, not merely
folders.

- `core/` MUST NOT import from `transports/`. Transport-layer capabilities reach core
  by injection — `setGetConnection`, `setGetBotInfo`, `setGetChannelInfo`,
  `setIsConnected` — wired at startup by `playback.js` and `client.js`.
- Cross-module notification MUST use the shared bus in `src/events/bus.js`, which lives
  outside every transport precisely so `core/` and `transports/` can both depend on it
  without forming a cycle.
- Persistence MUST be reached through `persistence/db.js`; transports MUST NOT reach
  into the database for state that `musicManager` owns.

Known exception: `services/playback.js` imports `getConnection` from
`transports/discord/voiceManager.js` directly. This is the one standing violation of the
direction above; it MUST NOT be used to justify new ones.

Rationale: the injection seams and the standalone bus are the existing, deliberate
mechanism for keeping the layering acyclic. Bypassing them reintroduces the import
cycles the structure was built to avoid.

### III. Transport Parity

Discord slash commands, the HTTP REST API, and the Socket.io realtime layer are three
front-ends over one playback engine. They MUST behave consistently.

- Every transport MUST mutate playback and queue state through the `musicManager`
  mediator and the shared `player`/`queue` singletons. No transport may hold its own
  playback state.
- The play / fallback / lookahead sequence MUST go through `advanceAndPlay` in
  `services/playback.js`, which is the single source of truth for that sequence.
- A capability exposed on one transport MUST NOT silently diverge in behavior on
  another. Where a transport legitimately differs (authentication, rate limiting,
  per-user throttling, Discord-only interaction affordances), the difference MUST be in
  the transport's own concerns, not in playback or queue semantics.
- State changes MUST be broadcast so all connected surfaces converge; transports MUST
  NOT depend on clients polling for state another transport already changed.

Rationale: the same queue is visible simultaneously in Discord and in the browser.
Divergent semantics between transports surface directly to users as the two views
disagreeing about what is playing.

### IV. Fail-Fast Configuration

Required configuration MUST be validated before any module with import-time side
effects is loaded.

- `validateEnv` MUST collect ALL missing variables and throw one aggregated error, so an
  operator can fix every problem in a single pass.
- Modules that open the database, construct the Discord client, or otherwise act at
  import time MUST be loaded dynamically *after* validation, as `src/index.js` does.
  Static imports hoist above the check and MUST NOT be used for these modules.

Rationale: without this ordering a misconfiguration surfaces as an unrelated native or
connection crash instead of a clear message naming the missing variables.

### V. CI-Enforced Validation Gates

`.github/workflows/ci.yml` defines the validation contract. All four jobs MUST pass on
every pull request and every push to `master`; changes MUST NOT be merged on a red CI.

- **backend** — `npm ci`, `npm run lint` (ESLint), `npm run format:check` (Prettier).
- **test** — `npm test` (Vitest). This includes `test/import-resolution.test.js`, which
  statically walks every relative import in backend and test sources and asserts each
  target resolves on disk. It exists because the app cannot be booted in CI (native
  `better-sqlite3` binary), so a wrong path would pass `node --check` and only explode at
  runtime. It MUST NOT be weakened or skipped.
- **web** — `npm ci`, lint, `format:check`, and `npm run build` in `web/`.
- **docker** — image build, then a smoke test that boots the production Express app from
  the built image and polls `/api/health` for `{"status":"ok"}`. This proves native
  modules (`better-sqlite3`, opus, sodium) load, every route module resolves, SQLite
  initialises in `/app/data`, and the server answers.

Node 22 is the CI runtime and `package.json` pins `engines.node >= 22.12.0`; these MUST
stay aligned.

Rationale: these gates are the project's existing definition of "working." No additional
validation requirements are imposed here beyond what CI already enforces.

## Technology & Operational Constraints

- **Runtime**: Node.js >= 22.12.0, ES modules (`"type": "module"`) throughout.
- **Stack**: discord.js + `@discordjs/voice` (Discord), Express (HTTP), Socket.io
  (realtime), better-sqlite3 (persistence), React + Vite + Tailwind (`web/`).
- **External binaries**: yt-dlp and FFmpeg are runtime dependencies. `YT_DLP_PATH` is
  auto-detected (local `./bin/yt-dlp`, Docker `/app/bin/yt-dlp`, or system). yt-dlp
  breakage from upstream YouTube changes is an expected operational condition, bounded by
  `YT_DLP_MAX_CONCURRENCY`, `YT_DLP_MAX_QUEUE`, and `YT_DLP_STREAM_TIMEOUT_MS`.
- **Authentication**: Discord OAuth with JWT sessions, authorized against the configured
  guild's membership. `developerMode` bypasses login and is for local development ONLY;
  it MUST NOT be enabled in a deployed environment.
- **Deployment**: the Docker image is the deployment artifact. `TRUST_PROXY` is a hop
  count (not a boolean) and MUST be set behind a reverse proxy so rate limiting sees real
  client IPs.
- **Secrets**: `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, and `JWT_SECRET` MUST come from
  the environment and MUST NOT be committed.

## Development Workflow

- Work on `master` as the main branch; changes land via pull request, which runs the
  Principle V gates.
- Run `npm run lint`, `npm run format:check`, and `npm test` locally before pushing;
  `npm run format` applies Prettier. The root ESLint and Prettier configs deliberately
  ignore `web/`, `demo/`, `docs/`, `bin/`, and `data/` — `web/` is linted by its own job
  using the shared `prettier.config.cjs`.
- Changes to slash-command definitions require `npm run register`.
- Architecturally significant decisions — especially any that touch guild scope, the
  layer boundaries of Principle II, or transport parity — MUST be recorded as an ADR in
  `docs/`, following the `ADR-001` format (Status, Context, Decision Drivers, Options,
  Decision, Consequences). Reversing an accepted ADR requires a new ADR that supersedes it.
- New behavior that crosses transports SHOULD carry tests under `test/`, mirroring the
  existing `test/http/`, `test/transports/`, `test/services/`, and `test/music/` layout.

## Governance

This constitution supersedes other practices where they conflict. It governs how
SquareMusica is built; it does not describe features.

- **Authority**: where a principle here and an ad-hoc convention disagree, this document
  wins. Where this document and an accepted ADR disagree, that is a defect — reconcile
  them explicitly rather than following the more convenient one.
- **Amendment procedure**: amendments are proposed as a pull request that edits this file,
  states the rationale, and names the affected principles. An amendment that changes
  Principle I additionally requires a superseding ADR. Merging requires maintainer approval.
- **Versioning policy**: semantic versioning of this document.
  - MAJOR — a principle is removed or redefined in a backward-incompatible way.
  - MINOR — a principle or section is added, or guidance is materially expanded.
  - PATCH — clarification, wording, or typo fixes with no change in meaning.
- **Compliance review**: pull requests MUST be reviewed against these principles. The
  Principle V gates are automated and blocking; Principles I–IV are enforced at review.
  Any deviation MUST be justified in the PR description, and a deviation intended to
  persist MUST be recorded here or in an ADR rather than left in review comments.
- **Outstanding work**: debt acknowledged in this document (the ADR-001 follow-ups under
  Principle I, and the `services/playback.js` exception under Principle II) is permitted
  to remain. It MUST NOT be cited as precedent for new code, and closing an item MUST NOT
  require a constitution amendment.
- **Runtime guidance**: `CLAUDE.md` holds agent and tooling guidance and is subordinate to
  this constitution.

**Version**: 1.0.0 | **Ratified**: 2026-09-12 | **Last Amended**: 2026-09-12
