// Draws images/icon.png (128x128): a blue rounded tile with white angle
// brackets and a green check mark, 4x supersampled, using only zlib.
// Replace the PNG with real artwork whenever you like; keep it 128x128.
//   node scripts/icon.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

type Point = [number, number];
type Color = [number, number, number];

const SIZE = 128;
const SS = 4;

const strokes: Array<{ color: Color; width: number; path: Point[] }> = [
  { color: [255, 255, 255], width: 9, path: [[40, 40], [18, 64], [40, 88]] }, // <
  { color: [255, 255, 255], width: 9, path: [[88, 40], [110, 64], [88, 88]] }, // >
  { color: [76, 217, 100], width: 11, path: [[47, 66], [60, 80], [83, 48]] }, // check mark
];

function distToSegment(px: number, py: number, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideRoundedRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number): boolean {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && Math.hypot(x - cx, y - cy) <= r;
}

// null means transparent
function sample(x: number, y: number): Color | null {
  if (!insideRoundedRect(x, y, 4, 4, 124, 124, 26)) return null;
  const t = (x + y) / 256; // diagonal gradient
  let color: Color = [Math.round(24 + 22 * t), Math.round(78 + 40 * t), Math.round(140 + 60 * t)];
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.path.length; i++) {
      if (distToSegment(x, y, s.path[i]!, s.path[i + 1]!) <= s.width / 2) color = s.color;
    }
  }
  return color;
}

const rows: Buffer[] = [];
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 4); // filter byte, then RGBA
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        hits++;
      }
    }
    const o = 1 + x * 4;
    if (hits > 0) {
      row[o] = Math.round(r / hits);
      row[o + 1] = Math.round(g / hits);
      row[o + 2] = Math.round(b / hits);
    }
    row[o + 3] = Math.round((hits / (SS * SS)) * 255);
  }
  rows.push(row);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("images", { recursive: true });
writeFileSync("images/icon.png", png);
console.log(`images/icon.png written (${png.length} bytes)`);
