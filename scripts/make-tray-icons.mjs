// =============================================================================
// Tray icons, generated from the Bipli logo.
//
// 🔑 THE SOURCE IS THE ANDROID MONOCHROME ADAPTIVE ICON. It is already a solid
// single-colour silhouette of the mark on transparency — exactly the shape a
// tray icon needs — so nothing here has to guess at thresholds or trace edges
// out of the full-colour logo.
//
// ⚠️ WINDOWS AND macOS WANT OPPOSITE THINGS, and both are produced:
//   · Windows tray sits on a dark taskbar → WHITE silhouette.
//   · macOS menu bar takes a TEMPLATE image → BLACK on transparent, and the OS
//     inverts it for light/dark. A template image is rendered as a mask, so any
//     colour in it is DISCARDED.
//
// 🔴 WHICH MEANS THE STATE DOT CANNOT BE A TEMPLATE. A coloured dot inside a
// macOS template image comes out as an indistinguishable blob — the one thing
// the dot exists to distinguish. So on macOS only IDLE is a template; ringing
// and on-call ship as normal coloured images and give up automatic light/dark
// inversion. That is the right trade: those states are transient and the colour
// IS the information, whereas idle is what sits in the bar all day and must
// look native.
//
//   node scripts/make-tray-icons.mjs
// =============================================================================
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";

const SRC = process.argv[2] ?? "/home/samuel/bipli-mobile/assets/adaptive-icon-monochrome.png";
const OUT = path.resolve(import.meta.dirname, "..", "assets");

// --- PNG decode (8-bit RGBA only; the source is verified to be that) --------
function readPng(file) {
  const d = fs.readFileSync(file);
  if (d.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let i = 8, w = 0, h = 0, bitDepth = 0, colourType = 0;
  const idat = [];
  while (i < d.length) {
    const len = d.readUInt32BE(i);
    const type = d.toString("ascii", i + 4, i + 8);
    const body = d.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      bitDepth = body[8]; colourType = body[9];
      if (body[12] !== 0) throw new Error("interlaced PNG unsupported");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    i += 12 + len;
  }
  if (bitDepth !== 8 || colourType !== 6) {
    throw new Error(`need 8-bit RGBA, got depth ${bitDepth} type ${colourType}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`bad filter ${filter}`);
      }
      cur[x] = v & 0xff;
    }
  }
  return { w, h, rgba: out };
}

// --- PNG encode -------------------------------------------------------------
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, c]);
}
function writePng(file, w, h, rgba) {
  const stride = w * 4;
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(Buffer.concat([Buffer.from([0]), rgba.subarray(y * stride, (y + 1) * stride)]));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]));
}

// --- ops --------------------------------------------------------------------
// ⚠️ CROP TO THE INK FIRST. An adaptive icon carries a large safe-zone margin;
// scaled straight to 16px the mark would be a smudge in the middle of empty
// space, which is how tray icons end up looking broken rather than small.
function cropToAlpha({ w, h, rgba }) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (rgba[(y * w + x) * 4 + 3] > 8) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error("source is fully transparent");
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const side = Math.max(cw, ch); // keep it square so nothing is stretched
  const ox = x0 - ((side - cw) >> 1), oy = y0 - ((side - ch) >> 1);
  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const sx = ox + x, sy = oy + y;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * side + x) * 4);
  }
  return { w: side, h: side, rgba: out };
}

// Box filter with PREMULTIPLIED alpha — averaging straight RGBA drags the
// colour of fully transparent pixels into the edges and haloes the result.
function resize({ w, h, rgba }, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx0 = Math.floor((x * w) / tw), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / tw));
    const sy0 = Math.floor((y * h) / th), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / th));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const i = (sy * w + sx) * 4, al = rgba[i + 3] / 255;
      r += rgba[i] * al; g += rgba[i + 1] * al; b += rgba[i + 2] * al; a += rgba[i + 3];
      n++;
    }
    const o = (y * tw + x) * 4, av = a / n;
    out[o + 3] = Math.round(av);
    const un = av > 0 ? (n * 255) / a : 0;
    out[o] = Math.min(255, Math.round((r / n) * un));
    out[o + 1] = Math.min(255, Math.round((g / n) * un));
    out[o + 2] = Math.min(255, Math.round((b / n) * un));
  }
  return { w: tw, h: th, rgba: out };
}

/** Recolour the silhouette, keeping its alpha. */
function tint({ w, h, rgba }, [r, g, b]) {
  const out = Buffer.from(rgba);
  for (let i = 0; i < out.length; i += 4) { out[i] = r; out[i + 1] = g; out[i + 2] = b; }
  return { w, h, rgba: out };
}

/**
 * A state dot in the bottom-right, punched out of the logo by a transparent
 * ring so it reads as a separate badge rather than part of the mark.
 */
function dot({ w, h, rgba }, [r, g, b]) {
  const out = Buffer.from(rgba);
  const rad = Math.max(2.2, w * 0.30) / 2;
  const cx = w - rad - w * 0.04, cy = h - rad - h * 0.04;
  const gap = rad * 0.55;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const i = (y * w + x) * 4;
    if (d <= rad + gap && d > rad) { out[i + 3] = 0; continue; } // separation ring
    if (d <= rad) {
      const cov = d <= rad - 1 ? 255 : Math.round(255 * (rad - d));
      out[i] = r; out[i + 1] = g; out[i + 2] = b;
      out[i + 3] = Math.max(out[i + 3], Math.max(0, cov));
    }
  }
  return { w, h, rgba: out };
}

// --- build ------------------------------------------------------------------
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
// 🔴 THE DOT MUST CONTRAST WITH THE MARK, and the first version did not: the
// Windows silhouette is white and the ringing dot was also white, so the
// "ringing" icon was pixel-identical to idle. Caught by comparing the two
// outputs rather than by looking at them.
//
// Green ringing (the answer colour, matching the call button), blue on-a-call.
// Both stay clear of the presence vocabulary's red (deliberately off) and amber
// (broken) — these are ACTIVITY states, not presence, and must not borrow a
// meaning that already belongs to something else.
const RINGING = [34, 197, 94], INCALL = [59, 130, 246];

const src = cropToAlpha(readPng(SRC));
fs.mkdirSync(OUT, { recursive: true });

const made = [];
for (const [size, suffix] of [[16, ""], [32, "@2x"]]) {
  const base = resize(src, size, size);
  const win = tint(base, WHITE);
  const mac = tint(base, BLACK);
  const write = (name, img) => { writePng(path.join(OUT, name + ".png"), img.w, img.h, img.rgba); made.push(name); };
  // Windows: white mark, coloured dot for the active states.
  write(`tray-idle${suffix}`, win);
  write(`tray-ringing${suffix}`, dot(win, RINGING));
  write(`tray-incall${suffix}`, dot(win, INCALL));
  // macOS: idle is a TEMPLATE (black, OS-inverted). Active states carry colour
  // and therefore cannot be templates — see the header.
  write(`trayTemplate${suffix}`, mac);
  write(`tray-ringing-mac${suffix}`, dot(mac, RINGING));
  write(`tray-incall-mac${suffix}`, dot(mac, INCALL));
}
console.log(`wrote ${made.length} icons to ${OUT}`);
