'use client';

/**
 * The Saved tab (issue 14-saved-list).
 *
 * PRD F-E8: ONE list with TWO tags. So there is one list of rows here and two
 * filter chips above it, never two lists. No chip picked shows both tags;
 * tapping a chip narrows to that tag; tapping it again clears the filter.
 *
 * COLOUR NEVER WORKS ALONE (DESIGN.md section 3). Every row carries the tag as
 * an ICON AND A WORD ("Wrong" with a cross, "Marked" with a bookmark), so a
 * colour-blind student reads the same list as everybody else.
 *
 * A client component, because the chips and Remove hold state. The client is a
 * PROP so the test can inject a fake: no real network call and no real key
 * (web/CLAUDE.md). It posts to our own route and never holds a Supabase key.
 *
 * REMOVE IS OPTIMISTIC AND REVERSIBLE. The row goes at once, because a tap that
 * does nothing for a second feels broken on 4G; a refusal puts it back and says
 * so, rather than leaving the student thinking it went.
 *
 * Removing one tag leaves the other alone: the key is
 * `(user_id, question_id, tag)`, so a question that was wrong AND marked keeps
 * its other row (0014).
 *
 * A11y: the chips are real `<button>`s with `aria-pressed`, 48 px tall, and the
 * Remove button names the question number, so "Remove" is never ambiguous.
 */
import { Bookmark, Play, Trash2, X } from 'lucide-react';
import { ReadError } from '@/components/read-error';
import { EmptyState } from '@/components/student-ui';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { playerPath } from '@/lib/attempts/types';
import { DEFAULT_MODE, labels, plain, type LangMode, type MessageKey } from '@/lib/i18n';
import { createBrowserSavedClient } from '@/lib/saved/browser-saved-client';
import {
  SAVED_TAGS,
  countByTag,
  filterSaved,
  type BrowserSavedClient,
  type SavedItem,
  type SavedTag,
} from '@/lib/saved/types';

const CARD = 'rounded-[10px] border border-border bg-card p-3';

/** Pills are 999 px (DESIGN.md section 0) and 48 px tall (section 5). */
const CHIP =
  'inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-[8px] px-3 text-base font-medium transition-colors duration-100';

const CHIP_ON = 'bg-primary text-primary-foreground';
const CHIP_OFF = 'text-foreground';

/** A destructive action is the one red outline button DESIGN.md allows. */
const REMOVE =
  'inline-flex min-h-12 items-center gap-2 rounded-[10px] border border-wrong-icon px-3 text-base font-medium text-wrong transition-colors duration-100 disabled:opacity-50';

const OPEN =
  'inline-flex min-h-12 items-center gap-2 rounded-[10px] border border-primary px-3 text-base font-medium text-primary transition-colors duration-100';

const BADGE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium';

const TAG_LABEL: Record<SavedTag, MessageKey> = {
  wrong: 'saved.wrong',
  marked: 'saved.marked',
};

const TAG_BADGE: Record<SavedTag, string> = {
  wrong: 'border-wrong-icon bg-wrong-soft text-wrong',
  marked: 'border-marked text-marked',
};

/** One key per saved pair, which is exactly the primary key of the table. */
function keyOf(item: { questionId: string; tag: SavedTag }): string {
  return `${item.questionId}:${item.tag}`;
}

export function SavedList({
  items,
  client,
  mode = DEFAULT_MODE,
  failed = false,
}: {
  /** Read on the server, newest first, so the first paint is the real list. */
  items: readonly SavedItem[];
  client?: BrowserSavedClient;
  mode?: LangMode;
  /**
   * True when the SERVER read failed rather than came back empty
   * (issue 54c-read-errors-saved-practice-media). It wins over `items`: a
   * part-read list shown as if it were whole tells a student their saved
   * question is gone when it is not.
   */
  failed?: boolean;
}) {
  const fallback = useMemo(() => createBrowserSavedClient(), []);
  const saved = client ?? fallback;

  /** Null is "no chip picked", which shows both tags (F-E8). */
  const [picked, setPicked] = useState<SavedTag | null>(null);
  /** Rows already removed, by `(questionId, tag)`. Put back on a refusal. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set<string>());
  /** A REMOVE that was refused. Nothing to do with the read above it. */
  const [removeFailed, setRemoveFailed] = useState(false);

  // Checked BEFORE anything is drawn, and after the hooks so their order
  // never changes: a broken read must not say "Nothing saved yet", and the two
  // filter chips must not offer to narrow rows nobody read.
  if (failed) {
    return <ReadError mode={mode} />;
  }

  const live = items.filter((one) => !gone.has(keyOf(one)));
  const shown = filterSaved(live, picked);

  async function remove(item: SavedItem): Promise<void> {
    const key = keyOf(item);
    if (busy.has(key)) return;

    setRemoveFailed(false);
    setBusy((before) => new Set(before).add(key));
    setGone((before) => new Set(before).add(key));

    try {
      await saved.setSaved(item.questionId, item.tag, false);
    } catch {
      // Put it back and say so: a row that is gone from the screen but still
      // in the database would come back on the next visit and look like a bug.
      setGone((before) => {
        const after = new Set(before);
        after.delete(key);
        return after;
      });
      setRemoveFailed(true);
    } finally {
      setBusy((before) => {
        const after = new Set(before);
        after.delete(key);
        return after;
      });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* The two chips of F-E8. A group, so a screen reader hears what they do. */}
      <div
        role="group"
        aria-label={plain('saved.filter', mode)}
        className="flex gap-1 rounded-[10px] border border-border bg-card p-1"
      >
        {SAVED_TAGS.map((tag) => {
          const on = picked === tag;
          return (
            <button
              key={tag}
              type="button"
              data-testid="saved-chip"
              data-tag={tag}
              aria-pressed={on}
              // Tapping the chip that is on clears the filter, so both tags
              // come back without a third "All" chip taking a nav slot.
              onClick={() => setPicked(on ? null : tag)}
              className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
            >
              {tag === 'wrong' ? (
                <X aria-hidden="true" className="size-5" strokeWidth={2} />
              ) : (
                <Bookmark aria-hidden="true" className="size-5" strokeWidth={2} />
              )}
              {plain(TAG_LABEL[tag], mode)}
              <span
                className={`rounded-full px-2 text-sm leading-6 font-bold tabular-nums ${
                  on ? 'bg-primary-foreground/20' : 'bg-background'
                }`}
              >
                {countByTag(live, tag)}
              </span>
            </button>
          );
        })}
      </div>

      {removeFailed ? (
        <p data-testid="saved-failed" role="alert" className="text-sm text-wrong">
          {plain('saved.failed', mode)}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState
          Icon={Bookmark}
          text={plain('saved.none', mode)}
          action={{ href: '/practice', label: plain('sui.noSavedAction', mode) }}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((item) => (
            <li
              key={keyOf(item)}
              data-testid="saved-row"
              data-tag={item.tag}
              className={`${CARD} flex flex-col gap-2`}
            >
              <div className="flex items-start gap-2">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-sm leading-5 font-bold tabular-nums text-muted-foreground ring-1 ring-border">
                  {item.number}
                </span>
                <p className="grow text-[17px] leading-[26px] font-medium">{item.stem}</p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <span className={`${BADGE} ${TAG_BADGE[item.tag]}`}>
                  {item.tag === 'wrong' ? (
                    <X aria-hidden="true" className="size-4" />
                  ) : (
                    <Bookmark aria-hidden="true" className="size-4" />
                  )}
                  {plain(TAG_LABEL[item.tag], mode)}
                </span>

                {/* A mock-test question has no paper to open (issue 15). */}
                {item.paperId ? (
                  <Link
                    href={playerPath(item.teacherId, item.paperId)}
                    prefetch={false}
                    aria-label={`${item.number}: ${plain('player.title', mode)}`}
                    className={`${OPEN} ml-auto`}
                  >
                    <Play aria-hidden="true" className="size-5" />
                    <span className="flex flex-col items-start">
                      {labels('player.title', mode).map((line, index) => (
                        <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                          {line}
                        </span>
                      ))}
                    </span>
                  </Link>
                ) : null}

                <button
                  type="button"
                  data-testid="saved-remove"
                  disabled={busy.has(keyOf(item))}
                  aria-label={`${item.number}: ${plain('saved.remove', mode)}`}
                  onClick={() => void remove(item)}
                  className={item.paperId ? REMOVE : `${REMOVE} ml-auto`}
                >
                  <Trash2 aria-hidden="true" className="size-5" />
                  <span className="flex flex-col items-start">
                    {labels('saved.remove', mode).map((line, index) => (
                      <span key={line} className={index === 0 ? undefined : 'text-xs'}>
                        {line}
                      </span>
                    ))}
                  </span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
