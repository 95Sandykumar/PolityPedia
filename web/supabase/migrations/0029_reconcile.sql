-- 0029_reconcile.sql  (issue 29-ledger-reconcile-payouts)
--
-- THE TWO THINGS NOBODY WATCHES AT NIGHT.
--
-- design.md A6: "Nightly reconcile: Razorpay payments vs `purchases`,
-- mismatch -> alert." X1: "Monthly manual bank transfer from the
-- `teacher_ledger` report."
--
-- 0027 wrote the money down. This file is what happens afterwards: once a
-- night something checks that the gateway and our database still tell the same
-- story, and once a month Boss pays the teachers what the ledger says.
--
-- Both of them are run by a human or a cron, which means both of them WILL be
-- run twice. PM2 restarts. A cron fires twice when the clock moves. Boss
-- double-clicks Mark paid. So the rule for this whole file is: the second run
-- must change nothing.
--
-- Three things live here:
--
--  * `reconcile_alerts`          -- one row per distinct mismatch (A6).
--  * `record_reconcile_alert()`  -- write it, or say "already known".
--  * `payout_report()` and `mark_payout_paid()` -- the monthly transfer (X1).
--
-- WHAT IS NOT HERE. No Telegram alert, no email: the alert row IS the record,
-- and pushing it to Boss is the ClaudeClaw side, later. And no clawback for a
-- sale that was paid out and then refunded; X1 says that is a manual bank
-- matter in v1.
--
-- Security in one line: an alert payload names other people's payments, so the
-- table is ADMIN ONLY to read and service-role only to write. The payout
-- functions are SECURITY DEFINER with an explicit `is_admin()` guard, because
-- they have to write two tables in one transaction and a teacher must never be
-- able to pay themselves.

-- ---------------------------------------------------------------------------
-- ledger_month(ts) -- which month a sale belongs to.
--
-- ONE function, because `payout_report()` and `mark_payout_paid()` must agree
-- down to the last row. If the report grouped by one expression and the payout
-- selected by another, a sale could show as owed, be left out of the transfer,
-- and show as owed again next month, forever.
--
-- `Asia/Kolkata` AND NOT UTC, on purpose. Boss pays Indian teachers for an
-- Indian month. A sale at 2026-10-31 20:00 UTC happened at 01:30 on 1 November
-- in Delhi, and putting it in October would mean the October report Boss
-- already paid keeps growing.
--
-- IMMUTABLE is true here: `timezone(text, timestamptz)` with a literal zone
-- does not read the session TimeZone, and `to_char(timestamp, text)` is
-- immutable too. That is what lets the partial index below use it.
-- ---------------------------------------------------------------------------
create or replace function public.ledger_month(at timestamptz)
returns text
language sql
immutable
as $$
  select to_char(at at time zone 'Asia/Kolkata', 'YYYY-MM')
$$;

comment on function public.ledger_month(timestamptz) is
  'The payout month of a timestamp, as YYYY-MM in Asia/Kolkata. The ONE expression payout_report() and mark_payout_paid() both use, so a sale cannot be owed by one and skipped by the other. Issue 29-ledger-reconcile-payouts.';

grant execute on function public.ledger_month(timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- reconcile_alerts  (A6)
--
-- One row per DISTINCT PROBLEM, not one row per night. `(kind, subject)` is
-- UNIQUE and that is the whole design: the nightly job keeps seeing the same
-- ghost payment until somebody fixes it, and Boss must see one line about it,
-- not thirty.
--
-- `subject` is whatever names the problem so a human can look it up:
--   * a Razorpay payment id        -- for the three gateway-side kinds
--   * `order:<razorpay order id>`  -- for `no_payment`, where there is no
--                                     payment id, because that is the point
--
-- The four kinds, worst first:
--
--   `no_purchase`     Razorpay captured money and we have no purchase row for
--                     it. A student paid and got nothing. Refund or grant.
--   `not_paid`        We have the purchase, Razorpay captured it, and our row
--                     never turned `paid`. The webhook was lost. The set is
--                     shut and the money is gone.
--   `amount_mismatch` Both sides agree it is paid and disagree about how much.
--                     Either a price changed mid-checkout or a coupon did.
--   `no_payment`      Our row says `paid` and Razorpay has no captured payment
--                     for that order. A set given away, or a test-mode row in
--                     a live database.
--
-- WHY NOT just one `detail jsonb`: the two amounts are the first thing a human
-- asks about, and a column can be compared, summed and indexed. The paise are
-- kept as PAISE (bigint, integers) rather than rupees: that is the unit
-- Razorpay speaks, and converting before storing is how a rounding argument
-- starts.
--
-- `resolved_at` is how an alert stops being news without being deleted. A
-- deleted alert is an audit trail Boss cannot reconstruct; a resolved one is
-- a decision somebody made.
-- ---------------------------------------------------------------------------
create table if not exists public.reconcile_alerts (
  id             uuid        primary key default gen_random_uuid(),
  kind           text        not null,
  subject        text        not null,
  order_id       text,
  expected_paise bigint,
  actual_paise   bigint,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,

  -- A LIST, not free text. A typo in the job would otherwise write
  -- `no_purchse` and sit in the table looking like a different problem,
  -- un-deduped, forever.
  constraint reconcile_alerts_kind_check
    check (kind in ('no_purchase', 'not_paid', 'amount_mismatch', 'no_payment')),

  -- THE DE-DUPE. Two different problems with one payment are two rows (a
  -- payment can be both unknown to us and the wrong amount), the same problem
  -- twice is one row.
  constraint reconcile_alerts_subject_unique unique (kind, subject),

  -- An alert nobody can look up is noise. 160 fits a payment id, an order id
  -- and the `order:` prefix with room to spare.
  constraint reconcile_alerts_subject_check
    check (length(btrim(subject)) between 1 and 160),
  constraint reconcile_alerts_order_check
    check (order_id is null or length(btrim(order_id)) between 1 and 80),

  -- Negative money is not a mismatch, it is a bug in the job.
  constraint reconcile_alerts_amounts_check
    check ((expected_paise is null or expected_paise >= 0)
           and (actual_paise is null or actual_paise >= 0))
);

comment on table public.reconcile_alerts is
  'One row per distinct mismatch between Razorpay and our purchases (A6). (kind, subject) is UNIQUE, so a nightly job that keeps seeing the same problem keeps showing Boss one line. ADMIN ONLY to read: a subject names somebody''s payment. service_role only to write. Issue 29-ledger-reconcile-payouts.';
comment on column public.reconcile_alerts.kind is
  'no_purchase (money taken, no row), not_paid (row never turned paid), amount_mismatch (both paid, different amounts), no_payment (our row says paid, the gateway has nothing).';
comment on column public.reconcile_alerts.subject is
  'What names this problem: the Razorpay payment id, or order:<order id> for no_payment, where there is no payment to name. Half of the UNIQUE that makes a re-run free.';
comment on column public.reconcile_alerts.expected_paise is
  'What OUR purchase row says, in paise. NULL when we have no row to compare.';
comment on column public.reconcile_alerts.actual_paise is
  'What RAZORPAY says, in paise. NULL when the gateway has no payment at all.';
comment on column public.reconcile_alerts.resolved_at is
  'NULL while this still needs Boss. Set by hand once it is dealt with. An alert is never deleted: that would erase the trail of a money problem.';

-- "What is still open?", which is the only question this table is ever asked.
create index if not exists reconcile_alerts_open_idx
  on public.reconcile_alerts (created_at desc)
  where resolved_at is null;

alter table public.reconcile_alerts enable row level security;

-- Admin only, in both directions. There is NO policy for a plain user, so RLS
-- hands a student and a teacher zero rows. A teacher is deliberately shut out
-- too: a subject names another teacher's sale.
create policy reconcile_alerts_admin_all on public.reconcile_alerts
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- record_reconcile_alert() -- A6's write, as ONE statement.
--
-- Returns TRUE when this was a new problem and FALSE when we already knew, so
-- the job can log "3 mismatches, 1 new" rather than shouting the same thing
-- every night.
--
-- `on conflict do nothing` plus `found` is the same trick 0027 uses for
-- `record_payment_event()`: the insert and the "have I seen this?" are the
-- SAME statement, so two runs that overlap cannot both be told "new".
--
-- IT DOES NOT UPDATE THE AMOUNTS on a conflict. The FIRST sighting is the one
-- worth keeping: if the numbers moved afterwards, that is a second problem and
-- overwriting the first would hide how it started.
-- ---------------------------------------------------------------------------
create or replace function public.record_reconcile_alert(
  new_kind           text,
  new_subject        text,
  new_order_id       text default null,
  new_expected_paise bigint default null,
  new_actual_paise   bigint default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  trimmed text := btrim(coalesce(new_subject, ''));
begin
  -- A nameless alert cannot be de-duped, so it would be written again every
  -- night. Refused loudly: this is a bug in the caller, not a mismatch.
  if trimmed = '' then
    raise exception 'a reconcile alert needs a subject' using errcode = 'PP422';
  end if;

  insert into public.reconcile_alerts (
    kind, subject, order_id, expected_paise, actual_paise
  )
  values (
    new_kind, trimmed, nullif(btrim(coalesce(new_order_id, '')), ''),
    new_expected_paise, new_actual_paise
  )
  on conflict (kind, subject) do nothing;

  return found;
end;
$$;

comment on function public.record_reconcile_alert(text, text, text, bigint, bigint) is
  'Write one reconcile mismatch, or say we already knew. TRUE = new row, FALSE = this exact (kind, subject) is already on the list, which is what makes a nightly re-run free (A6). service_role only. Issue 29-ledger-reconcile-payouts.';

-- ---------------------------------------------------------------------------
-- payout_report(for_period) -- "what do I owe, per teacher, per month?" (X1)
--
-- The unpaid half of `teacher_ledger`, grouped the way a bank transfer is
-- made: one teacher, one month, one number.
--
-- THREE RULES ARE IN THE `WHERE`, and each of them is money.
--
--  1. `payout_id is null`. A linked row has been paid. This is what makes the
--     report shrink when Boss presses Mark paid, and it is why the
--     `teacher_ledger_unpaid_idx` partial index in 0027 exists.
--
--  2. `p.status = 'paid'`. 0027 KEEPS the ledger row when a purchase is
--     refunded, because a ledger is append-only, and it says so out loud: "the
--     payout report (issue 29) joins `purchases.status` and leaves refunded
--     sales out". This is that join. Without it Boss pays a teacher for money
--     that went back to the student.
--
--  3. `teacher_amount`, not `net` and not `gross`. The teacher's half only.
--
-- SECURITY DEFINER with an `is_admin()` guard rather than plain RLS: the whole
-- point of the report is to sum across every teacher, and the
-- `teacher_ledger_select_own` policy would (correctly) hand a teacher only
-- their own rows and a student nothing. A teacher asking for this gets a
-- refusal, not a filtered answer: a half-answer looks like a complete one.
-- ---------------------------------------------------------------------------
create or replace function public.payout_report(for_period text default null)
returns table (
  teacher_id uuid,
  period     text,
  sale_count bigint,
  amount     numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'the payout report is admin only' using errcode = 'PP403';
  end if;

  return query
    select l.teacher_id,
           public.ledger_month(l.created_at) as period,
           count(*)                          as sale_count,
           sum(l.teacher_amount)             as amount
    from public.teacher_ledger l
    join public.purchases p on p.id = l.purchase_id
    where l.payout_id is null
      and p.status = 'paid'
      and (for_period is null or public.ledger_month(l.created_at) = for_period)
    group by l.teacher_id, public.ledger_month(l.created_at)
    -- Newest month first, biggest cheque first: the order Boss works in.
    order by period desc, amount desc;
end;
$$;

comment on function public.payout_report(text) is
  'Unpaid teacher earnings, per teacher per month (X1): ledger rows with no payout_id whose purchase is still paid, summed on teacher_amount. Refunded sales are left out. ADMIN ONLY, and it refuses a teacher rather than filtering, because a half-answer reads like a whole one. Issue 29-ledger-reconcile-payouts.';

-- ---------------------------------------------------------------------------
-- mark_payout_paid(teacher, period, reference) -- the transfer happened (X1)
--
-- Returns the payout id, or NULL when nothing was owed, so the screen can say
-- "nothing to pay" instead of reporting a payout that did not happen.
--
-- ONE TRANSACTION, and it has to be. The `payouts` row and the `payout_id` on
-- every ledger row are the same fact written in two places: a crash between
-- them leaves either a payout for sales that still look unpaid (Boss pays
-- twice) or paid-looking sales with no payout (the teacher's earnings list
-- disagrees with their bank). The `for update` on the ledger rows holds them
-- while the payout is written, so a second press cannot grab the same rows.
--
-- WHY IT PICKS THE ROWS FIRST AND SUMS THOSE EXACT IDS, instead of summing
-- the month and then updating the month: between the sum and the update a
-- webhook can land a new sale in the same month, and the payout would then
-- claim rows whose money is not in its total. The ids are collected under the
-- lock, and only they are touched.
--
-- WHY `on conflict do update` AND NOT a refusal. `payouts_period_unique`
-- allows one payout per teacher per month, which is right: it is the thing
-- that stops a double payment. But a webhook can land a late sale inside a
-- month Boss already paid, and refusing would strand that money forever with
-- no way to clear it. So a second call for a month that has new unpaid rows
-- TOPS UP the same payout row and returns the same id. The amount only ever
-- grows by rows this call actually linked, so the total always equals the sum
-- of its ledger rows.
--
-- The reference is overwritten on a top-up, because the latest transfer is the
-- one Boss can look up in the bank. The ledger rows carry the full history.
-- ---------------------------------------------------------------------------
create or replace function public.mark_payout_paid(
  for_teacher  uuid,
  for_period   text,
  new_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  row_ids   uuid[];
  owed      numeric;
  payout    uuid;
  reference text := nullif(btrim(coalesce(new_reference, '')), '');
begin
  if not public.is_admin() then
    raise exception 'marking a payout paid is admin only' using errcode = 'PP403';
  end if;

  -- Checked here and not left to `payouts_period_check`, so a bad month is a
  -- clear refusal rather than a constraint name in a browser. Two spellings of
  -- one month would be two payouts for the same sales.
  if for_period is null or for_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'a payout period must be YYYY-MM' using errcode = 'PP422';
  end if;

  if for_teacher is null then
    raise exception 'a payout needs a teacher' using errcode = 'PP422';
  end if;

  -- The exact rows this payout will cover, locked so a second press cannot
  -- claim them too. Same three rules as `payout_report()`.
  select array_agg(l.id), coalesce(sum(l.teacher_amount), 0)
  into row_ids, owed
  from (
    select l.id, l.teacher_amount
    from public.teacher_ledger l
    join public.purchases p on p.id = l.purchase_id
    where l.teacher_id = for_teacher
      and l.payout_id is null
      and p.status = 'paid'
      and public.ledger_month(l.created_at) = for_period
    for update of l
  ) l;

  -- Nothing owed. NULL, and not a zero payout: a `payouts` row says money
  -- moved, and no money moved.
  if row_ids is null or array_length(row_ids, 1) = 0 then
    return null;
  end if;

  insert into public.payouts (teacher_id, period, amount, paid_at, reference)
  values (for_teacher, for_period, owed, now(), reference)
  on conflict (teacher_id, period) do update
    -- `+`, never `=`: a top-up adds the rows this call linked to what the
    -- earlier call already paid, so the payout total always equals the sum of
    -- its own ledger rows.
    set amount    = public.payouts.amount + excluded.amount,
        paid_at   = now(),
        reference = coalesce(excluded.reference, public.payouts.reference)
  returning id into payout;

  update public.teacher_ledger
  set payout_id = payout
  where id = any(row_ids);

  return payout;
end;
$$;

comment on function public.mark_payout_paid(uuid, text, text) is
  'Record the monthly manual bank transfer (X1): one payouts row plus payout_id on every unpaid, still-paid ledger row of that month, in ONE transaction. Returns the payout id, or NULL when nothing was owed, so a second press pays nothing. A late sale in an already-paid month tops the same payout up. ADMIN ONLY. Issue 29-ledger-reconcile-payouts.';

-- ---------------------------------------------------------------------------
-- Who may call them.
--
-- Postgres grants EXECUTE on a new function to PUBLIC, and Supabase's default
-- privileges add `anon` and `authenticated`. For the WRITER that is a hole:
-- `select record_reconcile_alert('no_purchase', 'pay_x')` from any signed-in
-- student would let them fill Boss's alert list with invented problems until
-- the real ones are unfindable. So it is revoked from everybody and handed to
-- `service_role`, which is what the nightly job runs as.
--
-- `service_role` is granted INSIDE a guard, because that role is Supabase
-- platform config like `auth.users` and does not exist in the PGlite test
-- harness (web/CLAUDE.md). The harness runs migrations as the owner, which
-- needs no grant, so the tests still drive the real function.
--
-- The TWO PAYOUT functions go to `authenticated` and NOT to `service_role`:
-- the admin screen calls them with the admin's OWN access token, and the
-- `is_admin()` guard inside each one is the gate. `service_role` has no
-- `auth.uid()`, so it would be refused by that guard anyway, and a grant that
-- cannot work is a grant a later reader trusts by mistake. No service-role key
-- reaches the payout route.
-- ---------------------------------------------------------------------------
revoke all on function public.record_reconcile_alert(text, text, text, bigint, bigint)
  from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.record_reconcile_alert(text, text, text, bigint, bigint) to service_role';
  end if;
end
$$;

grant execute on function public.payout_report(text) to authenticated;
grant execute on function public.mark_payout_paid(uuid, text, text) to authenticated;
