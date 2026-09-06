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

// TWO SOURCES, because the two platforms need genuinely different images.
//   Windows → the full app icon, the same one on the taskbar. It carries its own
//             background, so it does not depend on the taskbar's colour.
//   macOS   → the monochrome silhouette, which becomes a template image.
// 🔑 THE BRAND SOURCE IS VENDORED, NOT READ OUT OF A SIBLING CHECKOUT. These
// used to point at absolute paths inside ../bipli-mobile, which made this script
// depend on one machine's layout AND on files that repo generates — when mobile
// regenerated its own icons from this same mark, both paths silently became the
// wrong picture and re-running here would have quietly changed the tray.
const WIN_SRC = process.argv[2] ?? path.resolve(import.meta.dirname, "..", "assets", "brand-icon-source.png");
const MAC_SRC = process.argv[3] ?? path.resolve(import.meta.dirname, "..", "assets", "brand-mono-source.png");
// 🔑 THE APP ICON USES A DIFFERENT SOURCE TO THE TRAY, ON PURPOSE. The tray reads
// the 512px framed icon, whose inner tile is only 320px — plenty for a 16px tray
// icon, and changing it would move pixels in icons that are already right. The
// 1024px foreground carries the SAME tile at 536px, which is what a 1024px app
// icon should be built from: a 1.9x grow instead of a 3.2x one.
const TILE_SRC = path.resolve(import.meta.dirname, "..", "assets", "brand-tile-source.png");
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


/**
 * Bilinear GROW, premultiplied.
 *
 * 🔑 NOT resize(). That one averages the source pixels covered by each
 * destination pixel — correct for shrinking, which is all the tray ever does,
 * but when growing, the covered area is a single pixel and it silently
 * degenerates to nearest-neighbour. Invisible at 16px; at the 1.9x the 1024 app
 * icon needs, it is visibly blocky. Premultiplied so the tile's transparent
 * rounded corners cannot bleed their colour into the edge.
 */
function upscale({ w, h, rgba }, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const fx = ((x + 0.5) * w) / size - 0.5, fy = ((y + 0.5) * h) / size - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    let r = 0, g = 0, b = 0, a = 0;
    for (const [dx, dy, wt] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const sx = Math.min(w - 1, Math.max(0, x0 + dx)), sy = Math.min(h - 1, Math.max(0, y0 + dy));
      const i = (sy * w + sx) * 4, al = rgba[i + 3] / 255;
      r += rgba[i] * al * wt; g += rgba[i + 1] * al * wt; b += rgba[i + 2] * al * wt; a += rgba[i + 3] * wt;
    }
    const o = (y * size + x) * 4;
    out[o + 3] = Math.round(a);
    const un = a > 0 ? 255 / a : 0;
    out[o] = Math.min(255, Math.round(r * un));
    out[o + 1] = Math.min(255, Math.round(g * un));
    out[o + 2] = Math.min(255, Math.round(b * un));
  }
  return { w: size, h: size, rgba: out };
}

/**
 * Crop the app icon down to its INNER dark tile.
 *
 * 🔴 THE SOURCE IS A TILE INSIDE A TILE. icon.png is a 512px CREAM square with a
 * 320px black rounded tile inset 96px on every side. Scaled straight to 16px the
 * tray showed a tile-in-a-tile — a cream frame around the real icon — which is
 * both ugly and wastes a third of the pixels at the size where pixels are
 * scarcest.
 *
 * ⚠️ CREAM CANNOT BE REMOVED BY COLOUR. The B inside the tile is ALSO cream, so
 * knocking out every cream pixel would erase the letter and leave a black
 * lozenge. The cream to remove is the cream OUTSIDE the tile, and "outside" is a
 * topological fact, not a colour one — so it is found by flood-filling inward
 * from the four corners. Cream enclosed by black is never reached.
 */
function cropToInnerTile({ w, h, rgba }) {
  const lum = (i) => 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  // 1. Flood the outer background from every corner.
  const outside = new Uint8Array(w * h);
  const stack = [0, w - 1, (h - 1) * w, h * w - 1];
  for (const s of stack) outside[s] = 1;
  while (stack.length) {
    const idx = stack.pop();
    const x = idx % w, y = (idx / w) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (outside[ni]) continue;
      if (lum(ni * 4) < 150) continue; // hit the dark tile — stop
      outside[ni] = 1;
      stack.push(ni);
    }
  }
  // 2. Bounding box of everything NOT outside = the tile.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (outside[y * w + x]) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) throw new Error("no inner tile found");
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const si = ((y + y0) * w + (x + x0)) * 4;
    const di = (y * cw + x) * 4;
    out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2];
    // Outside the tile becomes transparent; the tile's own rounded corners are
    // preserved by this rather than re-cut, so the original curve survives.
    out[di + 3] = outside[(y + y0) * w + (x + x0)] ? 0 : rgba[si + 3];
  }
  return { w: cw, h: ch, rgba: out };
}

/**
 * Round the corners of a full-bleed tile.
 *
 * The app icon is a hard square (100% opaque to the edge). A square block in the
 * tray reads as a placeholder next to every other rounded icon, so the corners
 * are cut here rather than shipping a different source art.
 */
function roundCorners({ w, h, rgba }, radiusPct = 0.22) {
  const out = Buffer.from(rgba);
  const r = Math.max(1, Math.round(Math.min(w, h) * radiusPct));
  const corners = [[r, r], [w - r, r], [r, h - r], [w - r, h - r]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const inX = x >= r && x <= w - r, inY = y >= r && y <= h - r;
    if (inX || inY) continue; // straight edges and the middle stay put
    // Only the four corner squares remain; find which one and test the radius.
    let best = Infinity;
    for (const [cx, cy] of corners) best = Math.min(best, Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
    const i = (y * w + x) * 4;
    if (best > r) out[i + 3] = 0;
    else if (best > r - 1) out[i + 3] = Math.round(out[i + 3] * (r - best));
  }
  return { w, h, rgba: out };
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

// ⚠️ THE WINDOWS SOURCE IS NOT CROPPED TO ALPHA. It is a full-bleed tile with no
// transparency, so there is no ink bounding box to find — cropping is what the
// macOS silhouette needs, and applying it here would do nothing or worse.
const winSrc = cropToInnerTile(readPng(WIN_SRC));
const macSrc = cropToAlpha(readPng(MAC_SRC));
fs.mkdirSync(OUT, { recursive: true });

const made = [];
for (const [size, suffix] of [[16, ""], [32, "@2x"]]) {
  const write = (name, img) => {
    writePng(path.join(OUT, name + ".png"), img.w, img.h, img.rgba);
    made.push(name);
  };

  // --- Windows: the INNER tile, so no cream frame wastes a third of a 16px
  // icon. ⚠️ NOT re-rounded — the tile already carries its own corner radius,
  // and cutting it again would shave the artwork.
  const win = resize(winSrc, size, size);
  write(`tray-idle${suffix}`, win);
  write(`tray-ringing${suffix}`, dot(win, RINGING));
  write(`tray-incall${suffix}`, dot(win, INCALL));

  // --- macOS: idle is a TEMPLATE; the active states cannot be (see header) --
  const mac = tint(resize(macSrc, size, size), BLACK);
  write(`trayTemplate${suffix}`, mac);
  write(`tray-ringing-mac${suffix}`, dot(mac, RINGING));
  write(`tray-incall-mac${suffix}`, dot(mac, INCALL));
}
// 🔑 THE APP ICON IS COMPOSED AT 1024, NOT SHIPPED AS THE RAW CROP. build/icon.png
// feeds the installer, the Start Menu entry and the macOS bundle. It used to be
// written straight from the cropped tile at whatever size that landed on — 320px
// from the old 512px source — with a comment claiming that cleared
// electron-builder's minimum. It did not: macOS needs at least 512 and the mac
// job failed with "Icon must be at least 512x512 pixels, provided: 320x320".
// Sized from the same 536px tile the mobile icons use, so all three apps compose
// one mark from one source.
//
// ⚠️ THE ROUNDED CORNERS ARE KEPT HERE AND DISCARDED ON iOS, and that is not an
// inconsistency. iOS rejects alpha outright and masks the icon itself, so corners
// baked into the art would draw a dark ring inside Apple's rounding. macOS and
// Windows apply NO mask — a full-bleed square would sit in the Dock as the one
// hard-edged icon among rounded neighbours. Same mark, opposite handling,
// because the platforms disagree about who rounds it.
const APP_ICON = 1024;
const BUILD_ICON = path.resolve(import.meta.dirname, "..", "build", "icon.png");
fs.mkdirSync(path.dirname(BUILD_ICON), { recursive: true });
const appIcon = upscale(cropToAlpha(readPng(TILE_SRC)), APP_ICON);
writePng(BUILD_ICON, appIcon.w, appIcon.h, appIcon.rgba);
if (appIcon.w < 512) throw new Error(`app icon ${appIcon.w}px is below the 512 macOS floor`);
console.log(`wrote ${made.length} tray icons to ${OUT}`);
console.log(`wrote app icon ${appIcon.w}x${appIcon.h} to ${BUILD_ICON}`);
