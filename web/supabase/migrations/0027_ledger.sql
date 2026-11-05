-- 0027_ledger.sql  (issue 27-razorpay-webhook-ledger)
--
-- WHAT HAPPENS WHEN RAZORPAY SAYS THE MONEY ARRIVED. design.md flow 4:
-- "... -> webhook (signature first) -> `payment_events` de-dupe ->
-- `purchases` row `paid` -> `set_access` row -> `teacher_ledger` row with the
-- split."
--
-- Issue 26 built everything up to the checkout screen. This file is the other
-- half, and almost all of it is in Postgres on purpose. A webhook is the one
-- request in the app that arrives MORE THAN ONCE: Razorpay retries until it
-- gets a 2xx, two deliveries can overlap, and a refund can land before the
-- capture it refunds. A route handler that reads, decides and then writes has
-- a gap between the read and the write, and in that gap a student can end up
-- with two ledger rows, or with money taken and a set that stays shut.
--
-- So the whole decision is ONE statement block inside ONE transaction, keyed
-- on the purchase row and holding its lock (A5).
--
-- Five things live here:
--
--  * `payment_events`        -- every webhook we have ever accepted (A2).
--  * `teacher_ledger`        -- one row per paid purchase, with the split (X3).
--  * `payouts`               -- the monthly bank transfer that clears it (X1).
--  * `record_payment_event()`-- insert the event id, or say "seen it".
--  * `grant_purchase()` and `refund_purchase()` -- the two state moves.
--
-- THE SIGNATURE IS NOT HERE, and cannot be. HMAC-SHA256 is computed over the
-- RAW request body, and by the time anything reaches Postgres the body has
-- been parsed and re-serialised, which changes the bytes. So the signature
-- check lives in `src/lib/purchases/webhook.ts`, runs FIRST, and nothing in
-- this file is called until it passes (A2).
--
-- A3, FORWARD ONLY, IS SPELLED IN THE `WHERE`. `created -> paid -> refunded`,
-- and never backwards. Both functions re-read the row under `FOR UPDATE` and
-- put the old status in the UPDATE's own WHERE, so a late capture arriving
-- after a refund updates zero rows instead of reopening a set somebody has
-- already been paid back for.
--
-- EVERY REFUSAL IS A `false`, NOT AN EXCEPTION. design.md C: "Webhook replies
-- 2xx fast." An order we never sold, a second delivery of an event we already
-- handled, a refund for something that was never paid: all of those are
-- NORMAL, and raising on them would make Razorpay retry forever. `false`
-- means "nothing to do", and the route still answers 200.
--
-- NOBODY MAY CALL THESE THREE FUNCTIONS. Postgres grants EXECUTE on a new
-- function to PUBLIC, and Supabase's default privileges add `anon` and
-- `authenticated` on top. Left alone, that is a free mock set for anybody who
-- can guess an order id: `select grant_purchase('order_x', 0)` opens it. So
-- each one is REVOKED from public, anon and authenticated straight after it is
-- created, and granted to `service_role` only, which is the role the webhook
-- route carries and the only caller there is.
--
-- MONEY IS `numeric(12,2)`, NOT A FLOAT AND NOT AN INTEGER OF PAISE.
--  * Not float: 0.1 + 0.2 is a bug report in a payout.
--  * Not integer paise: every report, every CHECK and every eye-check then
--    has to divide by 100, and the one place somebody forgets is a 100x
--    payout.
-- `numeric(12,2)` is rupees and paise, exact, up to ten crore.
--
-- WHERE THE ROUNDING DUST GOES. Three roundings could each drop a paisa, so
-- the order is fixed and only TWO numbers are ever rounded:
--   gst      = round(gross - gross / 1.18, 2)
--   net      = gross - gst - gateway_fee          (exact, no rounding)
--   teacher  = round(net * share_pct / 100, 2)
--   platform = net - teacher                      (exact, no rounding)
-- The platform takes the remainder, so `gst + gateway_fee + net` is always
-- exactly the gross and `teacher_amount + platform_amount` is always exactly
-- the net. Two CHECK constraints below hold that true for hand-written rows
-- too.
--
-- X4 IS STILL OPEN. design.md: "GST and marketplace tax (e-commerce operator
-- TCS) on teacher sales. Unverified. CA must confirm before the first paid
-- sale. Prices treated as GST-inclusive." This file implements the
-- GST-inclusive reading (the 18% is already inside the Rs 299-399 price, so
-- it is backed OUT of the gross) because that is what design.md decided. The
-- rate is in ONE place, `public.gst_divisor()`, so the CA's answer is a
-- one-line migration and not a hunt.

-- ---------------------------------------------------------------------------
-- The two constants, as functions
--
-- A function and not a literal sprinkled through `grant_purchase()`, because
-- both are OUTSIDE FACTS that will change: the GST rate is X4 (a CA has to
-- confirm it) and the 12-month fallback is X2. A later migration replaces one
-- line here; nothing else moves. They are IMMUTABLE so the planner can fold
-- them, and they are safe for anybody to read: a tax rate is not a secret.
-- ---------------------------------------------------------------------------
create or replace function public.gst_divisor()
returns numeric
language sql
immutable
as $$
  -- 18% GST, INCLUSIVE. design.md X4: "Prices treated as GST-inclusive", so
  -- the tax is backed out of the price rather than added to it.
  select 1.18::numeric
$$;

comment on function public.gst_divisor() is
  'The GST-inclusive divisor: price / 1.18 is the amount before 18% tax. One place, because design.md X4 is still unverified and a CA may change it. Issue 27-razorpay-webhook-ledger.';

create or replace function public.access_fallback()
returns interval
language sql
immutable
as $$
  -- X2: "If no date set: 12 months."
  select interval '12 months'
$$;

comment on function public.access_fallback() is
  'How long a bought mock set stays open when the teacher has announced no next exam date (X2). Issue 27-razorpay-webhook-ledger.';

-- ---------------------------------------------------------------------------
-- payment_events  (A2)
--
-- The de-dupe table, and nothing else. One row per webhook Razorpay has ever
-- sent us that passed the signature check.
--
-- `event_id` IS THE PRIMARY KEY, and that single fact is the whole of A2's
-- second half. De-duping in JavaScript ("have I seen this id?") needs a read
-- and then a write, and two overlapping deliveries both read "no". A primary
-- key is checked by Postgres at write time, so the second one loses, every
-- time, with no lock written by hand.
--
-- `payload` is kept whole for support and for the nightly reconcile (A6): it
-- is the only record of what the gateway actually claimed. It can carry a
-- payment id, an email and an amount, so NOBODY but an admin may read this
-- table. Not even the teacher whose sale it was.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_events (
  event_id    text        primary key,
  type        text        not null,
  payload     jsonb       not null default '{}'::jsonb,
  received_at timestamptz not null default now(),

  constraint payment_events_id_check   check (length(btrim(event_id)) between 1 and 120),
  constraint payment_events_type_check check (length(btrim(type)) between 1 and 80)
);

comment on table public.payment_events is
  'Every Razorpay webhook we have accepted, keyed on its own event id. The primary key IS the de-dupe (A2): a retried delivery loses the insert and the handler does nothing. ADMIN ONLY to read: the payload carries payment details. Issue 27-razorpay-webhook-ledger.';
comment on column public.payment_events.event_id is
  'Razorpay''s X-Razorpay-Event-Id when it sends one, else "<event type>:<payment id>" built from the body. Primary key, so the same event can never be handled twice.';
comment on column public.payment_events.payload is
  'The whole body as it arrived, for support and the nightly reconcile (A6). Never shown to a student or a teacher.';

-- "What came in last night", for the reconcile and for support.
create index if not exists payment_events_received_idx
  on public.payment_events (received_at desc);

alter table public.payment_events enable row level security;

-- Admin only, in both directions. There is NO policy for a plain user, so RLS
-- hands a student and a teacher zero rows.
create policy payment_events_admin_all on public.payment_events
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- payouts  (X1)
--
-- Created BEFORE `teacher_ledger` only so the foreign key has something to
-- point at. X1: "Monthly manual bank transfer from the `teacher_ledger`
-- report. Razorpay Route (auto split, needs teacher KYC) in V2."
--
-- `paid_at` is NULL until the transfer actually leaves the bank, so a prepared
-- payout and a sent payout are different rows of the same table rather than a
-- status column somebody has to remember to move.
--
-- THE PAYOUT UI IS ISSUE 29. This file creates the table and its policies so
-- the ledger's `payout_id` means something; nothing writes a payout yet.
-- ---------------------------------------------------------------------------
create table if not exists public.payouts (
  id         uuid          primary key default gen_random_uuid(),
  teacher_id uuid          not null references public.teachers (user_id) on delete cascade,
  period     text          not null,
  amount     numeric(12,2) not null,
  paid_at    timestamptz,
  reference  text,
  created_at timestamptz   not null default now(),

  -- 'YYYY-MM'. A month and not a date range, because X1 says monthly: two
  -- spellings of the same month would be two payouts for one month's sales.
  constraint payouts_period_check check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),

  -- One payout per teacher per month. The second run of the same month is a
  -- double payment, and this is the only thing that stops it.
  constraint payouts_period_unique unique (teacher_id, period),

  -- Zero is legal (a month with no sales may still be recorded); negative is
  -- not, because a clawback is not a payout.
  constraint payouts_amount_check check (amount >= 0),

  constraint payouts_reference_check
    check (reference is null or length(btrim(reference)) between 1 and 120)
);

comment on table public.payouts is
  'One monthly manual bank transfer to one teacher (X1). paid_at is NULL until the money has actually left. RLS: a teacher reads their own; only an admin writes one. The payout SCREEN is issue 29. Issue 27-razorpay-webhook-ledger.';
comment on column public.payouts.period is
  'The month being paid for, as YYYY-MM. UNIQUE per teacher, so one month can never be paid twice.';
comment on column public.payouts.paid_at is
  'NULL = prepared but not sent. Set when the transfer is done, with the bank reference beside it.';

create index if not exists payouts_teacher_idx
  on public.payouts (teacher_id, period desc);

alter table public.payouts enable row level security;

-- A teacher sees their own payouts: that is the "you were paid Rs X on 3 Dec"
-- line in their dashboard. They cannot change one, because there is no
-- insert, update or delete policy for them.
create policy payouts_select_own on public.payouts
  for select to authenticated
  using (auth.uid() = teacher_id);

create policy payouts_admin_all on public.payouts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- teacher_ledger  (X3)
--
-- design.md: "Written once per paid purchase. Share copied at sale time, so a
-- later change of share does not rewrite history."
--
-- `purchase_id` IS UNIQUE, and that is A1 for the money half of the sale. A
-- retried webhook, a double delivery and a hand re-run of the reconcile all
-- try to insert the same purchase id, and all but the first lose.
--
-- `share_pct` IS A COPY, not a join to `teachers.revenue_share_pct`. If the
-- report read the live share, an admin raising a teacher from 50% to 60% would
-- silently rewrite every sale they have ever made, including the ones already
-- paid out. A copy makes last month's report the same number next year.
--
-- `teacher_amount` AND `platform_amount` ARE STORED, not computed on read, for
-- the same reason: a stored number can be reconciled against a bank statement.
-- The two CHECKs below are what keep them honest.
-- ---------------------------------------------------------------------------
create table if not exists public.teacher_ledger (
  id              uuid          primary key default gen_random_uuid(),
  teacher_id      uuid          not null references public.teachers (user_id) on delete cascade,
  purchase_id     uuid          not null references public.purchases (id) on delete cascade,
  gross           numeric(12,2) not null,
  gst             numeric(12,2) not null,
  gateway_fee     numeric(12,2) not null,
  net             numeric(12,2) not null,
  share_pct       integer       not null,
  teacher_amount  numeric(12,2) not null,
  platform_amount numeric(12,2) not null,
  payout_id       uuid          references public.payouts (id) on delete set null,
  created_at      timestamptz   not null default now(),

  -- A1: one ledger row per purchase, forever.
  constraint teacher_ledger_purchase_unique unique (purchase_id),

  -- Same range as `teachers_share_range_check`, so a copied value can never
  -- be a share the teacher could not have had.
  constraint teacher_ledger_share_check check (share_pct between 0 and 100),

  -- Nothing negative. A refund is a purchase status, not a negative ledger
  -- row (see the note on `refund_purchase()` below).
  constraint teacher_ledger_signs_check
    check (gross >= 0 and gst >= 0 and gateway_fee >= 0 and net >= 0
           and teacher_amount >= 0 and platform_amount >= 0),

  -- THE TWO THAT MATTER. Nothing evaporates in the rounding: the three parts
  -- rebuild the gross exactly, and the two shares rebuild the net exactly.
  -- A row that cannot pass these is a payout somebody would have to explain.
  constraint teacher_ledger_gross_check
    check (gst + gateway_fee + net = gross),
  constraint teacher_ledger_split_check
    check (teacher_amount + platform_amount = net)
);

comment on table public.teacher_ledger is
  'One row per PAID purchase: what was charged, what the tax and the gateway took, and how the rest was split (X3, V19 mock sets only). purchase_id is UNIQUE, so a retried webhook writes one row (A1). share_pct is a COPY taken at sale time, so changing a teacher''s share never rewrites history. RLS: a teacher reads their own; only an admin writes. Issue 27-razorpay-webhook-ledger.';
comment on column public.teacher_ledger.gross is
  'Rupees actually CHARGED, i.e. purchases.amount_inr after any coupon. Not the list price: a discounted sale earns a share of what came in.';
comment on column public.teacher_ledger.gst is
  'The 18% already inside the price, backed out: gross - gross / gst_divisor(), rounded to the paisa. X4 is unverified; a CA must confirm before the first live sale.';
comment on column public.teacher_ledger.gateway_fee is
  'What Razorpay kept, as the webhook reported it. Clamped so it can never push net below zero.';
comment on column public.teacher_ledger.net is
  'gross - gst - gateway_fee. X3: the teacher share is worked out on THIS, not on the gross.';
comment on column public.teacher_ledger.share_pct is
  'teachers.revenue_share_pct AS IT WAS when the money arrived. A copy on purpose.';
comment on column public.teacher_ledger.platform_amount is
  'net - teacher_amount, exactly. The platform carries the rounding remainder so the two halves always add back up to the net.';
comment on column public.teacher_ledger.payout_id is
  'NULL until this sale is included in a monthly payout (X1). The payout screen is issue 29.';

-- "What does this teacher still have coming?" -- the whole payout report.
create index if not exists teacher_ledger_unpaid_idx
  on public.teacher_ledger (teacher_id, created_at desc)
  where payout_id is null;

-- "What was in the November payout?"
create index if not exists teacher_ledger_payout_idx
  on public.teacher_ledger (payout_id)
  where payout_id is not null;

alter table public.teacher_ledger enable row level security;

-- A teacher reads their OWN rows: that is their earnings list. They cannot
-- write one, because a writable ledger is a teacher who can pay themselves.
create policy teacher_ledger_select_own on public.teacher_ledger
  for select to authenticated
  using (auth.uid() = teacher_id);

create policy teacher_ledger_admin_all on public.teacher_ledger
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- record_payment_event() -- A2's de-dupe, as one statement.
--
-- Returns TRUE when the event is new and the caller should go on and handle
-- it, FALSE when we have already accepted this event id and the caller must
-- do nothing at all.
--
-- `on conflict do nothing` plus `row_count` is the whole trick: the insert and
-- the "have I seen this?" are the SAME statement, so two deliveries racing
-- each other cannot both be told "new".
--
-- A blank event id answers FALSE and stores nothing. An event we cannot name
-- cannot be de-duped, and handling it would mean handling it again on the next
-- retry. `src/lib/purchases/webhook.ts` refuses it with a 400 before it ever
-- gets here; this is the second lock on the same door.
-- ---------------------------------------------------------------------------
create or replace function public.record_payment_event(
  new_event_id text,
  new_type     text,
  new_payload  jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted  text := btrim(coalesce(new_event_id, ''));
  kind    text := btrim(coalesce(new_type, ''));
  touched integer;
begin
  if wanted = '' or length(wanted) > 120 then
    return false;
  end if;

  insert into public.payment_events (event_id, type, payload)
  values (
    wanted,
    -- A body with no `event` field still has to be stored, or it cannot be
    -- de-duped. 'unknown' is honest; dropping the row is not.
    case when kind = '' then 'unknown' else left(kind, 80) end,
    coalesce(new_payload, '{}'::jsonb)
  )
  on conflict (event_id) do nothing;

  get diagnostics touched = row_count;
  return touched = 1;
end;
$$;

comment on function public.record_payment_event(text, text, jsonb) is
  'Store one webhook event id, or say we already had it. TRUE = new, handle it; FALSE = a repeat, do nothing (A2). The insert and the check are one statement, so two deliveries cannot both win. service_role only. Issue 27-razorpay-webhook-ledger.';

-- ---------------------------------------------------------------------------
-- forget_payment_event() -- undo the de-dupe row when the work did not happen.
--
-- THE ONE HOLE IN "DE-DUPE FIRST". `record_payment_event()` runs before the
-- grant, which is what A2 asks for. But the two are separate round trips from
-- the route, so a database failure can land BETWEEN them: the event id is
-- stored and the set never opened. Razorpay's next delivery would then be a
-- "duplicate" that does nothing, and the student has paid for a shut set.
--
-- So the webhook releases the id on that path and answers 500, which asks
-- Razorpay to deliver again. This is a compensating step, not a delete tool:
-- it is called with an id the handler stored seconds earlier, and the nightly
-- reconcile (A6) is the backstop if even this call fails.
-- ---------------------------------------------------------------------------
create or replace function public.forget_payment_event(new_event_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted  text := btrim(coalesce(new_event_id, ''));
  touched integer;
begin
  if wanted = '' then
    return false;
  end if;

  delete from public.payment_events e where e.event_id = wanted;

  get diagnostics touched = row_count;
  return touched = 1;
end;
$$;

comment on function public.forget_payment_event(text) is
  'Release one event id after its handling failed, so Razorpay''s retry is not de-duped away and a paid student is not left with a shut set. The compensating half of record_payment_event(). service_role only. Issue 27-razorpay-webhook-ledger.';

-- ---------------------------------------------------------------------------
-- grant_purchase(order_id, fee) -- the captured payment, in one transaction.
--
-- A5: "Access grant + ledger in one transaction keyed on purchase id." A
-- plpgsql body IS one transaction, and the first thing it does is take the
-- purchase row's lock, so a second delivery of the same payment waits here and
-- then finds the status already moved.
--
-- In order:
--   1. find our purchase from the Razorpay order id, FOR UPDATE,
--   2. created -> paid, with `status = 'created'` in the UPDATE's own WHERE
--      (A3: forward only, in the database and not in an IF),
--   3. `set_access`, with X2's window,
--   4. the ledger row with the split (X3),
--   5. spend the coupon use, because the sale is only now real.
--
-- Returns TRUE only when THIS call did the work. An unknown order id, an
-- already-paid purchase and a refunded purchase all answer FALSE, and the
-- route still replies 200: see the header on why a refusal is not an
-- exception.
--
-- `fee` is what Razorpay says it kept, in rupees. It is the ONE number in this
-- function that comes from outside, and it cannot do any harm: it only moves
-- money between the gateway column and the two shares, it is clamped to a
-- sane range, and the amount CHARGED still comes from our own `purchases` row
-- (F-G2 again).
-- ---------------------------------------------------------------------------
create or replace function public.grant_purchase(order_id text, fee numeric default 0)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted     text := btrim(coalesce(order_id, ''));
  bought     public.purchases;
  owner      uuid;
  for_exam   uuid;
  pct        integer;
  exam_day   date;
  open_until timestamptz;
  v_gross    numeric(12,2);
  v_gst      numeric(12,2);
  v_fee      numeric(12,2);
  v_net      numeric(12,2);
  v_teacher  numeric(12,2);
  touched    integer;
begin
  if wanted = '' then
    return false;
  end if;

  -- FOR UPDATE, and it is the first statement for a reason: it serialises two
  -- overlapping deliveries of the same payment. The second one blocks here,
  -- and when it wakes up the status is 'paid', so it falls out below.
  select p.* into bought
  from public.purchases p
  where p.razorpay_order_id = wanted
  for update;

  -- Not ours. A webhook for another project's order, or a test event. Nothing
  -- to do, and nothing wrong.
  if not found then
    return false;
  end if;

  -- A3. 'paid' is a repeat delivery; 'refunded' is a capture that arrived
  -- after the refund, and reopening it would hand back a set we have already
  -- paid the student back for.
  if bought.status <> 'created' then
    return false;
  end if;

  update public.purchases p
  set status = 'paid'
  where p.id = bought.id
    and p.status = 'created';

  get diagnostics touched = row_count;
  -- Belt and braces behind the lock: if the row moved under us, stop rather
  -- than write a ledger row for a sale we did not complete.
  if touched <> 1 then
    return false;
  end if;

  -- V19: the share is on MOCK SETS, and `purchases.set_id` only ever points at
  -- one. The teacher and the exam both come from the set, not from the request.
  select s.teacher_id, s.exam_id into owner, for_exam
  from public.mock_sets s
  where s.id = bought.set_id;

  select t.revenue_share_pct into pct
  from public.teachers t
  where t.user_id = owner;

  -- X2: "Until the teacher's next exam date for that exam + 30 days. If no
  -- date set: 12 months."
  select te.next_exam_date into exam_day
  from public.teacher_exams te
  where te.teacher_id = owner
    and te.exam_id = for_exam;

  open_until := case
    -- A date the teacher announced and has not yet let go stale. The `>
    -- current_date` guard is the practical reading of "no date set": a
    -- teacher who forgot to move last year's date must not sell a set that
    -- is already shut when the student taps it.
    when exam_day is not null and (exam_day + 30) > current_date
      then (exam_day + 30)::timestamptz
    else now() + public.access_fallback()
  end;

  insert into public.set_access (user_id, set_id, source, valid_until)
  values (bought.user_id, bought.set_id, 'purchase', open_until)
  on conflict (user_id, set_id, source)
    -- GREATEST, never a plain overwrite. The A4 zero-price path writes
    -- 'infinity' (0026), and a re-run must not shorten access somebody has
    -- already paid for.
    do update set valid_until = greatest(set_access.valid_until, excluded.valid_until);

  -- The split. Read the header for why only `gst` and `teacher_amount` are
  -- rounded and the other two are exact.
  v_gross := bought.amount_inr::numeric;
  v_gst   := round(v_gross - v_gross / public.gst_divisor(), 2);
  -- Clamped twice: never negative (a gateway does not pay us), and never more
  -- than what is left after tax, so `net` cannot go below zero and trip
  -- `teacher_ledger_signs_check`, which would roll back a sale that really
  -- happened.
  v_fee   := least(greatest(round(coalesce(fee, 0), 2), 0), v_gross - v_gst);
  v_net   := v_gross - v_gst - v_fee;

  -- A missing teachers row would mean a set with no owner, which cascades
  -- cannot produce; 0 keeps the arithmetic sound if it ever happens.
  pct := coalesce(pct, 0);
  v_teacher := round(v_net * pct / 100, 2);

  insert into public.teacher_ledger (
    teacher_id, purchase_id, gross, gst, gateway_fee, net, share_pct,
    teacher_amount, platform_amount
  )
  values (
    owner, bought.id, v_gross, v_gst, v_fee, v_net, pct,
    v_teacher, v_net - v_teacher
  )
  -- A1. Cannot happen behind the lock and the status check; it is here so
  -- that a hand re-run of the reconcile (A6) is safe too.
  on conflict (purchase_id) do nothing;

  -- 0026 deliberately left this to the webhook: "an abandoned checkout must
  -- not burn a code". The sale is real now, so the use is spent.
  --
  -- `used < max_uses` is in the WHERE and not left to the CHECK on purpose. If
  -- the code ran out while this student was on the card screen, tripping
  -- `coupons_used_check` would roll back the WHOLE transaction: money taken,
  -- set shut. An under-counted coupon is a reporting blemish; a locked-out
  -- paying student is a refund.
  if bought.coupon is not null then
    update public.coupons c
    set used = c.used + 1
    where c.code = bought.coupon
      and c.used < c.max_uses;
  end if;

  return true;
end;
$$;

comment on function public.grant_purchase(text, numeric) is
  'A captured Razorpay payment, in ONE transaction keyed on the purchase (A5): created -> paid (forward only, A3), set_access for X2''s window, one teacher_ledger row with the share copied at sale time (X3), and the coupon use spent. TRUE only when this call did the work; an unknown, already-paid or refunded order answers FALSE so the webhook can still reply 2xx. service_role only. Issue 27-razorpay-webhook-ledger.';

-- ---------------------------------------------------------------------------
-- refund_purchase(order_id) -- paid -> refunded, and the set shuts.
--
-- Only from `paid`. A refund event for a purchase that never paid (A3's
-- out-of-order case) answers FALSE and touches nothing: it must not mark a
-- `created` row refunded, because a `created` row can still legitimately be
-- paid by a capture that is a second behind.
--
-- It deletes ONLY the `source = 'purchase'` access row. `set_access`'s primary
-- key includes the source (0016) exactly so this is possible: a student who
-- also sits in a teacher's batch keeps the batch's access when their own
-- purchase is refunded.
--
-- THE LEDGER ROW IS LEFT ALONE, and that is a decision, not an oversight. A
-- ledger is append-only: deleting the row would make last month's report
-- disagree with itself, and writing a negative row would break
-- `teacher_ledger_signs_check` and the reconcile's "one row per purchase"
-- rule. The payout report (issue 29) joins `purchases.status` and leaves
-- refunded sales out, which is why `payout_id` exists on the row at all. A
-- sale already paid out and then refunded is a clawback, and X1 says that is
-- a manual bank matter in v1.
-- ---------------------------------------------------------------------------
create or replace function public.refund_purchase(order_id text)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted  text := btrim(coalesce(order_id, ''));
  bought  public.purchases;
  touched integer;
begin
  if wanted = '' then
    return false;
  end if;

  select p.* into bought
  from public.purchases p
  where p.razorpay_order_id = wanted
  for update;

  if not found then
    return false;
  end if;

  -- A3. 'created' means the capture has not landed (or never will), and
  -- 'refunded' means we have already done this.
  if bought.status <> 'paid' then
    return false;
  end if;

  update public.purchases p
  set status = 'refunded'
  where p.id = bought.id
    and p.status = 'paid';

  get diagnostics touched = row_count;
  if touched <> 1 then
    return false;
  end if;

  -- The purchase's own access, and nothing else. A batch or admin grant for
  -- the same set survives.
  delete from public.set_access a
  where a.user_id = bought.user_id
    and a.set_id = bought.set_id
    and a.source = 'purchase';

  return true;
end;
$$;

comment on function public.refund_purchase(text) is
  'A refunded Razorpay payment: paid -> refunded (forward only, A3) and the purchase''s own set_access row deleted, leaving any batch or admin grant alone. FALSE when the purchase never paid, so an out-of-order refund opens nothing. The ledger row is kept: a ledger is append-only. service_role only. Issue 27-razorpay-webhook-ledger.';

-- ---------------------------------------------------------------------------
-- Who may call them: the webhook, and nothing else.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and Supabase's default
-- privileges add `anon` and `authenticated`. All three are revoked here. Left
-- in place, `select grant_purchase('order_x', 0)` from any signed-in student's
-- own token is a free mock set, and `record_payment_event()` would let them
-- poison the de-dupe table so the real webhook does nothing.
--
-- `service_role` is granted INSIDE a guard, because that role is Supabase
-- platform config like `auth.users` and does not exist in the PGlite test
-- harness (web/CLAUDE.md). The harness runs migrations as the owner, which
-- needs no grant, so the tests still drive the real functions.
-- ---------------------------------------------------------------------------
revoke all on function public.record_payment_event(text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.forget_payment_event(text)
  from public, anon, authenticated;
revoke all on function public.grant_purchase(text, numeric)
  from public, anon, authenticated;
revoke all on function public.refund_purchase(text)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.record_payment_event(text, text, jsonb) to service_role';
    execute 'grant execute on function public.forget_payment_event(text) to service_role';
    execute 'grant execute on function public.grant_purchase(text, numeric) to service_role';
    execute 'grant execute on function public.refund_purchase(text) to service_role';
  end if;
end
$$;

-- The two constants are safe to read: a tax rate and a window length are not
-- secrets, and a later teacher dashboard will want to show both.
grant execute on function public.gst_divisor() to authenticated;
grant execute on function public.access_fallback() to authenticated;
