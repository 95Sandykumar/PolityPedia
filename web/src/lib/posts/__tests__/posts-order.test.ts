/**
 * Ordering and the Home feed rule (issue 09-teacher-notifications).
 *
 * Two of the three proofs the issue asks for live here as pure functions, so
 * they are decided once and every screen reuses the same answer:
 *
 *  1. `sortPosts`  : highest priority first, then newest first.
 *  2. `homeFeed`   : Home shows posts ONLY from followed teachers, at most 5.
 *
 * Postgres orders the same way in `0009_teacher_posts.sql`, and
 * `test/teacher-posts.test.ts` proves that half. These functions are what keeps
 * a page honest even when a response comes back in another order.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_HOME_POSTS,
  homeFeed,
  isPriority,
  normalizeHeading,
  normalizeLink,
  sortPosts,
  type TeacherPost,
} from '../types';

const GURU = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function post(partial: Partial<TeacherPost> & { heading: string }): TeacherPost {
  return {
    id: partial.heading,
    teacherId: partial.teacherId ?? GURU,
    priority: partial.priority ?? 0,
    heading: partial.heading,
    link: partial.link ?? null,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00Z',
  };
}

describe('sortPosts', () => {
  it('puts the highest priority first, then the newest first', () => {
    const input = [
      post({ heading: 'old normal', priority: 0, createdAt: '2026-01-01T00:00:00Z' }),
      post({ heading: 'new normal', priority: 0, createdAt: '2026-03-01T00:00:00Z' }),
      post({ heading: 'old urgent', priority: 2, createdAt: '2026-01-01T00:00:00Z' }),
      post({ heading: 'new important', priority: 1, createdAt: '2026-04-01T00:00:00Z' }),
    ];

    expect(sortPosts(input).map((p) => p.heading)).toEqual([
      'old urgent',
      'new important',
      'new normal',
      'old normal',
    ]);
  });

  it('beats date with priority, even when the low post is much newer', () => {
    const input = [
      post({ heading: 'normal, tomorrow', priority: 0, createdAt: '2027-12-31T00:00:00Z' }),
      post({ heading: 'urgent, last year', priority: 2, createdAt: '2025-01-01T00:00:00Z' }),
    ];
    expect(sortPosts(input)[0].heading).toBe('urgent, last year');
  });

  it('does not change the array it was given', () => {
    const input = [
      post({ heading: 'a', priority: 0 }),
      post({ heading: 'b', priority: 2 }),
    ];
    const before = input.map((p) => p.heading);
    sortPosts(input);
    expect(input.map((p) => p.heading)).toEqual(before);
  });

  it('keeps an unreadable date at the back instead of throwing', () => {
    const input = [
      post({ heading: 'broken date', createdAt: 'not a date' }),
      post({ heading: 'good date', createdAt: '2026-01-01T00:00:00Z' }),
    ];
    expect(sortPosts(input).map((p) => p.heading)).toEqual(['good date', 'broken date']);
  });

  it('is happy with an empty list', () => {
    expect(sortPosts([])).toEqual([]);
  });
});

describe('homeFeed', () => {
  const followed = [
    { userId: GURU, displayName: 'Polity Guru' },
  ];

  it('shows posts only from the teachers the student follows', () => {
    const feed = homeFeed({
      teachers: followed,
      posts: [
        post({ heading: 'from a followed teacher', teacherId: GURU }),
        post({ heading: 'from a stranger', teacherId: OTHER }),
      ],
    });

    expect(feed.map((p) => p.heading)).toEqual(['from a followed teacher']);
  });

  it('is empty when the student follows nobody, whatever posts arrive', () => {
    const feed = homeFeed({
      teachers: [],
      posts: [post({ heading: 'nobody asked', teacherId: GURU })],
    });
    expect(feed).toEqual([]);
  });

  it('names the author, because Home mixes several teachers', () => {
    const feed = homeFeed({
      teachers: [
        { userId: GURU, displayName: 'Polity Guru' },
        { userId: OTHER, displayName: 'Second Guru' },
      ],
      posts: [
        post({ heading: 'one', teacherId: GURU, priority: 1 }),
        post({ heading: 'two', teacherId: OTHER }),
      ],
    });

    expect(feed.map((p) => [p.heading, p.teacherName])).toEqual([
      ['one', 'Polity Guru'],
      ['two', 'Second Guru'],
    ]);
  });

  it('keeps 5 at most, the highest priority and newest of them', () => {
    const posts = [
      post({ heading: 'p0 a', createdAt: '2026-01-01T00:00:00Z' }),
      post({ heading: 'p0 b', createdAt: '2026-01-02T00:00:00Z' }),
      post({ heading: 'p0 c', createdAt: '2026-01-03T00:00:00Z' }),
      post({ heading: 'p0 d', createdAt: '2026-01-04T00:00:00Z' }),
      post({ heading: 'p0 e', createdAt: '2026-01-05T00:00:00Z' }),
      post({ heading: 'urgent', priority: 2, createdAt: '2025-01-01T00:00:00Z' }),
    ];

    const feed = homeFeed({ teachers: followed, posts });

    expect(MAX_HOME_POSTS).toBe(5);
    expect(feed).toHaveLength(5);
    expect(feed.map((p) => p.heading)).toEqual(['urgent', 'p0 e', 'p0 d', 'p0 c', 'p0 b']);
  });

  it('takes a smaller limit when a caller asks for one', () => {
    const feed = homeFeed({
      teachers: followed,
      posts: [post({ heading: 'one' }), post({ heading: 'two' })],
      limit: 1,
    });
    expect(feed).toHaveLength(1);
  });
});

describe('input rules', () => {
  it('accepts only the three priorities', () => {
    expect([0, 1, 2].every(isPriority)).toBe(true);
    for (const bad of [-1, 3, 1.5, '1', null, undefined, NaN]) {
      expect(isPriority(bad)).toBe(false);
    }
  });

  it('trims a heading and refuses a blank or an over-long one', () => {
    expect(normalizeHeading('  NET form is out  ')).toBe('NET form is out');
    expect(normalizeHeading('   ')).toBeNull();
    expect(normalizeHeading('')).toBeNull();
    expect(normalizeHeading(42)).toBeNull();
    expect(normalizeHeading('x'.repeat(201))).toBeNull();
    expect(normalizeHeading('x'.repeat(200))).toHaveLength(200);
  });

  it('allows http and https links and refuses every other scheme', () => {
    expect(normalizeLink('https://ugcnet.nta.ac.in')).toBe('https://ugcnet.nta.ac.in');
    expect(normalizeLink('  http://nta.ac.in  ')).toBe('http://nta.ac.in');
    expect(normalizeLink('')).toBeNull();
    expect(normalizeLink(null)).toBeNull();
    expect(normalizeLink(undefined)).toBeNull();
  });

  it('refuses a link that could run code in the page', () => {
    // The heading and the link both end up in the DOM, so this is the gate
    // that stops an href from becoming a script. Postgres repeats the check.
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox',
      'file:///etc/passwd',
      '//evil.example.com',
      'ugcnet.nta.ac.in',
      42,
    ]) {
      expect(normalizeLink(bad)).toBeNull();
    }
  });
});
