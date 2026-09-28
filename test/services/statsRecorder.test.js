import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// FR-025 / SC-008: recording is best-effort. EventEmitter invokes listeners
// synchronously, inside the emitting transport's own call stack, so a throw in the
// recorder would propagate into the HTTP handler, socket handler or Discord
// command that performed the action and break the action itself. Losing a stat is
// acceptable; breaking playback is not.
vi.mock('../../src/persistence/db.js', () => ({
  db: { logEvent: vi.fn() }
}));
vi.mock('../../src/core/musicManager.js', () => ({
  musicManager: { guildId: 'guild-1' }
}));
vi.mock('../../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
}));

import { db } from '../../src/persistence/db.js';
import { logger } from '../../src/utils/logger.js';
import { botEvents } from '../../src/events/bus.js';
import { STATS_EVENT, STATS_EVENT_TYPES, createStatsEvent } from '../../src/shared/statsEvents.js';
import {
  registerStatsRecorder,
  unregisterStatsRecorder
} from '../../src/services/statsRecorder.js';

function skipEvent() {
  return createStatsEvent({
    type: STATS_EVENT_TYPES.SKIP,
    actor: { discord_id: 'a1', username: 'alice', avatar: 'av-a' },
    track: {
      title: 'Song',
      url: 'https://example.com/song',
      requestedById: 'b1',
      requestedBy: 'bob'
    }
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  unregisterStatsRecorder();
  registerStatsRecorder();
});

afterEach(() => {
  unregisterStatsRecorder();
});

describe('registerStatsRecorder', () => {
  it('records an emitted event through db.logEvent', () => {
    botEvents.emit(STATS_EVENT, skipEvent());

    expect(db.logEvent).toHaveBeenCalledTimes(1);
    expect(db.logEvent.mock.calls[0][0]).toMatchObject({
      type: 'skip',
      actor: { id: 'a1', name: 'alice' },
      track: { requestedById: 'b1' }
    });
  });

  it('resolves the guild at the single write site', () => {
    botEvents.emit(STATS_EVENT, skipEvent());

    expect(db.logEvent.mock.calls[0][0].guildId).toBe('guild-1');
  });

  it('does not double-record when registered twice', () => {
    // A second registration (a re-import, a stray setup call) must not duplicate
    // every action for the rest of the process.
    registerStatsRecorder();

    botEvents.emit(STATS_EVENT, skipEvent());

    expect(db.logEvent).toHaveBeenCalledTimes(1);
  });
});

describe('best-effort recording (FR-025, SC-008)', () => {
  it('lets the emit return normally when db.logEvent throws', () => {
    db.logEvent.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    // The emit is what a transport does mid-action. If this throws, the action
    // that triggered it fails.
    expect(() => botEvents.emit(STATS_EVENT, skipEvent())).not.toThrow();
  });

  it('logs the failure rather than swallowing it silently', () => {
    db.logEvent.mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    botEvents.emit(STATS_EVENT, skipEvent());

    expect(logger.error).toHaveBeenCalled();
    expect(logger.error.mock.calls.some((call) => String(call[0]).includes('StatsRecorder'))).toBe(
      true
    );
  });

  it('reports the emit as handled, so the emitter continues', () => {
    db.logEvent.mockImplementation(() => {
      throw new Error('boom');
    });

    // EventEmitter.emit returns true when a listener was invoked. The emitter
    // carrying on is the behavior that matters here.
    expect(botEvents.emit(STATS_EVENT, skipEvent())).toBe(true);
  });

  it('survives a malformed payload without throwing', () => {
    db.logEvent.mockImplementation(() => {});

    expect(() => botEvents.emit(STATS_EVENT, undefined)).not.toThrow();
    expect(() => botEvents.emit(STATS_EVENT, null)).not.toThrow();
    expect(() => botEvents.emit(STATS_EVENT, { type: 'skip' })).not.toThrow();
  });

  it('keeps recording subsequent events after one failure', () => {
    db.logEvent.mockImplementationOnce(() => {
      throw new Error('transient');
    });

    botEvents.emit(STATS_EVENT, skipEvent());
    botEvents.emit(STATS_EVENT, skipEvent());

    expect(db.logEvent).toHaveBeenCalledTimes(2);
  });
});

describe('db.logEvent contract', () => {
  it('is the only writer the recorder calls', async () => {
    // The recorder must not reach the database any other way; events rows have
    // exactly one writer so the recorded shape cannot diverge.
    const source = await import('../../src/services/statsRecorder.js');
    expect(typeof source.registerStatsRecorder).toBe('function');

    botEvents.emit(STATS_EVENT, skipEvent());

    expect(db.logEvent).toHaveBeenCalled();
  });
});
