/**
 * Issue 78-installable-app: draws the app icons. Run: `node scripts/make-icons.mjs`
 *
 * The repo has no brand asset, so the icons are generated from the app name and
 * the main colour in DESIGN.md (#4F46E5): a white "P" on indigo. No dependency:
 * a PNG is built by hand with node:zlib. The glyph is a stem plus a ring bowl.
 *
 *  - icon-192.png, icon-512.png: "any" purpose, rounded square, transparent corners.
 *  - icon-maskable-512.png: full bleed, glyph kept inside the central 80% safe zone.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const INDIGO = [0x4f, 0x46, 0xe5];
const WHITE = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Share of the pixel (0..1) covered by the shape, by 4x4 sampling. */
function coverage(x, y, inside) {
  let hit = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hit++;
  }
  return hit / 16;
}

function render(size, { rounded, glyphScale }) {
  const u = (size * glyphScale) / 100; // glyph unit, glyph box is 100 units
  const ox = (size - 100 * u) / 2;
  const oy = (size - 100 * u) / 2;
  const radius = size * 0.22;

  const inRounded = (px, py) => {
    if (!rounded) return true;
    const cx = Math.min(Math.max(px, radius), size - radius);
    const cy = Math.min(Math.max(py, radius), size - radius);
    return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2;
  };
  const inGlyph = (px, py) => {
    const gx = (px - ox) / u;
    const gy = (py - oy) / u;
    const stem = gx >= 24 && gx <= 42 && gy >= 14 && gy <= 86;
    const d = Math.hypot(gx - 50, gy - 38);
    const bowl = gx >= 42 && d <= 26 && d >= 8;
    const bar = gx >= 24 && gx <= 50 && ((gy >= 12 && gy <= 22) || (gy >= 54 && gy <= 64));
    return stem || bowl || bar;
  };

  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const shape = coverage(x, y, inRounded);
      const glyph = coverage(x, y, inGlyph);
      const rgb = INDIGO.map((c, i) => Math.round(c * (1 - glyph) + WHITE[i] * glyph));
      row.set([...rgb, Math.round(255 * shape)], 1 + x * 4);
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8 bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
const files = [
  ['icon-192.png', render(192, { rounded: true, glyphScale: 0.8 })],
  ['icon-512.png', render(512, { rounded: true, glyphScale: 0.8 })],
  ['icon-maskable-512.png', render(512, { rounded: false, glyphScale: 0.6 })],
];
for (const [name, bytes] of files) {
  writeFileSync(new URL(`../public/icons/${name}`, import.meta.url), bytes);
  console.log(name, bytes.length, 'bytes');
}
