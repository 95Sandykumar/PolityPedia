/**
 * What a LOGGED-OUT visitor sees (issue 63-public-landing).
 *
 * persona-1 gap 3: `/` and a shared `/t/<id>` both showed "Teachers are not
 * set up yet", which reads as "this app is broken". A first visitor arrives
 * from a WhatsApp or Telegram link and gets five seconds to decide. These two
 * blocks are that decision:
 *
 *  - `PublicLanding`: the brand, one line of what this is (UGC NET, CUET PG),
 *    a "Try a free test" button, a "Sign in" button, and how it works in
 *    three short lines.
 *  - `PublicTeacherCard`: a shared teacher link, with the public fields only
 *    and "Sign in to follow" in place of the real Follow button.
 *
 * Server components, no state and no hook, so nothing here is added to the
 * client bundle and no key or signed-in read can reach a visitor.
 *
 * PRIVACY (PRD F-A5, design constraint C): the only teacher input is a
 * `PublicTeacher`, the shape of the `teachers_public` view, which has no
 * real-name field at all. An alias teacher shows their alias here because
 * that is the only name the database handed over.
 *
 * Both buttons lead to `/sign-in` for now. The free test card itself is
 * ticket 68, so "Try a free test" is the promise and sign-in is the door.
 *
 * DESIGN.md: tokens only, 1 px borders, radius 10, no shadow, no gradient,
 * 48 px touch targets, and every label in English and Hindi. Links carry
 * `prefetch={false}` (B3), so a visitor on dropping 4G downloads one page.
 */
import { BookOpenCheck } from 'lucide-react';
import Link from 'next/link';
import { TeacherAvatar } from '@/components/teacher-avatar';
import { CARD, Lines } from '@/components/student-ui';
import { DEFAULT_MODE, labels, plain, type LangMode } from '@/lib/i18n';
import type { PublicTeacher } from '@/lib/teachers/types';

/** The one door out of every logged-out screen. */
const SIGN_IN_PATH = '/sign-in';

const PRIMARY_BUTTON =
  'inline-flex min-h-12 w-full items-center justify-center rounded-[10px] bg-primary px-4 text-base font-medium text-primary-foreground transition-colors duration-100';
const OUTLINE_BUTTON =
  'inline-flex min-h-12 w-full items-center justify-center rounded-[10px] border border-border bg-card px-4 text-base font-medium text-foreground transition-colors duration-100';

/** Brand mark, name and the one line that answers "what is this". */
function Pitch({ mode, heading }: { mode: LangMode; heading: boolean }) {
  const name = <>{plain('sui.brand', mode)}</>;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-12 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary"
        >
          <BookOpenCheck className="size-6" strokeWidth={2} />
        </span>
        {heading ? (
          <h1 className="text-[22px] leading-8 font-bold">{name}</h1>
        ) : (
          <p className="text-[22px] leading-8 font-bold">{name}</p>
        )}
      </div>
      <p className="text-base leading-6 text-muted-foreground">
        <Lines keyName="land.pitch" mode={mode} />
      </p>
    </div>
  );
}

/**
 * The two buttons. "Try a free test" is the primary one, because a visitor
 * who has not signed in anywhere yet wants to try before they type an email.
 */
function SignInButtons({ mode }: { mode: LangMode }) {
  return (
    <div className="flex flex-col gap-3">
      <Link
        href={SIGN_IN_PATH}
        prefetch={false}
        aria-label={plain('land.tryFree', mode)}
        className={PRIMARY_BUTTON}
      >
        <span>
          <Lines keyName="land.tryFree" mode={mode} />
        </span>
      </Link>
      <Link
        href={SIGN_IN_PATH}
        prefetch={false}
        aria-label={plain('land.signIn', mode)}
        className={OUTLINE_BUTTON}
      >
        <span>
          <Lines keyName="land.signIn" mode={mode} />
        </span>
      </Link>
    </div>
  );
}

/** Three numbered lines. Minimum text (DESIGN.md section 1), no paragraphs. */
function HowItWorks({ mode }: { mode: LangMode }) {
  const title = plain('land.howTitle', mode);
  return (
    <section className={`${CARD} flex flex-col gap-3 p-4`}>
      <h2 className="text-[18px] leading-7 font-bold">
        <Lines keyName="land.howTitle" mode={mode} />
      </h2>
      <ol aria-label={title} className="flex flex-col gap-3">
        {(['land.how1', 'land.how2', 'land.how3'] as const).map((key, index) => (
          <li key={key} className="flex items-start gap-3">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary tabular-nums"
            >
              {index + 1}
            </span>
            <span className="min-w-0 text-base leading-6">
              {labels(key, mode).map((line, lineIndex) => (
                <span key={line} className={lineIndex === 0 ? 'block' : 'block text-xs'}>
                  {line}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The logged-out `/`, and the fallback when a shared teacher link is dead. */
export function PublicLanding({ mode = DEFAULT_MODE }: { mode?: LangMode }) {
  return (
    <div className="flex flex-col gap-6">
      <Pitch mode={mode} heading />
      <SignInButtons mode={mode} />
      <HowItWorks mode={mode} />
    </div>
  );
}

/**
 * The logged-out `/t/<teacherId>`: who this teacher is, then the same pitch
 * and the same door. The teacher's own tiles are NOT shown, because every one
 * of them needs a signed-in read.
 */
export function PublicTeacherCard({
  teacher,
  mode = DEFAULT_MODE,
}: {
  teacher: PublicTeacher;
  mode?: LangMode;
}) {
  // The bio in the student's language, exactly as the signed-in portfolio
  // picks it, so a shared link and the real page read the same.
  const bioSource =
    mode === 'hi'
      ? [teacher.bioHi ?? teacher.bioEn]
      : mode === 'both'
        ? [teacher.bioEn, teacher.bioHi]
        : [teacher.bioEn ?? teacher.bioHi];
  const bioLines = bioSource.filter(
    (line): line is string => typeof line === 'string' && line.length > 0,
  );

  return (
    <div className="flex flex-col gap-6">
      <section className={`${CARD} flex flex-col gap-4 p-4`}>
        <div className="flex items-center gap-4">
          <TeacherAvatar
            displayName={teacher.displayName}
            avatarPath={teacher.avatarPath}
            size={72}
            decorative
          />
          <div className="flex min-w-0 flex-col items-start gap-1">
            <h1 className="text-[22px] leading-8 font-bold">{teacher.displayName}</h1>
            <p className="text-sm leading-5 text-muted-foreground">
              <Lines keyName="land.teacherHint" mode={mode} />
            </p>
          </div>
        </div>

        {bioLines.length > 0 ? (
          <div className="flex flex-col gap-1 text-base leading-6 text-muted-foreground">
            {bioLines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        ) : null}

        {/* A link, not a button: following needs an account, so the honest
            action is "go and sign in", not a button that fails. */}
        <Link
          href={SIGN_IN_PATH}
          prefetch={false}
          aria-label={plain('land.signInToFollow', mode)}
          className={PRIMARY_BUTTON}
        >
          <span>
            <Lines keyName="land.signInToFollow" mode={mode} />
          </span>
        </Link>
      </section>

      <Pitch mode={mode} heading={false} />
      <HowItWorks mode={mode} />
    </div>
  );
}
