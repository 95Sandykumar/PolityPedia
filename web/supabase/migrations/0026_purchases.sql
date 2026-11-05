-- 0026_purchases.sql  (issue 26-razorpay-order-checkout)
--
-- Taking the money for a mock set, up to the point the Razorpay checkout
-- opens. design.md flow 4: "Razorpay Order (amount from DB, never from the
-- browser) -> checkout -> webhook (signature first) -> `payment_events`
-- de-dupe -> `purchases` row `paid` -> `set_access` row -> `teacher_ledger`
-- row with the split. Zero-price path: coupon to Rs 0 still writes
-- `purchases` + `set_access` (A4)."
--
-- EVERYTHING FROM THE WEBHOOK ONWARDS IS ISSUE 27. This file stops at the
-- order: it stores what is owed, hands back an amount, and for an Rs 0 coupon
-- it finishes the sale on the spot because there is no gateway in that path.
--
-- Four things live here:
--
--  * `purchases`            -- our own order state, one row per attempt to buy.
--  * `coupons`              -- a code and a percentage. Admin-only, in both
--                              directions: a student cannot read it either.
--  * `start_set_purchase()` -- the only way a `purchases` row is born.
--  * `attach_order_id()`    -- writes the Razorpay order id, once, ever.
--
-- WHERE THE PRICE RULE LIVES (F-G2: "the price always comes from our
-- database, never from the phone"). `start_set_purchase()` has NO amount
-- parameter. It reads `mock_sets.price_inr` itself. A route handler cannot
-- pass an amount through because there is nowhere to put one, and the browser
-- is told the amount only AFTER the database has decided it. The alternative
-- (validate the posted amount against the table) is the same check written
-- somewhere it can be forgotten.
--
-- WHERE THE ZERO-PRICE RULE LIVES (A4). Also `start_set_purchase()`. A plpgsql
-- function body is ONE transaction, so the `purchases` row, the `set_access`
-- row and the coupon's spent use either all land or none do. Splitting that
-- across two REST calls from a route handler is how a student ends up with a
-- paid purchase and no access, holding a receipt for a set that will not open.
--
-- WHY STUDENTS HAVE NO INSERT POLICY ON `purchases`. The two functions are
-- SECURITY DEFINER and they are the whole write surface. A student who could
-- insert their own row could insert `status = 'paid'`, and `status = 'paid'`
-- is what issue 27 and the nightly reconcile (A6) trust. The read policy is
-- separate and narrow: your own rows, so a receipt can be shown.
--
-- THE REFUSAL CODES. Both functions raise CUSTOM five-character SQLSTATEs,
-- because the standard ones would have had to do double duty:
-- `check_violation` cannot mean both "that is your own set" and "that coupon
-- is not valid" when the screen has to tell the student which it was.
-- `src/lib/purchases/types.ts` maps them back, and nothing else does.
--
--   PP401  not signed in
--   PP403  that is your own mock set
--   PP404  no such live set, or no such purchase of yours
--   PP409  you already own this set
--   PP422  the coupon (or the order id) is not valid
--
-- NO LEDGER AND NO PAYOUT HERE. `teacher_ledger` and `payment_events` are
-- issue 27's tables, written by the webhook that knows a payment really
-- happened.

-- ---------------------------------------------------------------------------
-- coupons
--
-- Created BEFORE `purchases` only for reading order; there is no foreign key
-- between them. `purchases.coupon` is a copy of the code AT SALE TIME, the
-- same reasoning as `teacher_ledger.share_pct` in design.md: deleting a
-- campaign must not rewrite what a student was charged last month.
-- ---------------------------------------------------------------------------
create table if not exists public.coupons (
  code        text        primary key,
  percent_off integer     not null,
  max_uses    integer     not null default 1,
  used        integer     not null default 0,
  created_at  timestamptz not null default now(),

  -- Stored upper case and trimmed, so 'free100', ' FREE100 ' and 'FREE100'
  -- cannot become three rows with three different discounts.
  constraint coupons_code_check
    check (code = upper(btrim(code)) and length(code) between 3 and 40),

  -- 1 to 100. A 0% coupon is not a discount, it is a confusing receipt.
  constraint coupons_percent_check check (percent_off between 1 and 100),

  constraint coupons_max_uses_check check (max_uses between 1 and 100000),

  -- THE EXHAUSTION GUARD, and it is a CHECK on purpose. `start_set_purchase()`
  -- reads `used < max_uses` first, but two buyers in the same millisecond both
  -- read the old value. The second UPDATE waits on the row lock, re-reads the
  -- committed `used`, and trips this CHECK, so its whole transaction rolls
  -- back: no purchase, no access, no over-spent code.
  constraint coupons_used_check check (used >= 0 and used <= max_uses)
);

comment on table public.coupons is
  'A discount code and its percentage. ADMIN ONLY in both directions: a student has no select policy either, because a readable coupons table is a 100%-off code anybody can look up. Issue 26-razorpay-order-checkout.';
comment on column public.coupons.percent_off is
  'A whole percentage, 1 to 100. 100 is the Rs 0 path (A4): it reaches set_access with no Razorpay call.';
comment on column public.coupons.used is
  'Uses SPENT. Only a paid sale spends one: an abandoned checkout must not burn a code. The CHECK used <= max_uses is the race-proof exhaustion guard.';

alter table public.coupons enable row level security;

-- An admin manages codes. Nobody else reads or writes a single row: with no
-- policy at all for a plain student, RLS returns them zero rows.
create policy coupons_admin_all on public.coupons
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- purchases
-- ---------------------------------------------------------------------------
create table if not exists public.purchases (
  id                uuid        primary key default gen_random_uuid(),
  user_id           uuid        not null references auth.users (id) on delete cascade,
  set_id            uuid        not null references public.mock_sets (id) on delete cascade,
  -- NULL until Razorpay has given us an order, and NULL forever on the Rs 0
  -- path, where there is no order. Postgres lets a UNIQUE column hold many
  -- NULLs, so A1 is enforced exactly where it means something and an
  -- abandoned checkout never blocks the next one.
  razorpay_order_id text        unique,
  amount_inr        integer     not null,
  coupon            text,
  status            text        not null default 'created',
  created_at        timestamptz not null default now(),

  -- 0 is legal and is the whole point of A4. The ceiling is a sanity rail: a
  -- set costs Rs 299 to Rs 399 (0015), so five figures is already a bug.
  constraint purchases_amount_check check (amount_inr between 0 and 100000),

  constraint purchases_status_check check (status in ('created', 'paid', 'refunded')),

  constraint purchases_coupon_check
    check (coupon is null or length(btrim(coupon)) between 3 and 40),

  -- A paid purchase has an order id OR was free. A `paid` row with neither is
  -- money we cannot trace back to Razorpay, which is exactly what the nightly
  -- reconcile (A6) exists to shout about.
  constraint purchases_paid_check
    check (status <> 'paid' or razorpay_order_id is not null or amount_inr = 0)
);

comment on table public.purchases is
  'Our own order state for one mock set: created -> paid (webhook, issue 27) -> refunded. The amount is OURS, read from mock_sets by start_set_purchase() and never taken from a request (F-G2). RLS: read your own; every write goes through the two SECURITY DEFINER functions here. Issue 26-razorpay-order-checkout.';
comment on column public.purchases.razorpay_order_id is
  'A1: UNIQUE, so one Razorpay order can never be two purchases. NULL until the order exists, and NULL forever on the Rs 0 coupon path.';
comment on column public.purchases.amount_inr is
  'Rupees owed AFTER the coupon, decided by the database. 0 means the A4 zero-price path, which is already paid.';
comment on column public.purchases.coupon is
  'A COPY of the code used, upper case, at sale time. Not a foreign key: deleting a campaign must not rewrite an old receipt.';

-- "My purchases, newest first": the receipt list a student sees.
create index if not exists purchases_user_idx
  on public.purchases (user_id, created_at desc);

-- "What sold, and did it pay": the teacher report and the nightly reconcile.
create index if not exists purchases_set_idx
  on public.purchases (set_id, status, created_at desc);

alter table public.purchases enable row level security;

-- READ your own. That is the receipt, and it tells you nothing about anybody
-- else's buying.
create policy purchases_select_own on public.purchases
  for select to authenticated
  using (auth.uid() = user_id);

-- An admin reads and fixes by hand: support, and the reconcile report.
create policy purchases_admin_all on public.purchases
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Deliberately absent: an insert or update policy for a plain student. See the
-- header. The two functions below are the entire write surface.

-- ---------------------------------------------------------------------------
-- start_set_purchase(for_set, coupon_code) -- the only way a purchase is born.
--
-- Returns one row: the purchase id, the rupees owed, and the status.
--   status 'created' -> the caller must now make a Razorpay order for
--                       `amount_inr` and call `attach_order_id()`.
--   status 'paid'    -> A4. Nothing left to do: `set_access` is already
--                       written and the set is open.
--
-- SECURITY DEFINER, because it writes two tables a student has no policy on
-- (`purchases`, `set_access`) and reads one they must never see (`coupons`).
-- It is safe to be definer because it takes its buyer from `auth.uid()` and
-- never from an argument: there is no way to spell "buy this for somebody
-- else", or "buy this as nobody".
--
-- The parameters are `for_set` and `coupon_code`, not `set_id` and `coupon`,
-- so neither can be read as the COLUMN of the same name inside a WHERE.
--
-- Five refusals, in the order a student meets them:
--   1. not signed in,
--   2. the set is not live (a draft price is not a price),
--   3. it is the teacher's own set,
--   4. they already own it (paying twice for one set is a refund ticket),
--   5. the coupon is unknown or spent.
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
  'Start buying one mock set. The amount is read from mock_sets, never passed in (F-G2). An Rs 0 coupon finishes the sale here: purchases paid plus set_access in ONE transaction, with no Razorpay call (A4). Issue 26-razorpay-order-checkout.';

grant execute on function public.start_set_purchase(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- attach_order_id(purchase, order_id) -- write the Razorpay order id. Once.
--
-- Called straight after the Razorpay Orders API answers, before the checkout
-- opens, so the webhook in issue 27 can find our row from the order id alone.
--
-- `razorpay_order_id is null` and `status = 'created'` are in the WHERE, not
-- in an IF: that makes the write single-shot inside Postgres rather than
-- inside a route handler. A second call cannot repoint a row at a different
-- order, and no call can touch a row that is already paid.
--
-- A wrong id, somebody else's purchase and an already-attached purchase all
-- answer the same 'purchase not found'. A caller holding a guessed uuid
-- learns nothing from the reply.
-- ---------------------------------------------------------------------------
create or replace function public.attach_order_id(purchase uuid, order_id text)
returns void
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  trimmed text := btrim(coalesce(order_id, ''));
  touched integer;
begin
  if auth.uid() is null then
    raise exception 'sign in to buy a mock set'
      using errcode = 'PP401';
  end if;

  if length(trimmed) between 1 and 80 then
    null;
  else
    raise exception 'order id is not valid'
      using errcode = 'PP422';
  end if;

  update public.purchases p
  set razorpay_order_id = trimmed
  where p.id = purchase
    and p.user_id = auth.uid()
    and p.status = 'created'
    and p.razorpay_order_id is null;

  get diagnostics touched = row_count;

  if touched <> 1 then
    raise exception 'purchase not found'
      using errcode = 'PP404';
  end if;
end;
$$;

comment on function public.attach_order_id(uuid, text) is
  'Store the Razorpay order id on the caller''s own created purchase. Single-shot: the WHERE requires a null order id, so a row can never be repointed at another order (A1). Issue 26-razorpay-order-checkout.';

grant execute on function public.attach_order_id(uuid, text) to authenticated;
