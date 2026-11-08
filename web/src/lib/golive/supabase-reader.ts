/**
 * Supabase, READ ONLY, for the two go-live tools
 * (issue 44-h5-golive-readiness).
 *
 * Plain `fetch` with the service-role key, exactly like
 * `src/lib/ledger/supabase-reconcile-store.ts`, and for the same reason: a
 * command-line tool is not a signed-in user, and RLS would hand the anon key
 * zero rows on every table that matters here.
 *
 * EVERY METHOD IS A GET. There is no insert, no update, no RPC that writes,
 * and no `delete` anywhere in this file. A preflight that could change state
 * is a preflight nobody dares run on go-live day.
 *
 * LAPTOP ONLY. Nothing under `src/app/` imports this file. The only importers
 * are `jobs/golive-check.ts` and `jobs/verify-test-purchase.ts`.
 *
 * Security.
 *  * `SUPABASE_SERVICE_ROLE_KEY` bypasses every RLS policy. No `NEXT_PUBLIC_`
 *    prefix, so Next.js cannot inline it into a bundle.
 *  * Env is read lazily inside every call (web/CLAUDE.md), so importing this
 *    file can never break a build with no environment set.
 *  * No `console` call lives in this file, and every error carries a fixed
 *    message plus the HTTP status, NEVER a response body: a PostgREST body
 *    quotes constraint names and a 401 body can echo a token.
 */
import type { PurchaseStatus } from '@/lib/purchases/types';

const REST = '/rest/v1/';

/** Never `select=*`, so a column added later cannot leak by accident. */
const PURCHASE_COLUMNS = 'id,user_id,set_id,razorpay_order_id,amount_inr,coupon,status,created_at';
const LEDGER_COLUMNS =
  'id,teacher_id,purchase_id,gross,gst,gateway_fee,net,share_pct,teacher_amount,platform_amount,payout_id,created_at';
const ACCESS_COLUMNS = 'user_id,set_id,source,valid_until';
const ALERT_COLUMNS = 'id,kind,subject,order_id,created_at';
const EVENT_COLUMNS = 'event_id,type,payload,received_at';

/**
 * How many recent webhook events the verifier reads.
 *
 * The verifier matches events to a purchase by scanning their payloads, and
 * it is run minutes after a hand-made test purchase, so the event is in the
 * newest handful. 500 is far past that and still one page.
 */
export const EVENT_WINDOW = 500;

/** How many open alerts the preflight will list before it stops counting. */
export const ALERT_WINDOW = 200;

export interface GoliveServiceEnv {
  /** Project URL with no trailing slash. */
  readonly url: string;
  /** The service-role key. Bypasses RLS. Never logged, never sent onward. */
  readonly serviceRoleKey: string;
}

/**
 * Both names, or nothing.
 *
 * There is NO fallback to the anon key. The anon key would read zero
 * `reconcile_alerts` rows and zero of somebody else's `purchases`, which would
 * turn a misconfigured tool into a confident all-clear: the one answer these
 * tools must never give by accident.
 */
export function readGoliveServiceEnv(
  env: Record<string, string | undefined> = process.env,
): GoliveServiceEnv | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) return null;
  return { url: url.replace(/\/+$/, ''), serviceRoleKey };
}

export interface PurchaseRow {
  readonly id: string;
  readonly userId: string;
  readonly setId: string;
  /** NULL on the Rs 0 coupon path (0026): normal, and meaningful. */
  readonly orderId: string | null;
  readonly amountInr: number;
  readonly coupon: string | null;
  readonly status: PurchaseStatus;
  readonly createdAt: string | null;
}

export interface LedgerRow {
  readonly id: string;
  readonly teacherId: string;
  readonly purchaseId: string;
  readonly gross: number;
  readonly gst: number;
  readonly gatewayFee: number;
  readonly net: number;
  readonly sharePct: number;
  readonly teacherAmount: number;
  readonly platformAmount: number;
  readonly payoutId: string | null;
  /** When the grant ran, which is the clock X2's 12-month window starts on. */
  readonly createdAt: string | null;
}

export interface AccessRow {
  readonly userId: string;
  readonly setId: string;
  readonly source: string;
  readonly validUntil: string;
}

export interface OpenAlertRow {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly orderId: string | null;
  readonly createdAt: string | null;
}

export interface EventRow {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
  readonly receivedAt: string | null;
}

/** 'yes' applied, 'no' not applied, 'unreadable' the table is not exposed. */
export type MigrationAnswer = 'yes' | 'no' | 'unreadable';

export interface GoliveReader {
  isConfigured(): boolean;
  /** One tiny read that proves the service-role key works. */
  ping(): Promise<{ ok: boolean; status: number }>;
  openAlerts(): Promise<OpenAlertRow[]>;
  migrationApplied(version: string): Promise<MigrationAnswer>;
  purchaseById(id: string): Promise<PurchaseRow | null>;
  purchaseByOrderId(orderId: string): Promise<PurchaseRow | null>;
  ledgerRows(purchaseId: string): Promise<LedgerRow[]>;
  accessRows(userId: string, setId: string): Promise<AccessRow[]>;
  recentEvents(): Promise<EventRow[]>;
  setOwner(setId: string): Promise<{ teacherId: string; examId: string | null } | null>;
  teacherSharePct(teacherId: string): Promise<number | null>;
  nextExamDate(teacherId: string, examId: string): Promise<string | null>;
}

export interface SupabaseGoliveReaderOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function text(value: unknown, max = 200): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

/**
 * A money column, as a number.
 *
 * PostgREST has sent `numeric` as both a JSON number and a quoted string over
 * its life, so both are read. Anything else answers NaN, which every rule
 * below treats as "cannot read", never as zero: a zero teacher share that was
 * really an unreadable column is a teacher who does not get paid.
 */
function money(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

const STATUSES: readonly PurchaseStatus[] = ['created', 'paid', 'refunded'];

function readPurchase(raw: unknown): PurchaseRow | null {
  const row = raw as Record<string, unknown> | null;
  const id = text(row?.id, 80);
  const userId = text(row?.user_id, 80);
  const setId = text(row?.set_id, 80);
  const status = text(row?.status, 20);
  const amountInr = money(row?.amount_inr);
  if (!id || !userId || !setId || !status) return null;
  if (!(STATUSES as readonly string[]).includes(status)) return null;
  if (!Number.isFinite(amountInr)) return null;
  return {
    id,
    userId,
    setId,
    orderId: text(row?.razorpay_order_id, 80),
    amountInr,
    coupon: text(row?.coupon, 40),
    status: status as PurchaseStatus,
    createdAt: text(row?.created_at, 40),
  };
}

function readLedger(raw: unknown): LedgerRow | null {
  const row = raw as Record<string, unknown> | null;
  const id = text(row?.id, 80);
  const teacherId = text(row?.teacher_id, 80);
  const purchaseId = text(row?.purchase_id, 80);
  if (!id || !teacherId || !purchaseId) return null;
  return {
    id,
    teacherId,
    purchaseId,
    gross: money(row?.gross),
    gst: money(row?.gst),
    gatewayFee: money(row?.gateway_fee),
    net: money(row?.net),
    sharePct: money(row?.share_pct),
    teacherAmount: money(row?.teacher_amount),
    platformAmount: money(row?.platform_amount),
    payoutId: text(row?.payout_id, 80),
    createdAt: text(row?.created_at, 40),
  };
}

export function createSupabaseGoliveReader(
  options: SupabaseGoliveReaderOptions = {},
): GoliveReader {
  // Kept as a getter, never read here: lazy env (web/CLAUDE.md).
  const env = () => readGoliveServiceEnv(options.env ?? process.env);
  const doFetch: typeof fetch = (...args) => (options.fetchImpl ?? fetch)(...args);

  function required(): GoliveServiceEnv {
    const found = env();
    if (!found) throw new Error('the go-live tools are not configured');
    return found;
  }

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const { serviceRoleKey } = required();
    return {
      apikey: serviceRoleKey,
      authorization: 'Bearer ' + serviceRoleKey,
      accept: 'application/json',
      ...extra,
    };
  }

  /** One GET. Throws with a status and NEVER with a body. */
  async function get(path: string, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const { url } = required();
    const res = await doFetch(url + REST + path, {
      method: 'GET',
      headers: headers(extraHeaders),
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error('Supabase read failed with status ' + res.status);
    }
    return (await res.json()) as unknown;
  }

  async function rows(path: string, extraHeaders?: Record<string, string>): Promise<unknown[]> {
    const body = await get(path, extraHeaders);
    return Array.isArray(body) ? body : [];
  }

  return {
    isConfigured() {
      return env() !== null;
    },

    /**
     * The cheapest possible proof that the key works: one row, one column,
     * from a table only the service role can read.
     *
     * `reconcile_alerts` and not `profiles`, because the anon key can read a
     * profile. A key that reads an alert is a key that really bypasses RLS.
     */
    async ping() {
      const { url } = required();
      try {
        const res = await doFetch(url + REST + 'reconcile_alerts?select=id&limit=1', {
          method: 'GET',
          headers: headers(),
          cache: 'no-store',
        });
        return { ok: res.ok, status: res.status };
      } catch {
        // 0 is "no answer at all", which the check reports as unreachable.
        return { ok: false, status: 0 };
      }
    },

    async openAlerts() {
      const raw = await rows(
        'reconcile_alerts?select=' +
          ALERT_COLUMNS +
          '&resolved_at=is.null&order=created_at.desc&limit=' +
          ALERT_WINDOW,
      );
      const out: OpenAlertRow[] = [];
      for (const one of raw) {
        const row = one as Record<string, unknown>;
        const id = text(row?.id, 80);
        const kind = text(row?.kind, 40);
        const subject = text(row?.subject, 160);
        if (!id || !kind || !subject) continue;
        out.push({
          id,
          kind,
          subject,
          orderId: text(row?.order_id, 80),
          createdAt: text(row?.created_at, 40),
        });
      }
      return out;
    },

    /**
     * Is the newest migration file in `supabase_migrations.schema_migrations`?
     *
     * That schema is NOT in PostgREST's exposed list by default, so the usual
     * answer to this request is a 404 or a 406. `Accept-Profile` is the one
     * header that can reach it when a project HAS exposed it, and any refusal
     * answers 'unreadable' rather than 'no': "I could not look" and "it is not
     * applied" are different sentences, and the second one would send Boss to
     * re-push migrations that are already there.
     */
    async migrationApplied(version: string) {
      const wanted = text(version, 40);
      if (!wanted) return 'unreadable';
      let body: unknown;
      try {
        body = await get(
          'schema_migrations?select=version&version=eq.' + encodeURIComponent(wanted) + '&limit=1',
          { 'accept-profile': 'supabase_migrations' },
        );
      } catch {
        return 'unreadable';
      }
      if (!Array.isArray(body)) return 'unreadable';
      return body.length > 0 ? 'yes' : 'no';
    },

    async purchaseById(id) {
      const wanted = text(id, 80);
      if (!wanted) return null;
      const raw = await rows(
        'purchases?select=' + PURCHASE_COLUMNS + '&id=eq.' + encodeURIComponent(wanted) + '&limit=1',
      );
      return raw.length > 0 ? readPurchase(raw[0]) : null;
    },

    async purchaseByOrderId(orderId) {
      const wanted = text(orderId, 80);
      if (!wanted) return null;
      const raw = await rows(
        'purchases?select=' +
          PURCHASE_COLUMNS +
          '&razorpay_order_id=eq.' +
          encodeURIComponent(wanted) +
          '&limit=1',
      );
      return raw.length > 0 ? readPurchase(raw[0]) : null;
    },

    /**
     * EVERY ledger row for this purchase, with no limit of 1.
     *
     * `teacher_ledger_purchase_unique` says there can only be one, and reading
     * one row would make the tool agree with the constraint instead of
     * checking it. Two rows here is the bug the verifier exists to catch.
     */
    async ledgerRows(purchaseId) {
      const wanted = text(purchaseId, 80);
      if (!wanted) return [];
      const raw = await rows(
        'teacher_ledger?select=' +
          LEDGER_COLUMNS +
          '&purchase_id=eq.' +
          encodeURIComponent(wanted) +
          '&order=created_at.asc&limit=20',
      );
      const out: LedgerRow[] = [];
      for (const one of raw) {
        const row = readLedger(one);
        if (row) out.push(row);
      }
      return out;
    },

    /** All sources, so a refund that left a batch grant alone can be seen. */
    async accessRows(userId, setId) {
      const user = text(userId, 80);
      const set = text(setId, 80);
      if (!user || !set) return [];
      const raw = await rows(
        'set_access?select=' +
          ACCESS_COLUMNS +
          '&user_id=eq.' +
          encodeURIComponent(user) +
          '&set_id=eq.' +
          encodeURIComponent(set) +
          '&limit=10',
      );
      const out: AccessRow[] = [];
      for (const one of raw) {
        const row = one as Record<string, unknown>;
        const source = text(row?.source, 20);
        const validUntil = text(row?.valid_until, 60);
        if (!source || !validUntil) continue;
        out.push({ userId: user, setId: set, source, validUntil });
      }
      return out;
    },

    async recentEvents() {
      const raw = await rows(
        'payment_events?select=' + EVENT_COLUMNS + '&order=received_at.desc&limit=' + EVENT_WINDOW,
      );
      const out: EventRow[] = [];
      for (const one of raw) {
        const row = one as Record<string, unknown>;
        const eventId = text(row?.event_id, 120);
        const type = text(row?.type, 80);
        if (!eventId || !type) continue;
        out.push({ eventId, type, payload: row?.payload, receivedAt: text(row?.received_at, 40) });
      }
      return out;
    },

    async setOwner(setId) {
      const wanted = text(setId, 80);
      if (!wanted) return null;
      const raw = await rows(
        'mock_sets?select=teacher_id,exam_id&id=eq.' + encodeURIComponent(wanted) + '&limit=1',
      );
      if (raw.length === 0) return null;
      const row = raw[0] as Record<string, unknown>;
      const teacherId = text(row?.teacher_id, 80);
      if (!teacherId) return null;
      return { teacherId, examId: text(row?.exam_id, 80) };
    },

    async teacherSharePct(teacherId) {
      const wanted = text(teacherId, 80);
      if (!wanted) return null;
      const raw = await rows(
        'teachers?select=revenue_share_pct&user_id=eq.' + encodeURIComponent(wanted) + '&limit=1',
      );
      if (raw.length === 0) return null;
      const pct = money((raw[0] as Record<string, unknown>)?.revenue_share_pct);
      return Number.isFinite(pct) ? pct : null;
    },

    async nextExamDate(teacherId, examId) {
      const teacher = text(teacherId, 80);
      const exam = text(examId, 80);
      if (!teacher || !exam) return null;
      const raw = await rows(
        'teacher_exams?select=next_exam_date&teacher_id=eq.' +
          encodeURIComponent(teacher) +
          '&exam_id=eq.' +
          encodeURIComponent(exam) +
          '&limit=1',
      );
      if (raw.length === 0) return null;
      return text((raw[0] as Record<string, unknown>)?.next_exam_date, 40);
    },
  };
}
