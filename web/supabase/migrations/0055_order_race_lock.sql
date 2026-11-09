-- 0055_order_race_lock.sql  (issue 80-fix-double-tap-order-race)
--
-- Two quick taps can both create a pending order. This closes that.
--
-- ROLLBACK. One statement: re-run the
-- `create or replace function public.start_set_purchase(...)` block from
-- `0049_block_second_order.sql`. This file only ADDS one line to it, so 0049
-- is the undo. Nothing here creates, drops or alters a table, a column, an
-- index or a policy.
--
-- THE BUG (review finding on issue 61). 0049 refuses a second order by READING
-- `purchases` ("is there a `created` row for this student and this set,
-- younger than 15 minutes?") and then INSERTING. Check-then-insert, with no
-- lock in between. A double tap that is merely FAST is caught, because the
-- first request has already committed by the time the second one reads. Two
-- requests that are truly CONCURRENT are not: both run the SELECT before
-- either runs the INSERT, both see no pending row, and both insert. The
-- student ends up with two `purchases` rows and two Razorpay orders, which is
-- exactly the double charge 61 was written to stop.
--
-- WHY A LOCK AND NOT A CONSTRAINT. 0049 already wrote down why a UNIQUE index
-- cannot express this rule, and none of it has changed: the rule is about TIME
-- (the same student and set are allowed again once the old row is stale) and
-- `now()` is not immutable, so a partial unique index cannot carry the
-- 15-minute window. A unique index also could not hand back the pending
-- Razorpay order id, which is the half of 61 the student actually sees. So the
-- two callers have to be put in a queue, and that is a lock.
--
-- WHY AN ADVISORY LOCK AND NOT `select ... for update`. There is nothing to
-- lock yet. The race is two callers who each find NO row: `for update` locks
-- rows that exist, and the first insert is invisible to the second caller's
-- snapshot anyway. The thing being protected is the PAIR (buyer, set), which is
-- a value, not a row, and an advisory lock is Postgres' lock on a value.
--
-- THE KEY. `hashtextextended(buyer::text || for_set::text, 0)` and nothing
-- else, so the lock is as narrow as the rule:
--   * the same student tapping the same set twice -> same key -> the second
--     call waits, then reads the committed row and refuses PP425 as before,
--   * two different students, or one student on two different sets -> different
--     keys -> neither ever waits for the other.
-- A hash can collide, and a collision here costs one unlucky pair of requests
-- a few milliseconds of waiting and changes no answer, because the SELECT that
-- follows still decides. That is the right trade for a 64-bit key.
--
-- WHY `xact` AND NOT A SESSION LOCK. `pg_advisory_xact_lock` is released by
-- COMMIT or ROLLBACK, always, including when a later refusal in this same
-- function raises. A session lock would need an explicit unlock that an
-- exception would skip, and a leaked lock would block that student from ever
-- buying that set again on a pooled connection.
--
-- WHERE IT SITS, AND WHY THERE. Immediately before the pending-order SELECT:
--   * AFTER the sign-in (PP401), live-set (PP404), own-set (PP403) and
--     already-owned (PP409) checks, so the refusal order the student sees is
--     byte for byte the one 0049 shipped, and so a caller who is going to be
--     refused for one of those reasons never queues for a lock at all,
--   * BEFORE the SELECT, because that is the whole fix. A lock taken after the
--     read would let both callers decide "no pending row" first and gate
--     nothing.
-- The lock is held to COMMIT, so the SELECT and the INSERT that follows are
-- both inside it. That is what makes check-then-insert safe.
--
-- WHAT DOES NOT MOVE. Same signature, same returns, same grants, same
-- SQLSTATEs (PP401, PP403, PP404, PP409, PP422, PP425) in the same order, same
-- DETAIL on PP425, same 15-minute window, same price read from `mock_sets`
-- (F-G2), same "a refusal spends no coupon use", same Rs 0 path (A4). This
-- function still never sets a purchase to `paid` for a real charge, never
-- writes `teacher_ledger` and never touches `payment_events` (A5, A6).
-- `purchases_pending_idx` stays where 0049 created it.
--
-- `src/lib/purchases/types.ts` still maps PP425 to the code `pending`, and the
-- checkout route needs no change: a queued second request now returns the same
-- refusal it would have returned if it had been a little slower.

-- ---------------------------------------------------------------------------
-- start_set_purchase(for_set, coupon_code)
--
-- 0049's function, plus ONE line (marked NEW IN 0055).
-- ---------------------------------------------------------------------------
create or replace function public.start_set_purchase(
  for_set     uuid,
  coupon_code text default null
)
returns table (purchase_id uuid, amount_inr integer, status text)
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  buyer      uuid    := auth.uid();
  price      integer;
  owner      uuid;
  -- `wanted` and not `code`: a plain `code` would be ambiguous against the
  -- `coupons.code` COLUMN in the lookup below, the same trap the parameter
  -- names avoid.
  wanted     text    := nullif(upper(btrim(coalesce(coupon_code, ''))), '');
  percent    integer := 0;
  owed       integer;
  new_id     uuid;
  new_status text;
  -- 0049: the payment that is already in flight, if there is one.
  pending_id    uuid;
  pending_order text;
begin
  if buyer is null then
    raise exception 'sign in to buy a mock set'
      using errcode = 'PP401';
  end if;

  -- F-G2. The price is read HERE, from our table, and only a LIVE set has one.
  select s.price_inr, s.teacher_id into price, owner
  from public.mock_sets s
  where s.id = for_set
    and s.status = 'live';

  if price is null then
    raise exception 'mock set not found'
      using errcode = 'PP404';
  end if;

  -- A teacher does not buy their own set: `questions_mock_needs_access`
  -- already lets them read it, so the charge would buy nothing.
  if owner = buyer then
    raise exception 'that is your own mock set'
      using errcode = 'PP403';
  end if;

  -- Already open, from any source (purchase, batch, admin). Charging again
  -- would be a refund ticket, and the same rule as `has_test_access()`:
  -- valid_until > now().
  if exists (
    select 1
    from public.set_access a
    where a.set_id = for_set
      and a.user_id = buyer
      and a.valid_until > now()
  ) then
    raise exception 'that mock set is already unlocked'
      using errcode = 'PP409';
  end if;

  -- -------------------------------------------------------------------------
  -- NEW IN 0055. One queue per (buyer, set), for the check-then-insert below.
  --
  -- Everything from here to the end of the transaction is one student's turn
  -- for one set. The second of two concurrent taps waits here, and by the time
  -- it is let through the first tap has committed its purchase row, so the
  -- SELECT that follows SEES that row and raises PP425 exactly as a slow
  -- second tap always did.
  --
  -- Released by COMMIT or ROLLBACK, including the rollback a PP422 coupon
  -- refusal below causes, so nothing can leak a lock onto a pooled connection.
  -- -------------------------------------------------------------------------
  perform pg_advisory_xact_lock(hashtextextended(buyer::text || for_set::text, 0));

  -- -------------------------------------------------------------------------
  -- From 0049. A payment this student already started for this set.
  --
  -- `status = 'created'` only: a `paid` row is finished business (and is
  -- normally caught by the PP409 above once the webhook has written
  -- `set_access`), and a `refunded` row is history.
  --
  -- The 15-minute window is the whole difference between "do not charge twice"
  -- and "you may never buy this set again". `created_at` is set by the column
  -- default, not by any caller, so it cannot be gamed from a request.
  --
  -- Newest first, because that is the checkout the student is most likely
  -- still looking at. `razorpay_order_id` may be NULL: the second tap can land
  -- before the Razorpay order even exists, and the refusal still has to
  -- happen. A pending row with a NULL order id is known and accepted.
  -- -------------------------------------------------------------------------
  select p.id, p.razorpay_order_id into pending_id, pending_order
  from public.purchases p
  where p.user_id = buyer
    and p.set_id = for_set
    and p.status = 'created'
    and p.created_at > now() - interval '15 minutes'
  order by p.created_at desc
  limit 1;

  if pending_id is not null then
    -- DETAIL carries the order id and NOTHING else, so the route can hand the
    -- browser back its own checkout. PostgREST sends it as `details`. An empty
    -- string means "pending, but no order yet": the UI says the same sentence
    -- and simply has nothing to reopen.
    raise exception 'a payment for this set is already in progress'
      using errcode = 'PP425', detail = coalesce(pending_order, '');
  end if;

  if wanted is not null then
    select c.percent_off into percent
    from public.coupons c
    where c.code = wanted
      and c.used < c.max_uses;

    -- Refused OUT LOUD. Silently charging full price for a code the student
    -- believed in is the support ticket that ends in a chargeback.
    if percent is null then
      raise exception 'that coupon is not valid'
        using errcode = 'PP422';
    end if;
  end if;

  -- Whole rupees, rounded UP. Razorpay takes paise, but our prices and our
  -- ledger are whole rupees, and rounding up keeps the half-rupee on our side
  -- rather than the student's. 100% off is still exactly 0.
  owed := ceil(price::numeric * (100 - percent) / 100)::integer;

  -- A4: Rs 0 has no gateway to wait for, so the sale is finished now.
  new_status := case when owed = 0 then 'paid' else 'created' end;

  insert into public.purchases (user_id, set_id, amount_inr, coupon, status)
  values (buyer, for_set, owed, wanted, new_status)
  returning id into new_id;

  -- A use is spent only when the sale is DONE. On the Razorpay path the
  -- webhook (issue 27) spends it, so an abandoned checkout does not burn a
  -- code that a real buyer could have used.
  if wanted is not null and new_status = 'paid' then
    update public.coupons c
    set used = c.used + 1
    where c.code = wanted;
  end if;

  if new_status = 'paid' then
    -- `source = 'purchase'`, and `infinity` because a bought set is bought
    -- forever (0016: NOT NULL on purpose, so every reader has one rule).
    insert into public.set_access (user_id, set_id, source, valid_until)
    values (buyer, for_set, 'purchase', 'infinity')
    on conflict (user_id, set_id, source)
      do update set valid_until = 'infinity';
  end if;

  return query select new_id, owed, new_status;
end;
$$;

comment on function public.start_set_purchase(uuid, text) is
  'Start buying one mock set. The amount is read from mock_sets, never passed in (F-G2). An Rs 0 coupon finishes the sale here: purchases paid plus set_access in ONE transaction, with no Razorpay call (A4). Refuses PP425 while a created purchase for the same student and set is younger than 15 minutes, with the pending Razorpay order id in DETAIL (issue 61-block-second-order). Takes pg_advisory_xact_lock on (buyer, set) before that check, so two CONCURRENT taps cannot both pass it (issue 80-fix-double-tap-order-race). Issue 26-razorpay-order-checkout.';

-- `create or replace` keeps the grants from 0026 and 0049. Spelled out again so
-- this file is readable on its own.
grant execute on function public.start_set_purchase(uuid, text) to authenticated;
