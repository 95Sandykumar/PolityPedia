/**
 * The render path refuses a url it would not put in an `href`
 * (issue 32-ai-claim-tokens).
 *
 * A stored source is drawn as a real anchor the student taps
 * (`revision-panel.tsx`). Before this slice both stored-row readers accepted
 * any string, so a `javascript:` url written by a hand-posted REST call was
 * rendered as given, and tapping it ran code in that student's own session.
 *
 * `0032_ai_claim_tokens.sql` is the gate: a bad url is never stored. This is
 * the second lock, for rows written before it existed, and it is why the
 * check has to live in the READER and not only in the SQL.
 */
import { describe, expect, it } from 'vitest';
import { readExplanationRow, readExplanationSources } from '../explanation-row';
import { MAX_SOURCE_URL, readSourceUrl } from '../types';

const BODY = {
  exam: 'UGC NET',
  topic: 'Parliament',
  question: 'Which house is the Council of States?',
  sections: [{ heading: 'Answer', body: 'The Rajya Sabha.' }],
  remember: 'Rajya Sabha = Council of States.',
};

describe('readSourceUrl', () => {
  it('keeps http and https', () => {
    expect(readSourceUrl('https://www.indiacode.nic.in/')).toBe(
      'https://www.indiacode.nic.in/',
    );
    expect(readSourceUrl('http://example.org/a?b=1')).toBe('http://example.org/a?b=1');
  });

  it('drops every other scheme', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      '  javascript:alert(1)  ',
      'data:text/html,<script>1</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'ftp://example.org/x',
    ]) {
      expect(readSourceUrl(bad)).toBeNull();
    }
  });

  it('drops what is not a url at all', () => {
    for (const bad of ['', '   ', '/questions/1', 'indiacode.nic.in', 42, null, undefined, {}]) {
      expect(readSourceUrl(bad)).toBeNull();
    }
  });

  it('drops a url too long to be a real source', () => {
    expect(readSourceUrl('https://x.org/' + 'a'.repeat(MAX_SOURCE_URL))).toBeNull();
  });

  it('normalises the scheme, so it matches what the SQL CHECK accepts', () => {
    expect(readSourceUrl('HTTPS://Example.ORG/Path')).toBe('https://example.org/Path');
  });
});

describe('readExplanationSources', () => {
  it('keeps the good link and drops the dangerous one', () => {
    const kept = readExplanationSources([
      { title: 'Free marks', url: 'javascript:alert(1)' },
      { title: 'India Code', url: 'https://www.indiacode.nic.in/' },
      { title: 'No url' },
      'not an object',
      null,
    ]);
    expect(kept).toEqual([
      { title: 'India Code', url: 'https://www.indiacode.nic.in/' },
    ]);
  });

  it('falls back to the url as the title, never to the raw string', () => {
    const kept = readExplanationSources([{ url: 'https://x.org/a' }]);
    expect(kept).toEqual([{ title: 'https://x.org/a', url: 'https://x.org/a' }]);
  });

  it('is an empty list when sources is not an array', () => {
    expect(readExplanationSources(null)).toEqual([]);
    expect(readExplanationSources({ url: 'https://x.org' })).toEqual([]);
  });
});

describe('readExplanationRow', () => {
  it('hands the screen a row with no dangerous source left in it', () => {
    const row = readExplanationRow({
      question_id: '11111111-1111-4111-8111-111111111111',
      lang: 'en',
      status: 'ready',
      body: BODY,
      sources: [
        { title: 'Phish', url: 'javascript:fetch("/api")' },
        { title: 'India Code', url: 'https://www.indiacode.nic.in/' },
      ],
      audio_path: null,
      edited_by_teacher: false,
    });

    expect(row?.sources.map((s) => s.url)).toEqual(['https://www.indiacode.nic.in/']);
    expect(row?.body?.sections).toHaveLength(1);
  });
});
