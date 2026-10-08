import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseManager } from '../../../src/persistence/db.js';
import { buildContext, speakableName } from '../../../src/services/dj/context.js';

describe('speakableName (R7)', () => {
  it.each([
    ['Kasper 🎧', 'Kasper'],
    ['★ DJ   Bea ★', 'DJ Bea'],
    ['  Anna\t\tMaria  ', 'Anna Maria'],
    ['Bartholomew Montgomery-Smith', 'Bartholomew'],
    ['🔥🔥🔥', null],
    ['!!! ### ***', null],
    ['', null],
    [null, null],
    ['Søren', 'Søren']
  ])('%j → %j', (input, expected) => {
    expect(speakableName(input)).toBe(expected);
  });

  it('never returns more than 20 characters for a single long word', () => {
    // Cut to the first word; a single 25-letter word is still one word.
    expect(speakableName('Supercalifragilistic Expialidocious')).toBe('Supercalifragilistic');
  });
});

let store;
const NEXT_URL = 'https://y/next';
const next = { title: 'Dancing Queen', url: NEXT_URL, channel: 'ABBA' };
const previous = { title: 'Mr. Brightside', url: 'https://y/prev', channel: 'The Killers' };

const A = { id: 'A', username: 'anna_u', displayName: 'Anna' };
const B = { id: 'B', username: 'bob_u', displayName: 'Bob' };
const C = { id: 'C', username: 'carl_u', displayName: 'Carl' };

function plays(userId, url, n, { name = userId, artist = null, loop = 0 } = {}) {
  for (let i = 0; i < n; i++) {
    store.db
      .prepare(
        'INSERT INTO history (title, url, requested_by, requested_by_id, is_loop_replay, artist) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(url === NEXT_URL ? 'Dancing Queen' : 'Other', url, name, userId, loop, artist);
  }
}

beforeEach(() => {
  store = new DatabaseManager(':memory:');
});

afterEach(() => {
  store.close();
});

describe('member facts (FR-016–FR-018)', () => {
  it('emits a member fact only when the count is at least 3', () => {
    plays('A', NEXT_URL, 3, { name: 'Anna' });
    plays('B', NEXT_URL, 2, { name: 'Bob' });
    plays('B', NEXT_URL, 4, { name: 'Bob', loop: 1 });
    const ctx = buildContext({ previous, next, present: [A, B], store });

    const members = ctx.facts.filter((f) => f.kind === 'member');
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: 'A', value: 3 });
    expect(members[0].text).toBe('Anna has played this track 3 times.');
    expect(ctx.allowedNames).toEqual(['Anna']);
    expect(ctx.forbiddenNames).toContain('Bob');
  });

  it('a top-track fact needs at least 3 plays', () => {
    plays('A', 'https://y/fav', 4, { name: 'Anna' });
    plays('B', 'https://y/other', 2, { name: 'Bob' });
    const ctx = buildContext({ previous, next, present: [A, B], store });
    const members = ctx.facts.filter((f) => f.kind === 'member');
    expect(members).toHaveLength(1);
    expect(members[0].text).toMatch(/^Anna's most-played track is .* 4 times\.$/);
  });

  it('absent members never appear in allowedNames or member facts', () => {
    plays('C', NEXT_URL, 9, { name: 'Carl' });
    const ctx = buildContext({ previous, next, present: [A], store });
    expect(ctx.facts.some((f) => f.userId === 'C')).toBe(false);
    expect(ctx.allowedNames).not.toContain('Carl');
    expect(ctx.forbiddenNames).toContain('Carl');
  });

  it('opted-out present members never appear in allowedNames or member facts', () => {
    plays('A', NEXT_URL, 5, { name: 'Anna' });
    plays('A', 'https://y/fav', 6, { name: 'Anna' });
    store.setShoutoutOptOut('A', true);
    const ctx = buildContext({ previous, next, present: [A, B], store });
    expect(ctx.facts.some((f) => f.userId === 'A')).toBe(false);
    expect(ctx.allowedNames).toEqual([]);
    expect(ctx.forbiddenNames).toEqual(expect.arrayContaining(['Anna', 'anna_u']));
    expect(ctx.present.find((m) => m.userId === 'A').optedOut).toBe(true);
  });

  it('group facts never name anyone and may count opted-out members (FR-020)', () => {
    plays('A', NEXT_URL, 2, { name: 'Anna', artist: 'ABBA' });
    plays('B', NEXT_URL, 2, { name: 'Bob', artist: 'ABBA' });
    plays('C', NEXT_URL, 1, { name: 'Carl', artist: 'ABBA' });
    store.setShoutoutOptOut('A', true);
    const ctx = buildContext({ previous, next, present: [A, B, C], store });
    const groups = ctx.facts.filter((f) => f.kind === 'group');
    expect(groups.map((g) => g.text)).toEqual([
      'People here have played this track 5 times.',
      '3 of the people here have queued ABBA this week.'
    ]);
    for (const g of groups) {
      expect(g.userId).toBeUndefined();
      for (const name of ['Anna', 'Bob', 'Carl', 'anna_u', 'bob_u', 'carl_u']) {
        expect(g.text).not.toContain(name);
      }
    }
  });

  it('two people present, one opted out: no group fact, so the other cannot subtract (FR-020)', () => {
    plays('A', NEXT_URL, 4, { name: 'Anna', artist: 'ABBA' });
    plays('B', NEXT_URL, 2, { name: 'Bob', artist: 'ABBA' });
    store.setShoutoutOptOut('A', true);
    const ctx = buildContext({ previous, next, present: [A, B], store });
    expect(ctx.facts.filter((f) => f.kind === 'group')).toEqual([]);
  });

  it('two opted-in people present still get group facts', () => {
    plays('A', NEXT_URL, 2, { name: 'Anna', artist: 'ABBA' });
    plays('B', NEXT_URL, 2, { name: 'Bob', artist: 'ABBA' });
    const ctx = buildContext({ previous, next, present: [A, B], store });
    expect(ctx.facts.filter((f) => f.kind === 'group').map((g) => g.text)).toEqual([
      'People here have played this track 4 times.',
      '2 of the people here have queued ABBA this week.'
    ]);
  });

  it('a known DJ from history who is not present is forbidden; DJ picks are not', () => {
    store.addToHistory({ title: 'x', url: 'u', requestedBy: 'Zed', requestedById: 'Z' });
    store.addToHistory({ title: 'x', url: 'u', requestedBy: 'SquareMusica DJ' });
    const ctx = buildContext({ previous, next, present: [A], store });
    expect(ctx.forbiddenNames).toContain('Zed');
    expect(ctx.forbiddenNames).not.toContain('SquareMusica DJ');
  });
});

describe('display names of absent members (R6 step 3, US3/AC2)', () => {
  it('a member seen in voice stays forbidden by display name after leaving', () => {
    plays('B', NEXT_URL, 3, { name: 'bob_u' }); // history holds the username
    buildContext({ previous, next, present: [A, B], store });
    const ctx = buildContext({ previous, next, present: [A], store });
    expect(ctx.forbiddenNames).toEqual(expect.arrayContaining(['Bob', 'bob_u']));
    expect(ctx.allowedNames).not.toContain('Bob');
  });

  it('a present, named member is not forbidden by their recorded display name', () => {
    plays('A', NEXT_URL, 3, { name: 'anna_u' });
    buildContext({ previous, next, present: [A], store });
    const ctx = buildContext({ previous, next, present: [A], store });
    expect(ctx.allowedNames).toEqual(['Anna']);
    expect(ctx.forbiddenNames).not.toContain('Anna');
  });
});

describe('queuedBy (FR-017, FR-020)', () => {
  const queuedByC = { ...next, requestedBy: 'carl_u', requestedById: 'C' };

  it('a first-time queuer who left produces no queuedBy and is forbidden', () => {
    const ctx = buildContext({ previous, next: queuedByC, present: [A], store });
    expect(ctx.next.queuedBy).toBeUndefined();
    expect(ctx.facts.some((f) => /Carl|carl_u/.test(f.text))).toBe(false);
    expect(ctx.forbiddenNames).toContain('carl_u');
  });

  it('a present opted-out queuer produces no queuedBy and is forbidden', () => {
    store.setShoutoutOptOut('C', true);
    const ctx = buildContext({ previous, next: queuedByC, present: [A, C], store });
    expect(ctx.next.queuedBy).toBeUndefined();
    expect(ctx.forbiddenNames).toEqual(expect.arrayContaining(['Carl', 'carl_u']));
  });

  it('a present opted-in queuer is named by speakable name and allowed', () => {
    const ctx = buildContext({
      previous,
      next: queuedByC,
      present: [A, { ...C, displayName: 'Carl 🎸' }],
      store
    });
    expect(ctx.next.queuedBy).toBe('Carl');
    expect(ctx.allowedNames).toEqual(['Carl']);
    expect(ctx.allowedMembers).toEqual([{ userId: 'C', name: 'Carl' }]);
    expect(ctx.forbiddenNames).not.toContain('Carl');
    expect(ctx.facts.find((f) => f.trackId === 't2').text).toMatch(/queued by Carl\.$/);
  });

  it('a DJ pick is queued by "the DJ"', () => {
    const ctx = buildContext({ previous, next: { ...next, addedByDj: true }, present: [A], store });
    expect(ctx.next.queuedBy).toBe('the DJ');
    expect(ctx.allowedNames).toEqual([]);
  });
});
