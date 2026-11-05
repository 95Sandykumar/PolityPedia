/**
 * Issue 08-videos-tile: the YouTube URL parser.
 *
 * "Test that proves it", first half: the parser handles 4 URL forms and
 * rejects a non-YouTube URL. V6 says YouTube links ONLY, so this function is
 * the gate: nothing that it cannot read becomes a row.
 *
 * No network call anywhere in this file. The parser is pure string work.
 */
import { describe, expect, it } from 'vitest';
import {
  parseYouTubeId,
  youTubeThumbUrl,
  youTubeWatchUrl,
  YOUTUBE_ID_RE,
} from '../youtube-url';

/** A real 11-character YouTube id shape: letters, digits, `-` and `_`. */
const ID = 'dQw4w9WgXcQ';
const ODD = 'a-b_C1234_9';

describe('parseYouTubeId, the four forms V6 allows', () => {
  it('reads a watch link', () => {
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it('reads a youtu.be short link', () => {
    expect(parseYouTubeId(`https://youtu.be/${ID}`)).toBe(ID);
  });

  it('reads a shorts link', () => {
    expect(parseYouTubeId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
  });

  it('reads an embed link', () => {
    expect(parseYouTubeId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
  });
});

describe('parseYouTubeId, the shapes a teacher really pastes', () => {
  it('keeps the id when the link carries extra query parameters', () => {
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ID}&t=42s&list=PL1`)).toBe(ID);
    expect(parseYouTubeId(`https://youtu.be/${ID}?si=abcdef&t=10`)).toBe(ID);
  });

  it('accepts m.youtube.com, no www, and http', () => {
    expect(parseYouTubeId(`https://m.youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeId(`https://youtube.com/watch?v=${ID}`)).toBe(ID);
    expect(parseYouTubeId(`http://www.youtube.com/watch?v=${ID}`)).toBe(ID);
  });

  it('trims the surrounding spaces a paste leaves behind', () => {
    expect(parseYouTubeId(`  https://youtu.be/${ID}  `)).toBe(ID);
  });

  it('keeps every character a YouTube id may contain', () => {
    expect(parseYouTubeId(`https://www.youtube.com/watch?v=${ODD}`)).toBe(ODD);
  });
});

describe('parseYouTubeId rejects', () => {
  it('a non-YouTube URL', () => {
    expect(parseYouTubeId('https://vimeo.com/76979871')).toBeNull();
  });

  it('a look-alike host, so youtube.com.evil.test cannot slip through', () => {
    expect(parseYouTubeId(`https://youtube.com.evil.test/watch?v=${ID}`)).toBeNull();
    expect(parseYouTubeId(`https://notyoutube.com/watch?v=${ID}`)).toBeNull();
  });

  it('a YouTube URL with no video id', () => {
    expect(parseYouTubeId('https://www.youtube.com/watch?v=')).toBeNull();
    expect(parseYouTubeId('https://www.youtube.com/')).toBeNull();
    expect(parseYouTubeId('https://www.youtube.com/@politypedia')).toBeNull();
  });

  it('an id that is not 11 characters', () => {
    expect(parseYouTubeId('https://youtu.be/short')).toBeNull();
    expect(parseYouTubeId('https://youtu.be/waaaaaaaaaaaaaaytoolong')).toBeNull();
  });

  it('a bare id, empty text and rubbish: V6 wants a link', () => {
    expect(parseYouTubeId(ID)).toBeNull();
    expect(parseYouTubeId('')).toBeNull();
    expect(parseYouTubeId('   ')).toBeNull();
    expect(parseYouTubeId('not a url at all')).toBeNull();
  });

  it('a javascript: URL', () => {
    expect(parseYouTubeId('javascript:alert(1)')).toBeNull();
  });
});

describe('the two URLs we build from an id', () => {
  it('builds the hqdefault thumbnail the issue names', () => {
    expect(youTubeThumbUrl(ID)).toBe(`https://i.ytimg.com/vi/${ID}/hqdefault.jpg`);
  });

  it('builds a watch link, so a tile can open the video on YouTube', () => {
    expect(youTubeWatchUrl(ID)).toBe(`https://www.youtube.com/watch?v=${ID}`);
  });

  it('refuses to build a URL from an id it would not have parsed', () => {
    expect(() => youTubeThumbUrl('../../evil')).toThrow();
    expect(() => youTubeWatchUrl('')).toThrow();
  });

  it('exports the id shape, so the route and the DB agree on it', () => {
    expect(YOUTUBE_ID_RE.test(ID)).toBe(true);
    expect(YOUTUBE_ID_RE.test('too-short')).toBe(false);
  });
});
