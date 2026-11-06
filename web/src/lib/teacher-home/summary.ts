/**
 * The numbers and the to-do list on the teacher's Home screen (teacher-ui).
 *
 * PURE: it takes rows the server already read and counts them. No fetch, no
 * Supabase, no env, so it is the same on the server and in a test.
 *
 * "Needs your attention" is only ever a DRAFT the teacher can finish: a paper
 * that is not live yet (check the questions, then publish) or a mock set that
 * is not live yet (add tests, then publish). Nothing else is invented.
 */
import type { BatchRow } from '@/lib/batches/types';
import { mockSetPath, type MockSet } from '@/lib/mocks/types';
import type { Paper } from '@/lib/papers/types';
import { paperReviewPath } from '@/lib/questions/types';
import type { TeacherStatus } from '@/lib/teachers/types';

/** How many to-do rows the Home screen lists before it says "and more". */
export const ATTENTION_LIMIT = 5;

export interface OwnTeacher {
  /** The name the teacher greets themselves with, or null when there is none. */
  name: string | null;
  status: TeacherStatus | null;
}

export interface StatusCount {
  total: number;
  live: number;
  draft: number;
}

export interface AttentionItem {
  kind: 'paper' | 'mock';
  id: string;
  title: string;
  href: string;
}

export interface TeacherHomeSummary {
  name: string | null;
  status: TeacherStatus | null;
  papers: StatusCount;
  mocks: StatusCount;
  batches: number;
  /** Students across every batch. A student in two batches counts twice. */
  students: number;
  notices: number;
  videos: number;
  /** At most `ATTENTION_LIMIT` rows. */
  attention: AttentionItem[];
  /** The full count, so the screen can say "+2 more". */
  attentionTotal: number;
}

function countStatus(rows: readonly { status: string }[]): StatusCount {
  const live = rows.filter((row) => row.status === 'live').length;
  return { total: rows.length, live, draft: rows.length - live };
}

export function summarizeTeacherHome(input: {
  teacher: OwnTeacher;
  papers: readonly Paper[];
  mocks: readonly MockSet[];
  batches: readonly BatchRow[];
  notices: number;
  videos: number;
}): TeacherHomeSummary {
  const draftPapers: AttentionItem[] = input.papers
    .filter((paper) => paper.status !== 'live')
    .map((paper) => ({
      kind: 'paper',
      id: paper.id,
      title: paper.label,
      href: paperReviewPath(paper.id),
    }));

  const draftMocks: AttentionItem[] = input.mocks
    .filter((set) => set.status !== 'live')
    .map((set) => ({
      kind: 'mock',
      id: set.id,
      title: set.title,
      href: mockSetPath(set.id),
    }));

  const all = [...draftPapers, ...draftMocks];

  return {
    name: input.teacher.name,
    status: input.teacher.status,
    papers: countStatus(input.papers),
    mocks: countStatus(input.mocks),
    batches: input.batches.length,
    students: input.batches.reduce((sum, row) => sum + row.studentCount, 0),
    notices: input.notices,
    videos: input.videos,
    attention: all.slice(0, ATTENTION_LIMIT),
    attentionTotal: all.length,
  };
}
