import { describe, it, expect, beforeEach } from 'vitest';
import { Queue } from '../../src/core/queue.js';

// Helper: build a track with a stable id we can assert on. Queue.add() spreads
// the track into a new object (adding addedAt), so identity comparison won't
// work -- we compare by id instead.
const t = (id) => ({ id });

// Seed a queue with the given ids without going through add() side effects,
// so tests can control currentIndex precisely.
function seed(queue, ids, currentIndex = 0) {
  queue.tracks = ids.map((id) => ({ id }));
  queue.currentIndex = currentIndex;
}

describe('Queue', () => {
  let queue;

  beforeEach(() => {
    queue = new Queue();
  });

  describe('add', () => {
    it('appends a track and stamps addedAt', () => {
      queue.add(t('a'));
      expect(queue.length).toBe(1);
      expect(queue.tracks[0].id).toBe('a');
      expect(queue.tracks[0].addedAt).toBeInstanceOf(Date);
    });

    it('resets a stale currentIndex to 0 when adding to an empty queue', () => {
      queue.currentIndex = 5; // stale index, queue is empty
      queue.add(t('a'));
      expect(queue.currentIndex).toBe(0);
      expect(queue.getCurrent().id).toBe('a');
    });

    it('does not move currentIndex when adding to a non-empty queue', () => {
      seed(queue, ['a', 'b'], 1);
      queue.add(t('c'));
      expect(queue.currentIndex).toBe(1);
      expect(queue.length).toBe(3);
    });
  });

  describe('remove', () => {
    it('returns null and leaves the queue unchanged for a negative index', () => {
      seed(queue, ['a', 'b'], 0);
      expect(queue.remove(-1)).toBeNull();
      expect(queue.length).toBe(2);
    });

    it('returns null and leaves the queue unchanged for an out-of-range index', () => {
      seed(queue, ['a', 'b'], 0);
      expect(queue.remove(5)).toBeNull();
      expect(queue.length).toBe(2);
    });

    it('returns the removed track', () => {
      seed(queue, ['a', 'b', 'c'], 0);
      expect(queue.remove(1).id).toBe('b');
    });

    it('decrements currentIndex when removing before it (current stays the same track)', () => {
      seed(queue, ['a', 'b', 'c'], 2); // current = c
      queue.remove(0);
      expect(queue.currentIndex).toBe(1);
      expect(queue.getCurrent().id).toBe('c');
    });

    it('keeps currentIndex (now pointing at the next track) when removing at current and more follow', () => {
      seed(queue, ['a', 'b', 'c'], 1); // current = b
      queue.remove(1);
      expect(queue.currentIndex).toBe(1);
      expect(queue.getCurrent().id).toBe('c');
    });

    it('clamps currentIndex when removing the current track that was last', () => {
      seed(queue, ['a', 'b', 'c'], 2); // current = c (last)
      queue.remove(2);
      expect(queue.currentIndex).toBe(1);
      expect(queue.getCurrent().id).toBe('b');
    });

    it('does not adjust currentIndex when removing after it', () => {
      seed(queue, ['a', 'b', 'c'], 0); // current = a
      queue.remove(2);
      expect(queue.currentIndex).toBe(0);
      expect(queue.getCurrent().id).toBe('a');
    });

    it('clamps currentIndex to 0 when removing the only track', () => {
      seed(queue, ['a'], 0);
      expect(queue.remove(0).id).toBe('a');
      expect(queue.currentIndex).toBe(0);
      expect(queue.length).toBe(0);
    });
  });

  describe('reorder', () => {
    it('returns false for an out-of-range from index', () => {
      seed(queue, ['a', 'b', 'c'], 0);
      expect(queue.reorder(-1, 1)).toBe(false);
      expect(queue.reorder(3, 1)).toBe(false);
    });

    it('returns false for an out-of-range to index', () => {
      seed(queue, ['a', 'b', 'c'], 0);
      expect(queue.reorder(0, -1)).toBe(false);
      expect(queue.reorder(0, 3)).toBe(false);
    });

    it('returns false when from === to', () => {
      seed(queue, ['a', 'b', 'c'], 0);
      expect(queue.reorder(1, 1)).toBe(false);
    });

    it('moves the track and returns true', () => {
      seed(queue, ['a', 'b', 'c', 'd'], 0);
      expect(queue.reorder(0, 2)).toBe(true);
      expect(queue.tracks.map((x) => x.id)).toEqual(['b', 'c', 'a', 'd']);
    });

    it('follows the current track when the moved track IS the current one', () => {
      seed(queue, ['a', 'b', 'c', 'd', 'e'], 2); // current = c
      queue.reorder(2, 4);
      expect(queue.currentIndex).toBe(4);
      expect(queue.getCurrent().id).toBe('c');
    });

    it('decrements currentIndex when moving from before current to at/after current', () => {
      seed(queue, ['a', 'b', 'c', 'd', 'e'], 2); // current = c
      queue.reorder(0, 3);
      expect(queue.currentIndex).toBe(1);
      expect(queue.getCurrent().id).toBe('c');
    });

    it('increments currentIndex when moving from after current to at/before current', () => {
      seed(queue, ['a', 'b', 'c', 'd', 'e'], 2); // current = c
      queue.reorder(4, 0);
      expect(queue.currentIndex).toBe(3);
      expect(queue.getCurrent().id).toBe('c');
    });

    it('leaves currentIndex untouched when the move does not cross it', () => {
      seed(queue, ['a', 'b', 'c', 'd', 'e'], 2); // current = c
      queue.reorder(0, 1);
      expect(queue.currentIndex).toBe(2);
      expect(queue.getCurrent().id).toBe('c');
    });
  });

  describe('next', () => {
    it('returns null for an empty queue', () => {
      expect(queue.next()).toBeNull();
    });

    describe("loopMode 'off'", () => {
      it('advances to the next track', () => {
        seed(queue, ['a', 'b'], 0);
        queue.loopMode = 'off';
        expect(queue.next().id).toBe('b');
        expect(queue.currentIndex).toBe(1);
      });

      it('clears the queue and returns null at natural end', () => {
        seed(queue, ['a', 'b'], 1); // already on last track
        queue.loopMode = 'off';
        expect(queue.next()).toBeNull();
        expect(queue.length).toBe(0);
        expect(queue.currentIndex).toBe(0);
      });
    });

    describe("loopMode 'track'", () => {
      it('returns the same current track without moving the index', () => {
        seed(queue, ['a', 'b'], 0);
        queue.loopMode = 'track';
        expect(queue.next().id).toBe('a');
        expect(queue.currentIndex).toBe(0);
      });
    });

    describe("loopMode 'queue'", () => {
      it('advances normally when not at the end', () => {
        seed(queue, ['a', 'b'], 0);
        queue.loopMode = 'queue';
        expect(queue.next().id).toBe('b');
        expect(queue.currentIndex).toBe(1);
      });

      it('wraps to index 0 at the end', () => {
        seed(queue, ['a', 'b'], 1);
        queue.loopMode = 'queue';
        expect(queue.next().id).toBe('a');
        expect(queue.currentIndex).toBe(0);
        expect(queue.length).toBe(2); // not cleared
      });
    });
  });

  describe('previous', () => {
    it('returns null for an empty queue', () => {
      expect(queue.previous()).toBeNull();
    });

    it('moves back one track when not at the start', () => {
      seed(queue, ['a', 'b', 'c'], 2);
      expect(queue.previous().id).toBe('b');
      expect(queue.currentIndex).toBe(1);
    });

    it("stays on the first track at index 0 with loop 'off'", () => {
      seed(queue, ['a', 'b'], 0);
      queue.loopMode = 'off';
      expect(queue.previous().id).toBe('a');
      expect(queue.currentIndex).toBe(0);
    });

    it("wraps to the last track at index 0 with loop 'queue'", () => {
      seed(queue, ['a', 'b', 'c'], 0);
      queue.loopMode = 'queue';
      expect(queue.previous().id).toBe('c');
      expect(queue.currentIndex).toBe(2);
    });
  });

  describe('clearUpcoming', () => {
    it('removes tracks after the current one, keeping the current track', () => {
      seed(queue, ['a', 'b', 'c', 'd'], 1); // current = b
      queue.clearUpcoming();
      expect(queue.tracks.map((x) => x.id)).toEqual(['a', 'b']);
      expect(queue.getCurrent().id).toBe('b');
    });

    it('does nothing when current is already the last track', () => {
      seed(queue, ['a', 'b', 'c'], 2);
      queue.clearUpcoming();
      expect(queue.tracks.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    });

    it('does nothing for an empty queue', () => {
      queue.clearUpcoming();
      expect(queue.length).toBe(0);
    });
  });

  describe('shuffle', () => {
    it('does nothing for a queue of length <= 1', () => {
      seed(queue, ['a'], 0);
      queue.shuffle();
      expect(queue.tracks.map((x) => x.id)).toEqual(['a']);
    });

    it('keeps the current track in its position and preserves the preceding tracks', () => {
      seed(queue, ['a', 'b', 'c', 'd', 'e'], 2); // current = c
      queue.shuffle();
      // Current track stays put; everything before it is untouched.
      expect(queue.currentIndex).toBe(2);
      expect(queue.tracks[2].id).toBe('c');
      expect(queue.tracks[0].id).toBe('a');
      expect(queue.tracks[1].id).toBe('b');
      // No tracks lost or duplicated.
      expect(queue.tracks.map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(queue.length).toBe(5);
    });
  });

  describe('getCurrent', () => {
    it('returns null for an empty queue', () => {
      expect(queue.getCurrent()).toBeNull();
    });

    it('returns the current track', () => {
      seed(queue, ['a', 'b'], 1);
      expect(queue.getCurrent().id).toBe('b');
    });

    it('resets a stale (out-of-range) currentIndex to 0', () => {
      seed(queue, ['a', 'b'], 5);
      expect(queue.getCurrent().id).toBe('a');
      expect(queue.currentIndex).toBe(0);
    });
  });

  describe('getUnresolvedInWindow', () => {
    it('returns unresolved spotify tracks within the window, excluding resolved/failed/non-spotify', () => {
      queue.tracks = [
        { url: 'http://x', spotifyData: {} }, // resolved (has url) -> excluded
        { url: null, spotifyData: {} }, // unresolved -> included (index 1)
        { url: null, spotifyData: {}, status: 'failed' }, // failed -> excluded
        { url: null }, // no spotifyData -> excluded
        { url: null, spotifyData: {}, status: 'pending' } // unresolved -> included (index 4)
      ];
      const result = queue.getUnresolvedInWindow(0, 5);
      expect(result.map((r) => r.index)).toEqual([1, 4]);
    });

    it('honors the window start and size bounds', () => {
      queue.tracks = [
        { url: null, spotifyData: {} }, // index 0 (outside window)
        { url: null, spotifyData: {} }, // index 1
        { url: null, spotifyData: {} }, // index 2
        { url: null, spotifyData: {} } // index 3 (outside window)
      ];
      const result = queue.getUnresolvedInWindow(1, 2);
      expect(result.map((r) => r.index)).toEqual([1, 2]);
    });

    it('clamps the window end to the queue length', () => {
      queue.tracks = [{ url: null, spotifyData: {} }];
      expect(queue.getUnresolvedInWindow(0, 100)).toHaveLength(1);
    });
  });

  describe('getResolutionStats', () => {
    it('counts tracks by resolution status', () => {
      queue.tracks = [
        { url: 'http://x' }, // resolved
        { url: 'http://y', status: 'resolved' }, // resolved
        { url: 'http://z', status: 'failed' }, // failed (url present but status wins)
        { status: 'resolving' }, // resolving
        { status: 'pending' }, // pending
        { status: 'failed' }, // failed
        {}, // unresolved (no url, no status)
        { status: 'unresolved' } // unresolved (falls through to else)
      ];
      expect(queue.getResolutionStats()).toEqual({
        resolved: 2,
        resolving: 1,
        pending: 1,
        failed: 2,
        unresolved: 2
      });
    });

    it('returns all-zero counts for an empty queue', () => {
      expect(queue.getResolutionStats()).toEqual({
        resolved: 0,
        unresolved: 0,
        resolving: 0,
        pending: 0,
        failed: 0
      });
    });
  });
});
