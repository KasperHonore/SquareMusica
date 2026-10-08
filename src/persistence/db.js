import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, existsSync } from 'fs';
import { randomUUID, createHash } from 'crypto';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The counted-play predicate: the one definition of which history rows feed the
// DJ stats page. Written against the `h` alias every stats query uses.
const COUNTED_PLAY = 'h.requested_by_id IS NOT NULL AND h.is_loop_replay = 0';

export class DatabaseManager {
  /**
   * @param {string|null} [dbPath] - Override the database file. Defaults to
   *   data/music.db. Pass ':memory:' to get a throwaway database; used by tests
   *   to exercise migrate() without touching the real file.
   */
  constructor(dbPath = null) {
    if (dbPath) {
      this.db = new Database(dbPath);
    } else {
      // Ensure data directory exists
      const dataDir = join(__dirname, '../../data');
      if (!existsSync(dataDir)) {
        mkdirSync(dataDir, { recursive: true });
      }

      this.db = new Database(join(dataDir, 'music.db'));
      this.db.pragma('journal_mode = WAL');
    }
    this.checkTimezone();
    this.init();
  }

  /**
   * Verify SQLite's 'localtime' agrees with TZ.
   *
   * Intl uses ICU data bundled into Node, while SQLite goes through libc and
   * /usr/share/zoneinfo. If the runtime lacks zoneinfo, Intl accepts the zone but
   * SQLite silently computes in UTC. One January and one July instant are
   * compared so both sides of a DST change are covered. Skipped when TZ is unset.
   */
  checkTimezone() {
    const tz = process.env.TZ;
    if (!tz) return;

    const format = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    });
    const probe = this.db.prepare("SELECT strftime('%H:%M', ?, 'localtime')").pluck();

    for (const instant of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z']) {
      const expected = format.format(new Date(instant));
      const actual = probe.get(instant.slice(0, 19).replace('T', ' '));
      if (actual !== expected) {
        throw new Error(
          `TZ="${tz}": timezone data missing from runtime. For ${instant} Intl ` +
            `gives ${expected} but SQLite 'localtime' gives ${actual}. ` +
            'Install tzdata (/usr/share/zoneinfo) in the runtime image.'
        );
      }
    }
  }

  init() {
    // Run migrations before schema to handle existing tables
    this.migrate();
    const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
    logger.info('[Database] Schema initialized successfully');
  }

  migrate() {
    // Check if history table exists first
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history'")
      .all();
    if (tables.length === 0) {
      return; // Table doesn't exist yet, schema.sql will create it with guild_id
    }

    // Add guild_id column to history table if it doesn't exist
    const tableInfo = this.db.pragma('table_info(history)');
    const hasGuildId = tableInfo.some((col) => col.name === 'guild_id');
    if (!hasGuildId) {
      this.db.exec('ALTER TABLE history ADD COLUMN guild_id TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_guild_id ON history(guild_id)');
      logger.info('[Database] Migrated: added guild_id to history table');
    }

    // Add the stats attribution columns. Existing rows keep NULL, which is the
    // launch boundary the DJ stats queries filter on — they are never counted.
    const hasRequestedById = tableInfo.some((col) => col.name === 'requested_by_id');
    if (!hasRequestedById) {
      this.db.exec('ALTER TABLE history ADD COLUMN requested_by_id TEXT');
      logger.info('[Database] Migrated: added requested_by_id to history table');
    }

    const hasRequestedByAvatar = tableInfo.some((col) => col.name === 'requested_by_avatar');
    if (!hasRequestedByAvatar) {
      this.db.exec('ALTER TABLE history ADD COLUMN requested_by_avatar TEXT');
      logger.info('[Database] Migrated: added requested_by_avatar to history table');
    }

    // Guarded on its own, not nested under requested_by_id: a database that
    // already has the two columns above must still get this one. Existing rows
    // read as 0, i.e. ordinary plays.
    const hasIsLoopReplay = tableInfo.some((col) => col.name === 'is_loop_replay');
    if (!hasIsLoopReplay) {
      this.db.exec('ALTER TABLE history ADD COLUMN is_loop_replay INTEGER NOT NULL DEFAULT 0');
      logger.info('[Database] Migrated: added is_loop_replay to history table');
    }

    // The AI DJ's group facts read the track's artist (feature 002). Old rows
    // stay NULL and never match an artist read.
    const hasArtist = tableInfo.some((col) => col.name === 'artist');
    if (!hasArtist) {
      this.db.exec('ALTER TABLE history ADD COLUMN artist TEXT');
      logger.info('[Database] Migrated: added artist to history table');
    }

    // Also declared in schema.sql, for the fresh-install path this method returns
    // early on. IF NOT EXISTS keeps both paths idempotent.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_history_requested_by_id ON history(requested_by_id)'
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_history_url ON history(url)');
  }

  // User methods
  findOrCreateUser(discordId, username, avatar) {
    const existing = this.getUserByDiscordId(discordId);
    if (existing) {
      // Update user info
      const stmt = this.db.prepare(
        'UPDATE users SET username = ?, avatar = ? WHERE discord_id = ?'
      );
      stmt.run(username, avatar, discordId);
      return this.getUserByDiscordId(discordId);
    }

    const id = randomUUID();
    const stmt = this.db.prepare(
      'INSERT INTO users (id, discord_id, username, avatar) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, discordId, username, avatar);
    return this.getUserById(id);
  }

  getUserById(id) {
    const stmt = this.db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id);
  }

  getUserByDiscordId(discordId) {
    const stmt = this.db.prepare('SELECT * FROM users WHERE discord_id = ?');
    return stmt.get(discordId);
  }

  // Session methods
  hashToken(token) {
    return createHash('sha256').update(String(token)).digest('hex');
  }

  createSession(userId, token, expiresAt) {
    const id = randomUUID();
    const tokenHash = this.hashToken(token);
    const stmt = this.db.prepare(
      'INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)'
    );
    stmt.run(id, userId, tokenHash, expiresAt.toISOString());
    return { id, userId, expiresAt };
  }

  getSessionByToken(token) {
    const tokenHash = this.hashToken(token);
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
    );
    return stmt.get(tokenHash);
  }

  deleteSessionByToken(token) {
    const tokenHash = this.hashToken(token);
    const stmt = this.db.prepare('DELETE FROM sessions WHERE token = ?');
    stmt.run(tokenHash);
  }

  // History methods
  addToHistory(track, guildId = null, { loopReplay = false } = {}) {
    try {
      if (!track?.title || !track?.url) {
        logger.warn('[Database] addToHistory: Missing required track fields', {
          title: track?.title,
          url: track?.url
        });
        return;
      }
      const stmt = this.db.prepare(
        'INSERT INTO history (guild_id, title, url, duration, thumbnail, requested_by, requested_by_id, requested_by_avatar, is_loop_replay, artist) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      stmt.run(
        guildId,
        track.title,
        track.url,
        track.duration || 0,
        track.thumbnail || null,
        track.requestedBy || 'Unknown',
        track.requestedById || null,
        track.requestedByAvatar || null,
        loopReplay ? 1 : 0,
        track.spotifyData?.artists?.[0] ?? track.channel ?? null
      );
    } catch (error) {
      logger.error('[Database] addToHistory failed:', error.message, { track: track?.title });
    }
  }

  getHistory(limit = 50, offset = 0) {
    const stmt = this.db.prepare('SELECT * FROM history ORDER BY played_at DESC LIMIT ? OFFSET ?');
    return stmt.all(limit, offset);
  }

  clearHistoryByGuild(guildId) {
    try {
      // Clear history for this guild, including old records with NULL guild_id
      const stmt = this.db.prepare('DELETE FROM history WHERE guild_id = ? OR guild_id IS NULL');
      const result = stmt.run(guildId);
      logger.info(`[Database] Cleared ${result.changes} history entries for guild ${guildId}`);
      return result.changes;
    } catch (error) {
      logger.error('[Database] clearHistoryByGuild failed:', error.message);
      return 0;
    }
  }

  clearAllHistory() {
    try {
      const stmt = this.db.prepare('DELETE FROM history');
      const result = stmt.run();
      logger.info(`[Database] Cleared all ${result.changes} history entries`);
      return result.changes;
    } catch (error) {
      logger.error('[Database] clearAllHistory failed:', error.message);
      return 0;
    }
  }

  // Counterpart to clearAllHistory(). Both are called together on guild removal:
  // clearing one without the other leaves the two tables divergent, so the stats
  // page would show behavior-award winners above an empty leaderboard.
  clearAllEvents() {
    try {
      const stmt = this.db.prepare('DELETE FROM events');
      const result = stmt.run();
      logger.info(`[Database] Cleared all ${result.changes} event entries`);
      return result.changes;
    } catch (error) {
      logger.error('[Database] clearAllEvents failed:', error.message);
      return 0;
    }
  }

  /**
   * Record one control action or natural track completion.
   *
   * Best-effort by contract (FR-025): wrapped, logged, never rethrown. Recording
   * runs inside the transport that performed the action, so a throw here would
   * break the action being recorded rather than just losing a stat.
   *
   * @param {Object} payload - As produced by shared/statsEvents.js.
   */
  logEvent(payload) {
    try {
      if (!payload?.type) {
        logger.warn('[Database] logEvent: missing event type');
        return;
      }
      const stmt = this.db.prepare(
        `INSERT INTO events (
          guild_id, event_type, actor_id, actor_name, actor_avatar,
          target_user_id, target_user_name, track_title, track_url, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      stmt.run(
        payload.guildId || null,
        payload.type,
        payload.actor?.id || null,
        payload.actor?.name || null,
        payload.actor?.avatar || null,
        payload.track?.requestedById || null,
        payload.track?.requestedBy || null,
        payload.track?.title || null,
        payload.track?.url || null,
        payload.metadata ? JSON.stringify(payload.metadata) : null
      );
    } catch (error) {
      logger.error('[Database] logEvent failed:', error.message, { type: payload?.type });
    }
  }

  // ---------------------------------------------------------------------------
  // DJ stats read models
  //
  // Every history query below counts only rows matching COUNTED_PLAY (defined
  // at the top of this file): `requested_by_id IS NOT NULL AND is_loop_replay = 0`.
  // The NULL check is the launch boundary (FR-005): rows written before this
  // feature carry no stable identity, so they are attributable only to a display
  // name that may since have changed, and are deliberately never counted. The
  // loop-replay check drops plays loop mode started automatically (FR-005a);
  // they stay in history for the History page. Interpolate the fragment rather
  // than spelling either condition out, so no query can drift from the others.
  //
  // Ordering is always `<count> DESC, MIN(played_at) ASC, <id> ASC`. The trailing
  // two keys are required, not decoration: without them SQLite may return tied
  // rows in any order, so repeated requests against unchanged data could reorder
  // the leaderboard (SC-012) and award winners could flip between loads (FR-015).
  //
  // Hour and date expressions all pass 'localtime'. played_at is stored in UTC
  // (CURRENT_TIMESTAMP), so omitting it computes awards against UTC and produces
  // plausible but wrong winners.
  // ---------------------------------------------------------------------------

  /**
   * Top DJs by track count for a period.
   *
   * Returns up to `limit + 1` rows on purpose: the caller needs to know whether
   * an (limit+1)-th DJ qualified in order to report truncation, and a result
   * capped at exactly `limit` cannot distinguish a full page from a truncated
   * one. The caller slices the extra row off before rendering.
   *
   * @param {{ since: string|null, limit: number }} params
   * @returns {Array<{ userId: string, displayName: string, avatar: string|null,
   *   trackCount: number, totalDurationSeconds: number, uniqueTrackCount: number }>}
   */
  getLeaderboard({ since = null, limit = 10 } = {}) {
    // Name and avatar come from the member's MOST RECENT row, not an arbitrary
    // one: a DJ who changed their display name should appear under the new one.
    const sql = `
      SELECT
        h.requested_by_id                        AS userId,
        COUNT(*)                                 AS trackCount,
        SUM(COALESCE(h.duration, 0))             AS totalDurationSeconds,
        COUNT(DISTINCT h.url)                    AS uniqueTrackCount,
        MIN(h.played_at)                         AS firstPlayedAt,
        (SELECT h2.requested_by FROM history h2
          WHERE h2.requested_by_id = h.requested_by_id
            ${since ? 'AND h2.played_at >= @since' : ''}
          ORDER BY h2.played_at DESC, h2.id DESC LIMIT 1)      AS displayName,
        (SELECT h3.requested_by_avatar FROM history h3
          WHERE h3.requested_by_id = h.requested_by_id
            ${since ? 'AND h3.played_at >= @since' : ''}
          ORDER BY h3.played_at DESC, h3.id DESC LIMIT 1)      AS avatar
      FROM history h
      WHERE ${COUNTED_PLAY}
        ${since ? 'AND h.played_at >= @since' : ''}
      GROUP BY h.requested_by_id
      ORDER BY trackCount DESC, firstPlayedAt ASC, userId ASC
      LIMIT @limit
    `;
    return this.db.prepare(sql).all({ since, limit: limit + 1 });
  }

  /**
   * One member's aggregate plus their true rank in the full ordering, for the
   * pinned self-row when they fall outside the top 10.
   *
   * The rank is computed over every qualifying DJ, not just the returned page,
   * so it is the member's real standing. Returns null when they have no
   * qualifying plays in the period.
   *
   * @param {{ since: string|null, userId: string }} params
   */
  getLeaderboardEntryForUser({ since = null, userId }) {
    if (!userId) return null;

    // Same grouping and ordering as getLeaderboard, wrapped so ROW_NUMBER gives
    // the rank. Keeping the ORDER BY byte-identical is what makes the pinned
    // row's rank agree with the ranks assigned to the top-10 rows.
    const sql = `
      WITH ranked AS (
        SELECT
          h.requested_by_id            AS userId,
          COUNT(*)                     AS trackCount,
          SUM(COALESCE(h.duration, 0)) AS totalDurationSeconds,
          COUNT(DISTINCT h.url)        AS uniqueTrackCount,
          MIN(h.played_at)             AS firstPlayedAt,
          ROW_NUMBER() OVER (
            ORDER BY COUNT(*) DESC, MIN(h.played_at) ASC, h.requested_by_id ASC
          )                            AS rank
        FROM history h
        WHERE ${COUNTED_PLAY}
          ${since ? 'AND h.played_at >= @since' : ''}
        GROUP BY h.requested_by_id
      )
      SELECT
        r.rank,
        r.userId,
        r.trackCount,
        r.totalDurationSeconds,
        r.uniqueTrackCount,
        (SELECT h2.requested_by FROM history h2
          WHERE h2.requested_by_id = r.userId
            ${since ? 'AND h2.played_at >= @since' : ''}
          ORDER BY h2.played_at DESC, h2.id DESC LIMIT 1)  AS displayName,
        (SELECT h3.requested_by_avatar FROM history h3
          WHERE h3.requested_by_id = r.userId
            ${since ? 'AND h3.played_at >= @since' : ''}
          ORDER BY h3.played_at DESC, h3.id DESC LIMIT 1)  AS avatar
      FROM ranked r
      WHERE r.userId = @userId
    `;
    return this.db.prepare(sql).get({ since, userId }) || null;
  }

  /**
   * Convert local-calendar date modifiers into the UTC boundary played_at is
   * compared against.
   *
   * The modifiers arrive as data (e.g. ['start of month']) and are bound, never
   * interpolated. The 'utc' modifier reads the preceding local date as local time
   * and converts it, which is what makes "this month" the viewer's month rather
   * than UTC's.
   *
   * @param {string[]} modifiers - SQLite date modifiers, applied in order.
   * @returns {string} UTC datetime string, e.g. '2026-08-31 22:00:00'.
   */
  getPeriodBoundary(modifiers = []) {
    const placeholders = modifiers.map(() => ', ?').join('');
    const sql = `SELECT datetime(date('now','localtime'${placeholders}), 'utc') AS since`;
    return this.db
      .prepare(sql)
      .pluck()
      .get(...modifiers);
  }

  // --- Awards derived from play history -------------------------------------
  //
  // Each returns at most one row shaped { userId, displayName, avatar, value },
  // or undefined when nothing qualifies. The 3-item minimum is applied by the
  // caller so the boundary lives in one place.
  //
  // Every hour and date expression repeats the full strftime(...) call on both
  // sides of its OR/AND. `>= '22' OR < '04'` is prose shorthand, not valid SQL.

  /** Most-played track. The winner is a track, not a member. */
  getMostPlayedSongAward({ since = null } = {}) {
    const sql = `
      SELECT
        h.url                                  AS url,
        COUNT(*)                               AS value,
        MIN(h.played_at)                        AS firstPlayedAt,
        (SELECT h2.title FROM history h2
          WHERE h2.url = h.url
          ORDER BY h2.played_at DESC, h2.id DESC LIMIT 1)     AS displayName,
        (SELECT h3.thumbnail FROM history h3
          WHERE h3.url = h.url
          ORDER BY h3.played_at DESC, h3.id DESC LIMIT 1)     AS avatar
      FROM history h
      WHERE ${COUNTED_PLAY}
        ${since ? 'AND h.played_at >= @since' : ''}
      GROUP BY h.url
      ORDER BY value DESC, firstPlayedAt ASC, h.url ASC
      LIMIT 1
    `;
    return this.db.prepare(sql).get({ since });
  }

  /** Most tracks queued between 22:00 and 04:00 local time. */
  getNightOwlAward({ since = null } = {}) {
    return this.#historyMemberAward({
      since,
      hourPredicate: `(
        strftime('%H', h.played_at, 'localtime') >= '22'
        OR strftime('%H', h.played_at, 'localtime') < '04'
      )`
    });
  }

  /** Most tracks queued between 05:00 and 09:00 local time. */
  getEarlyBirdAward({ since = null } = {}) {
    return this.#historyMemberAward({
      since,
      hourPredicate: `(
        strftime('%H', h.played_at, 'localtime') >= '05'
        AND strftime('%H', h.played_at, 'localtime') < '09'
      )`
    });
  }

  /**
   * Most plays by one member within a single local day.
   *
   * Grouped by member AND local date, then the best single day per member wins.
   */
  getHogAward({ since = null } = {}) {
    const sql = `
      WITH per_day AS (
        SELECT
          h.requested_by_id                     AS userId,
          date(h.played_at, 'localtime')        AS localDay,
          COUNT(*)                              AS value,
          MIN(h.played_at)                      AS firstPlayedAt
        FROM history h
        WHERE ${COUNTED_PLAY}
          ${since ? 'AND h.played_at >= @since' : ''}
        GROUP BY h.requested_by_id, date(h.played_at, 'localtime')
      )
      SELECT
        p.userId,
        p.value,
        (SELECT h2.requested_by FROM history h2
          WHERE h2.requested_by_id = p.userId
          ORDER BY h2.played_at DESC, h2.id DESC LIMIT 1)   AS displayName,
        (SELECT h3.requested_by_avatar FROM history h3
          WHERE h3.requested_by_id = p.userId
          ORDER BY h3.played_at DESC, h3.id DESC LIMIT 1)   AS avatar
      FROM per_day p
      ORDER BY p.value DESC, p.firstPlayedAt ASC, p.userId ASC
      LIMIT 1
    `;
    return this.db.prepare(sql).get({ since });
  }

  /**
   * Shared shape for the member awards counting history rows under an hour
   * predicate. Private: the predicate is a code-defined SQL fragment from the two
   * callers above, never anything user-supplied.
   */
  #historyMemberAward({ since, hourPredicate }) {
    const sql = `
      SELECT
        h.requested_by_id                       AS userId,
        COUNT(*)                                AS value,
        MIN(h.played_at)                        AS firstPlayedAt,
        (SELECT h2.requested_by FROM history h2
          WHERE h2.requested_by_id = h.requested_by_id
          ORDER BY h2.played_at DESC, h2.id DESC LIMIT 1)   AS displayName,
        (SELECT h3.requested_by_avatar FROM history h3
          WHERE h3.requested_by_id = h.requested_by_id
          ORDER BY h3.played_at DESC, h3.id DESC LIMIT 1)   AS avatar
      FROM history h
      WHERE ${COUNTED_PLAY}
        AND ${hourPredicate}
        ${since ? 'AND h.played_at >= @since' : ''}
      GROUP BY h.requested_by_id
      ORDER BY value DESC, firstPlayedAt ASC, userId ASC
      LIMIT 1
    `;
    return this.db.prepare(sql).get({ since });
  }

  // --- Awards derived from recorded actions ---------------------------------

  /**
   * Most tracks skipped BY OTHER PEOPLE.
   *
   * Grouped by target_user_id, so the winner is the member whose queued tracks
   * others skipped most — the victim, not the skipper. Grouping by actor_id here
   * compiles, returns a plausible winner, and names the wrong person.
   */
  getDjSkipAward({ since = null } = {}) {
    return this.#eventAward({
      since,
      eventType: 'skip',
      groupColumn: 'target_user_id',
      nameColumn: 'target_user_name',
      extraPredicate: 'e.target_user_id <> e.actor_id',
      // events records no avatar for the target, only for the actor, and the
      // actor here is the person doing the skipping. The victim's own avatar
      // comes from the plays they queued.
      avatarFromHistory: true
    });
  }

  /** Most skips of one's own tracks. */
  getSelfSkipAward({ since = null } = {}) {
    return this.#eventAward({
      since,
      eventType: 'skip',
      groupColumn: 'actor_id',
      nameColumn: 'actor_name',
      extraPredicate: 'e.target_user_id = e.actor_id'
    });
  }

  /** Most queue removals performed. */
  getQueueYeeterAward({ since = null } = {}) {
    return this.#eventAward({
      since,
      eventType: 'remove',
      groupColumn: 'actor_id',
      nameColumn: 'actor_name'
    });
  }

  /** Most shuffles performed. */
  getShuffleAddictAward({ since = null } = {}) {
    return this.#eventAward({
      since,
      eventType: 'shuffle',
      groupColumn: 'actor_id',
      nameColumn: 'actor_name'
    });
  }

  /**
   * Shared shape for the awards counting `events` rows. Private, and every
   * interpolated fragment is code-defined by the four callers above.
   */
  #eventAward({
    since,
    eventType,
    groupColumn,
    nameColumn,
    extraPredicate = null,
    avatarFromHistory = false
  }) {
    const avatarSubquery = avatarFromHistory
      ? `(SELECT h.requested_by_avatar FROM history h
           WHERE h.requested_by_id = e.${groupColumn}
           ORDER BY h.played_at DESC, h.id DESC LIMIT 1)`
      : `(SELECT e3.actor_avatar FROM events e3
           WHERE e3.${groupColumn} = e.${groupColumn}
           ORDER BY e3.created_at DESC, e3.id DESC LIMIT 1)`;

    const sql = `
      SELECT
        e.${groupColumn}                        AS userId,
        COUNT(*)                                AS value,
        MIN(e.created_at)                       AS firstActionAt,
        (SELECT e2.${nameColumn} FROM events e2
          WHERE e2.${groupColumn} = e.${groupColumn}
          ORDER BY e2.created_at DESC, e2.id DESC LIMIT 1)  AS displayName,
        ${avatarSubquery}                       AS avatar
      FROM events e
      WHERE e.event_type = @eventType
        AND e.${groupColumn} IS NOT NULL
        AND e.actor_id IS NOT NULL
        ${extraPredicate ? `AND ${extraPredicate}` : ''}
        ${since ? 'AND e.created_at >= @since' : ''}
      GROUP BY e.${groupColumn}
      ORDER BY value DESC, firstActionAt ASC, userId ASC
      LIMIT 1
    `;
    return this.db.prepare(sql).get({ since, eventType });
  }

  // AI DJ methods (feature 002)
  getDjSettings() {
    this.db.prepare('INSERT OR IGNORE INTO dj_settings (id) VALUES (1)').run();
    const row = this.db
      .prepare('SELECT enabled, interval, lookahead FROM dj_settings WHERE id = 1')
      .get();
    return { enabled: row.enabled === 1, interval: row.interval, lookahead: row.lookahead };
  }

  updateDjSettings(partial = {}) {
    this.db.prepare('INSERT OR IGNORE INTO dj_settings (id) VALUES (1)').run();
    const sets = [];
    const params = {};
    if (partial.enabled !== undefined) {
      sets.push('enabled = @enabled');
      params.enabled = partial.enabled ? 1 : 0;
    }
    if (partial.interval !== undefined) {
      sets.push('interval = @interval');
      params.interval = partial.interval;
    }
    if (partial.lookahead !== undefined) {
      sets.push('lookahead = @lookahead');
      params.lookahead = partial.lookahead;
    }
    sets.push('updated_at = CURRENT_TIMESTAMP');
    this.db.prepare(`UPDATE dj_settings SET ${sets.join(', ')} WHERE id = 1`).run(params);
    return this.getDjSettings();
  }

  getDjUsage(day) {
    const row = this.db.prepare('SELECT lines, themed_tracks FROM dj_usage WHERE day = ?').get(day);
    return { lines: row?.lines ?? 0, themed_tracks: row?.themed_tracks ?? 0 };
  }

  incrementDjUsage(day, field) {
    // Whitelisted: the column name is interpolated into the SQL.
    if (field !== 'lines' && field !== 'themed_tracks') {
      throw new Error(`incrementDjUsage: unknown field "${field}"`);
    }
    this.db
      .prepare(
        `INSERT INTO dj_usage (day, ${field}) VALUES (?, 1)
         ON CONFLICT(day) DO UPDATE SET ${field} = ${field} + 1`
      )
      .run(day);
  }

  // Old usage rows are never read; prune them so the table stays small.
  pruneDjUsage() {
    this.db.prepare("DELETE FROM dj_usage WHERE day < date('now', 'localtime', '-30 days')").run();
  }

  // Shout-out opt-outs (FR-019). Keyed by Discord user id; a row means opted out.
  isShoutoutOptedOut(userId) {
    return Boolean(
      this.db.prepare('SELECT 1 FROM dj_shoutout_optouts WHERE user_id = ?').get(userId)
    );
  }

  setShoutoutOptOut(userId, optedOut) {
    if (optedOut) {
      this.db.prepare('INSERT OR IGNORE INTO dj_shoutout_optouts (user_id) VALUES (?)').run(userId);
    } else {
      this.db.prepare('DELETE FROM dj_shoutout_optouts WHERE user_id = ?').run(userId);
    }
  }

  getShoutoutOptOuts() {
    const ids = this.db.prepare('SELECT user_id FROM dj_shoutout_optouts').pluck().all();
    return new Set(ids);
  }

  // DJ grounding reads (research R6). All use COUNTED_PLAY, so loop replays and
  // DJ picks (requested_by_id NULL) never feed a fact.

  /**
   * Counted plays of one track per member.
   * @param {string} url
   * @param {string[]} userIds - Discord user ids
   * @returns {Array<{ userId: string, count: number }>}
   */
  getUserPlayCountsForUrl(url, userIds) {
    if (!url || !userIds?.length) return [];
    const placeholders = userIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT h.requested_by_id AS userId, COUNT(*) AS count
         FROM history h
         WHERE ${COUNTED_PLAY} AND h.url = ? AND h.requested_by_id IN (${placeholders})
         GROUP BY h.requested_by_id
         ORDER BY count DESC, MIN(h.played_at) ASC, h.requested_by_id ASC`
      )
      .all(url, ...userIds);
  }

  /**
   * A member's single most-played track.
   * @param {string} userId
   * @returns {{ url: string, title: string, count: number }|null}
   */
  getUserTopTrack(userId) {
    const row = this.db
      .prepare(
        `SELECT h.url AS url, MAX(h.title) AS title, COUNT(*) AS count
         FROM history h
         WHERE ${COUNTED_PLAY} AND h.requested_by_id = ?
         GROUP BY h.url
         ORDER BY count DESC, MIN(h.played_at) ASC, h.url ASC
         LIMIT 1`
      )
      .get(userId);
    return row ?? null;
  }

  /**
   * The latest display name of every member who ever queued a track; DJ picks
   * (requested_by_id NULL) are excluded. Feeds the forbidden-name check.
   * @returns {string[]}
   */
  getKnownMemberNames() {
    return this.db
      .prepare(
        `SELECT h.requested_by
         FROM history h
         WHERE h.requested_by_id IS NOT NULL
           AND h.id = (SELECT MAX(h2.id) FROM history h2 WHERE h2.requested_by_id = h.requested_by_id)
         ORDER BY h.requested_by`
      )
      .pluck()
      .all();
  }

  /**
   * Remember the display names of members seen in voice, so a name the DJ may
   * have said stays forbidden after that member leaves (R6 step 3).
   * @param {Array<{ userId: string, displayName: string|null }>} members
   */
  recordMemberNames(members) {
    const stmt = this.db.prepare(
      `INSERT INTO dj_member_names (user_id, display_name) VALUES (?, ?)
       ON CONFLICT(user_id, display_name) DO UPDATE SET seen_at = CURRENT_TIMESTAMP`
    );
    const run = this.db.transaction((rows) => {
      for (const { userId, displayName } of rows) {
        if (userId && displayName) stmt.run(userId, displayName);
      }
    });
    run(members ?? []);
  }

  /**
   * Every display name recorded by recordMemberNames(), for any member.
   * @returns {string[]}
   */
  getKnownDisplayNames() {
    return this.db
      .prepare('SELECT DISTINCT display_name FROM dj_member_names ORDER BY display_name')
      .pluck()
      .all();
  }

  /**
   * How many of `userIds` have counted plays of `artist` in the last `days`
   * local days. Anonymous group facts only; a NULL artist never matches.
   * @param {string} artist
   * @param {string[]} userIds
   * @param {number} days
   * @returns {number}
   */
  getArtistQueuersSince(artist, userIds, days) {
    if (!artist || !userIds?.length) return 0;
    const placeholders = userIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT COUNT(DISTINCT h.requested_by_id)
         FROM history h
         WHERE ${COUNTED_PLAY}
           AND h.artist IS NOT NULL AND LOWER(h.artist) = LOWER(?)
           AND h.requested_by_id IN (${placeholders})
           AND date(h.played_at, 'localtime') > date('now', 'localtime', ?)`
      )
      .pluck()
      .get(artist, ...userIds, `-${Number(days)} days`);
  }

  // Playlist methods
  getPlaylists() {
    const stmt = this.db.prepare('SELECT * FROM playlists ORDER BY created_at DESC');
    return stmt.all();
  }

  createPlaylist(id, name, spotifyUrl, coverImage, createdBy) {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO playlists (id, name, spotify_url, cover_image, created_by) VALUES (?, ?, ?, ?, ?)'
      );
      stmt.run(id, name, spotifyUrl, coverImage || null, createdBy || null);
      return this.getPlaylistById(id);
    } catch (error) {
      logger.error('[Database] createPlaylist failed:', error.message);
      return null;
    }
  }

  getPlaylistById(id) {
    const stmt = this.db.prepare('SELECT * FROM playlists WHERE id = ?');
    return stmt.get(id);
  }

  deletePlaylist(id) {
    try {
      const stmt = this.db.prepare('DELETE FROM playlists WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    } catch (error) {
      logger.error('[Database] deletePlaylist failed:', error.message);
      return false;
    }
  }

  close() {
    this.db.close();
  }
}

export const db = new DatabaseManager();
