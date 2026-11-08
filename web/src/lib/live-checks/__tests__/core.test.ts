/**
 * The live-check maths, with FAKE data only (issue 42-h3-live-check-tools).
 *
 * Nothing here reaches api.anthropic.com or Supabase, nothing here holds a
 * real key and nothing here spends a token (web/CLAUDE.md). The three CLI
 * scripts in `web/jobs/live-checks/` are thin wrappers over these functions,
 * so what the tests cover is the part that can be silently wrong: the
 * comparison, the similarity number, the dollar maths, the probe verdict and
 * the "key is missing" message.
 *
 * The live run against the real API is ticket H3, which is Boss's.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SPLIT_ACCURACY_TARGET,
  SPLIT_MATCH_THRESHOLD,
  EXPLAIN_COST_ESTIMATE_USD,
  MODEL_PRICES,
  WEB_SEARCH_USD_PER_SEARCH,
} from '../prices';
import {
  RESULTS_DIR,
  alignByStem,
  compareSplit,
  compareToEstimate,
  createUsageRecorder,
  cut,
  explanationToText,
  formatExplainReport,
  formatProbeReport,
  formatSplitReport,
  normaliseText,
  readLiveCheckEnv,
  readProbeOutcome,
  redactSecrets,
  resultFileName,
  similarity,
  tokenCostUsd,
} from '../core';

// --------------------------------------------------------------------------
// Fixture. The stem is EXACTLY 50 normalised characters long, so one changed
// character is a similarity of 0.98 and two is 0.96: the two near misses the
// issue asks for, either side of the 0.97 threshold.
// --------------------------------------------------------------------------

const STEM = 'who appoints the governor of an indian state 00001';
const STEM_098 = 'who appoints the governor of an indian state 00002';
const STEM_096 = 'who appoints the governor of an indian state 00023';

const OPTIONS = ['The President', 'The Prime Minister', 'The Chief Justice', 'Parliament'];

function truthQuestion(number: number, stem = STEM, options = OPTIONS) {
  return { number, stem, options };
}

describe('normaliseText', () => {
  it('ignores case, whitespace, curly quotes, dashes and zero-width junk', () => {
    const fromPdf = '  The  PRESIDENT’s​ office — Article 155 ';
    expect(normaliseText(fromPdf)).toBe("the president's office - article 155");
  });

  it('is stable: normalising twice changes nothing', () => {
    const once = normaliseText('A – B’s  C');
    expect(normaliseText(once)).toBe(once);
  });
});

describe('similarity', () => {
  it('is 1 for two strings that differ only in the things we normalise', () => {
    expect(similarity('The President', '  the   PRESIDENT ')).toBe(1);
  });

  it('is 0.98 for one changed character in a 50 character stem', () => {
    expect(similarity(STEM, STEM_098)).toBeCloseTo(0.98, 10);
  });

  it('is 0.96 for two changed characters in a 50 character stem', () => {
    expect(similarity(STEM, STEM_096)).toBeCloseTo(0.96, 10);
  });

  it('is 0 when one side is empty and 1 when both are', () => {
    expect(similarity('anything', '   ')).toBe(0);
    expect(similarity('', '  ')).toBe(1);
  });
});

describe('compareSplit', () => {
  const truth = [
    truthQuestion(1),
    truthQuestion(2),
    truthQuestion(3),
    truthQuestion(4),
    truthQuestion(5),
  ];

  const found = [
    // 1: the same question as it comes out of a PDF, with the junk a PDF adds.
    { number: 1, stem: '  WHO appoints the governor of an indian state 00001 ', options: OPTIONS },
    // 2: a near miss ABOVE the threshold. Still right.
    { number: 2, stem: STEM_098, options: OPTIONS },
    // 3: a near miss BELOW the threshold. Wrong.
    { number: 3, stem: STEM_096, options: OPTIONS },
    // 4: the right four options in the wrong order. Wrong, and reported.
    { number: 4, stem: STEM, options: [OPTIONS[1], OPTIONS[0], OPTIONS[2], OPTIONS[3]] },
    // 5 is never produced, so it is MISSING. 6 has no truth row, so it is EXTRA.
    { number: 6, stem: STEM, options: OPTIONS },
  ];

  const result = compareSplit({ truth, found });

  it('counts right, wrong, missing and extra', () => {
    expect(result.truthCount).toBe(5);
    expect(result.foundCount).toBe(5);
    expect(result.rightCount).toBe(2);
    expect(result.wrong.map((one) => one.number)).toEqual([3, 4]);
    expect(result.missingNumbers).toEqual([5]);
    expect(result.extraNumbers).toEqual([6]);
  });

  it('reports the raw similarity of every near miss', () => {
    const three = result.wrong.find((one) => one.number === 3);
    expect(three?.stemSimilarity).toBeCloseTo(0.96, 10);
    expect(three?.worstSimilarity).toBeCloseTo(0.96, 10);

    // The 0.98 one is RIGHT, and its similarity is still reported.
    const two = result.perQuestion.find((one) => one.number === 2);
    expect(two?.verdict).toBe('right');
    expect(two?.stemSimilarity).toBeCloseTo(0.98, 10);
  });

  it('names the questions whose options are in the wrong order', () => {
    expect(result.outOfOrderNumbers).toEqual([4]);
    const four = result.wrong.find((one) => one.number === 4);
    expect(four?.optionsOutOfOrder).toBe(true);
    // The stem matched, so the stem similarity is not what failed.
    expect(four?.stemSimilarity).toBe(1);
  });

  it('scores against the 80 percent target', () => {
    expect(SPLIT_ACCURACY_TARGET).toBe(0.8);
    expect(SPLIT_MATCH_THRESHOLD).toBe(0.97);
    expect(result.accuracy).toBeCloseTo(0.4, 10);
    expect(result.meetsTarget).toBe(false);
  });

  it('gives 100 percent and meets the target when every question matches', () => {
    const perfect = compareSplit({ truth, found: truth });
    expect(perfect.rightCount).toBe(5);
    expect(perfect.accuracy).toBe(1);
    expect(perfect.meetsTarget).toBe(true);
    expect(perfect.wrong).toEqual([]);
    expect(perfect.missingNumbers).toEqual([]);
    expect(perfect.extraNumbers).toEqual([]);
  });

  it('is 0 percent, not a crash, when the splitter found nothing', () => {
    const none = compareSplit({ truth, found: [] });
    expect(none.foundCount).toBe(0);
    expect(none.rightCount).toBe(0);
    expect(none.accuracy).toBe(0);
    expect(none.missingNumbers).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('tokenCostUsd', () => {
  it('turns known token counts into the dollars the price table says', () => {
    // design.md: 15k in + 1.5k out + 2 searches is the AS3 estimate's shape.
    const cost = tokenCostUsd({
      model: 'claude-haiku-5-5',
      tokensIn: 15_000,
      tokensOut: 1_500,
      searches: 2,
    });

    expect(cost.inputUsd).toBeCloseTo(0.0015, 12);
    expect(cost.outputUsd).toBeCloseTo(0.00075, 12);
    expect(cost.searchUsd).toBeCloseTo(0.02, 12);
    expect(cost.totalUsd).toBeCloseTo(0.02225, 12);
  });

  it('reads the prices from the one price table', () => {
    expect(MODEL_PRICES['claude-haiku-5-5'].inputUsdPerMillion).toBe(0.1);
    expect(MODEL_PRICES['claude-haiku-5-5'].outputUsdPerMillion).toBe(0.5);
    expect(WEB_SEARCH_USD_PER_SEARCH).toBe(0.01);
  });

  it('charges nothing for a call with no searches', () => {
    const cost = tokenCostUsd({ model: 'claude-haiku-5-5', tokensIn: 0, tokensOut: 0, searches: 0 });
    expect(cost.totalUsd).toBe(0);
  });

  it('refuses a model it has no price for, and says which file to edit', () => {
    expect(() =>
      tokenCostUsd({ model: 'claude-made-up-9', tokensIn: 1, tokensOut: 1, searches: 0 }),
    ).toThrow(/prices\.ts/);
  });
});

describe('compareToEstimate', () => {
  it('gives the gap against the 0.022 estimate in dollars and percent', () => {
    expect(EXPLAIN_COST_ESTIMATE_USD).toBe(0.022);
    const gap = compareToEstimate(0.02225, EXPLAIN_COST_ESTIMATE_USD);
    expect(gap.differenceUsd).toBeCloseTo(0.00025, 12);
    expect(gap.differencePercent).toBeCloseTo(1.136_363_636, 6);
  });

  it('gives a negative percent when the real call is cheaper', () => {
    const gap = compareToEstimate(0.011, 0.022);
    expect(gap.differencePercent).toBeCloseTo(-50, 10);
  });
});

describe('readProbeOutcome', () => {
  const NEW_TYPE = 'web_search_20260209';
  const OLD_TYPE = 'web_search_20250305';

  it('picks the first accepted type when the newer one is refused with a 400', () => {
    const outcome = readProbeOutcome([
      {
        toolType: NEW_TYPE,
        status: 400,
        accepted: false,
        error: 'tools.0.type: web_search_20260209 is not supported for this model',
      },
      { toolType: OLD_TYPE, status: 200, accepted: true, error: null },
    ]);

    expect(outcome.acceptedTypes).toEqual([OLD_TYPE]);
    expect(outcome.willUse).toBe(OLD_TYPE);
    expect(outcome.noneAccepted).toBe(false);
    expect(outcome.nextStep).toBeNull();
  });

  it('keeps the order of the tool list, not the order they were tried', () => {
    const outcome = readProbeOutcome(
      [
        { toolType: OLD_TYPE, status: 200, accepted: true, error: null },
        { toolType: NEW_TYPE, status: 200, accepted: true, error: null },
      ],
      // SEARCH_TOOL_TYPES order: the app tries the newer one first.
      [NEW_TYPE, OLD_TYPE],
    );
    // Both work, so the app uses the first of SEARCH_TOOL_TYPES.
    expect(outcome.willUse).toBe(NEW_TYPE);
    expect(outcome.acceptedTypes).toEqual([NEW_TYPE, OLD_TYPE]);
  });

  it('says plainly when neither type is accepted, and names the next step', () => {
    const outcome = readProbeOutcome([
      { toolType: NEW_TYPE, status: 400, accepted: false, error: 'bad tool' },
      { toolType: OLD_TYPE, status: 400, accepted: false, error: 'bad tool' },
    ]);

    expect(outcome.acceptedTypes).toEqual([]);
    expect(outcome.willUse).toBeNull();
    expect(outcome.noneAccepted).toBe(true);
    expect(outcome.nextStep).toBeTruthy();
    expect(outcome.nextStep).toMatch(/pricing|docs|tool/i);
  });
});

describe('readLiveCheckEnv', () => {
  it('names every missing key in ONE line and never prints a value', () => {
    const check = readLiveCheckEnv({
      need: ['ANTHROPIC_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
      env: { SUPABASE_SERVICE_ROLE_KEY: 'super-secret-value' },
    });

    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(['ANTHROPIC_API_KEY']);
    expect(check.message).toContain('ANTHROPIC_API_KEY');
    expect(check.message).toContain('web/.env.local');
    expect(check.message.split('\n')).toHaveLength(1);
    // The one thing that must never happen.
    expect(check.message).not.toContain('super-secret-value');
  });

  it('treats a blank value as missing', () => {
    const check = readLiveCheckEnv({ need: ['ANTHROPIC_API_KEY'], env: { ANTHROPIC_API_KEY: '   ' } });
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('is ok with an empty message when every key is set', () => {
    const check = readLiveCheckEnv({
      need: ['ANTHROPIC_API_KEY'],
      env: { ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key' },
    });
    expect(check.ok).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.message).toBe('');
  });
});

describe('redactSecrets', () => {
  it('removes a key that was handed to it, and anything shaped like one', () => {
    const text = 'failed for sk-ant-api03-AAAABBBBCCCC and for my-service-role-key';
    const safe = redactSecrets(text, ['my-service-role-key']);
    expect(safe).not.toContain('my-service-role-key');
    expect(safe).not.toContain('sk-ant-api03-AAAABBBBCCCC');
    expect(safe).toContain('[redacted]');
  });

  it('ignores an empty secret, so it does not redact the whole string', () => {
    expect(redactSecrets('plain text', ['', '   '])).toBe('plain text');
  });
});

describe('cut', () => {
  it('cuts to the limit and marks that it cut', () => {
    const long = 'x'.repeat(500);
    const short = cut(long, 200);
    expect(short.startsWith('x'.repeat(200))).toBe(true);
    expect(short).toContain('...');
    expect(cut('short', 200)).toBe('short');
  });
});

describe('createUsageRecorder', () => {
  it('records the token usage of a call without eating the body', async () => {
    const inner = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ usage: { input_tokens: 10, output_tokens: 2 }, hello: 'world' }),
        }) as unknown as Response,
    );

    const recorder = createUsageRecorder(inner);
    const res = await recorder.fetch('https://example.invalid/v1/messages', { method: 'POST' });

    expect(recorder.usage()).toEqual({ tokensIn: 10, tokensOut: 2 });
    // The caller still gets to read the body, which is the whole point.
    expect(await res.json()).toEqual({
      usage: { input_tokens: 10, output_tokens: 2 },
      hello: 'world',
    });
  });

  it('passes a failed response straight through and records nothing', async () => {
    const inner = vi.fn(
      async () => ({ ok: false, status: 429, text: async () => 'slow down' }) as unknown as Response,
    );
    const recorder = createUsageRecorder(inner);
    const res = await recorder.fetch('https://example.invalid/v1/messages');

    expect(res.status).toBe(429);
    expect(recorder.usage()).toBeNull();
    // Untouched, so the caller's own error path can still read it.
    expect(await res.text()).toBe('slow down');
  });
});

describe('explanationToText', () => {
  it('turns the structured answer into something Boss can read', () => {
    const text = explanationToText({
      body: {
        exam: 'UGC NET',
        topic: 'Indian Constitution',
        question: 'Who appoints a Governor?',
        sections: [{ heading: 'Article 155', body: 'The President appoints the Governor.' }],
        remember: 'Article 155.',
      },
      sources: [{ title: 'India Code', url: 'https://example.invalid/155' }],
    });

    expect(text).toContain('UGC NET');
    expect(text).toContain('Article 155');
    expect(text).toContain('https://example.invalid/155');
    expect(text).not.toContain('undefined');
  });

  it('says "none" instead of printing nothing when there are no sources', () => {
    const text = explanationToText({
      body: { sections: [{ heading: 'H', body: 'B' }] },
      sources: [],
    });
    expect(text).toContain('- none');
    expect(text).toContain('(none)');
    expect(text).not.toContain('undefined');
  });
});

describe('resultFileName', () => {
  it('is the date and the check name, under the results folder', () => {
    expect(RESULTS_DIR).toBe('live-checks/results');
    expect(resultFileName('split-accuracy', new Date(Date.UTC(2026, 10, 7, 3, 4, 5)))).toBe(
      '2026-11-07-split-accuracy.md',
    );
  });
});

describe('the three reports', () => {
  const splitResult = compareSplit({
    truth: [truthQuestion(1), truthQuestion(2)],
    found: [{ number: 1, stem: STEM_096, options: OPTIONS }],
  });

  it('the split report shows the percent, the target and both texts side by side', () => {
    const report = formatSplitReport({
      result: splitResult,
      paperId: '11111111-2222-3333-4444-555555555555',
      pdfPath: 'papers-import/cuetpg/pdfs/2024.pdf',
      model: 'claude-haiku-5-5',
      usage: { tokensIn: 20_000, tokensOut: 3_000 },
      cost: tokenCostUsd({ model: 'claude-haiku-5-5', tokensIn: 20_000, tokensOut: 3_000, searches: 0 }),
      date: new Date(Date.UTC(2026, 10, 7)),
    });

    expect(report).toContain('0.0 percent');
    expect(report).toContain('80 percent');
    expect(report).toContain('found 1');
    expect(report).toContain('0.96');
    expect(report).toContain(STEM);
    expect(report).toContain(STEM_096);
    expect(report).toContain('missing');
    expect(report).toContain('$0.0035');
    expect(report).not.toContain('undefined');
  });

  it('the explain report shows tokens, searches, cost and the gap to the estimate', () => {
    const report = formatExplainReport({
      questionId: '11111111-2222-3333-4444-555555555555',
      lang: 'en',
      runs: [
        {
          tokensIn: 15_000,
          tokensOut: 1_500,
          searches: 2,
          model: 'claude-haiku-5-5',
          cost: tokenCostUsd({
            model: 'claude-haiku-5-5',
            tokensIn: 15_000,
            tokensOut: 1_500,
            searches: 2,
          }),
          text: 'Article 155. The President appoints the Governor of a state.',
        },
      ],
      date: new Date(Date.UTC(2026, 10, 7)),
    });

    expect(report).toContain('tokens_in');
    expect(report).toContain('15000');
    expect(report).toContain('searches');
    expect(report).toContain('$0.02225');
    expect(report).toContain('$0.022');
    expect(report).toContain('percent');
    expect(report).toContain('Article 155');
    expect(report).not.toContain('undefined');
  });

  it('the probe report says which type the app will use', () => {
    const report = formatProbeReport({
      outcome: readProbeOutcome([
        { toolType: 'web_search_20260209', status: 400, accepted: false, error: 'not supported' },
        { toolType: 'web_search_20250305', status: 200, accepted: true, error: null },
      ]),
      model: 'claude-haiku-5-5',
      date: new Date(Date.UTC(2026, 10, 7)),
    });

    expect(report).toContain('web_search_20260209');
    expect(report).toContain('400');
    expect(report).toContain('not supported');
    expect(report).toContain('web_search_20250305');
    expect(report).toMatch(/will use/i);
    expect(report).not.toContain('undefined');
  });
});

describe('alignByStem', () => {
  const stems = [
    'who appoints the governor of an indian state',
    'which article of the constitution deals with the right to equality',
    'the concept of judicial review in india is borrowed from which country',
    'who was the chairman of the drafting committee of the constitution',
    'the rajya sabha is dissolved after how many years',
    'which schedule of the constitution lists the official languages',
  ];
  const truth = stems.map((stem, index) => truthQuestion(index + 1, stem));

  it('changes nothing on a clean split', () => {
    const result = alignByStem(truth, truth);
    expect(result.renumbered).toBe(0);
    expect(result.unpaired).toBe(0);
    expect(result.aligned.map((one) => one.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('one dropped question does not shift and fail every later one', () => {
    // The splitter skipped question 2, so positions 2..5 hold questions 3..6.
    const found = [truth[0], ...truth.slice(2)].map((one, index) => ({ ...one, number: index + 1 }));

    const byPosition = compareSplit({ truth, found });
    expect(byPosition.rightCount).toBe(1);

    const alignment = alignByStem(truth, found);
    expect(alignment.renumbered).toBe(4);
    expect(alignment.unpaired).toBe(0);
    const aligned = compareSplit({ truth, found: alignment.aligned });
    expect(aligned.rightCount).toBe(5);
    expect(aligned.missingNumbers).toEqual([2]);
  });

  it('leaves out a found question that matches nothing', () => {
    const junk = { number: 7, stem: 'page 4 of 12 roll number ________', options: OPTIONS };
    const result = alignByStem(truth, [...truth, junk]);
    expect(result.unpaired).toBe(1);
    expect(result.aligned).toHaveLength(6);
    // The junk keeps its own number out of the paired list, so the report can
    // still count the splitter's whole answer and list it as extra.
    expect(result.pairedFoundNumbers).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.aligned.length + result.unpaired).toBe(7);
  });
});
