/**
 * Idempotent DEMO seed for the real PolityPedia Supabase project.
 *
 *   node demo/seed.cjs
 *
 * Safe to run twice: every demo row has a deterministic id and the teacher's
 * content is wiped and re-inserted inside one transaction. Boss's real account
 * is never edited; it only receives follow / saved / attempt rows.
 * Undo everything with: node demo/unseed.cjs
 *
 * Secrets: read from web/.env.local at run time, never printed or stored here.
 */
const L = require('./lib.cjs');
const { QUESTIONS, AI_EXPLANATIONS } = require('./content.cjs');

const E = L.EMAILS;
const UGC_NET = 'a4000001-0000-4000-8000-000000000001';
const CUET_PG = 'a4000001-0000-4000-8000-000000000002';

// ---------------------------------------------------------------- tiny PDF
function pdfEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > width) {
      out.push(line);
      line = word;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line) out.push(line);
  return out;
}
/** A minimal, valid single-page PDF (Helvetica, ASCII only). */
function makePdf(title, bodyLines) {
  const lines = [];
  for (const l of bodyLines) for (const w of wrap(l, 88)) lines.push(w);
  let stream = `BT /F1 16 Tf 56 790 Td (${pdfEscape(title)}) Tj ET\n`;
  stream += 'BT /F1 11 Tf 56 760 Td 16 TL\n';
  for (const l of lines.slice(0, 40)) stream += `(${pdfEscape(l)}) Tj T*\n`;
  stream += 'ET\n';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const ascii = (s) => s.replace(/[^\x20-\x7e]/g, '');

// -------------------------------------------------------------------- main
(async () => {
  const c = await L.db();
  const log = (...a) => console.log(...a);

  // 1. auth users (no password, no email sent)
  const ids = {};
  let anyCreated = false;
  for (const key of L.DEMO_USER_KEYS) {
    const r = await L.ensureAuthUser(c, E[key]);
    ids[key] = r.id;
    if (r.created) anyCreated = true;
    log(r.created ? 'created auth user' : 'auth user exists  ', key);
  }
  // New auth users mean any saved cookie-<role>.json points at a deleted user: drop them,
  // shot.cjs then mints fresh ones.
  if (anyCreated) {
    const fs = require('fs');
    const { OUT_DIR } = require('./qa-login.cjs');
    for (const r of ['student', 'teacher', 'admin']) {
      try { fs.unlinkSync(`${OUT_DIR}/cookie-${r}.json`); } catch { /* none */ }
    }
  }
  ids.boss = await L.findUserId(c, E.boss);
  if (!ids.boss) log('NOTE: Boss account not found, skipping its follow/saved/attempt rows');

  const T = ids.teacher;
  const SET = L.uid('set-full-mock-1');
  const TEST1 = L.uid('test-1-free');
  const TEST2 = L.uid('test-2-paid');
  const qid = (i) => L.uid('question-' + (i + 1));
  const BATCH = L.uid('batch-weekend');

  // 2. storage PDFs (before the rows that point at them)
  const pdfs = [
    {
      path: `${T}/demo-ugcnet-2024-p2-questions.pdf`,
      bytes: makePdf('[Demo] UGC NET Dec 2024 Paper 2 - Questions', [
        'DEMO FILE for app testing. Not a real exam paper.',
        '',
        ...QUESTIONS.slice(0, 6).flatMap((q, i) => [
          `Q${i + 1}. ${ascii(q.stem)}`,
          q.options.map((o, j) => `(${'ABCD'[j]}) ${ascii(o)}`).join('   '),
          '',
        ]),
      ]),
    },
    {
      path: `${T}/demo-ugcnet-2024-p2-solutions.pdf`,
      bytes: makePdf('[Demo] UGC NET Dec 2024 Paper 2 - Solutions', [
        'DEMO FILE for app testing. Not a real answer key.',
        '',
        ...QUESTIONS.slice(0, 6).map((q, i) => `Q${i + 1}: (${'ABCD'[q.correct]}) ${ascii(q.options[q.correct])}`),
      ]),
    },
    {
      path: `${T}/demo-cuetpg-2025-questions.pdf`,
      bytes: makePdf('[Demo] CUET PG 2025 Political Science - Questions', [
        'DEMO FILE for app testing. Not a real exam paper.',
        '',
        ...QUESTIONS.slice(10, 15).flatMap((q, i) => [
          `Q${i + 1}. ${ascii(q.stem)}`,
          q.options.map((o, j) => `(${'ABCD'[j]}) ${ascii(o)}`).join('   '),
          '',
        ]),
      ]),
    },
  ];
  for (const p of pdfs) await L.storagePut(p.path, p.bytes);
  log('uploaded pdfs', pdfs.length);

  // 3. database, one transaction
  await c.query('begin');
  try {
    // roles + profile fields. The role guard trigger needs an admin caller, so
    // it is switched off for this transaction only (we are postgres, not a user).
    await c.query('alter table public.profiles disable trigger profiles_block_role_change');
    const prof = [
      ['teacher', 'teacher', 'Demo Teacher Account', 'en'],
      ['admin', 'admin', 'Demo Admin', 'en'],
      ['student', 'student', 'Demo QA Student', 'en'],
      ['pending', 'teacher', 'Demo: Pending Teacher', 'en'],
      ['s1', 'student', 'Demo Student One', 'en'],
      ['s2', 'student', 'Demo Student Two', 'hi'],
      ['s3', 'student', 'Demo Student Three', 'en'],
    ];
    for (const [k, role, name, lang] of prof) {
      await c.query(
        `insert into public.profiles (id, role, display_name, lang) values ($1,$2,$3,$4)
         on conflict (id) do update set role=excluded.role, display_name=excluded.display_name, lang=excluded.lang`,
        [ids[k], role, name, lang],
      );
    }
    await c.query('alter table public.profiles enable trigger profiles_block_role_change');

    // onboarding gate = at least one student_exams row
    for (const k of ['student', 's1', 's2', 's3']) {
      const exams = k === 'student' ? [UGC_NET, CUET_PG] : [UGC_NET];
      for (const ex of exams) {
        await c.query(
          'insert into public.student_exams (user_id, exam_id) values ($1,$2) on conflict do nothing',
          [ids[k], ex],
        );
      }
    }

    // teachers
    await c.query(
      `insert into public.teachers (user_id, identity_mode, real_name, alias, bio_en, bio_hi, status, approved_by, videos_visible, revenue_share_pct)
       values ($1,'public','Demo: Dr. Meera Nair','Demo: Dr. Meera Nair',$2,$3,'approved',$4,true,50)
       on conflict (user_id) do update set identity_mode='public', real_name=excluded.real_name, alias=excluded.alias,
         bio_en=excluded.bio_en, bio_hi=excluded.bio_hi, status='approved', approved_by=excluded.approved_by,
         videos_visible=true, revenue_share_pct=50`,
      [
        T,
        'DEMO PROFILE. Twelve years of teaching Political Science for UGC NET and CUET PG. I cover Indian polity, political theory and comparative politics, with a weekly mock test and a Saturday doubt class.',
        'डेमो प्रोफ़ाइल। यूजीसी नेट और सीयूईटी पीजी के लिए राजनीति विज्ञान पढ़ाने का बारह वर्ष का अनुभव। मैं भारतीय राजव्यवस्था, राजनीतिक सिद्धांत और तुलनात्मक राजनीति पढ़ाती हूँ, साप्ताहिक मॉक टेस्ट और शनिवार को डाउट क्लास के साथ।',
        ids.admin,
      ],
    );
    await c.query(
      `insert into public.teachers (user_id, identity_mode, real_name, alias, bio_en, status, videos_visible)
       values ($1,'alias','Demo: Pending Teacher','Demo: Pending Teacher','DEMO applicant waiting for admin approval.','pending',true)
       on conflict (user_id) do update set real_name=excluded.real_name, alias=excluded.alias, bio_en=excluded.bio_en, status='pending'`,
      [ids.pending],
    );

    // wipe the demo teacher's content (cascades tests, questions, attempts, saved, ledger...)
    await c.query('delete from public.mock_sets where teacher_id=$1', [T]);
    await c.query('delete from public.papers where teacher_id=$1', [T]);
    await c.query('delete from public.teacher_videos where teacher_id=$1', [T]);
    await c.query('delete from public.teacher_posts where teacher_id=$1', [T]);
    await c.query('delete from public.batches where teacher_id=$1', [T]);
    await c.query('delete from public.teacher_exams where teacher_id=$1', [T]);
    await c.query('delete from public.payouts where teacher_id=$1', [T]);
    await c.query('delete from public.follows where teacher_id=$1', [T]);
    await c.query("delete from public.reconcile_alerts where subject like 'DEMO %'");

    // teacher_exams
    await c.query(
      `insert into public.teacher_exams (teacher_id, exam_id, next_exam_date, label) values ($1,$2,'2026-12-20','NET'),($1,$3,'2027-03-15','CUET PG')`,
      [T, UGC_NET, CUET_PG],
    );

    // mock set + 2 tests
    await c.query(
      `insert into public.mock_sets (id, teacher_id, exam_id, title, price_inr, status) values ($1,$2,$3,'[Demo] UGC NET Political Science Full Mock 1',349,'live')`,
      [SET, T, UGC_NET],
    );
    await c.query(
      `insert into public.mock_tests (id, set_id, title, position, duration_min, is_free_sample) values
       ($1,$3,'[Demo] Mock 1 - Free Sample Test',1,15,true),
       ($2,$3,'[Demo] Mock 1 - Test 2',2,15,false)`,
      [TEST1, TEST2, SET],
    );

    // 20 questions
    for (let i = 0; i < QUESTIONS.length; i++) {
      const q = QUESTIONS[i];
      const test = i < 10 ? TEST1 : TEST2;
      const number = (i % 10) + 1;
      const expl = q.hi ? `${q.expl}\n\nहिंदी: ${q.hi}` : q.expl;
      await c.query(
        `insert into public.questions (id, teacher_id, test_id, number, stem, options, correct_idx, teacher_explanation, lang, checked, status)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,'en',true,'live')`,
        [qid(i), T, test, number, q.stem, JSON.stringify(q.options), q.correct, expl],
      );
    }

    // 2 ready AI explanations (no audio)
    for (const a of AI_EXPLANATIONS) {
      await c.query(
        `insert into public.ai_explanations (question_id, lang, status, body, sources, audio_status, edited_by_teacher, model)
         values ($1,'en','ready',$2::jsonb,$3::jsonb,'none',false,'claude-haiku-5-5')`,
        [qid(a.q), JSON.stringify(a.body), JSON.stringify(a.sources)],
      );
    }

    // 2 live papers
    await c.query(
      `insert into public.papers (id, teacher_id, exam_id, year, month, label, pdf_questions_path, pdf_solutions_path, status) values
       ($1,$3,$4,2024,12,'[Demo] UGC NET Dec 2024 Paper 2',$5,$6,'live'),
       ($2,$3,$7,2025,3,'[Demo] CUET PG 2025 Political Science',$8,null,'live')`,
      [L.uid('paper-ugc'), L.uid('paper-cuet'), T, UGC_NET, pdfs[0].path, pdfs[1].path, CUET_PG, pdfs[2].path],
    );

    // 3 videos (placeholder ids, not real videos)
    const vids = [
      ['Xk3pLm9QzR1', '[Demo] Fundamental Rights in 20 minutes'],
      ['B7fT2nVc8Yd', '[Demo] Rawls vs Nozick: justice explained'],
      ['hJ4wQe6Ns0A', '[Demo] Parliament and federalism: PYQ walkthrough'],
    ];
    for (let i = 0; i < vids.length; i++) {
      await c.query(
        `insert into public.teacher_videos (id, teacher_id, youtube_id, title, thumb_url, position) values ($1,$2,$3,$4,$5,$6)`,
        [L.uid('video-' + i), T, vids[i][0], vids[i][1], `https://i.ytimg.com/vi/${vids[i][0]}/hqdefault.jpg`, i],
      );
    }

    // 3 notices
    await c.query(
      `insert into public.teacher_posts (id, teacher_id, priority, heading, link, created_at) values
       ($1,$4,1,'[Demo] New: UGC NET Full Mock 1 is live. Try the free sample test first.',null, now() - interval '3 hours'),
       ($2,$4,0,'[Demo] Doubt class this Saturday, 7 PM IST: Parliament, federalism and Rawls.',null, now() - interval '1 day'),
       ($3,$4,0,'[Demo] Syllabus tip: revise Unit 2 (Indian Political Thought) with one thinker per day.','https://www.ugcnet.nta.ac.in/', now() - interval '2 days')`,
      [L.uid('post-0'), L.uid('post-1'), L.uid('post-2'), T],
    );

    // batch with join code + 3 members + the demo set (access comes from triggers)
    await c.query(`insert into public.batches (id, teacher_id, name, join_code) values ($1,$2,'[Demo] UGC NET Weekend Batch','DEMNET')`, [BATCH, T]);
    await c.query('insert into public.batch_sets (batch_id, set_id) values ($1,$2)', [BATCH, SET]);
    for (const k of ['s1', 's2', 's3']) {
      await c.query('insert into public.batch_members (batch_id, user_id) values ($1,$2)', [BATCH, ids[k]]);
    }

    // follows: QA student, Boss, and the 3 demo students
    for (const k of ['student', 'boss', 's1', 's2', 's3']) {
      if (!ids[k]) continue;
      await c.query('insert into public.follows (user_id, teacher_id) values ($1,$2) on conflict do nothing', [ids[k], T]);
    }

    // saved questions + one finished practice attempt (QA student and Boss)
    // chosen: index of option picked, null = skipped. Q4 and Q8 are wrong.
    const chosen = [1, 3, 2, 0, 1, 0, 2, 0, 2, null];
    const marked = new Set([5, 9]);
    const nCorrect = chosen.filter((ch, i) => ch !== null && ch === QUESTIONS[i].correct).length;
    for (const k of ['student', 'boss']) {
      if (!ids[k]) continue;
      const aid = L.uid('attempt-' + k);
      await c.query(
        `insert into public.attempts (id, user_id, test_id, mode, started_at, submitted_at, score)
         values ($1,$2,$3,'practice', now() - interval '2 hours', now() - interval '105 minutes', $4)`,
        [aid, ids[k], TEST1, nCorrect * 2],
      );
      for (let i = 0; i < 10; i++) {
        const ch = chosen[i];
        await c.query(
          `insert into public.attempt_answers (attempt_id, question_id, chosen_idx, is_correct, marked) values ($1,$2,$3,$4,$5)`,
          [aid, qid(i), ch, ch === null ? null : ch === QUESTIONS[i].correct, marked.has(i)],
        );
      }
      const saves = [[3, 'wrong'], [7, 'wrong'], [5, 'marked'], [9, 'marked']];
      for (const [i, tag] of saves) {
        await c.query('insert into public.saved_questions (user_id, question_id, tag) values ($1,$2,$3)', [ids[k], qid(i), tag]);
      }
    }

    // admin screens: 3 demo purchases -> ledger -> 1 payout; 1 reconcile alert
    const buyers = [
      ['s1', 'order_demo_001', "now() - interval '3 hours'"],
      ['s2', 'order_demo_002', "now() - interval '1 hour'"],
      ['s3', 'order_demo_003', "timestamptz '2026-10-15 10:00:00+05:30'"],
    ];
    for (const [k, order, ts] of buyers) {
      await c.query(
        `insert into public.purchases (id, user_id, set_id, razorpay_order_id, amount_inr, status, created_at)
         values ($1,$2,$3,$4,349,'paid',${ts})`,
        [L.uid('purchase-' + k), ids[k], SET, order],
      );
    }
    const payoutId = L.uid('payout-2026-10');
    await c.query(
      `insert into public.payouts (id, teacher_id, period, amount, paid_at, reference) values ($1,$2,'2026-10',144.39,timestamptz '2026-11-02 12:00:00+05:30','DEMO-UTR-000123')`,
      [payoutId, T],
    );
    for (const [k, , ts] of buyers) {
      await c.query(
        `insert into public.teacher_ledger (id, teacher_id, purchase_id, gross, gst, gateway_fee, net, share_pct, teacher_amount, platform_amount, payout_id, created_at)
         values ($1,$2,$3,349.00,53.24,6.98,288.78,50,144.39,144.39,$4,${ts})`,
        [L.uid('ledger-' + k), T, L.uid('purchase-' + k), k === 's3' ? payoutId : null],
      );
    }
    await c.query(
      `insert into public.reconcile_alerts (kind, subject, order_id, expected_paise, actual_paise)
       values ('amount_mismatch','DEMO order_demo_alert','order_demo_alert',34900,29900)`,
    );

    await c.query('commit');
  } catch (e) {
    await c.query('rollback').catch(() => {});
    await c.query('alter table public.profiles enable trigger profiles_block_role_change').catch(() => {});
    console.log('SEED FAILED:', e.code || '', String(e.message).slice(0, 300));
    await c.end();
    process.exit(1);
  }

  // 4. report counts
  const q = async (sql, p = []) => (await c.query(sql, p)).rows[0].n;
  const rows = {
    'auth users (demo)': await q(`select count(*)::int n from auth.users where email = any($1)`, [L.DEMO_USER_KEYS.map((k) => E[k])]),
    profiles: await q('select count(*)::int n from public.profiles where id = any($1)', [L.DEMO_USER_KEYS.map((k) => ids[k])]),
    teachers: await q('select count(*)::int n from public.teachers where user_id = any($1)', [[T, ids.pending]]),
    teacher_exams: await q('select count(*)::int n from public.teacher_exams where teacher_id=$1', [T]),
    mock_sets: await q('select count(*)::int n from public.mock_sets where teacher_id=$1', [T]),
    mock_tests: await q('select count(*)::int n from public.mock_tests where set_id=$1', [SET]),
    questions: await q('select count(*)::int n from public.questions where teacher_id=$1', [T]),
    ai_explanations: await q('select count(*)::int n from public.ai_explanations e join public.questions q on q.id=e.question_id where q.teacher_id=$1', [T]),
    papers: await q('select count(*)::int n from public.papers where teacher_id=$1', [T]),
    teacher_videos: await q('select count(*)::int n from public.teacher_videos where teacher_id=$1', [T]),
    teacher_posts: await q('select count(*)::int n from public.teacher_posts where teacher_id=$1', [T]),
    batches: await q('select count(*)::int n from public.batches where teacher_id=$1', [T]),
    batch_members: await q('select count(*)::int n from public.batch_members where batch_id=$1', [BATCH]),
    batch_sets: await q('select count(*)::int n from public.batch_sets where batch_id=$1', [BATCH]),
    set_access: await q('select count(*)::int n from public.set_access where set_id=$1', [SET]),
    follows: await q('select count(*)::int n from public.follows where teacher_id=$1', [T]),
    attempts: await q('select count(*)::int n from public.attempts where test_id=$1', [TEST1]),
    attempt_answers: await q('select count(*)::int n from public.attempt_answers aa join public.attempts a on a.id=aa.attempt_id where a.test_id=$1', [TEST1]),
    saved_questions: await q('select count(*)::int n from public.saved_questions s join public.questions q on q.id=s.question_id where q.teacher_id=$1', [T]),
    purchases: await q('select count(*)::int n from public.purchases where set_id=$1', [SET]),
    teacher_ledger: await q('select count(*)::int n from public.teacher_ledger where teacher_id=$1', [T]),
    payouts: await q('select count(*)::int n from public.payouts where teacher_id=$1', [T]),
    reconcile_alerts: await q("select count(*)::int n from public.reconcile_alerts where subject like 'DEMO %'"),
    'storage objects (papers)': pdfs.length,
  };
  console.log('\nSEED DONE. Rows now present:');
  for (const [k, v] of Object.entries(rows)) console.log('  ' + k.padEnd(26) + v);
  console.log('\nteacherId for URLs: ' + T);
  await c.end();
})().catch((e) => {
  console.log('SEED ERROR:', String(e.message).slice(0, 300));
  process.exit(1);
});
