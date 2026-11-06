'use client';

/**
 * The price stepper and the earning line (issue 15-mock-sets-authoring,
 * restyled in teacher-ui).
 *
 * V11: the teacher picks the price, Rs 299 to Rs 399. Two big buttons and a
 * numeric box, because the whole thing has to work with a thumb on a 360 px
 * phone (DESIGN.md section 10): `inputMode="numeric"` so Android opens the
 * number pad and not a keyboard, and `min-h-12` on the buttons so they are a
 * real 48 px target.
 *
 * `step={10}` is on the input as well as in the buttons, so a laptop's own
 * spinner arrows move by the same Rs 10.
 *
 * TYPING IS ALLOWED AND CLAMPED ON BLUR, not on every keystroke. Clamping
 * while the teacher types would fight them: the first digit of "350" is "3",
 * which would jump to 299 and eat the rest.
 *
 * The earning line is the honest part. It is labelled "about", it rounds DOWN,
 * and it carries a hint saying GST and the fee are already out (AS6: the fee
 * is ~2% and unverified). It sits in a tinted box so it reads as the answer to
 * "what do I get", not as small print.
 */
import { Minus, Plus } from 'lucide-react';
import { Lines } from '@/components/teacher-ui';
import {
  clampPrice,
  MAX_PRICE_INR,
  MIN_PRICE_INR,
  PRICE_STEP_INR,
  stepPrice,
  teacherEarningEstimate,
} from '@/lib/mocks/types';
import { plain, type LangMode } from '@/lib/i18n';

const STEP_BUTTON =
  'flex min-h-12 min-w-12 items-center justify-center rounded-[10px] border border-border bg-card text-foreground transition-colors duration-100 hover:bg-background disabled:opacity-60';

const BOX =
  'min-h-12 w-full rounded-[10px] border border-border bg-card px-3 text-xl font-bold text-foreground';

export function PriceStepper({
  price,
  onChange,
  sharePct,
  mode,
  busy = false,
}: {
  price: number;
  /** Always handed a price inside the band. */
  onChange: (price: number) => void;
  /** The teacher's own `revenue_share_pct` (X3). */
  sharePct: number;
  mode: LangMode;
  busy?: boolean;
}) {
  const estimate = teacherEarningEstimate(price, sharePct);

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium text-muted-foreground">
        <Lines keyName="mocks.price" mode={mode} />
      </span>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || price <= MIN_PRICE_INR}
          aria-label={plain('mocks.priceDown', mode)}
          onClick={() => onChange(stepPrice(price, -1))}
          className={STEP_BUTTON}
        >
          <Minus size={20} strokeWidth={2} aria-hidden="true" />
        </button>

        <input
          type="number"
          // The number pad, not a keyboard, on a cheap Android phone.
          inputMode="numeric"
          min={MIN_PRICE_INR}
          max={MAX_PRICE_INR}
          step={PRICE_STEP_INR}
          value={String(price)}
          aria-label={plain('mocks.price', mode)}
          onChange={(event) => {
            // Not clamped yet: a half-typed number is not a price.
            const typed = Number(event.target.value);
            onChange(Number.isFinite(typed) ? typed : price);
          }}
          // Clamped when the teacher leaves the box, so the stored price is
          // always inside V11's band.
          onBlur={() => onChange(clampPrice(price))}
          className={`${BOX} text-center tabular-nums`}
        />

        <button
          type="button"
          disabled={busy || price >= MAX_PRICE_INR}
          aria-label={plain('mocks.priceUp', mode)}
          onClick={() => onChange(stepPrice(price, 1))}
          className={STEP_BUTTON}
        >
          <Plus size={20} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <p className="text-xs text-muted-foreground">{plain('mocks.priceRange', mode)}</p>

      {/* "You get about ₹165 per sale". The number is in the middle, so the
          line is built from two keys rather than one with a placeholder: the
          Hindi word order puts the number in the middle as well. */}
      <div className="flex flex-col gap-1 rounded-[10px] bg-primary/10 p-3">
        <p data-testid="earning-estimate" className="font-medium text-foreground">
          {plain('mocks.earnPrefix', mode)}{' '}
          <span className="font-bold tabular-nums">{'₹' + estimate}</span>{' '}
          {plain('mocks.earnSuffix', mode)}
        </p>
        <p className="text-xs text-muted-foreground">{plain('mocks.earnHint', mode)}</p>
      </div>
    </div>
  );
}
