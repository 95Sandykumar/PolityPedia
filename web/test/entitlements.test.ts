/**
 * Entitlements + can_use (issue 21-plans-entitlements).
 *
 * V18 plans: Free, AI plan Rs 100/month (AI only), Pro Rs 500/month
 * (AI + notes + score vs cut-off). This proves the single gate the app asks:
 * `can_use(user_id, feature)`.
 *
 * Seed with `db.admin` (bypasses RLS), assert with `db.asUser` (policies are
 * evaluated by Postgres for real).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db';

type EntitlementRow = {
  user_id: string;
  plan: string;
  valid_until: string;
  source: string;
};

let db: TestDb;

/** Student on the AI plan (Rs 100), valid for another month. */
let aiUser: string;
/** Student on Pro (Rs 500), valid for another month. */
let proUser: string;
/** Student whose Pro ran out yesterday. */
let expiredUser: string;
/** Student on no plan at all (Free). */
let freeUser: string;
/** An admin, the only one who may grant or end a plan. */
let adminUser: string;

/** `can_use` through the caller's own RLS, the way a route handler asks it. */
async function canUse(caller: string, subject: string, feature: string): Promise<boolean> {
  return db.asUser(caller, async (sql) => {
    const r = await sql.query<{ allowed: boolean }>(
      'select public.can_use($1, $2) as allowed',
      [subject, feature],
    );
    return r.rows[0].allowed;
  });
}

async function grantAsAdmin(
  admin: string,
  subject: string,
  plan: string,
  validUntil: string,
): Promise<void> {
  await db.asUser(admin, async (sql) => {
    await sql.query(
      `insert into public.entitlements (user_id, plan, valid_until, source)
       values ($1, $2, $3, 'admin')
       on conflict (user_id, plan) do update set valid_until = excluded.valid_until`,
      [subject, plan, validUntil],
    );
  });
}

beforeAll(async () => {
  db = await createTestDb();

  aiUser = await db.createUser();
  proUser = await db.createUser();
  expiredUser = await db.createUser();
  freeUser = await db.createUser();
  adminUser = await db.createUser();

  // 0002's `profiles_block_role_change` trigger fires on UPDATE for everybody,
  // including the owner, and needs an existing admin to pass. Replace the row
  // instead: INSERT does not fire that trigger.
  await db.admin.query('delete from public.profiles where id = $1', [adminUser]);
  await db.admin.query("insert into public.profiles (id, role) values ($1, 'admin')", [adminUser]);

  await db.admin.query(
    `insert into public.entitlements (user_id, plan, valid_until, source)
     values ($1, 'ai', now() + interval '30 days', 'admin')`,
    [aiUser],
  );
  await db.admin.query(
    `insert into public.entitlements (user_id, plan, valid_until, source)
     values ($1, 'pro', now() + interval '30 days', 'admin')`,
    [proUser],
  );
  await db.admin.query(
    `insert into public.entitlements (user_id, plan, valid_until, source)
     values ($1, 'pro', now() - interval '1 day', 'razorpay')`,
    [expiredUser],
  );
});

afterAll(async () => {
  await db?.close();
});

describe('can_use: the one gate the app asks', () => {
  it('AI plan unlocks ai, not notes and not analysis', async () => {
    expect(await canUse(aiUser, aiUser, 'ai')).toBe(true);
    expect(await canUse(aiUser, aiUser, 'notes')).toBe(false);
    expect(await canUse(aiUser, aiUser, 'analysis')).toBe(false);
  });

  it('Pro unlocks ai, notes and analysis', async () => {
    expect(await canUse(proUser, proUser, 'ai')).toBe(true);
    expect(await canUse(proUser, proUser, 'notes')).toBe(true);
    expect(await canUse(proUser, proUser, 'analysis')).toBe(true);
  });

  it('an expired plan unlocks nothing', async () => {
    expect(await canUse(expiredUser, expiredUser, 'ai')).toBe(false);
    expect(await canUse(expiredUser, expiredUser, 'notes')).toBe(false);
    expect(await canUse(expiredUser, expiredUser, 'analysis')).toBe(false);
  });

  it('Free unlocks nothing', async () => {
    expect(await canUse(freeUser, freeUser, 'ai')).toBe(false);
    expect(await canUse(freeUser, freeUser, 'notes')).toBe(false);
    expect(await canUse(freeUser, freeUser, 'analysis')).toBe(false);
  });

  it('an unknown feature is false, never an error', async () => {
    expect(await canUse(proUser, proUser, 'teleport')).toBe(false);
    expect(await canUse(proUser, proUser, '')).toBe(false);
  });

  it('reads through RLS, so one student cannot probe another plan', async () => {
    expect(await canUse(freeUser, proUser, 'ai')).toBe(false);
  });

  it('lets an admin ask about any student', async () => {
    expect(await canUse(adminUser, proUser, 'notes')).toBe(true);
    expect(await canUse(adminUser, aiUser, 'notes')).toBe(false);
  });
});

describe('entitlements RLS', () => {
  it('stops a student inserting their own entitlement', async () => {
    await expect(
      db.asUser(freeUser, async (sql) => {
        await sql.query(
          `insert into public.entitlements (user_id, plan, valid_until, source)
           values ($1, 'pro', now() + interval '365 days', 'admin')`,
          [freeUser],
        );
      }),
    ).rejects.toThrow(/row-level security/i);

    const r = await db.admin.query('select 1 from public.entitlements where user_id = $1', [
      freeUser,
    ]);
    expect(r.rows).toHaveLength(0);
  });

  it('stops a student stretching their own valid_until', async () => {
    const changed = await db.asUser(aiUser, async (sql) => {
      const r = await sql.query(
        "update public.entitlements set valid_until = now() + interval '10 years' where user_id = $1",
        [aiUser],
      );
      return r.affectedRows ?? 0;
    });
    expect(changed).toBe(0);
  });

  it('stops a student deleting an entitlement', async () => {
    const changed = await db.asUser(aiUser, async (sql) => {
      const r = await sql.query('delete from public.entitlements where user_id = $1', [aiUser]);
      return r.affectedRows ?? 0;
    });
    expect(changed).toBe(0);
  });

  it('lets a student read their own row and nobody else', async () => {
    const rows = await db.asUser(aiUser, async (sql) => {
      const r = await sql.query<EntitlementRow>('select * from public.entitlements');
      return r.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(aiUser);
    expect(rows[0].plan).toBe('ai');
  });
});

describe('admin grants and ends a plan', () => {
  it('grants Pro to a free student, who can then use notes', async () => {
    const student = await db.createUser();
    expect(await canUse(student, student, 'notes')).toBe(false);

    await grantAsAdmin(adminUser, student, 'pro', new Date(Date.now() + 86_400_000).toISOString());

    expect(await canUse(student, student, 'notes')).toBe(true);
    expect(await canUse(student, student, 'ai')).toBe(true);
  });

  it('re-granting the same plan moves valid_until instead of adding a row (PK)', async () => {
    const student = await db.createUser();
    const soon = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 30 * 86_400_000).toISOString();

    await grantAsAdmin(adminUser, student, 'ai', soon);
    await grantAsAdmin(adminUser, student, 'ai', later);

    const r = await db.admin.query<EntitlementRow>(
      'select * from public.entitlements where user_id = $1',
      [student],
    );
    expect(r.rows).toHaveLength(1);
    expect(new Date(r.rows[0].valid_until).getTime()).toBeGreaterThan(
      new Date(soon).getTime() + 1000,
    );
  });

  it('ends a plan by deleting the row, which locks the feature again', async () => {
    const student = await db.createUser();
    await grantAsAdmin(adminUser, student, 'pro', new Date(Date.now() + 86_400_000).toISOString());
    expect(await canUse(student, student, 'analysis')).toBe(true);

    const removed = await db.asUser(adminUser, async (sql) => {
      const r = await sql.query("delete from public.entitlements where user_id = $1 and plan = 'pro'", [
        student,
      ]);
      return r.affectedRows ?? 0;
    });
    expect(removed).toBe(1);
    expect(await canUse(student, student, 'analysis')).toBe(false);
  });

  it('refuses a plan name that is not ai or pro', async () => {
    const student = await db.createUser();
    await expect(
      grantAsAdmin(adminUser, student, 'platinum', new Date(Date.now() + 86_400_000).toISOString()),
    ).rejects.toThrow(/entitlements_plan_check|violates check constraint/i);
  });

  it('refuses a source that is not admin or razorpay', async () => {
    const student = await db.createUser();
    await expect(
      db.asUser(adminUser, async (sql) => {
        await sql.query(
          `insert into public.entitlements (user_id, plan, valid_until, source)
           values ($1, 'ai', now() + interval '30 days', 'gift')`,
          [student],
        );
      }),
    ).rejects.toThrow(/entitlements_source_check|violates check constraint/i);
  });

  it('drops the entitlement when the auth user is deleted', async () => {
    const student = await db.createUser();
    await grantAsAdmin(adminUser, student, 'ai', new Date(Date.now() + 86_400_000).toISOString());
    await db.admin.query('delete from auth.users where id = $1', [student]);
    const r = await db.admin.query('select 1 from public.entitlements where user_id = $1', [
      student,
    ]);
    expect(r.rows).toHaveLength(0);
  });
});
