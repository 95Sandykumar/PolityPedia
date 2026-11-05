/**
 * The batch contract (issue 19-batches).
 *
 * Pure functions only: the join code a student typed, the links a teacher
 * copies, and the shape of a name a route will accept. Nothing here is
 * permission. The gate is `0019_batches.sql`.
 */
import { describe, expect, it } from 'vitest';
import {
  JOIN_CODE_LENGTH,
  MAX_BATCH_NAME_LENGTH,
  batchPath,
  countMembers,
  joinLink,
  joinPath,
  normalizeJoinCode,
  readBatchName,
  setsOfBatch,
} from '../types';

describe('normalizeJoinCode', () => {
  it('upper-cases and trims what a student typed', () => {
    expect(normalizeJoinCode('  abc234 ')).toBe('ABC234');
  });

  it('drops the spaces and dashes a code is pasted with', () => {
    expect(normalizeJoinCode('ABC-234')).toBe('ABC234');
    expect(normalizeJoinCode('ABC 234')).toBe('ABC234');
  });

  it('refuses the ambiguous characters the generator never uses', () => {
    // O/0 and I/1 are not in the alphabet, so a code containing one was
    // mistyped. Saying so beats a round trip that comes back "no such batch".
    expect(normalizeJoinCode('ABCO23')).toBeNull();
    expect(normalizeJoinCode('ABC1234')).toBeNull();
  });

  it('refuses a code that is too short or too long', () => {
    expect(normalizeJoinCode('ABC23')).toBeNull();
    expect(normalizeJoinCode('ABCDEFGHJKLMN')).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    expect(normalizeJoinCode(null)).toBeNull();
    expect(normalizeJoinCode(42)).toBeNull();
    expect(normalizeJoinCode(undefined)).toBeNull();
  });

  it('is the length the migration generates', () => {
    expect(JOIN_CODE_LENGTH).toBe(6);
  });
});

describe('the links a teacher shares', () => {
  it('builds the join path from the code', () => {
    expect(joinPath('ABC234')).toBe('/join/ABC234');
  });

  it('normalises the code inside the path', () => {
    expect(joinPath(' abc234 ')).toBe('/join/ABC234');
  });

  it('builds a full link a teacher can paste into WhatsApp', () => {
    expect(joinLink('https://politypedia.in', 'ABC234')).toBe(
      'https://politypedia.in/join/ABC234',
    );
  });

  it('never doubles the slash when the origin has one', () => {
    expect(joinLink('https://politypedia.in/', 'ABC234')).toBe(
      'https://politypedia.in/join/ABC234',
    );
  });

  it('falls back to the path alone when there is no origin yet', () => {
    // Server-rendered first paint has no `window.location`.
    expect(joinLink('', 'ABC234')).toBe('/join/ABC234');
  });

  it('builds the teacher page for one batch', () => {
    expect(batchPath('b1')).toBe('/teacher/batches/b1');
  });
});

describe('readBatchName', () => {
  it('trims the name a teacher typed', () => {
    expect(readBatchName({ name: '  Morning batch ' })).toBe('Morning batch');
  });

  it('refuses a blank name, the same as the CHECK constraint', () => {
    expect(readBatchName({ name: '   ' })).toBeNull();
    expect(readBatchName({ name: '' })).toBeNull();
  });

  it('refuses a name longer than the column allows', () => {
    expect(readBatchName({ name: 'x'.repeat(MAX_BATCH_NAME_LENGTH) })).toHaveLength(
      MAX_BATCH_NAME_LENGTH,
    );
    expect(readBatchName({ name: 'x'.repeat(MAX_BATCH_NAME_LENGTH + 1) })).toBeNull();
  });

  it('refuses a body that is not an object with a string name', () => {
    expect(readBatchName(null)).toBeNull();
    expect(readBatchName({ name: 7 })).toBeNull();
    expect(readBatchName('Morning batch')).toBeNull();
  });
});

describe('countMembers', () => {
  it('counts the students per batch', () => {
    const members = [
      { batchId: 'b1', userId: 'u1', joinedAt: 'x' },
      { batchId: 'b1', userId: 'u2', joinedAt: 'x' },
      { batchId: 'b2', userId: 'u1', joinedAt: 'x' },
    ];
    const counts = countMembers(members);
    expect(counts.get('b1')).toBe(2);
    expect(counts.get('b2')).toBe(1);
  });

  it('leaves an empty batch out, so the caller reads 0 not undefined-as-1', () => {
    expect(countMembers([]).get('b1')).toBeUndefined();
  });
});

describe('setsOfBatch', () => {
  it('lists the set ids one batch gives away', () => {
    const links = [
      { batchId: 'b1', setId: 's1' },
      { batchId: 'b2', setId: 's2' },
      { batchId: 'b1', setId: 's3' },
    ];
    expect(setsOfBatch(links, 'b1').sort()).toEqual(['s1', 's3']);
  });

  it('is empty for a batch that gives nothing away', () => {
    expect(setsOfBatch([], 'b1')).toEqual([]);
  });
});
