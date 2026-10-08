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

  // Research R11's rules table, row by row. start() stands in for
  // musicManager.onTrackChange(): it reports whether the start would be written
  // as a loop replay, then clears the flag and marks the entry played, exactly
  // as onTrackChange does on the same queue-entry object.
  describe('loop-replay marking (FR-005a, R11)', () => {
    function start(entry) {
      const loopReplay = entry.loopReplay === true;
      entry.loopReplay = false;
      entry.hasPlayed = true;
      return loopReplay;
    }

    it('flags a track-loop repeat of the current entry', () => {
      seed(queue, ['a'], 0);
      queue.loopMode = 'track';
      expect(start(queue.getCurrent())).toBe(false);

      for (let i = 0; i < 19; i++) {
        const entry = queue.next();
        expect(entry.id).toBe('a');
        expect(start(entry)).toBe(true);
      }
    });

    it('flags /skip in track-loop, since next() returns the same entry again', () => {
      seed(queue, ['a', 'b'], 0);
      queue.loopMode = 'track';
      start(queue.getCurrent());

      // A skip goes through advanceAndPlay -> queue.next(), same as a natural end.
      const entry = queue.next();
      expect(entry.id).toBe('a');
      expect(start(entry)).toBe(true);
    });

    it('does not flag the first pass through the queue with loop on', () => {
      seed(queue, ['a', 'b', 'c'], 0);
      queue.loopMode = 'queue';
      expect(start(queue.getCurrent())).toBe(false);
      expect(start(queue.next())).toBe(false);
      expect(start(queue.next())).toBe(false);
    });

    it('flags every entry on the queue-loop second pass and later passes', () => {
      seed(queue, ['a', 'b', 'c'], 0);
      queue.loopMode = 'queue';
      start(queue.getCurrent());
      start(queue.next());
      start(queue.next());

      for (let pass = 0; pass < 2; pass++) {
        for (const id of ['a', 'b', 'c']) {
          const entry = queue.next();
          expect(entry.id).toBe(id);
          expect(start(entry)).toBe(true);
        }
      }
    });

    it('does not flag an unplayed entry reached after a queue-loop wrap', () => {
      seed(queue, ['a', 'b'], 0);
      queue.loopMode = 'queue';
      start(queue.getCurrent());
      start(queue.next());

      const wrapped = queue.next();
      expect(wrapped.id).toBe('a');
      expect(start(wrapped)).toBe(true);

      queue.add(t('c')); // added after the wrap, never played
      expect(start(queue.next())).toBe(true); // b, second pass
      const fresh = queue.next();
      expect(fresh.id).toBe('c');
      expect(start(fresh)).toBe(false);
    });

    it('never flags previous() to an already-played entry, loop on or off', () => {
      for (const mode of ['off', 'track', 'queue']) {
        seed(queue, ['a', 'b'], 0);
        queue.loopMode = mode;
        start(queue.getCurrent());
        queue.currentIndex = 1;
        start(queue.getCurrent());

        const back = queue.previous();
        expect(back.id).toBe('a');
        expect(start(back), `previous with loop ${mode}`).toBe(false);
      }
    });

    it('does not flag previous then forward again with loop off', () => {
      seed(queue, ['a', 'b'], 0);
      start(queue.getCurrent());
      start(queue.next());
      start(queue.previous());

      const forward = queue.next();
      expect(forward.id).toBe('b');
      expect(start(forward)).toBe(false);
    });

    it('flags previous then forward again with queue-loop on (deliberate simplification)', () => {
      seed(queue, ['a', 'b'], 0);
      queue.loopMode = 'queue';
      start(queue.getCurrent());
      start(queue.next());
      start(queue.previous());

      const forward = queue.next();
      expect(forward.id).toBe('b');
      expect(start(forward)).toBe(true);
    });

    it('does not flag the same URL queued again as a new entry', () => {
      queue.loopMode = 'queue';
      queue.add({ id: 'first', url: 'https://example.com/same' });
      start(queue.getCurrent());
      queue.add({ id: 'again', url: 'https://example.com/same' });

      const requeued = queue.next();
      expect(requeued.id).toBe('again');
      expect(requeued.hasPlayed).toBeUndefined();
      expect(start(requeued)).toBe(false);
    });

    it('overwrites a stale flag once loop is switched off', () => {
      seed(queue, ['a', 'b'], 0);
      queue.loopMode = 'queue';
      start(queue.getCurrent());
      start(queue.next());
      // Loop flagged the wrap, but the start failed so onTrackChange never ran.
      expect(queue.next().loopReplay).toBe(true);

      queue.loopMode = 'off';
      const entry = queue.next();
      expect(entry.id).toBe('b');
      expect(start(entry)).toBe(false);
    });
  });
});

describe('Queue.peekNext (side-effect free)', () => {
  let queue;

  beforeEach(() => {
    queue = new Queue();
  });

  function snapshot(q) {
    return {
      currentIndex: q.currentIndex,
      flags: q.tracks.map((tr) => tr.loopReplay),
      ids: q.tracks.map((tr) => tr.id)
    };
  }

  it('returns null on an empty queue', () => {
    expect(queue.peekNext()).toBeNull();
  });

  it('loop off: returns the following entry', () => {
    seed(queue, ['a', 'b', 'c'], 0);
    const before = snapshot(queue);
    expect(queue.peekNext().id).toBe('b');
    expect(snapshot(queue)).toEqual(before);
  });

  it('loop off at the last index: returns null and does not clear the queue', () => {
    seed(queue, ['a', 'b'], 1);
    const before = snapshot(queue);
    expect(queue.peekNext()).toBeNull();
    expect(snapshot(queue)).toEqual(before);
  });

  it('loop track: returns the current entry', () => {
    seed(queue, ['a', 'b'], 1);
    queue.loopMode = 'track';
    queue.tracks[1].hasPlayed = true;
    const before = snapshot(queue);
    expect(queue.peekNext().id).toBe('b');
    expect(snapshot(queue)).toEqual(before);
    expect(queue.tracks[1].loopReplay).toBeUndefined();
  });

  it('loop queue mid-queue: returns the following entry', () => {
    seed(queue, ['a', 'b', 'c'], 1);
    queue.loopMode = 'queue';
    expect(queue.peekNext().id).toBe('c');
    expect(queue.currentIndex).toBe(1);
  });

  it('loop queue at the last index: wraps to tracks[0] without moving', () => {
    seed(queue, ['a', 'b', 'c'], 2);
    queue.loopMode = 'queue';
    queue.tracks[0].hasPlayed = true;
    const before = snapshot(queue);
    expect(queue.peekNext().id).toBe('a');
    expect(snapshot(queue)).toEqual(before);
  });

  it('agrees with next() for each loop mode', () => {
    for (const mode of ['off', 'track', 'queue']) {
      for (let i = 0; i < 3; i++) {
        const q = new Queue();
        seed(q, ['a', 'b', 'c'], i);
        q.loopMode = mode;
        const peeked = q.peekNext()?.id ?? null;
        const advanced = q.next()?.id ?? null;
        expect(peeked).toBe(advanced);
      }
    }
  });
});

describe('Queue themed-mode ordering (FR-024, R8)', () => {
  let queue;
  const dj = (id) => ({ id, addedByDj: true });
  const ids = () => queue.tracks.map((t) => t.id);

  beforeEach(() => {
    queue = new Queue();
  });

  describe('insertAt', () => {
    it('inserts among upcoming entries and stamps addedAt', () => {
      seed(queue, ['a', 'b', 'c'], 0);
      expect(queue.insertAt(2, t('x'))).toBe(2);
      expect(ids()).toEqual(['a', 'b', 'x', 'c']);
      expect(queue.tracks[2].addedAt).toBeInstanceOf(Date);
    });

    it('clamps below to currentIndex + 1, so current and past entries never move', () => {
      seed(queue, ['a', 'b', 'c'], 1);
      expect(queue.insertAt(0, t('x'))).toBe(2);
      expect(ids()).toEqual(['a', 'b', 'x', 'c']);
      expect(queue.currentIndex).toBe(1);
    });

    it('clamps above to length (append)', () => {
      seed(queue, ['a', 'b'], 0);
      expect(queue.insertAt(99, t('x'))).toBe(2);
      expect(ids()).toEqual(['a', 'b', 'x']);
    });
  });

  describe('add with prioritizeMemberTracks', () => {
    it('defaults to false and appends as before', () => {
      expect(queue.prioritizeMemberTracks).toBe(false);
      seed(queue, ['a'], 0);
      queue.tracks.push(dj('d1'), dj('d2'));
      queue.add(t('m'));
      expect(ids()).toEqual(['a', 'd1', 'd2', 'm']);
    });

    it('puts a member track before the first upcoming DJ pick', () => {
      seed(queue, ['a'], 0);
      queue.tracks.push(dj('d1'), dj('d2'));
      queue.prioritizeMemberTracks = true;
      queue.add(t('m'));
      expect(ids()).toEqual(['a', 'm', 'd1', 'd2']);
    });

    it('keeps several member adds in FIFO order ahead of the picks', () => {
      seed(queue, ['a'], 0);
      queue.tracks.push(dj('d1'), dj('d2'));
      queue.prioritizeMemberTracks = true;
      queue.add(t('m1'));
      queue.add(t('m2'));
      expect(ids()).toEqual(['a', 'm1', 'm2', 'd1', 'd2']);
    });

    it('ignores a DJ pick that is current or already played', () => {
      seed(queue, ['x', 'y'], 1);
      queue.tracks[0].addedByDj = true;
      queue.tracks[1].addedByDj = true;
      queue.prioritizeMemberTracks = true;
      queue.add(t('m'));
      expect(ids()).toEqual(['x', 'y', 'm']);
    });

    it('appends DJ picks themselves', () => {
      seed(queue, ['a'], 0);
      queue.prioritizeMemberTracks = true;
      queue.add(dj('d1'));
      queue.add(t('m'));
      queue.add(dj('d2'));
      expect(ids()).toEqual(['a', 'm', 'd1', 'd2']);
    });

    it('works on an empty queue', () => {
      queue.prioritizeMemberTracks = true;
      queue.currentIndex = 3;
      queue.add(t('m'));
      expect(ids()).toEqual(['m']);
      expect(queue.currentIndex).toBe(0);
    });
  });

  describe('countUpcoming', () => {
    it('counts only entries after currentIndex', () => {
      seed(queue, ['a', 'b', 'c', 'd'], 1);
      queue.tracks[0].addedByDj = true;
      queue.tracks[1].addedByDj = true;
      queue.tracks[3].addedByDj = true;
      expect(queue.countUpcoming((x) => x.addedByDj)).toBe(1);
      expect(queue.countUpcoming(() => true)).toBe(2);
    });

    it('is 0 on an empty queue', () => {
      expect(queue.countUpcoming(() => true)).toBe(0);
    });
  });

  it('addedByDj survives add() so queue:update payloads carry it', () => {
    queue.add(dj('d1'));
    expect(queue.getAll()[0].addedByDj).toBe(true);
  });

  it('shuffle() itself is unaffected by the flag; musicManager refuses instead', () => {
    seed(queue, ['a', 'b', 'c'], 0);
    queue.prioritizeMemberTracks = true;
    expect(() => queue.shuffle()).not.toThrow();
  });
});
