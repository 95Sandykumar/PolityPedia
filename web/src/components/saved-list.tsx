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
  'inline-flex min-h-12 items-center gap-2 rounded-full border px-4 text-base font-medium transition-colors duration-100';

const CHIP_ON = 'border-primary bg-primary text-primary-foreground';
const CHIP_OFF = 'border-border bg-card text-foreground';

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
}: {
  /** Read on the server, newest first, so the first paint is the real list. */
  items: readonly SavedItem[];
  client?: BrowserSavedClient;
  mode?: LangMode;
}) {
  const fallback = useMemo(() => createBrowserSavedClient(), []);
  const saved = client ?? fallback;

  /** Null is "no chip picked", which shows both tags (F-E8). */
  const [picked, setPicked] = useState<SavedTag | null>(null);
  /** Rows already removed, by `(questionId, tag)`. Put back on a refusal. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [failed, setFailed] = useState(false);

  const live = items.filter((one) => !gone.has(keyOf(one)));
  const shown = filterSaved(live, picked);

  async function remove(item: SavedItem): Promise<void> {
    const key = keyOf(item);
    if (busy.has(key)) return;

    setFailed(false);
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
      setFailed(true);
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
      <div role="group" aria-label={plain('saved.filter', mode)} className="flex gap-2">
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
              {plain(TAG_LABEL[tag], mode)}
              <span className="tabular-nums">{countByTag(live, tag)}</span>
            </button>
          );
        })}
      </div>

      {failed ? (
        <p data-testid="saved-failed" role="alert" className="text-sm text-wrong">
          {plain('saved.failed', mode)}
        </p>
      ) : null}

      {shown.length === 0 ? (
        <p role="status" className="text-muted-foreground">
          {plain('saved.none', mode)}
        </p>
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
                <span className="shrink-0 text-sm font-medium tabular-nums text-muted-foreground">
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
