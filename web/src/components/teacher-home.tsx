/**
 * Teacher Home (teacher-ui): who you are, how things stand, what to do next.
 *
 * Four blocks, top to bottom, so it reads the same on a phone and a laptop:
 *   1. Greeting with the approval state.
 *   2. "At a glance": four counts, each a door to its screen.
 *   3. "Quick actions": the six things a teacher does most.
 *   4. "Needs your attention": drafts that are one step from live.
 *
 * A server component: no state, nothing of this ships to the browser
 * (DESIGN.md section 10). Every number is read on the server by
 * `readTeacherHome`; this file only lays them out.
 */
import {
  CheckCircle2,
  ChevronRight,
  FileText,
  ListChecks,
  Megaphone,
  Plus,
  Sparkles,
  Users,
  UsersRound,
  Video,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { Lines, StatusChip, CARD } from '@/components/teacher-ui';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import type { TeacherHomeSummary } from '@/lib/teacher-home/summary';
import { cn } from '@/lib/utils';

interface Stat {
  key: MessageKey;
  Icon: LucideIcon;
  href: string;
  value: number;
  /** The small line under the label, e.g. "1 Live, 2 Draft". */
  sub: string;
}

interface Action {
  key: MessageKey;
  Icon: LucideIcon;
  href: string;
}

const ACTIONS: readonly Action[] = [
  { key: 'teacherHome.qaPaper', Icon: FileText, href: '/teacher/papers#paper-form' },
  { key: 'teacherHome.qaMock', Icon: ListChecks, href: '/teacher/mocks#mock-form' },
  { key: 'teacherHome.qaNotice', Icon: Megaphone, href: '/teacher/posts' },
  { key: 'teacherHome.qaVideo', Icon: Video, href: '/teacher/videos' },
  { key: 'teacherHome.qaBatch', Icon: Users, href: '/teacher/batches#batch-form' },
  { key: 'teacherHome.qaAi', Icon: Sparkles, href: '/teacher/explanations' },
];

const TILE =
  'flex min-h-12 items-center gap-3 rounded-[10px] border border-border bg-card p-3 transition-colors duration-100 hover:border-primary';

export function TeacherHome({
  summary,
  mode = DEFAULT_MODE,
}: {
  summary: TeacherHomeSummary;
  mode?: LangMode;
}) {
  const liveDraft = (live: number, draft: number) =>
    `${live} ${plain('mocks.live', mode)}, ${draft} ${plain('mocks.draft', mode)}`;

  const stats: Stat[] = [
    {
      key: 'nav.papers',
      Icon: FileText,
      href: '/teacher/papers',
      value: summary.papers.total,
      sub: liveDraft(summary.papers.live, summary.papers.draft),
    },
    {
      key: 'nav.mockSets',
      Icon: ListChecks,
      href: '/teacher/mocks',
      value: summary.mocks.total,
      sub: liveDraft(summary.mocks.live, summary.mocks.draft),
    },
    {
      key: 'nav.batches',
      Icon: Users,
      href: '/teacher/batches',
      value: summary.batches,
      sub: '',
    },
    {
      key: 'batches.students',
      Icon: UsersRound,
      href: '/teacher/batches',
      value: summary.students,
      sub: '',
    },
  ];

  const approved = summary.status === 'approved';
  const initial = (summary.name ?? 'T').trim().charAt(0).toUpperCase();
  const hidden = summary.attentionTotal - summary.attention.length;

  return (
    <div className="flex flex-col gap-6">
      {/* 1. Greeting. The h1 is the one heading a screen reader jumps to. */}
      <header className={cn(CARD, 'flex items-center gap-3 p-4')}>
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-xl font-bold text-primary-foreground"
        >
          {initial}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[22px] leading-7 font-bold break-words">
            {labels('teacherHome.hello', mode).join(' / ')}
            {summary.name ? `, ${summary.name}` : ''}
          </h1>
          {summary.status ? (
            <StatusChip live={approved} className="w-fit">
              {plain(approved ? 'teacherHome.approved' : 'teacherPending.title', mode)}
            </StatusChip>
          ) : null}
        </div>
      </header>

      {/* 2. At a glance. */}
      <section aria-labelledby="home-glance" className="flex flex-col gap-3">
        <h2 id="home-glance" className="sr-only">
          {plain('teacherHome.glance', mode)}
        </h2>
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {stats.map((stat) => (
            <li key={stat.key}>
              <Link
                href={stat.href}
                prefetch={false}
                className="flex h-full min-h-[104px] flex-col justify-between gap-2 rounded-[10px] border border-border bg-card p-3 transition-colors duration-100 hover:border-primary"
              >
                <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <stat.Icon size={20} strokeWidth={2} aria-hidden="true" className="text-primary" />
                  <span className="flex flex-col leading-5">
                    <Lines keyName={stat.key} mode={mode} />
                  </span>
                </span>
                <span className="flex flex-col">
                  <span className="text-[28px] leading-8 font-bold tabular-nums">{stat.value}</span>
                  {stat.sub ? (
                    <span className="text-xs leading-4 text-muted-foreground tabular-nums">
                      {stat.sub}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-col gap-6">
        {/* 3. Quick actions. */}
        <section aria-labelledby="home-quick" className="flex flex-col gap-3">
          <h2 id="home-quick" className="text-[18px] leading-6 font-bold">
            <Lines
              keyName="teacherHome.quick"
              mode={mode}
              sub="text-sm font-medium text-muted-foreground"
            />
          </h2>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {ACTIONS.map((action) => (
              <li key={action.key}>
                <Link
                  href={action.href}
                  prefetch={false}
                  className={cn(TILE, 'h-full min-h-[104px] flex-col items-start justify-between sm:min-h-12 sm:flex-row sm:items-center sm:justify-start')}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary"
                  >
                    <action.Icon size={20} strokeWidth={2} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col text-base leading-5 font-medium">
                    <Lines keyName={action.key} mode={mode} />
                  </span>
                  <Plus size={20} strokeWidth={2} aria-hidden="true" className="hidden shrink-0 text-muted-foreground sm:block" />
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {/* 4. Needs your attention. */}
        <section aria-labelledby="home-attention" className="flex flex-col gap-3">
          <h2 id="home-attention" className="text-[18px] leading-6 font-bold">
            <Lines
              keyName="teacherHome.attention"
              mode={mode}
              sub="text-sm font-medium text-muted-foreground"
            />
          </h2>

          {summary.attention.length === 0 ? (
            <div className={cn(CARD, 'flex items-center gap-3 p-4')}>
              <CheckCircle2 size={24} strokeWidth={2} aria-hidden="true" className="shrink-0 text-primary" />
              <p role="status" className="text-muted-foreground">
                {plain('teacherHome.allClear', mode)}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {summary.attention.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <Link href={item.href} prefetch={false} className={TILE}>
                    <span
                      aria-hidden="true"
                      className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-background text-muted-foreground"
                    >
                      {item.kind === 'paper' ? (
                        <FileText size={20} strokeWidth={2} />
                      ) : (
                        <ListChecks size={20} strokeWidth={2} />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-base leading-5 font-medium">{item.title}</span>
                      <span className="text-sm leading-5 text-muted-foreground">
                        {plain(
                          item.kind === 'paper'
                            ? 'teacherHome.attentionPaper'
                            : 'teacherHome.attentionMock',
                          mode,
                        )}
                      </span>
                    </span>
                    <ChevronRight size={20} strokeWidth={2} aria-hidden="true" className="shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
              {hidden > 0 ? (
                <li className="px-1 text-sm text-muted-foreground tabular-nums">
                  +{hidden} {plain('teacherHome.moreItems', mode)}
                </li>
              ) : null}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
