-- 0039_charge_alerts.sql  (issue 40-charge-alerts)
--
-- ONE CHANGE: the two subscription charges we used to drop in silence now
-- leave a line on /admin/alerts.
--
-- WHAT WAS WRONG (reviewer finding #10).
--
-- `charge_subscription()` in 0034 does the de-dupe insert into
-- `payment_events` FIRST and the month SECOND, inside one transaction. That
-- ordering is right and this file does not touch it: it is what stops a crash
-- from leaving the key stored and the month ungranted.
--
-- But it means the key is COMMITTED before the function decides whether the
-- month can be granted at all. Three refusals come after the insert, and until
-- now only one of them told a human:
--
--   plan mismatch           -> `reconcile_alerts` row + FALSE   (0034, good)
--   subscription not ours   -> FALSE, nothing else              (dropped)
--   subscription cancelled  -> FALSE, nothing else              (A3, dropped)
--
-- For the two dropped ones, Razorpay's retry of the SAME payment id hits the
-- de-dupe gate and is thrown away as "already seen". So: money was taken, no
-- month was granted, the retry cannot fix it, and nothing anywhere says so.
-- The FALSE goes to the webhook route, which correctly answers 2xx and forgets.
--
-- The unknown case is not a theory either. It is a RACE: Razorpay can deliver
-- `subscription.charged` before `attach_subscription_id()` has written our own
-- `razorpay_subscription_id`, and then a real paying student looks exactly
-- like somebody else's subscription.
--
-- THE FIX. Both branches call `record_reconcile_alert()` and then return FALSE,
-- exactly like the plan mismatch:
--
--   `unknown_subscription`    a charge for a Razorpay subscription id we have
--                             no row for. Either a race with our own write, or
--                             not ours at all. Look the payment up before
--                             refunding: a race means a real student paid.
--   `cancelled_subscription`  a charge that landed after the subscription was
--                             cancelled. The money has to go back, because a
--                             month for a plan the student stopped is a month
--                             we would owe anyway.
--
-- STILL NO RAISE for either, on purpose. A raise would roll back the de-dupe
-- row and make the route answer 5xx, and Razorpay would then retry a charge
-- that can never succeed, forever. FALSE + an alert is the same contract the
-- plan mismatch has had since 0034.
--
-- The subject is the same expression the plan mismatch uses, so one payment is
-- one line however many times it is delivered, and `(kind, subject)` UNIQUE in
-- 0029 does the de-duping: `charged:<pay id>` normally, and `sub:<rzp sub id>`
-- when the caller de-dupes itself and passed no key (the 0028 database tests).
--
-- NOT HERE, on purpose: the de-dupe insert is not moved, refunds and claims
-- are untouched, and no Telegram or email push is added. 0029 and 0035 both
-- say the alert row plus `/admin/alerts` is the whole delivery in v1.

-- ---------------------------------------------------------------------------
-- The kind list. `drop` then `add`, because Postgres has no "alter check
-- constraint", and both statements are guarded so a re-run of the file is free
-- (the PGlite harness and a repeated `supabase db push` both do that).
--
-- ALL EIGHT kinds from 0035 are repeated here. A shorter list would make every
-- existing alert row unwritable, which is the one failure that hides money.
-- ---------------------------------------------------------------------------
alter table public.reconcile_alerts
  drop constraint if exists reconcile_alerts_kind_check;

alter table public.reconcile_alerts
  add constraint reconcile_alerts_kind_check
  check (kind in (
    'no_purchase',
    'not_paid',
    'amount_mismatch',
    'no_payment',
    'currency_mismatch',
    'plan_mismatch',
    'bad_event',
    'unreadable_purchase',
    'unknown_subscription',
    'cancelled_subscription'
  ));

comment on column public.reconcile_alerts.kind is
  'no_purchase (money taken, no row), not_paid (row never turned paid), amount_mismatch (both paid, different amounts), no_payment (our row says paid, the gateway has nothing), currency_mismatch, plan_mismatch and bad_event (written by the webhook, issue 34), unreadable_purchase (the job could not parse N of our own purchase rows, so the rest of that night is suspect), unknown_subscription and cancelled_subscription (a subscription charge whose de-dupe row is already committed but whose month cannot be granted, so the retry buys nothing either, issue 40).';

-- ---------------------------------------------------------------------------
-- charge_subscription() -- the same function, with the two alerts added.
--
-- `create or replace`, NOT `drop` + `create`: the signature is unchanged, so
-- replacing it keeps the grants 0034 set (revoked from public / anon /
-- authenticated, granted to service_role only). A DROP here would silently
-- hand EXECUTE back to every signed-in account.
--
-- Everything else below is 0034's body, word for word, apart from the two new
-- `perform record_reconcile_alert(...)` calls.
-- ---------------------------------------------------------------------------
create or replace function public.charge_subscription(
  subscription_id text,
  charge_key      text    default null,
  new_type        text    default 'subscription.charged',
  new_payload     jsonb   default '{}'::jsonb,
  charged_plan    text    default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, auth, pg_temp
as $$
declare
  wanted  text := btrim(coalesce(subscription_id, ''));
  key     text := btrim(coalesce(charge_key, ''));
  kind    text := btrim(coalesce(new_type, ''));
  for_plan text := btrim(coalesce(charged_plan, ''));
  sub     public.subscriptions;
  touched integer;
begin
  if wanted = '' then
    return false;
  end if;

  -- Only our own code calls this, and only our own code can get the key
  -- wrong. A raise rather than a FALSE, the same call `mark_subscription()`
  -- makes for a status it does not know: a silent FALSE here would throw away
  -- a month somebody paid for.
  if key <> '' and length(key) > 120 then
    raise exception 'a subscription charge key is too long to de-dupe'
      using errcode = 'PP422';
  end if;

  -- THE DE-DUPE, AND THE LOCK. One statement, so two deliveries racing each
  -- other cannot both be told "new", and it is inside the same transaction as
  -- the month below, so neither can exist without the other.
  --
  -- IT STAYS FIRST (issue 40 did not move it). Every refusal below therefore
  -- runs with this row already committed, which is why each one has to file an
  -- alert: the retry will be dropped here.
  if key <> '' then
    insert into public.payment_events (event_id, type, payload)
    values (
      key,
      case when kind = '' then 'unknown' else left(kind, 80) end,
      coalesce(new_payload, '{}'::jsonb)
    )
    on conflict (event_id) do nothing;

    get diagnostics touched = row_count;
    -- Seen it. This exact charge has already been paid for.
    if touched <> 1 then
      return false;
    end if;
  end if;

  -- FOR UPDATE: it serialises anything else holding this subscription, so the
  -- month is added on top of the committed value and not on top of a stale
  -- read.
  select s.* into sub
  from public.subscriptions s
  where s.razorpay_subscription_id = wanted
  for update;

  -- Not ours: another project's subscription, a Razorpay test event, or OUR
  -- OWN RACE, where `charged` arrived before `attach_subscription_id()` wrote
  -- the id. The money is real in that last case, so this cannot stay a silent
  -- FALSE: the de-dupe row above means the retry buys nothing either
  -- (issue 40-charge-alerts).
  if not found then
    perform public.record_reconcile_alert(
      'unknown_subscription',
      left(case when key = '' then 'sub:' || wanted else key end, 160),
      null,
      null,
      null
    );
    return false;
  end if;

  -- THE PLAN. A Rs 100 AI charge must never extend a Rs 500 Pro plan, and a
  -- plan id we could not place is not something to guess about. The alert
  -- plus FALSE means the route answers 200 and a human looks at it, rather
  -- than Razorpay retrying a charge that can never be right.
  if for_plan <> '' and for_plan <> sub.plan then
    perform public.record_reconcile_alert(
      'plan_mismatch',
      left(case when key = '' then 'sub:' || wanted else key end, 160),
      null,
      null,
      null
    );
    return false;
  end if;

  -- A3. Cancelled is terminal. A charge that lands after a cancellation is
  -- either a race or a mistake on Razorpay's side, and buying a month for a
  -- plan the student has stopped is money we would have to give back. Which is
  -- the point of the alert: somebody has to give it back by hand, and the
  -- retry cannot tell us again (issue 40-charge-alerts).
  if sub.status = 'cancelled' then
    perform public.record_reconcile_alert(
      'cancelled_subscription',
      left(case when key = '' then 'sub:' || wanted else key end, 160),
      null,
      null,
      null
    );
    return false;
  end if;

  update public.subscriptions s
  set status = 'active'
  where s.id = sub.id
    and s.status <> 'cancelled';

  insert into public.entitlements (user_id, plan, valid_until, source)
  values (sub.user_id, sub.plan, now() + public.plan_period(), 'razorpay')
  on conflict (user_id, plan) do update
    set valid_until = greatest(public.entitlements.valid_until, now())
                      + public.plan_period(),
        source = 'razorpay';

  return true;
end;
$$;

comment on function public.charge_subscription(text, text, text, jsonb, text) is
  'One paid month for a Razorpay subscription, de-dupe row AND month in ONE transaction (issue 34), so a crash cannot leave one without the other. charge_key is the SIGNED body''s payment id as charged:<pay id>, never the unsigned x-razorpay-event-id header, so a replay under a new header buys nothing; NULL means the caller de-dupes itself. status -> active and entitlements.valid_until = greatest(paid-until, now) + plan_period(), so a renewal stacks and a lapsed plan restarts today. Writes NO teacher_ledger row (V19). EVERY refusal that happens after the de-dupe row is committed files a reconcile_alerts row and answers FALSE, never raises, so the webhook still replies 2xx while a human is told the retry will buy nothing: plan_mismatch (issue 34), unknown_subscription and cancelled_subscription (issue 40). A repeat is a plain FALSE with no alert: that one is correct, not lost. service_role only. Issues 28-plan-subscriptions, 34-webhook-grant-first and 40-charge-alerts.';
