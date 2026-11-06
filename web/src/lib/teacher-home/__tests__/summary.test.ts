import { describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@/lib/auth/types';
import type { BatchRow } from '@/lib/batches/types';
import type { MockSet } from '@/lib/mocks/types';
import type { Paper } from '@/lib/papers/types';
import { parseOwnTeacher, readOwnTeacher } from '../read-home';
import { ATTENTION_LIMIT, summarizeTeacherHome } from '../summary';

const TEACHER = '11111111-1111-4111-8111-111111111111';

function paper(over: Partial<Paper> = {}): Paper {
  return {
    id: 'p1',
    teacherId: TEACHER,
    examId: 'e1',
    year: 2024,
    month: null,
    label: 'NET 2024',
    questionsPath: 'a.pdf',
    solutionsPath: null,
    status: 'live',
    ...over,
  };
}

function set(over: Partial<MockSet> = {}): MockSet {
  return {
    id: 's1',
    teacherId: TEACHER,
    examId: 'e1',
    title: 'Full mock 1',
    priceInr: 299,
    status: 'live',
    ...over,
  };
}

function batch(over: Partial<BatchRow> = {}): BatchRow {
  return { id: 'b1', teacherId: TEACHER, name: 'Morning', joinCode: 'ABC234', studentCount: 3, ...over };
}

const base = { teacher: { name: 'Asha', status: 'approved' as const }, notices: 0, videos: 0 };

describe('summarizeTeacherHome', () => {
  it('counts live and draft papers and mock sets', () => {
    const out = summarizeTeacherHome({
      ...base,
      papers: [paper(), paper({ id: 'p2', status: 'draft' }), paper({ id: 'p3', status: 'draft' })],
      mocks: [set(), set({ id: 's2', status: 'draft' })],
      batches: [],
    });
    expect(out.papers).toEqual({ total: 3, live: 1, draft: 2 });
    expect(out.mocks).toEqual({ total: 2, live: 1, draft: 1 });
  });

  it('adds up students across batches and counts the batches', () => {
    const out = summarizeTeacherHome({
      ...base,
      papers: [],
      mocks: [],
      batches: [batch(), batch({ id: 'b2', studentCount: 4 })],
    });
    expect(out.batches).toBe(2);
    expect(out.students).toBe(7);
  });

  it('lists drafts, and only drafts, as needing attention with a link to finish them', () => {
    const out = summarizeTeacherHome({
      ...base,
      papers: [paper(), paper({ id: 'p2', label: 'Draft paper', status: 'draft' })],
      mocks: [set(), set({ id: 's2', title: 'Draft set', status: 'draft' })],
      batches: [],
    });
    expect(out.attentionTotal).toBe(2);
    expect(out.attention).toEqual([
      { kind: 'paper', id: 'p2', title: 'Draft paper', href: '/teacher/papers/p2/review' },
      { kind: 'mock', id: 's2', title: 'Draft set', href: '/teacher/mocks/s2' },
    ]);
  });

  it('caps the attention list but keeps the full count', () => {
    const papers = Array.from({ length: ATTENTION_LIMIT + 3 }, (_, i) =>
      paper({ id: `p${i}`, status: 'draft' }),
    );
    const out = summarizeTeacherHome({ ...base, papers, mocks: [], batches: [] });
    expect(out.attention).toHaveLength(ATTENTION_LIMIT);
    expect(out.attentionTotal).toBe(ATTENTION_LIMIT + 3);
  });

  it('is all zeros and an empty list for a brand new teacher', () => {
    const out = summarizeTeacherHome({ ...base, papers: [], mocks: [], batches: [] });
    expect(out.papers.total).toBe(0);
    expect(out.attention).toEqual([]);
    expect(out.attentionTotal).toBe(0);
  });
});

describe('parseOwnTeacher', () => {
  it('prefers the real name, then the alias', () => {
    expect(parseOwnTeacher({ real_name: 'Asha Rao', alias: 'Prof A', status: 'approved' })).toEqual({
      name: 'Asha Rao',
      status: 'approved',
    });
    expect(parseOwnTeacher({ real_name: null, alias: 'Prof A', status: 'pending' })).toEqual({
      name: 'Prof A',
      status: 'pending',
    });
  });

  it('fails closed on junk: no name, no status', () => {
    expect(parseOwnTeacher({ real_name: '  ', status: 'root' })).toEqual({ name: null, status: null });
    expect(parseOwnTeacher(undefined)).toEqual({ name: null, status: null });
  });
});

describe('readOwnTeacher', () => {
  const session = { accessToken: 'tok', refreshToken: 'r', userId: TEACHER, role: 'teacher' } as AuthSession;
  const env = { NEXT_PUBLIC_SUPABASE_URL: 'https://x.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon' };

  it('reads the caller own row with the caller token', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json([{ real_name: 'Asha', alias: null, status: 'approved' }]),
    );
    const out = await readOwnTeacher(session, fetchImpl as unknown as typeof fetch, env);
    expect(out).toEqual({ name: 'Asha', status: 'approved' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://x.test/rest/v1/teachers?select=real_name,alias,status&limit=1');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('gives an empty answer when the keys are missing, signed out, or the read fails', async () => {
    const empty = { name: null, status: null };
    const never = vi.fn();
    expect(await readOwnTeacher(session, never as unknown as typeof fetch, {})).toEqual(empty);
    expect(await readOwnTeacher(null, never as unknown as typeof fetch, env)).toEqual(empty);
    expect(never).not.toHaveBeenCalled();

    const bad = vi.fn(async () => new Response('no', { status: 500 }));
    expect(await readOwnTeacher(session, bad as unknown as typeof fetch, env)).toEqual(empty);
    const boom = vi.fn(async () => {
      throw new Error('network');
    });
    expect(await readOwnTeacher(session, boom as unknown as typeof fetch, env)).toEqual(empty);
  });
});
