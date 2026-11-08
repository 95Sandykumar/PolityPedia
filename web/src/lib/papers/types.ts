/**
 * The past papers contract (issue 10-papers-upload-browse).
 *
 * V8: a past paper belongs to ONE teacher, and past papers are free for every
 * student. The browse path is Exam > Year > Month (optional) > paper, which is
 * what `groupPapers` below builds.
 *
 * Supabase sits behind these interfaces so tests can fake it: no real network
 * call, no real key and no real 30 MB file anywhere in the suite
 * (web/CLAUDE.md).
 *
 * Three kinds of client, because a key must never reach the browser:
 * - `PapersClient` runs on the server with the caller's own access token, so
 *   Postgres RLS (`papers_*`) is the real gate.
 * - `FileStore` is the same idea for Supabase Storage: upload and a signed
 *   download URL, nothing else.
 * - `BrowserPapersClient` posts to our own route handler and sees no key.
 */
import type { Exam } from '@/lib/exams/types';
import type { Lang, LangMode } from '@/lib/i18n';

/**
 * 30 MB per PDF (design.md V8 and PRD F-D2). The real reason is not storage:
 * Claude takes a 32 MB request at most, and issue 11 sends this very file to
 * it, so a paper over the cap could never be split.
 */
export const MAX_PDF_BYTES = 30 * 1024 * 1024;

/** The row name is one line on a 360 px phone, so it stays short. */
export const MAX_PAPER_LABEL_LENGTH = 60;

/** Matches the `papers_year_check` constraint in 0010. */
export const MIN_PAPER_YEAR = 1950;
export const MAX_PAPER_YEAR = 2100;

/** The Supabase Storage bucket the PDFs live in. */
export const PAPERS_BUCKET = 'papers';

/** How long a download link stays good. Short: the page mints a new one. */
export const SIGNED_URL_SECONDS = 60;

export type PaperStatus = 'draft' | 'live';

/** A paper carries the questions, the solutions, or both (PRD F-D1). */
export type PaperKind = 'questions' | 'solutions';

export const PAPER_KINDS: readonly PaperKind[] = ['questions', 'solutions'];

export function isPaperKind(value: unknown): value is PaperKind {
  return typeof value === 'string' && (PAPER_KINDS as readonly string[]).includes(value);
}

export function isPaperStatus(value: unknown): value is PaperStatus {
  return value === 'draft' || value === 'live';
}

/** One row of `papers`, as the app passes it around. */
export interface Paper {
  id: string;
  teacherId: string;
  examId: string;
  year: number;
  /** NULL when the paper is known by year only. Not the same as January. */
  month: number | null;
  label: string;
  /** Object path in the `papers` bucket, or null when there is no such PDF. */
  questionsPath: string | null;
  solutionsPath: string | null;
  status: PaperStatus;
  /** Set when the paper was archived (0041). Absent otherwise. */
  archivedAt?: string | null;
}

/** What the teacher fills in, before anything is uploaded. */
export interface PaperDraft {
  examId: string;
  year: number;
  month: number | null;
  label: string;
}

/** A draft plus the paths the upload produced. What `create` stores. */
export interface NewPaper extends PaperDraft {
  questionsPath: string | null;
  solutionsPath: string | null;
}

/**
 * One PDF on its way up, as the SERVER sees it.
 *
 * `size` is read before `bytes()` on purpose: a 31 MB file is refused without
 * ever being pulled into memory.
 */
export interface UploadFile {
  name: string;
  type: string;
  size: number;
  bytes(): Promise<Uint8Array>;
}

/**
 * One PDF as the BROWSER sees it: a `File` from an `<input type="file">`.
 * Typed as the three fields we check plus `Blob`, so a test can hand over a
 * fake 31 MB file without allocating 31 MB.
 */
export type PdfPick = Blob & { name: string; type: string; size: number };

/** Why a picked file was refused. The UI turns these into one short line. */
export type PdfProblem = 'empty' | 'too-big' | 'not-pdf';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The 30 MB gate, run in the browser AND on the server.
 *
 * In the browser because a phone on 4G must not spend ten minutes uploading a
 * file we will refuse at the end; on the server because a browser check is a
 * courtesy, never a rule.
 *
 * The type check accepts a `.pdf` name when the phone sends no type or a
 * generic one: Android's file picker reports `application/octet-stream` for a
 * PDF that came out of WhatsApp, and refusing that would be refusing a real
 * paper.
 */
export function checkPdf(file: {
  name: string;
  type: string;
  size: number;
}): PdfProblem | null {
  if (!Number.isFinite(file.size) || file.size <= 0) return 'empty';
  if (file.size > MAX_PDF_BYTES) return 'too-big';

  const type = file.type.toLowerCase();
  const named = file.name.toLowerCase().endsWith('.pdf');
  if (type === 'application/pdf') return null;
  if (named && (type === '' || type === 'application/octet-stream')) return null;
  return 'not-pdf';
}

/**
 * The object key for one PDF: `<teacherId>/<uniqueId>-<kind>.pdf`.
 *
 * The bucket name is NOT part of it: the bucket goes in the URL, the key goes
 * in the column, so renaming the bucket later never rewrites a row.
 *
 * The teacher id leads, so a storage policy can be "your own folder" and a
 * listing never mixes two teachers up. Both parts are checked, because this
 * string becomes a URL path: a `..` in either one would walk out of the
 * folder.
 */
export function paperPdfPath(teacherId: string, kind: PaperKind, uniqueId: string): string {
  if (!UUID_RE.test(teacherId)) throw new Error('teacher id must be a uuid');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(uniqueId)) throw new Error('bad file id');
  return `${teacherId}/${uniqueId}-${kind}.pdf`;
}

/** The download link for one PDF. Our own route, never a Supabase URL. */
export function paperDownloadPath(paperId: string, kind: PaperKind): string {
  return `/api/papers/${encodeURIComponent(paperId)}/download?kind=${kind}`;
}

/**
 * Short month names. A fixed table, not `Intl`: the build must give the same
 * string on every machine, and DESIGN.md keeps numbers in Latin digits in both
 * languages, which `Intl` with a Hindi locale does not promise. Same table as
 * `teacher-exams/types.ts`, kept here so neither slice imports the other.
 */
const MONTHS: Record<Lang, readonly string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  hi: ['जन', 'फ़र', 'मार्च', 'अप्रै', 'मई', 'जून', 'जुला', 'अग', 'सित', 'अक्तू', 'नव', 'दिस'],
};

/**
 * The month heading: one line for `en`/`hi`, English then Hindi for `both`.
 * Same shape as `labels()` in i18n.
 */
export function monthLabels(month: number, mode: LangMode): string[] {
  const langs: Lang[] = mode === 'both' ? ['en', 'hi'] : [mode];
  return langs.map((lang) => MONTHS[lang][month - 1] ?? String(month));
}

export interface PaperMonthGroup {
  /** Null = the papers of that year with no month. Shown last. */
  month: number | null;
  papers: Paper[];
}

export interface PaperYearGroup {
  year: number;
  months: PaperMonthGroup[];
}

export interface PaperExamGroup {
  examId: string;
  /** Empty when the exam is not in the catalogue the page read. */
  nameEn: string;
  nameHi: string;
  years: PaperYearGroup[];
}

/**
 * Exam > Year > Month, the three levels a student taps through.
 *
 * Order: the exam order of the CATALOGUE (so it matches every other screen),
 * then year newest first, then month newest first with "no month" last, then
 * the paper label A to Z so the rows never jump between two renders.
 *
 * A paper whose exam is missing from the catalogue is kept, last, with an
 * empty name. Dropping it would hide free content because one extra read
 * failed; the list simply shows the year and the paper with no exam heading.
 */
export function groupPapers(
  papers: readonly Paper[],
  exams: readonly Exam[],
): PaperExamGroup[] {
  const order = new Map(exams.map((exam, index) => [exam.id, index]));
  const byExam = new Map<string, PaperExamGroup>();

  for (const paper of papers) {
    let group = byExam.get(paper.examId);
    if (!group) {
      const exam = exams.find((one) => one.id === paper.examId);
      group = {
        examId: paper.examId,
        nameEn: exam?.nameEn ?? '',
        nameHi: exam?.nameHi ?? '',
        years: [],
      };
      byExam.set(paper.examId, group);
    }

    let year = group.years.find((one) => one.year === paper.year);
    if (!year) {
      year = { year: paper.year, months: [] };
      group.years.push(year);
    }

    let month = year.months.find((one) => one.month === paper.month);
    if (!month) {
      month = { month: paper.month, papers: [] };
      year.months.push(month);
    }
    month.papers.push(paper);
  }

  const groups = [...byExam.values()].sort((a, b) => {
    // Unknown exams sort last: there is no heading to put them under.
    const left = order.get(a.examId) ?? Number.MAX_SAFE_INTEGER;
    const right = order.get(b.examId) ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    return a.examId.localeCompare(b.examId, 'en');
  });

  for (const group of groups) {
    group.years.sort((a, b) => b.year - a.year);
    for (const year of group.years) {
      // `null` is "year only", which belongs under the months, not above them.
      year.months.sort((a, b) => (b.month ?? 0) - (a.month ?? 0));
      for (const month of year.months) {
        month.papers.sort((a, b) => a.label.localeCompare(b.label, 'en'));
      }
    }
  }

  return groups;
}

/** Server side. Carries the caller's own access token, so RLS decides. */
export interface PapersClient {
  /** False when the Supabase env vars are missing, so pages can say so. */
  isConfigured(): boolean;
  /** The CALLER'S own papers, drafts included. The id comes from the session. */
  listMine(): Promise<Paper[]>;
  /** One teacher's LIVE papers, for a student. RLS enforces "live" as well. */
  listLiveForTeacher(teacherId: string): Promise<Paper[]>;
  /** One paper, or null. RLS decides whether the caller may see it at all. */
  readOne(paperId: string): Promise<Paper | null>;
  /**
   * Store a new paper as a DRAFT. The owner is the session user, never a
   * field of the input. Throws an error named `PaperConflict` when the
   * teacher already has that paper.
   */
  create(paper: NewPaper): Promise<Paper>;
}

/** Supabase Storage, narrowed to the three things the app needs. */
export interface FileStore {
  /** False when the Supabase env vars are missing. */
  isConfigured(): boolean;
  upload(input: { path: string; contentType: string; bytes: Uint8Array }): Promise<void>;
  /** A short-lived download URL, or null when there is no such object. */
  signedUrl(path: string, expiresInSeconds?: number): Promise<string | null>;
  /**
   * The object's BYTES, or null when there is no such object.
   *
   * Added by issue 12-pdf-split-worker: the split worker has to hand the whole
   * PDF to Claude, and a signed URL is no use to it. A browser never calls
   * this: a student gets `signedUrl` and downloads from Supabase directly, so
   * a 30 MB file never passes through our own server for them.
   */
  download(path: string): Promise<Uint8Array | null>;
}

/** What the upload form sends. `File`s included, so this is browser only. */
export interface NewPaperInput extends PaperDraft {
  questions?: PdfPick | null;
  solutions?: PdfPick | null;
}

/** Browser side: the Papers page. Calls our own route. */
export interface BrowserPapersClient {
  /** The stored paper, so the list can grow with no page reload. */
  create(input: NewPaperInput): Promise<Paper>;
}
