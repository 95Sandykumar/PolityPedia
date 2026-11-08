/**
 * Delete, archive and restore on the teacher lists
 * (issue 45-keep-money-and-scores).
 *
 * Pins what the teacher sees: Delete asks once, the toast tells which of
 * "deleted" or "archived" Postgres chose, an archived row moves under the
 * Archived tab, and Restore brings it back. Run against the mock set list, the
 * papers list and the batches list, which share one hook.
 *
 * The archive client is a prop, so the test injects a fake: no real network
 * call and no key (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherBatches } from '../teacher-batches';
import { TeacherMocks } from '../teacher-mocks';
import { TeacherPapersForm } from '../teacher-papers-form';
import type { BrowserArchiveClient } from '@/lib/archive/types';
import type { BatchRow } from '@/lib/batches/types';
import type { Exam } from '@/lib/exams/types';
import { dictionary } from '@/lib/i18n';
import type { MockSet } from '@/lib/mocks/types';
import type { Paper } from '@/lib/papers/types';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const TEACHER = '44444444-4444-4444-8444-444444444444';
const SET = '55555555-5555-4555-8555-555555555555';
const NET = 'a4000001-0000-4000-8000-000000000001';
const en = dictionary.en;

const EXAMS: Exam[] = [
  {
    id: NET,
    code: 'ugc-net',
    nameEn: 'UGC NET',
    nameHi: 'यूजीसी नेट',
    marksCorrect: 2,
    marksWrong: 0,
    durationMin: 180,
    questionCount: 100,
    markingUnverified: false,
  },
];

function mockSet(over: Partial<MockSet> = {}): MockSet {
  return {
    id: SET,
    teacherId: TEACHER,
    examId: NET,
    title: 'Sold set',
    priceInr: 349,
    status: 'live',
    ...over,
  };
}

function archiveClient(over: Partial<BrowserArchiveClient> = {}): BrowserArchiveClient {
  return {
    remove: vi.fn(async () => 'archived' as const),
    restore: vi.fn(async () => undefined),
    ...over,
  };
}

function renderMocks(sets: MockSet[], archive: BrowserArchiveClient) {
  return render(
    <TeacherMocks
      exams={EXAMS}
      sets={sets}
      sharePct={50}
      archiveClient={archive}
      client={{ saveSet: vi.fn(), saveTest: vi.fn(), publish: vi.fn() }}
    />,
  );
}

describe('mock set list', () => {
  it('asks once, then archives and says students who paid keep access', async () => {
    const archive = archiveClient();
    renderMocks([mockSet()], archive);

    fireEvent.click(screen.getByRole('button', { name: en['archive.delete'] }));
    // Nothing is sent until the teacher confirms.
    expect(archive.remove).not.toHaveBeenCalled();
    expect(screen.getByText(en['archive.confirmAsk'])).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: en['archive.confirmYes'] }));

    await waitFor(() => expect(archive.remove).toHaveBeenCalledWith('mock-set', SET));
    expect(await screen.findByText(en['archive.archivedSet'])).toBeTruthy();
    expect(en['archive.archivedSet']).toBe(
      'Archived. Students who paid keep access. Restore within 30 days.',
    );
    // It left the active list.
    expect(screen.queryByText('Sold set')).toBeNull();
  });

  it('says Deleted and drops the row when Postgres really deleted it', async () => {
    const archive = archiveClient({ remove: vi.fn(async () => 'deleted' as const) });
    renderMocks([mockSet({ status: 'draft' })], archive);

    fireEvent.click(screen.getByRole('button', { name: en['archive.delete'] }));
    fireEvent.click(screen.getByRole('button', { name: en['archive.confirmYes'] }));

    expect(await screen.findByText(en['archive.deleted'])).toBeTruthy();
    expect(screen.queryByText('Sold set')).toBeNull();
    // Nothing was archived, so there is no Archived tab.
    expect(screen.queryByRole('button', { name: new RegExp(en['archive.tabArchived']) })).toBeNull();
  });

  it('cancel sends nothing', () => {
    const archive = archiveClient();
    renderMocks([mockSet()], archive);

    fireEvent.click(screen.getByRole('button', { name: en['archive.delete'] }));
    fireEvent.click(screen.getByRole('button', { name: en['archive.cancel'] }));

    expect(archive.remove).not.toHaveBeenCalled();
    expect(screen.getByText('Sold set')).toBeTruthy();
  });

  it('shows archived sets only under the Archived tab, with Restore', async () => {
    const archive = archiveClient();
    renderMocks([mockSet({ archivedAt: '2026-11-01T00:00:00Z' }), mockSet({ id: 'b', title: 'Live set' })], archive);

    expect(screen.getByText('Live set')).toBeTruthy();
    expect(screen.queryByText('Sold set')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['archive.tabArchived']) }));
    expect(screen.getByText('Sold set')).toBeTruthy();
    expect(screen.queryByText('Live set')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: en['archive.restore'] }));
    await waitFor(() => expect(archive.restore).toHaveBeenCalledWith('mock-set', SET));
    expect(await screen.findByText(en['archive.restored'])).toBeTruthy();
    // Nothing is archived any more, so the tab and the row go back to Active.
    fireEvent.click(screen.getByRole('button', { name: en['archive.tabActive'] }));
    expect(screen.getByText('Sold set')).toBeTruthy();
  });

  it('tells the teacher when the 30 days are over, without a server message', async () => {
    const archive = archiveClient({
      restore: vi.fn(async () => {
        throw new Error('window-over');
      }),
    });
    renderMocks([mockSet({ archivedAt: '2026-09-01T00:00:00Z' })], archive);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['archive.tabArchived']) }));
    fireEvent.click(screen.getByRole('button', { name: en['archive.restore'] }));

    expect((await screen.findByRole('alert')).textContent).toBe(en['archive.windowOver']);
  });

  it('shows one generic line when the call fails', async () => {
    const archive = archiveClient({
      remove: vi.fn(async () => {
        throw new Error('Request failed with status 502');
      }),
    });
    renderMocks([mockSet()], archive);

    fireEvent.click(screen.getByRole('button', { name: en['archive.delete'] }));
    fireEvent.click(screen.getByRole('button', { name: en['archive.confirmYes'] }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(en['archive.failed']);
    expect(screen.getByText('Sold set')).toBeTruthy();
  });

  it('has a Hindi line for every archive label', () => {
    for (const key of Object.keys(en).filter((one) => one.startsWith('archive.'))) {
      expect(dictionary.hi[key as keyof typeof dictionary.hi]).toBeTruthy();
    }
  });
});

describe('papers list', () => {
  const paper: Paper = {
    id: '66666666-6666-4666-8666-666666666666',
    teacherId: TEACHER,
    examId: NET,
    year: 2024,
    month: 6,
    label: 'Shift 1',
    questionsPath: 'papers/q.pdf',
    solutionsPath: null,
    status: 'live',
  };

  it('archives a paper somebody sat and says their results are kept', async () => {
    const archive = archiveClient();
    render(
      <TeacherPapersForm
        exams={EXAMS}
        papers={[paper]}
        archiveClient={archive}
        client={{ create: vi.fn() }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: en['archive.delete'] }));
    fireEvent.click(screen.getByRole('button', { name: en['archive.confirmYes'] }));

    await waitFor(() => expect(archive.remove).toHaveBeenCalledWith('paper', paper.id));
    expect(await screen.findByText(en['archive.archivedPaper'])).toBeTruthy();
  });
});

describe('batches list', () => {
  const batch: BatchRow = {
    id: '77777777-7777-4777-8777-777777777777',
    teacherId: TEACHER,
    name: 'Morning batch',
    joinCode: 'ABCD23',
    studentCount: 4,
  };

  it('archives a batch with members and says the reports are kept', async () => {
    const archive = archiveClient();
    render(
      <TeacherBatches
        batches={[batch]}
        origin="https://example.test"
        archiveClient={archive}
        client={{ saveBatch: vi.fn() } as never}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: en['archive.delete'] }));
    fireEvent.click(screen.getByRole('button', { name: en['archive.confirmYes'] }));

    await waitFor(() => expect(archive.remove).toHaveBeenCalledWith('batch', batch.id));
    expect(await screen.findByText(en['archive.archivedBatch'])).toBeTruthy();
  });

  it('an archived batch shows Restore and no join code to copy', () => {
    render(
      <TeacherBatches
        batches={[{ ...batch, archivedAt: '2026-11-01T00:00:00Z' }]}
        origin="https://example.test"
        archiveClient={archiveClient()}
        client={{ saveBatch: vi.fn() } as never}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: new RegExp(en['archive.tabArchived']) }));
    expect(screen.getByRole('button', { name: en['archive.restore'] })).toBeTruthy();
    expect(screen.queryByText('ABCD23')).toBeNull();
  });
});
