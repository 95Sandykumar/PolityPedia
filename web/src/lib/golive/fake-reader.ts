/**
 * A fake `GoliveReader` (issue 44-h5-golive-readiness).
 *
 * Lives beside the real one rather than in `__tests__/` for the same reason
 * `src/lib/purchases/webhook.ts` ships `createFakeWebhookStore`: it is the
 * reference answer for what the interface promises, and two tools plus their
 * tests all read it. Nothing under `src/app/` imports it.
 *
 * web/CLAUDE.md: no real network call and no real key in any test. This is how
 * that is kept for the go-live tools. Every field has a safe default, so a
 * test only states the rows the case is about.
 */
import type {
  AccessRow,
  EventRow,
  GoliveReader,
  LedgerRow,
  MigrationAnswer,
  OpenAlertRow,
  PurchaseRow,
} from './supabase-reader';

export interface FakeGoliveReaderOptions {
  configured?: boolean;
  ping?: { ok: boolean; status: number };
  openAlerts?: readonly OpenAlertRow[];
  migration?: MigrationAnswer;
  purchases?: readonly PurchaseRow[];
  ledger?: readonly LedgerRow[];
  access?: readonly AccessRow[];
  events?: readonly EventRow[];
  owner?: { teacherId: string; examId: string | null } | null;
  sharePct?: number | null;
  nextExamDate?: string | null;
  /**
   * Make one method throw, so the "the read itself broke" branch is covered.
   * A read that throws must never be reported as an all-clear.
   */
  throwOn?: keyof GoliveReader;
}

export function fakeGoliveReader(options: FakeGoliveReaderOptions = {}): GoliveReader {
  function guard(method: keyof GoliveReader): void {
    if (options.throwOn === method) throw new Error('Supabase read failed with status 500');
  }

  return {
    isConfigured: () => options.configured ?? true,

    async ping() {
      guard('ping');
      return options.ping ?? { ok: true, status: 200 };
    },

    async openAlerts() {
      guard('openAlerts');
      return [...(options.openAlerts ?? [])];
    },

    async migrationApplied() {
      guard('migrationApplied');
      return options.migration ?? 'unreadable';
    },

    async purchaseById(id) {
      guard('purchaseById');
      return (options.purchases ?? []).find((one) => one.id === id) ?? null;
    },

    async purchaseByOrderId(orderId) {
      guard('purchaseByOrderId');
      return (options.purchases ?? []).find((one) => one.orderId === orderId) ?? null;
    },

    async ledgerRows(purchaseId) {
      guard('ledgerRows');
      return (options.ledger ?? []).filter((one) => one.purchaseId === purchaseId);
    },

    async accessRows(userId, setId) {
      guard('accessRows');
      return (options.access ?? []).filter((one) => one.userId === userId && one.setId === setId);
    },

    async recentEvents() {
      guard('recentEvents');
      return [...(options.events ?? [])];
    },

    async setOwner() {
      guard('setOwner');
      return options.owner ?? null;
    },

    async teacherSharePct() {
      guard('teacherSharePct');
      return options.sharePct ?? null;
    },

    async nextExamDate() {
      guard('nextExamDate');
      return options.nextExamDate ?? null;
    },
  };
}
