/**
 * The decision logic behind the two review routes
 * (issue 11-ingest-job-review-publish).
 *
 * Order of checks is the point of most of these tests: session, role, config,
 * then the body. A body is never looked at before we know who is asking.
 *
 * V9 is the headline: `handleSaveQuestion` cannot publish anything, and
 * `handlePublishPaper` turns the three Postgres refusals into three short
 * replies with no Postgres text in them.
 */
import { describe, expect, it, vi } from 'vitest';
import { handlePublishPaper, handleSaveQuestion } from '../questions-route';
import type { AuthSession } from '@/lib/auth/types';
import type { Question, QuestionsClient } from '../types';

const TEACHER = '44444444-4444-4444-8444-444444444444';
const PAPER = '55555555-5555-4555-8555-555555555555';
const QUESTION = '66666666-6666-4666-8666-666666666666';

function session(role: AuthSession['role'] = 'teacher'): AuthSession {
  return {
    userId: TEACHER,
    role,
    accessToken: 'caller-token',
    refreshToken: 'refresh',
    ...(role === 'teacher' ? { teacherStatus: 'approved' as const } : {}),
  };
}

const STORED: Question = {
  id: QUESTION,
  teacherId: TEACHER,
  paperId: PAPER,
  testId: null,
  number: 1,
  stem: 'Which house is the Council of States?',
  options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
  correctIdx: 1,
  teacherExplanation: null,
  topicId: null,
  lang: 'en',
  imagePath: null,
  checked: true,
  status: 'draft',
};

function client(over: Partial<QuestionsClient> = {}): QuestionsClient {
  return {
    isConfigured: () => true,
    listForPaper: vi.fn(async () => [STORED]),
    save: vi.fn(async () => STORED),
    publishPaper: vi.fn(async () => 3),
    ...over,
  };
}

const BODY = {
  id: null,
  paperId: PAPER,
  number: 1,
  stem: 'Which house is the Council of States?',
  options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
  correctIdx: 1,
  teacherExplanation: null,
  lang: 'en',
  checked: true,
};

function named(name: string) {
  return Object.assign(new Error('refused'), { name });
}

describe('handleSaveQuestion', () => {
  it('asks a visitor to sign in, without touching the body', async () => {
    const save = vi.fn();
    const reply = await handleSaveQuestion({
      body: BODY,
      session: null,
      client: client({ save }),
    });
    expect(reply.status).toBe(401);
    expect(save).not.toHaveBeenCalled();
  });

  it('turns a student away before the body is read', async () => {
    const save = vi.fn();
    const reply = await handleSaveQuestion({
      body: BODY,
      session: session('student'),
      client: client({ save }),
    });
    expect(reply.status).toBe(403);
    expect(save).not.toHaveBeenCalled();
  });

  it('says not configured when the Supabase keys are missing', async () => {
    const reply = await handleSaveQuestion({
      body: BODY,
      session: session(),
      client: client({ isConfigured: () => false }),
    });
    expect(reply.status).toBe(503);
  });

  it('stores a good question and hands the row back', async () => {
    const save = vi.fn(async () => STORED);
    const reply = await handleSaveQuestion({
      body: BODY,
      session: session(),
      client: client({ save }),
    });

    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ ok: true, question: STORED });
    expect(save).toHaveBeenCalledWith({
      id: null,
      paperId: PAPER,
      number: 1,
      stem: 'Which house is the Council of States?',
      options: ['Lok Sabha', 'Rajya Sabha', 'Both', 'Neither'],
      correctIdx: 1,
      teacherExplanation: null,
      lang: 'en',
      checked: true,
    });
  });

  it('never passes a status on, even when the body carries one (V9)', async () => {
    const seen: Record<string, unknown>[] = [];
    const save = vi.fn(async (edit) => {
      seen.push(edit as unknown as Record<string, unknown>);
      return STORED;
    });

    await handleSaveQuestion({
      body: { ...BODY, status: 'live', teacherId: 'somebody-else' },
      session: session(),
      client: client({ save }),
    });

    expect(seen[0]).not.toHaveProperty('status');
    expect(seen[0]).not.toHaveProperty('teacherId');
  });

  it('refuses three options, a blank stem and a correct answer out of range', async () => {
    for (const bad of [
      { ...BODY, options: ['a', 'b', 'c'] },
      { ...BODY, stem: '  ' },
      { ...BODY, correctIdx: 9 },
      { ...BODY, paperId: 'paper-1' },
      null,
    ]) {
      const reply = await handleSaveQuestion({
        body: bad,
        session: session(),
        client: client(),
      });
      expect(reply.status).toBe(400);
    }
  });

  it('answers 409 when that question number is already taken', async () => {
    const reply = await handleSaveQuestion({
      body: BODY,
      session: session(),
      client: client({
        save: vi.fn(async () => {
          throw named('QuestionConflict');
        }),
      }),
    });
    expect(reply).toEqual({ status: 409, body: { error: 'duplicate number' } });
  });

  it('answers 502 with a fixed message when Supabase fails', async () => {
    const reply = await handleSaveQuestion({
      body: BODY,
      session: session(),
      client: client({
        save: vi.fn(async () => {
          throw new Error('policy questions_insert_own blocked it');
        }),
      }),
    });
    expect(reply).toEqual({ status: 502, body: { error: 'save failed' } });
  });

  it('lets an admin through, because an admin outranks a teacher', async () => {
    const reply = await handleSaveQuestion({
      body: BODY,
      session: session('admin'),
      client: client(),
    });
    expect(reply.status).toBe(200);
  });
});

describe('handlePublishPaper', () => {
  it('asks a visitor to sign in', async () => {
    const publishPaper = vi.fn();
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: null,
      client: client({ publishPaper }),
    });
    expect(reply.status).toBe(401);
    expect(publishPaper).not.toHaveBeenCalled();
  });

  it('turns a student away', async () => {
    const publishPaper = vi.fn();
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: session('student'),
      client: client({ publishPaper }),
    });
    expect(reply.status).toBe(403);
    expect(publishPaper).not.toHaveBeenCalled();
  });

  it('says not configured when the Supabase keys are missing', async () => {
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: session(),
      client: client({ isConfigured: () => false }),
    });
    expect(reply.status).toBe(503);
  });

  it('refuses a paper id that is not a uuid', async () => {
    const publishPaper = vi.fn();
    const reply = await handlePublishPaper({
      paperId: 'paper-1',
      session: session(),
      client: client({ publishPaper }),
    });
    expect(reply.status).toBe(400);
    expect(publishPaper).not.toHaveBeenCalled();
  });

  it('publishes and reports how many questions went live', async () => {
    const publishPaper = vi.fn(async () => 42);
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: session(),
      client: client({ publishPaper }),
    });

    expect(reply).toEqual({ status: 200, body: { ok: true, published: 42 } });
    expect(publishPaper).toHaveBeenCalledWith(PAPER);
  });

  it('answers 409 "unchecked" while one question is not checked (F-D3)', async () => {
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: session(),
      client: client({
        publishPaper: vi.fn(async () => {
          throw named('PublishUnchecked');
        }),
      }),
    });
    expect(reply).toEqual({ status: 409, body: { error: 'unchecked' } });
  });

  it('answers 409 "splitting" while the split job is still going (Risk 1)', async () => {
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: session(),
      client: client({
        publishPaper: vi.fn(async () => {
          throw named('PublishSplitting');
        }),
      }),
    });
    expect(reply).toEqual({ status: 409, body: { error: 'splitting' } });
  });

  it('answers 404 for a paper that is not the caller own', async () => {
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: session(),
      client: client({
        publishPaper: vi.fn(async () => {
          throw named('PublishForbidden');
        }),
      }),
    });
    // 404, not 403: "that paper exists but is not yours" is nobody's business.
    expect(reply).toEqual({ status: 404, body: { error: 'not found' } });
  });

  it('answers 502 with a fixed message for anything else', async () => {
    const reply = await handlePublishPaper({
      paperId: PAPER,
      session: session(),
      client: client({
        publishPaper: vi.fn(async () => {
          throw new Error('function public.publish_paper does not exist');
        }),
      }),
    });
    expect(reply).toEqual({ status: 502, body: { error: 'publish failed' } });
  });
});
