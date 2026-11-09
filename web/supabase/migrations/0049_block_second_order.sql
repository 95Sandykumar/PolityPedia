-- 0049_block_second_order.sql  (issue 61-block-second-order)
--
-- No second order while a payment is pending.
--
-- ROLLBACK. Two statements, in this order:
--   1. re-run the `create or replace function public.start_set_purchase(...)`
--      block from `0026_purchases.sql` (this file only ADDS a check to it; it
--      is otherwise the same text, so 0026 is the undo),
--   2. `drop index if exists public.purchases_pending_idx;`
-- Nothing else here creates, drops or alters a table, a column or a policy.
--
-- THE BUG (walk persona-3, gap 4). `start_set_purchase()` decided "already
-- owned" from `set_access` ALONE. `set_access` is written by the webhook
-- (0027), so between the student paying and Razorpay calling us back there is
-- a window where the set is paid for and still locked. A student who taps
-- Unlock again in that window got a SECOND `purchases` row and a SECOND
-- Razorpay order. Two outcomes, both bad:
--   * both orders get paid -> the student is charged twice and we owe a refund,
--   * one gets paid -> a `created` row with a live order id that the nightly
--     reconcile (A6) has to explain every night.
--
-- THE RULE. A `created` purchase by the SAME student for the SAME set, younger
-- than 15 minutes, refuses the next order with a new SQLSTATE `PP425` and
-- carries the pending Razorpay order id in the error DETAIL. The checkout
-- route turns that into "A payment for this set is already in progress.", and
-- the detail is there so the UI can reopen the checkout the student already
-- has instead of opening a second one.
--
-- WHY 15 MINUTES, AND NOT "ANY CREATED ROW". A `created` row is also what an
-- ABANDONED checkout leaves behind (the student closed the modal, the card
-- failed, the phone died). Blocking on any created row would lock that student
-- out of a set they still want, forever, with no way out that is not a support
-- ticket. Razorpay's own checkout session is short-lived, so a created row
-- older than 15 minutes is dead paperwork and a fresh order is the right
-- answer. The window is written once, in the SELECT below.
--
-- WHY NOT A UNIQUE INDEX. "One created purchase per student per set" cannot be
-- expressed as a UNIQUE constraint, because the rule is about TIME: the same
-- pair is allowed again once the old row is stale, and a partial unique index
-- cannot say `created_at > now() - interval '15 minutes'` (now() is not
-- immutable). It also could not hand back the pending order id, which is the
-- half of this ticket the student actually sees.
--
-- WHY THIS EDITS THE FUNCTION AND NOT A TRIGGER. 0041 added its archived-set
-- guard as a BEFORE INSERT trigger to keep payment logic untouched. Here the
-- refusal has to CARRY something (the pending order id) and has to be checked
-- in the student's own refusal order, right after "you already own this", so
-- it lives in the function. This file now owns the text of
-- `start_set_purchase()`; it is 0026's body with ONE new block, marked below.
--
-- WHAT DOES NOT MOVE (A1 to A6, F-G2):
--   * the price is still read from `mock_sets.price_inr` here, and there is
--     still no amount parameter,
--   * this function still never sets a purchase to `paid` for a real charge,
--     never writes `teacher_ledger` and never touches `payment_events`,
--   * sign-in (PP401), live set (PP404), own set (PP403), already owned
--     (PP409) and coupon (PP422) keep their codes, their text and their order,
--   * a refusal spends no coupon use: a use is spent only by a DONE sale.
--
-- THE ORDER OF THE CHECKS IS THE DESIGN. "You already own this" comes BEFORE
-- "a payment is pending", because owned is the better news: reload and start
-- the test. And "a payment is pending" comes before the coupon lookup, because
-- a student with a live checkout needs to hear about it whatever they typed in
-- the coupon box.
--
--   PP401  not signed in
--   PP403  that is your own mock set
--   PP404  no such live set, or no such purchase of yours
--   PP409  you already own this set
--   PP422  the coupon (or the order id) is not valid
--   PP425  a payment for this set is already in progress   <-- NEW
--
-- `src/lib/purchases/types.ts` maps PP425 to the code `pending`, and nothing
-- else does.

-- ---------------------------------------------------------------------------
-- The read path the new check adds, as an index.
--
-- Partial, because only `created` rows are ever looked up this way, and the
-- whole point is that there is at most one of them per student per set. The
-- existing `purchases_user_idx (user_id, created_at desc)` would also serve,
-- but it carries every paid receipt a student has ever had.
-- ---------------------------------------------------------------------------
create index if not exists purchases_pending_idx
  on public.purchases (user_id, set_id, created_at desc)
  where status = 'created';

comment on index public.purchases_pending_idx is
  'The "is a payment already in progress for this set" lookup in start_set_purchase(). Issue 61-block-second-order.';

-- ---------------------------------------------------------------------------
-- start_set_purchase(for_set, coupon_code)
--
-- 0026's function, plus the pending-payment refusal. Same signature, same
-- returns, same grants.
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
  -- NEW IN 0049. A payment this student already started for this set.
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
  -- before the Razorpay order even exists, which is exactly the race this
  -- ticket is about, and the refusal still has to happen.
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
  'Start buying one mock set. The amount is read from mock_sets, never passed in (F-G2). An Rs 0 coupon finishes the sale here: purchases paid plus set_access in ONE transaction, with no Razorpay call (A4). Refuses PP425 while a created purchase for the same student and set is younger than 15 minutes, with the pending Razorpay order id in DETAIL (issue 61-block-second-order). Issue 26-razorpay-order-checkout.';

-- `create or replace` keeps the grants from 0026. Spelled out again so this
-- file is readable on its own.
grant execute on function public.start_set_purchase(uuid, text) to authenticated;
