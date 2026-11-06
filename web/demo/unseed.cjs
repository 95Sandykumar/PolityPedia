/**
 * Removes ALL demo data created by seed.cjs.
 *
 *   node demo/unseed.cjs
 *
 * Order: Boss's seeded follow / saved / attempt rows, storage PDFs, demo
 * teacher content, then the 7 demo auth users (3 plus-aliases, the pending
 * applicant, 3 demo students). Boss's real account row is NOT touched.
 */
const L = require('./lib.cjs');
const E = L.EMAILS;

(async () => {
  const c = await L.db();
  const out = {};
  const del = async (label, sql, p = []) => {
    const r = await c.query(sql, p);
    out[label] = (out[label] || 0) + r.rowCount;
  };

  const ids = {};
  for (const k of L.DEMO_USER_KEYS) ids[k] = await L.findUserId(c, E[k]);
  const bossId = await L.findUserId(c, E.boss);
  const demoIds = L.DEMO_USER_KEYS.map((k) => ids[k]).filter(Boolean);
  const T = ids.teacher;

  // 1. Boss's seeded rows only (his account row stays)
  if (bossId && T) {
    await del("boss saved_questions", `delete from public.saved_questions s using public.questions q where s.question_id=q.id and q.teacher_id=$1 and s.user_id=$2`, [T, bossId]);
    await del("boss attempts", `delete from public.attempts a using public.mock_tests t, public.mock_sets s where a.test_id=t.id and t.set_id=s.id and s.teacher_id=$1 and a.user_id=$2`, [T, bossId]);
    await del("boss follows", `delete from public.follows where teacher_id=$1 and user_id=$2`, [T, bossId]);
  }

  // 2. storage objects
  for (const t of [T, ids.pending].filter(Boolean)) {
    out['storage objects'] = (out['storage objects'] || 0) + (await L.storageRemoveFolder(t));
  }

  // 3. demo-tagged rows that are not owned by a user cascade
  await del('reconcile_alerts', `delete from public.reconcile_alerts where subject like 'DEMO %'`);

  // 4. teacher-owned content (explicit, so the counts are visible; auth delete would cascade anyway)
  if (T) {
    await del('mock_sets', 'delete from public.mock_sets where teacher_id=$1', [T]);
    await del('papers', 'delete from public.papers where teacher_id=$1', [T]);
    await del('teacher_videos', 'delete from public.teacher_videos where teacher_id=$1', [T]);
    await del('teacher_posts', 'delete from public.teacher_posts where teacher_id=$1', [T]);
    await del('batches', 'delete from public.batches where teacher_id=$1', [T]);
    await del('teacher_exams', 'delete from public.teacher_exams where teacher_id=$1', [T]);
    await del('payouts', 'delete from public.payouts where teacher_id=$1', [T]);
  }

  // 5. auth users (cascades profiles, teachers, follows, student_exams, attempts, purchases, set_access...)
  for (const k of L.DEMO_USER_KEYS) {
    if (!ids[k]) continue;
    const status = await L.deleteAuthUser(ids[k]);
    out['auth users deleted'] = (out['auth users deleted'] || 0) + (status < 300 ? 1 : 0);
    if (status >= 300) console.log('WARN delete auth user failed', k, status);
  }

  // 5b. saved QA cookies now point at deleted users
  {
    const fs = require('fs');
    const { OUT_DIR } = require('./qa-login.cjs');
    for (const r of ['student', 'teacher', 'admin']) {
      try { fs.unlinkSync(`${OUT_DIR}/cookie-${r}.json`); } catch { /* none */ }
    }
  }

  // 6. proof: nothing demo left, Boss still there
  const left = {
    'demo auth users': (await c.query('select count(*)::int n from auth.users where email = any($1)', [L.DEMO_USER_KEYS.map((k) => E[k])])).rows[0].n,
    'demo profiles': demoIds.length ? (await c.query('select count(*)::int n from public.profiles where id = any($1)', [demoIds])).rows[0].n : 0,
    'teachers': (await c.query('select count(*)::int n from public.teachers')).rows[0].n,
    'mock_sets': (await c.query('select count(*)::int n from public.mock_sets')).rows[0].n,
    'papers': (await c.query('select count(*)::int n from public.papers')).rows[0].n,
    'questions': (await c.query('select count(*)::int n from public.questions')).rows[0].n,
    'purchases': (await c.query('select count(*)::int n from public.purchases')).rows[0].n,
    'reconcile_alerts': (await c.query('select count(*)::int n from public.reconcile_alerts')).rows[0].n,
    'boss account rows (expect 1)': bossId ? (await c.query('select count(*)::int n from auth.users where id=$1', [bossId])).rows[0].n : 'n/a',
    'boss role (unchanged)': bossId ? (await c.query('select role from public.profiles where id=$1', [bossId])).rows[0]?.role : 'n/a',
  };
  console.log('UNSEED DONE. Removed:');
  for (const [k, v] of Object.entries(out)) console.log('  ' + k.padEnd(26) + v);
  console.log('Left in database now:');
  for (const [k, v] of Object.entries(left)) console.log('  ' + k.padEnd(30) + v);
  await c.end();
})().catch((e) => {
  console.log('UNSEED ERROR:', String(e.message).slice(0, 300));
  process.exit(1);
});
