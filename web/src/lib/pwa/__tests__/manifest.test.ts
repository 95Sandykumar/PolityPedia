/**
 * Issue 78-installable-app: the web app manifest.
 * Reads the real file in `public/`, so a wrong field or a missing icon fails here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PUBLIC_DIR = join(process.cwd(), 'public');
const manifest = JSON.parse(readFileSync(join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));

/** Width and height are bytes 16..23 of a PNG (the IHDR chunk). */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('manifest', () => {
  it('has the required fields', () => {
    expect(manifest.name).toBe('PolityPedia');
    expect(manifest.short_name).toBe('PolityPedia');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('uses the colours from DESIGN.md', () => {
    expect(manifest.theme_color).toBe('#4F46E5');
    expect(manifest.background_color).toBe('#F8FAFC');
  });

  it('lists 192 and 512 icons, and a maskable one', () => {
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(
      manifest.icons.some((icon: { purpose?: string }) => (icon.purpose ?? '').includes('maskable')),
    ).toBe(true);
  });

  it('points at real PNG files whose pixel size matches the claim', () => {
    for (const icon of manifest.icons as { src: string; sizes: string; type: string }[]) {
      expect(icon.type).toBe('image/png');
      const file = join(PUBLIC_DIR, icon.src);
      expect(existsSync(file), icon.src).toBe(true);
      const { width, height } = pngSize(file);
      expect(`${width}x${height}`).toBe(icon.sizes);
    }
  });

  it('keeps every icon tiny (B4)', () => {
    for (const icon of manifest.icons as { src: string }[]) {
      expect(readFileSync(join(PUBLIC_DIR, icon.src)).length).toBeLessThan(20_000);
    }
  });
});

describe('offline page', () => {
  it('says the required sentence', () => {
    const html = readFileSync(join(PUBLIC_DIR, 'offline.html'), 'utf8');
    expect(html).toContain('You are offline. Open the app again when you have network.');
    expect(html).toContain('आप ऑफ़लाइन हैं');
  });
});
