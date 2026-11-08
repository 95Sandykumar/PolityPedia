# GO-LIVE: taking real money, step by step

This is ticket **H5**. It is the day PolityPedia stops being a test app and
starts taking real rupees from real students.

Until every step below is done, the app uses **Razorpay TEST keys only**. Test
keys take no money. Nothing in this file can be skipped by "we will fix it
after the first sale": the first sale is the one that cannot be undone.

Run everything from inside `web/`.

Two commands do the checking for you:

```
node --import ./jobs/register-alias.mjs jobs/golive-check.ts --expect test
node --import ./jobs/register-alias.mjs jobs/verify-test-purchase.ts <id>
```

Both are **read only**. Neither can write a row, change a key or call Razorpay.

---

## 1. The seven gates

Nobody can automate these. Clear each one, then write it into
`web/golive.json` so the preflight can see it.

First time only:

```
cp golive.example.json golive.json
```

`golive.json` is gitignored. It holds real names and dates, so it is yours, not
the repo's.

| Gate | Who clears it | What clearing it means |
|---|---|---|
| **X1** payout method | Boss | Monthly manual bank transfer from the `teacher_ledger` report is confirmed as the v1 payout. Razorpay Route (auto split, needs teacher KYC) stays in V2. |
| **X3** revenue split | Boss, with each teacher | The share percentage per teacher is agreed **in writing**. It is worked out on the **net** (gross minus GST minus the gateway fee), never on the gross. |
| **X4** GST and TCS | A chartered accountant | A CA confirms the GST treatment and the e-commerce operator TCS on teacher sales. The code treats prices as **GST-inclusive** and backs 18% out of them. That rate lives in ONE place: `public.gst_divisor()` in `supabase/migrations/0027_ledger.sql`. If the CA says something different, that one function is the change. |
| **X8** Adda247 contract | Boss | Boss has read the Adda247 contract and is satisfied that running PolityPedia and taking money through it breaks no clause in it. |
| **B9** Vercel Pro | Boss | The Vercel plan is **Pro**. The free plan has no commercial-use right, and its function limits will cut a paid checkout off mid-flight. |
| **AS6** real Razorpay fee | Boss, from the Razorpay dashboard | The real fee percentage on a live Rs 299 sale is known and written down. The ledger stores whatever fee the webhook reports, so a wrong guess never corrupts a row, but every payout forecast until now used one. |
| **KYC** Razorpay KYC | Razorpay | The Razorpay account KYC is approved and live keys have been issued. Until then there are no live keys to switch to. |

A gate counts as done only with all three of `done: true`, a `by` and a
`date`. A `done: true` on its own is refused and reported, so a half-finished
edit cannot wave a gate through.

```json
"X4": { "done": true, "by": "Name of the CA", "date": "2026-11-20" }
```

---

## 2. Env to change in Vercel

Names only. **Never paste a key value into a chat window, a commit, an issue or
a screenshot.**

In Vercel: Project, Settings, Environment Variables, **Production**.

| Name | What it is | Where else it lives |
|---|---|---|
| `RAZORPAY_KEY_ID` | The public half of the key pair. Starts `rzp_live_` on the day. | `web/.env.local` for the laptop jobs |
| `RAZORPAY_KEY_SECRET` | The secret half. Take it from the **same** dashboard mode as the key id. | `web/.env.local` |
| `RAZORPAY_WEBHOOK_SECRET` | The webhook signing secret. The same string has to be in the Razorpay dashboard webhook. | `web/.env.local` |
| `RAZORPAY_PLAN_PRO_ID` | The Razorpay plan id for the Pro plan. Subscriptions only. | `web/.env.local` |
| `RAZORPAY_PLAN_AI_ID` | The Razorpay plan id for the AI plan. Subscriptions only. | `web/.env.local` |
| `NEXT_PUBLIC_SUPABASE_URL` | The project URL. Not a secret. | `web/.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server only.** It bypasses every RLS policy. It must NEVER get a `NEXT_PUBLIC_` prefix. | `web/.env.local` for the PM2 jobs |
| `NEXT_PUBLIC_SITE_URL` | Which URL the app calls its own. | optional |

Two things that look like env and are not:

- **The checkout script URL** is a code constant, `RAZORPAY_CHECKOUT_SRC` in
  `src/lib/purchases/types.ts`. There is nothing to set.
- **The webhook path** is `/api/webhooks/razorpay`. Paste
  `https://<your site>/api/webhooks/razorpay` into the Razorpay dashboard.

Redeploy after changing env. Vercel env changes do **not** reach a running
deployment.

In the Razorpay dashboard webhook, subscribe at least:
`payment.captured`, `refund.created`, `refund.processed`. Subscribe
`order.paid` too if you like; a second grant event is harmless because
`grant_purchase()` refuses it.

---

## 3. Run the preflight

**Today, and every day until go-live:**

```
node --import ./jobs/register-alias.mjs jobs/golive-check.ts --expect test
```

Read the exit code, then the table:

- `0` nothing is broken.
- `1` at least one row says **FAIL**. Fix it before anything else.

Statuses mean exactly four different things:

| Status | Meaning |
|---|---|
| `PASS` | Checked, and right. |
| `FAIL` | Checked, and **wrong**. Exit code 1. |
| `WARN` | Not wrong, but not go-live. Test keys are the main one. |
| `MANUAL` | The tool could not look. A CA's answer, a KYC, a `pm2` on another laptop. Not a failure. |

**On the day, after the env swap and the redeploy:**

```
node --import ./jobs/register-alias.mjs jobs/golive-check.ts --expect live
```

`--expect live` changes two things, and they are the whole point of the flag:

- Test keys become a **FAIL** instead of a WARN.
- Every unsigned gate becomes a **FAIL** instead of a MANUAL.

A live key pair is only a PASS when **every other row** is already a PASS. Live
keys with an open reconcile alert behind them is the exact shape of a wrong
go-live, so the tool refuses it.

To check a deployment that is not the default:

```
node --import ./jobs/register-alias.mjs jobs/golive-check.ts --expect live --site https://politypedia.vercel.app
```

---

## 4. The one Rs 299 purchase

Do this with live keys in place, from a real phone, on a real card or UPI.

1. Sign in as a **student account that is not the teacher's**. A teacher cannot
   buy their own set; the database refuses it.
2. Pick a live mock set priced at Rs 299. Do not use a coupon: an Rs 0 coupon
   sale never touches Razorpay, so it proves nothing about the money path.
3. Pay. Let the checkout finish on its own. Do not close the tab.
4. The set should open **within seconds**. That is the webhook working.
5. In the Razorpay dashboard, open the payment and copy its **payment id**. It
   starts `pay_`.

---

## 5. Verify the purchase

```
node --import ./jobs/register-alias.mjs jobs/verify-test-purchase.ts pay_XXXXXXXXXXXXXX
```

An order id (`order_...`) or the purchase uuid work too.
For a set at another price, add `--amount 399`.

Nine rows, every one read off the migrations:

| Row | What it proves |
|---|---|
| purchase status | The row is `paid`. |
| purchase amount | Rs 299 was charged, and the amount came from our database. |
| one teacher_ledger row | Exactly one. Two rows would mean the teacher gets paid twice. |
| ledger split | `gst`, `fee`, `net`, `teacher` and `platform` are right to the paisa. |
| share copied | `share_pct` is the copy taken at sale time, not today's number. |
| buyer access | `set_access` with `source=purchase`, ending where X2 says. |
| payment_events row | The webhook's audit row is there, once. |
| reconcile alerts | Nothing unresolved for this sale. |
| refund path | With `--refunded`: the refund really ran. |

Exit code 1 means **do not take another payment** until it is explained.

---

## 6. The refund

In the Razorpay dashboard, refund that same payment in full. Then:

```
node --import ./jobs/register-alias.mjs jobs/verify-test-purchase.ts pay_XXXXXXXXXXXXXX --refunded
```

What should be true, and the tool checks all four:

- The purchase is `refunded`.
- The student's `source=purchase` access is **gone**, so the set is shut.
- The `teacher_ledger` row is **still there**. A ledger is append-only: the
  payout report leaves refunded sales out by joining `purchases.status`, and
  deleting the row would make last month's report disagree with itself.
- A `refund.created` or `refund.processed` event was stored.

If a batch or admin grant gave the same student access to the same set, that
grant survives on purpose. Only the purchase's own row is deleted.

---

## 7. Start the two PM2 apps

Both already exist in `web/ecosystem.config.cjs`. H5 is the ticket that starts
them. Run from the **repo root**:

```
npx pm2 start web/ecosystem.config.cjs --only polity-pdf-split
npx pm2 start web/ecosystem.config.cjs --only polity-ledger
npx pm2 ls
```

Reading the logs:

```
npx pm2 logs polity-pdf-split --lines 50
npx pm2 logs polity-ledger --lines 50
```

What healthy looks like, and this trips people up:

| App | What it is | Healthy state in `pm2 ls` |
|---|---|---|
| `polity-pdf-split` | A listener. It waits for PDF split jobs. | `online` |
| `polity-ledger` | A cron job at 2 AM. It compares one night and exits. | `online` while it runs, then **`stopped`** |

`stopped` on `polity-ledger` is the job **finishing**, not crashing.
`stop_exit_codes: [0]` in the ecosystem file is what makes a clean night show
that way. The preflight knows this and does not fail on it.

Both apps read their secrets from `web/.env.local` or from the shell that
started PM2. No key is in `ecosystem.config.cjs`.

Make PM2 come back after a reboot:

```
npx pm2 save
```

---

## 8. Roll back to test keys, in one step

If anything looks wrong after going live, roll back **first** and investigate
after. One minute of test keys costs nothing; one hour of a broken money path
costs a refund queue.

1. In Vercel, Production env: set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and
   `RAZORPAY_WEBHOOK_SECRET` back to the **test** values.
2. Redeploy. (Vercel: Deployments, the latest one, Redeploy. Env changes do not
   reach a running deployment.)
3. In the Razorpay dashboard, point the webhook at the **test**-mode webhook
   with the test secret.
4. Confirm:

```
node --import ./jobs/register-alias.mjs jobs/golive-check.ts --expect test
```

The key MODE row should read `test mode, no real money`.

Keep both key pairs written down somewhere safe **before** go-live day, so the
rollback is a paste and not a hunt.

---

## 9. Never do

- **Never** mix a test key id with a live key secret, or the reverse. Take both
  halves from the same dashboard mode, at the same time. The preflight calls
  this `mixed` and fails it in both modes, because nothing can recover from it
  at runtime.
- **Never** switch to live keys while `/admin/alerts` has an open row. An open
  alert means the last night of **test** money did not add up.
- **Never** paste a key, a secret, a token or a payment secret into a chat, a
  commit, an issue or a screenshot. Neither of these tools ever prints one, and
  neither should you.
- **Never** give `SUPABASE_SERVICE_ROLE_KEY` a `NEXT_PUBLIC_` prefix, and never
  put it in a Vercel preview environment you share. It bypasses every RLS
  policy in the database.
- **Never** edit a `purchases`, `teacher_ledger` or `payment_events` row by
  hand to "fix" a sale. Those rows are what the nightly reconcile and the
  payout report trust. Open `/admin/alerts` instead.
- **Never** pay a teacher out from a `teacher_ledger` row whose `ledger split`
  row failed the verifier.
- **Never** take a second payment while the verifier exits 1.
- **Never** run `golive-check` or `verify-test-purchase` expecting them to fix
  something. They are read only, on purpose.
- **Never** go live on the Vercel free plan (B9), whatever the preflight says
  about the rest.

---

## Where the rules actually live

If a number here ever disagrees with the code, the code wins. These are the
files:

| Rule | File |
|---|---|
| Order, price, Rs 0 coupon path | `supabase/migrations/0026_purchases.sql` |
| Webhook grant, the split, the refund | `supabase/migrations/0027_ledger.sql` |
| The GST rate (X4) | `public.gst_divisor()` in `0027_ledger.sql` |
| Reconcile alerts | `supabase/migrations/0029_reconcile.sql` |
| Signature check, event order | `src/lib/purchases/webhook.ts` |
| Nightly reconcile | `src/lib/ledger/reconcile.ts`, `jobs/ledger-reconcile.ts` |
| The preflight rules | `src/lib/golive/` |
