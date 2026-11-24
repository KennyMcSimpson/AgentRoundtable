#!/usr/bin/env node
// dist/make-icon.mjs: draws the AgentRoundtable app icon (a round table with four seats) in pure Node and
// writes app/icon.ico. No image library: RGBA pixels are drawn with 4x4 supersampling, encoded as
// PNG with node:zlib, and packed into one ICO with 16/24/32/48/64/128/256 px entries (PNG-compressed
// ICO entries, which Windows reads since Vista). The pixels are deterministic, so the committed
// app/icon.ico must carry exactly what this script draws (test/app.test.mjs compares them decoded).
//
//   node dist/make-icon.mjs [--out <file.ico>]      default: app/icon.ico
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32 } from '../lib/zip.mjs';

export const ICON_SIZES = Object.freeze([16, 24, 32, 48, 64, 128, 256]);

const TABLE = [200, 135, 58];      // wood
const TABLE_RIM = [138, 85, 35];   // darker rim
const SEAT = [36, 86, 199];        // ui/lobby.css --accent

// Shape coverage at a point (unit square coordinates, 0..1): which colour, or null.
function colourAt(x, y) {
  const cx = 0.5;
  const cy = 0.5;
  const d = Math.hypot(x - cx, y - cy);
  if (d <= 0.285) return d >= 0.235 ? TABLE_RIM : TABLE;
  const seatDist = 0.405;
  const seatR = 0.088;
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
    if (Math.hypot(x - (cx + dx * seatDist), y - (cy + dy * seatDist)) <= seatR) return SEAT;
  }
  return null;
}

// RGBA (straight alpha), size x size, rows top to bottom.
export function renderIcon(size) {
  const S = 4; // supersampling per axis
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let sj = 0; sj < S; sj++) {
        for (let si = 0; si < S; si++) {
          const c = colourAt((i + (si + 0.5) / S) / size, (j + (sj + 0.5) / S) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
        }
      }
      const o = (j * size + i) * 4;
      if (n) {
        px[o] = Math.round(r / n);
        px[o + 1] = Math.round(g / n);
        px[o + 2] = Math.round(b / n);
        px[o + 3] = Math.round((255 * n) / (S * S));
      }
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// 8-bit RGBA PNG, filter 0 on every row, zlib level 9.
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ICONDIR + ICONDIRENTRY[] + PNG images.
export function buildIco(sizes = ICON_SIZES) {
  const images = sizes.map((s) => encodePng(renderIcon(s), s, s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const entries = Buffer.alloc(16 * sizes.length);
  let offset = 6 + entries.length;
  sizes.forEach((s, k) => {
    const e = k * 16;
    entries[e] = s >= 256 ? 0 : s;
    entries[e + 1] = s >= 256 ? 0 : s;
    entries[e + 2] = 0; // palette
    entries[e + 3] = 0; // reserved
    entries.writeUInt16LE(1, e + 4);  // planes
    entries.writeUInt16LE(32, e + 6); // bits per pixel
    entries.writeUInt32LE(images[k].length, e + 8);
    entries.writeUInt32LE(offset, e + 12);
    offset += images[k].length;
  });
  return Buffer.concat([header, entries, ...images]);
}

// Reads an ICO back: [{width, height, bpp, bytes, offset, png}] (for tests and the build check).
export function readIco(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('not an ICO file');
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let k = 0; k < n; k++) {
    const e = 6 + k * 16;
    const bytes = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    out.push({ width: buf[e] || 256, height: buf[e + 1] || 256, bpp: buf.readUInt16LE(e + 6), bytes, offset, png: buf.subarray(offset, offset + bytes) });
  }
  return out;
}

export function defaultIconPath() { return fileURLToPath(new URL('../app/icon.ico', import.meta.url)); }

function isMain() {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const out = path.resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : defaultIconPath());
  const ico = buildIco();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, ico);
  process.stdout.write(`ICON ${out.replace(/\\/g, '/')} sizes=${ICON_SIZES.join(',')} bytes=${ico.length}\n`);
}
