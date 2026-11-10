// الماسح 74 — imaging core. Pure functions over {data, width, height} so they run in a worker or on the main thread.

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

export function makeImage(width, height) {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/* ---------- downscale (box filter) ---------- */
export function downscale(img, maxSide) {
  const { width: w, height: h, data } = img;
  const s = Math.min(1, maxSide / Math.max(w, h));
  if (s === 1) return { img, scale: 1 };
  const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
  const out = makeImage(W, H), o = out.data;
  const fx = w / W, fy = h / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        let i = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      }
      const j = (y * W + x) * 4;
      o[j] = r / n; o[j + 1] = g / n; o[j + 2] = b / n; o[j + 3] = 255;
    }
  }
  return { img: out, scale: W / w };
}

function boxBlur1(src, w, h, r) {
  // separable box blur on a Float32 single channel
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / d;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / d;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

function otsu(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i] | 0]++;
  const total = values.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function cross(o, a, b) { return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x); }
function convexHull(pts) {
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}
function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) { const p = q[i], n = q[(i + 1) % q.length]; a += p.x * n.y - n.x * p.y; }
  return Math.abs(a) / 2;
}

export function orderQuad(q) {
  // returns [tl, tr, br, bl]
  const c = { x: q.reduce((s, p) => s + p.x, 0) / 4, y: q.reduce((s, p) => s + p.y, 0) / 4 };
  const sorted = [...q].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  // sorted clockwise starting near -PI (left). find the one with smallest x+y as tl
  let k = 0, best = Infinity;
  sorted.forEach((p, i) => { if (p.x + p.y < best) { best = p.x + p.y; k = i; } });
  return [0, 1, 2, 3].map((i) => sorted[(k + i) % 4]);
}

export function defaultQuad(w, h, inset = 0) {
  const ix = w * inset, iy = h * inset;
  return [{ x: ix, y: iy }, { x: w - ix, y: iy }, { x: w - ix, y: h - iy }, { x: ix, y: h - iy }];
}

/**
 * Find the document outline. Paper is usually the brightest, least saturated large region,
 * so we threshold a "whiteness" map, keep the largest blob, and fit the biggest 4-corner shape to its hull.
 * Returns {quad, confident} in the input image's coordinates.
 */
export function detectQuad(img) {
  const { img: small, scale } = downscale(img, 320);
  const { width: w, height: h, data } = small;
  const n = w * h;
  const white = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = data[j], g = data[j + 1], b = data[j + 2];
    const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
    white[i] = mn - 0.5 * (mx - mn); // bright and colourless scores highest
  }
  const blurred = boxBlur1(white, w, h, 2);
  const thr = otsu(blurred);
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = blurred[i] > thr ? 1 : 0;

  // largest connected component (4-connectivity, iterative)
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let bestLabel = -1, bestSize = 0, lab = 0, bestBorder = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] !== -1) continue;
    let sp = 0, size = 0, border = 0; stack[sp++] = s; label[s] = lab;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border++;
      if (x > 0 && mask[p - 1] && label[p - 1] === -1) { label[p - 1] = lab; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] === -1) { label[p + 1] = lab; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] === -1) { label[p - w] = lab; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] === -1) { label[p + w] = lab; stack[sp++] = p + w; }
    }
    if (size > bestSize) { bestSize = size; bestLabel = lab; bestBorder = border; }
    lab++;
  }
  const fallback = { quad: defaultQuad(img.width, img.height, 0.04), confident: false };
  if (bestLabel < 0 || bestSize < n * 0.12) return fallback;

  // boundary points of the blob
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (label[p] !== bestLabel) continue;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
      label[p - 1] !== bestLabel || label[p + 1] !== bestLabel || label[p - w] !== bestLabel || label[p + w] !== bestLabel) pts.push({ x, y });
  }
  const hull = convexHull(pts);
  if (hull.length < 4) return fallback;

  // start from extreme points, then improve each corner greedily to maximise area
  const pick = (f) => hull.reduce((a, b) => (f(b) > f(a) ? b : a));
  let q = [pick((p) => -p.x - p.y), pick((p) => p.x - p.y), pick((p) => p.x + p.y), pick((p) => -p.x + p.y)];
  for (let it = 0; it < 4; it++) {
    for (let k = 0; k < 4; k++) {
      let bestA = polyArea(q), bestP = q[k];
      for (const p of hull) { const t = q.slice(); t[k] = p; const a = polyArea(t); if (a > bestA) { bestA = a; bestP = p; } }
      q[k] = bestP;
    }
  }
  const area = polyArea(q);
  const hullArea = polyArea(hull);
  const fill = area / (w * h);
  const rect = area / hullArea; // how quadrilateral the blob is
  const confident = fill > 0.15 && fill < 0.97 && rect > 0.85 && bestBorder < (w + h) * 0.9;
  if (fill > 0.985) return fallback;
  q = orderQuad(q).map((p) => ({ x: Math.min(img.width, Math.max(0, (p.x + 0.5) / scale)), y: Math.min(img.height, Math.max(0, (p.y + 0.5) / scale)) }));
  return { quad: q, confident };
}

/* ---------- perspective ---------- */
function solve8(A, b) {
  // gaussian elimination, 8x8
  const n = 8; const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue; const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}
function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i], { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve8(A, b); h.push(1); return h;
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function outputSize(quad, maxSide = 2400) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
  const s = Math.min(1, maxSide / Math.max(W, H));
  return { w: Math.max(8, Math.round(W * s)), h: Math.max(8, Math.round(H * s)) };
}

export function warp(img, quad, maxSide = 2400) {
  const { w: W, h: H } = outputSize(quad, maxSide);
  const dst = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  const m = homography(dst, quad);
  const out = makeImage(W, H), o = out.data, s = img.data, sw = img.width, sh = img.height;
  for (let y = 0; y < H; y++) {
    const yc = y + 0.5;
    for (let x = 0; x < W; x++) {
      const xc = x + 0.5;
      const z = m[6] * xc + m[7] * yc + 1;
      let u = (m[0] * xc + m[1] * yc + m[2]) / z - 0.5, v = (m[3] * xc + m[4] * yc + m[5]) / z - 0.5;
      if (u < 0) u = 0; else if (u > sw - 1.001) u = sw - 1.001;
      if (v < 0) v = 0; else if (v > sh - 1.001) v = sh - 1.001;
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const j = (y * W + x) * 4;
      o[j] = s[i00] * w00 + s[i10] * w10 + s[i01] * w01 + s[i11] * w11;
      o[j + 1] = s[i00 + 1] * w00 + s[i10 + 1] * w10 + s[i01 + 1] * w01 + s[i11 + 1] * w11;
      o[j + 2] = s[i00 + 2] * w00 + s[i10 + 2] * w10 + s[i01 + 2] * w01 + s[i11 + 2] * w11;
      o[j + 3] = 255;
    }
  }
  return out;
}

export function rotate(img, quarterTurns) {
  const t = ((quarterTurns % 4) + 4) % 4;
  if (!t) return img;
  const { width: w, height: h, data } = img;
  const W = t % 2 ? h : w, H = t % 2 ? w : h;
  const out = makeImage(W, H), o = out.data;
  const d32 = new Uint32Array(data.buffer, data.byteOffset, w * h), o32 = new Uint32Array(o.buffer);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let X, Y;
    if (t === 1) { X = h - 1 - y; Y = x; } else if (t === 2) { X = w - 1 - x; Y = h - 1 - y; } else { X = y; Y = w - 1 - x; }
    o32[Y * W + X] = d32[y * w + x];
  }
  return out;
}

/* ---------- filters ---------- */

// estimate the paper's lighting per channel on a coarse grid, then sample bilinearly
function illumination(img, channels) {
  const { width: w, height: h, data } = img;
  const cell = Math.max(8, Math.round(Math.max(w, h) / 48));
  const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
  const maps = channels.map(() => new Float32Array(gw * gh));
  const hist = new Uint32Array(256);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x0 = gx * cell, y0 = gy * cell, x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
    channels.forEach((ch, ci) => {
      hist.fill(0); let cnt = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const i = (y * w + x) * 4;
        const v = ch === 'l' ? (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8 : data[i + ch];
        hist[v]++; cnt++;
      }
      // 92nd percentile ≈ paper, ignoring dark ink
      let target = cnt * 0.92, acc = 0, v = 255;
      for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc >= target) { v = k; break; } }
      maps[ci][gy * gw + gx] = Math.max(v, 24);
    });
  }
  const blurred = maps.map((m) => boxBlur1(boxBlur1(m, gw, gh, 1), gw, gh, 1));
  return { maps: blurred, gw, gh, cell };
}
function sampler(ill) {
  const { gw, gh, cell } = ill;
  return (m, x, y) => {
    let gx = x / cell - 0.5, gy = y / cell - 0.5;
    if (gx < 0) gx = 0; if (gy < 0) gy = 0; if (gx > gw - 1) gx = gw - 1; if (gy > gh - 1) gy = gh - 1;
    const x0 = gx | 0, y0 = gy | 0, x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1), fx = gx - x0, fy = gy - y0;
    return (m[y0 * gw + x0] * (1 - fx) + m[y0 * gw + x1] * fx) * (1 - fy) + (m[y1 * gw + x0] * (1 - fx) + m[y1 * gw + x1] * fx) * fy;
  };
}

function autoLevels(img, clip = 0.01) {
  const { data } = img; const n = data.length / 4;
  const lo = [], hi = [];
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    for (let i = c; i < data.length; i += 16) hist[data[i]]++;
    const tot = n / 4; let acc = 0, a = 0, b = 255;
    for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc > tot * clip) { a = k; break; } }
    acc = 0; for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc > tot * clip) { b = k; break; } }
    lo.push(a); hi.push(Math.max(a + 30, b));
  }
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = clamp255(((data[i + c] - lo[c]) * 255) / (hi[c] - lo[c]));
}

function saturate(r, g, b, k) {
  const l = r * 0.299 + g * 0.587 + b * 0.114;
  return [l + (r - l) * k, l + (g - l) * k, l + (b - l) * k];
}

export const FILTERS = ['original', 'magic', 'enhance', 'lighten', 'gray', 'bw'];

export function applyFilter(src, filter, adjust = { brightness: 0, contrast: 0 }) {
  const img = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data) };
  const { width: w, height: h, data } = img;

  if (filter === 'enhance') {
    autoLevels(img, 0.01);
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = saturate(data[i], data[i + 1], data[i + 2], 1.15);
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  } else if (filter === 'magic' || filter === 'lighten') {
    const ill = illumination(img, [0, 1, 2]); const S = sampler(ill);
    const magic = filter === 'magic';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = (data[i] / S(ill.maps[0], x, y)) * 255;
      let g = (data[i + 1] / S(ill.maps[1], x, y)) * 255;
      let b = (data[i + 2] / S(ill.maps[2], x, y)) * 255;
      if (magic) {
        // push paper to white, deepen ink, keep colour stamps and signatures vivid
        [r, g, b] = saturate(r, g, b, 1.35);
        r = 255 - (255 - r) * 1.35; g = 255 - (255 - g) * 1.35; b = 255 - (255 - b) * 1.35;
        r = 255 * Math.pow(clamp255(r) / 255, 1.25); g = 255 * Math.pow(clamp255(g) / 255, 1.25); b = 255 * Math.pow(clamp255(b) / 255, 1.25);
      } else {
        r = 255 - (255 - r) * 1.05; g = 255 - (255 - g) * 1.05; b = 255 - (255 - b) * 1.05;
      }
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  } else if (filter === 'gray' || filter === 'bw') {
    const ill = illumination(img, ['l']); const S = sampler(ill);
    const bw = filter === 'bw';
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      let v = (l / S(ill.maps[0], x, y)) * 255;
      if (bw) {
        // soft threshold keeps stroke edges smooth instead of jagged
        v = (v - 185) * 6 + 128;
      } else {
        v = 255 - (255 - v) * 1.2;
        v = 255 * Math.pow(clamp255(v) / 255, 1.15);
      }
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  }

  const br = (adjust.brightness || 0) * 1.6; // -100..100 -> ±160 range scaled
  const ct = adjust.contrast || 0;
  if (br || ct) {
    const f = (259 * (ct * 1.28 + 255)) / (255 * (259 - ct * 1.28));
    for (let i = 0; i < data.length; i += 4) {
      data[i] = f * (data[i] - 128) + 128 + br * 0.5;
      data[i + 1] = f * (data[i + 1] - 128) + 128 + br * 0.5;
      data[i + 2] = f * (data[i + 2] - 128) + 128 + br * 0.5;
    }
  }
  return img;
}
