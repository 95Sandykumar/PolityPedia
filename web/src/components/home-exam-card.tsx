/**
 * The "next exam" card at the top of Home (student-ui pass, 2026-11-06).
 *
 * It answers "how long do I have?" before anything else. The nearest future
 * exam date across the teachers the student follows is picked on the server;
 * this card only draws it. Solid primary fill with white text (6.29:1, DESIGN.md
 * section 3), no gradient, no shadow.
 *
 * A server component: no state, nothing ships to the browser.
 */
import { CalendarDays } from 'lucide-react';
import { formatExamDate, type NextExam } from '@/lib/teacher-exams/types';
import { DEFAULT_MODE, labels, plain, type Lang, type LangMode } from '@/lib/i18n';

export function HomeExamCard({
  exam,
  teacherName,
  daysLeft,
  mode = DEFAULT_MODE,
}: {
  exam: NextExam;
  teacherName: string;
  daysLeft: number;
  mode?: LangMode;
}) {
  const langs: Lang[] = mode === 'both' ? ['en', 'hi'] : [mode];
  const name = (lang: Lang) => exam.label ?? (lang === 'hi' ? exam.nameHi : exam.nameEn);
  const unit =
    daysLeft === 1
      ? labels('sui.dayLeft', mode)
      : labels('sui.daysLeft', mode);

  return (
    <section
      aria-label={plain('portfolio.nextExam', mode)}
      className="flex items-center gap-4 rounded-[10px] bg-primary p-4 text-primary-foreground"
    >
      <div className="flex min-w-0 grow flex-col gap-1">
        <p className="flex items-center gap-2 text-sm leading-5 font-medium">
          <CalendarDays aria-hidden="true" className="size-4 shrink-0" strokeWidth={2} />
          {plain('portfolio.nextExam', mode)}
        </p>
        <p className="text-[22px] leading-8 font-bold">
          {/* A short label like NET is the same in both languages: show it once. */}
          {[...new Set(langs.map((lang) => name(lang)))].map((line, index) => (
            <span key={line} className={index === 0 ? 'block' : 'block text-sm leading-6'}>
              {line}
            </span>
          ))}
        </p>
        <p className="text-sm leading-5 tabular-nums">
          {formatExamDate(exam.date, mode === 'hi' ? 'hi' : 'en')}
          <span aria-hidden="true"> · </span>
          <span className="font-medium">{teacherName}</span>
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-center rounded-[10px] border border-primary-foreground/40 px-3 py-2 text-center">
        {daysLeft === 0 ? (
          <span className="max-w-[9ch] text-sm leading-5 font-bold">
            {plain('sui.examToday', mode)}
          </span>
        ) : (
          <>
            <span className="text-[28px] leading-9 font-bold tabular-nums">{daysLeft}</span>
            {unit.map((line, index) => (
              <span key={line} className={index === 0 ? 'text-sm leading-5' : 'text-xs leading-4'}>
                {line}
              </span>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
