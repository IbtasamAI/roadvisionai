/* RoadVision core: homography, tracker, speed estimator, simulator.
   Pure math, no DOM. Works in browser (window.RVCore) and Node (module.exports).
   All image coordinates are NORMALISED (0..1 of the frame). Ground coordinates are metres. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RVCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- linear algebra ---------- */
  function gauss(A, b) {
    const n = b.length;
    const M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-12) return null;
      if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = M[i][n];
      for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k];
      x[i] = s / M[i][i];
    }
    return x;
  }

  /** Homography mapping 4 src points to 4 dst points. Returns 9-array (row-major) or null. */
  function solveHomography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    const h = gauss(A, b);
    return h ? h.concat([1]) : null;
  }

  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-14) return null;
    const k = 1 / det;
    return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
            B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
            C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
  }

  function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    if (Math.abs(w) < 1e-9) return null;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  /** Calibration: quad points in normalised image coords order BL, BR, TR, TL; ground W (m, across) x D (m, along). */
  function makeCalibration(quad, W, D) {
    const ground = [[0, 0], [W, 0], [W, D], [0, D]];
    const H = solveHomography(quad, ground);
    if (!H) return null;
    const Hinv = invert3(H);
    if (!Hinv) return null;
    return { quad, W, D, H, Hinv };
  }

  /** Quality check of a quad: convex, sensible orientation, perspective not degenerate. */
  function quadQuality(quad) {
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const [bl, br, tr, tl] = quad;
    const s = [cross(bl, br, tr), cross(br, tr, tl), cross(tr, tl, bl), cross(tl, bl, br)];
    const convex = s.every(v => v > 0) || s.every(v => v < 0);
    if (!convex) return { ok: false, msg: 'Corners are crossed – drag them so BL, BR, TR, TL go round the road patch.' };
    const area = Math.abs(cross(bl, br, tr) + cross(bl, tr, tl)) / 2;
    if (area < 0.03) return { ok: false, msg: 'Zone is too small – make it cover more of the road.' };
    const nearW = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
    const farW = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    if (farW > nearW * 1.15) return { ok: false, msg: 'Far edge wider than near edge – check corner order.' };
    return { ok: true, msg: '', area, ratio: farW / nearW };
  }

  /* ---------- tracker ---------- */
  function iou(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    const iw = Math.max(0, x2 - x1), ih = Math.max(0, y2 - y1);
    const inter = iw * ih;
    return inter / (a.w * a.h + b.w * b.h - inter + 1e-9);
  }

  const DIRS = ['away', 'away-right', 'right', 'toward-right', 'toward', 'toward-left', 'left', 'away-left'];
  const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  /** direction filter: all | toward | away | right | left  (sector based, includes the diagonals on each side) */
  function dirAllowed(est, mode) {
    if (!est || !mode || mode === 'all') return true;
    const a = est.ang;
    if (mode === 'away') return a <= 67.5 || a >= 292.5;
    if (mode === 'toward') return a >= 112.5 && a <= 247.5;
    if (mode === 'right') return a > 22.5 && a < 157.5;
    if (mode === 'left') return a > 202.5 && a < 337.5;
    return true;
  }

  const DEFAULTS = {
    iouMin: 0.12, maxAge: 0.7, minHits: 3, minScore: 0.35,
    window: 1.5, minSamples: 6, minSpan: 0.45,
    smooth: 0.35, calUnc: 0.04, maxSpeedKmh: 320,
    zoneMarginX: 0.25, zoneMarginYNear: 0.15, zoneMarginYFar: 0.2
  };

  class Tracker {
    constructor(opts) {
      this.o = Object.assign({}, DEFAULTS, opts || {});
      this.tracks = [];
      this.nextId = 1;
      this.cal = null;
      this.factor = 1;
    }
    setCalibration(cal) { this.cal = cal; for (const t of this.tracks) { t.samples.length = 0; t.speed = null; } }
    setFactor(f) { this.factor = f; }
    reset() { this.tracks = []; }

    /** dets: [{x,y,w,h,cls,score}] normalised, top-left origin. Returns {active, ended}. */
    update(dets, t, opts) {
      const o = this.o, sampleOK = !opts || opts.sample !== false;
      const tracks = this.tracks;
      for (const tr of tracks) {
        const dt = Math.max(0, t - tr.t);
        tr.pred = { x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt, w: tr.w, h: tr.h };
      }
      const pairs = [];
      for (let i = 0; i < tracks.length; i++) for (let j = 0; j < dets.length; j++) {
        const v = iou(tracks[i].pred, dets[j]);
        if (v >= o.iouMin) pairs.push([v, i, j]);
      }
      pairs.sort((a, b) => b[0] - a[0]);
      const usedT = new Set(), usedD = new Set();
      const match = (i, j) => { usedT.add(i); usedD.add(j); this._apply(tracks[i], dets[j], t, sampleOK); };
      for (const [, i, j] of pairs) if (!usedT.has(i) && !usedD.has(j)) match(i, j);
      // fallback: centre distance for fast movers where boxes no longer overlap
      for (let i = 0; i < tracks.length; i++) {
        if (usedT.has(i)) continue;
        const tr = tracks[i], pc = [tr.pred.x + tr.w / 2, tr.pred.y + tr.h / 2];
        const lim = 0.6 * Math.max(tr.w, tr.h);
        let best = -1, bd = lim;
        for (let j = 0; j < dets.length; j++) {
          if (usedD.has(j) || dets[j].cls !== tr.cls) continue;
          const d = Math.hypot(pc[0] - (dets[j].x + dets[j].w / 2), pc[1] - (dets[j].y + dets[j].h / 2));
          if (d < bd) { bd = d; best = j; }
        }
        if (best >= 0) match(i, best);
      }
      for (let j = 0; j < dets.length; j++) {
        if (usedD.has(j) || dets[j].score < o.minScore) continue;
        const d = dets[j];
        const tr = { id: this.nextId++, x: d.x, y: d.y, w: d.w, h: d.h, cls: d.cls, score: d.score,
          vx: 0, vy: 0, t, born: t, hits: 1, samples: [], speed: null, maxSpeed: 0, est: null,
          logged: false, peakConf: 0, sim: !!d.sim, simId: d.simId, truth: d.truth, lastDet: { x: d.x, y: d.y, w: d.w, h: d.h, t } };
        tracks.push(tr);
        this._sample(tr, t, sampleOK);
      }
      const ended = [], keep = [];
      for (const tr of tracks) {
        if (t - tr.t > o.maxAge) ended.push(tr); else keep.push(tr);
      }
      this.tracks = keep;
      return { active: keep.filter(tr => tr.hits >= o.minHits), ended: ended.filter(tr => tr.hits >= o.minHits) };
    }

    _apply(tr, d, t, sampleOK) {
      const dt = t - tr.t;
      const a = 0.65;
      const nx = tr.x + (d.x - tr.x) * a, ny = tr.y + (d.y - tr.y) * a;
      if (dt > 0.005) {
        const vx = ((d.x + d.w / 2) - (tr.x + tr.w / 2)) / dt, vy = ((d.y + d.h / 2) - (tr.y + tr.h / 2)) / dt;
        tr.vx = tr.vx * 0.5 + vx * 0.5; tr.vy = tr.vy * 0.5 + vy * 0.5;
      }
      tr.x = nx; tr.y = ny; tr.w += (d.w - tr.w) * a; tr.h += (d.h - tr.h) * a;
      tr.score = tr.score * 0.7 + d.score * 0.3;
      if (d.score > tr.score) tr.cls = d.cls;
      tr.t = t; tr.hits++;
      tr.lastDet = { x: d.x, y: d.y, w: d.w, h: d.h, t };
      if (d.sim) tr.sim = true;
      this._sample(tr, t, sampleOK);
    }

    _sample(tr, t, sampleOK) {
      const cal = this.cal, o = this.o;
      if (!cal) return;
      if (!sampleOK) { tr.gap = true; return; }
      // use the raw (unsmoothed) detection foot point for ground contact
      const ld = tr.lastDet;
      const g = applyH(cal.H, ld.x + ld.w / 2, ld.y + ld.h);
      if (!g) return;
      const [X, Y] = g;
      tr.ground = g;
      const inZone = X >= -o.zoneMarginX * cal.W && X <= (1 + o.zoneMarginX) * cal.W &&
                     Y >= -o.zoneMarginYNear * cal.D && Y <= (1 + o.zoneMarginYFar) * cal.D;
      tr.inZone = inZone;
      if (!inZone) return;
      tr.samples.push({ t, X, Y });
      while (tr.samples.length && t - tr.samples[0].t > o.window) tr.samples.shift();
      this._estimate(tr, t);
    }

    _estimate(tr, t) {
      const o = this.o, s = tr.samples, n = s.length;
      if (n < o.minSamples) { tr.est = null; return; }
      const span = s[n - 1].t - s[0].t;
      if (span < o.minSpan) { tr.est = null; return; }
      let tm = 0, xm = 0, ym = 0;
      for (const p of s) { tm += p.t; xm += p.X; ym += p.Y; }
      tm /= n; xm /= n; ym /= n;
      let sxx = 0, sxy_x = 0, sxy_y = 0;
      for (const p of s) { const dt = p.t - tm; sxx += dt * dt; sxy_x += dt * (p.X - xm); sxy_y += dt * (p.Y - ym); }
      if (sxx < 1e-9) { tr.est = null; return; }
      const bx = sxy_x / sxx, by = sxy_y / sxx;
      let rx = 0, ry = 0;
      for (const p of s) {
        const dt = p.t - tm;
        rx += Math.pow(p.X - (xm + bx * dt), 2); ry += Math.pow(p.Y - (ym + by * dt), 2);
      }
      const dof = Math.max(1, n - 2);
      const sx = Math.sqrt(rx / dof), sy = Math.sqrt(ry / dof);
      const rms = Math.sqrt((rx + ry) / n);
      const v = Math.hypot(bx, by);
      if (v * 3.6 > o.maxSpeedKmh) { tr.est = null; return; }
      const sbx = sx / Math.sqrt(sxx), sby = sy / Math.sqrt(sxx);
      const sv = v > 0.05 ? Math.sqrt(Math.pow(bx * sbx, 2) + Math.pow(by * sby, 2)) / v : Math.hypot(sbx, sby);
      const f = this.factor;
      const kmh = v * 3.6 * f;
      const margin = (1.96 * sv * 3.6 + v * 3.6 * o.calUnc) * f;
      const conf = Math.max(0, Math.min(1,
        0.4 * Math.min(1, n / 14) + 0.25 * Math.exp(-rms / 0.45) + 0.15 * Math.min(1, tr.score / 0.8) + 0.2 * Math.min(1, span / 1.0)));
      const ang = (Math.atan2(bx, by) * 180 / Math.PI + 360) % 360;      // 0 = away, 90 = to the right, 180 = toward camera, 270 = to the left
      const sec = Math.round(ang / 45) % 8;
      tr.est = { kmh, margin, conf, n, span, rms, ang, sec, dir: DIRS[sec], arrow: ARROWS[sec], lateral: bx };
      tr.speed = tr.speed == null ? kmh : tr.speed + o.smooth * (kmh - tr.speed);
      if (conf >= tr.peakConf - 0.001 || kmh > tr.maxSpeed) {
        tr.peakConf = Math.max(tr.peakConf, conf);
      }
      if (conf >= 0.45) {
        (tr.hist || (tr.hist = [])).push(kmh);
        if (tr.hist.length > 80) tr.hist.shift();
        const h = tr.hist.slice().sort((a, b) => a - b);
        tr.rep = h[h.length >> 1];            // median of confident estimates = reported speed
        tr.repN = h.length;
        tr.maxSpeed = tr.rep;
      }
    }
  }

  /* ---------- simulator (drives the real tracker with synthetic detections) ---------- */
  const SIM_CLASSES = [
    { cls: 'car', w: 1.85, h: 1.45, p: 0.7 }, { cls: 'car', w: 1.95, h: 1.8, p: 0.12 },
    { cls: 'truck', w: 2.4, h: 3.0, p: 0.1 }, { cls: 'bus', w: 2.5, h: 3.2, p: 0.04 }, { cls: 'motorcycle', w: 0.8, h: 1.4, p: 0.04 }
  ];

  class Sim {
    constructor(cal, opts) {
      this.cal = cal; this.o = Object.assign({ limit: 100, noisePx: 1.4, frameW: 1280, frameH: 720, rate: 1.1, seed: 7 }, opts || {});
      this.cars = []; this.t = 0; this.nextSpawn = 0; this.rs = this.o.seed;
    }
    rnd() { this.rs = (this.rs * 1664525 + 1013904223) >>> 0; return this.rs / 4294967296; }
    gauss() { return Math.sqrt(-2 * Math.log(this.rnd() + 1e-12)) * Math.cos(2 * Math.PI * this.rnd()); }
    spawn() {
      const lim = this.o.limit;
      const over = this.rnd() < 0.3;
      const kmh = over ? lim + 8 + this.rnd() * 55 : Math.max(30, lim * (0.55 + this.rnd() * 0.4));
      let r = this.rnd(), c = SIM_CLASSES[0], a = 0;
      for (const k of SIM_CLASSES) { a += k.p; if (r <= a) { c = k; break; } }
      const lanes = 3, lane = Math.floor(this.rnd() * lanes);
      const X = (lane + 0.5) * this.cal.W / lanes;
      const toward = this.rnd() < 0.5;
      this.cars.push({ kmh, ms: kmh / 3.6, X, Y: toward ? this.cal.D * 1.15 : -this.cal.D * 0.05, dir: toward ? -1 : 1, c, id: this.cars.length });
    }
    /** advance dt seconds; returns detections (normalised) for this instant */
    step(dt) {
      this.t += dt;
      this.nextSpawn -= dt;
      if (this.nextSpawn <= 0) { this.spawn(); this.nextSpawn = (0.8 + this.rnd() * 2.2) / this.o.rate; }
      const dets = [], cal = this.cal, nx = this.o.noisePx / this.o.frameW, ny = this.o.noisePx / this.o.frameH;
      this.cars = this.cars.filter(c => {
        c.Y += c.dir * c.ms * dt;
        return c.Y > -cal.D * 0.2 && c.Y < cal.D * 1.35;
      });
      for (const c of this.cars) {
        const foot = applyH(cal.Hinv, c.X, c.Y);
        if (!foot) continue;
        const l = applyH(cal.Hinv, c.X - c.c.w / 2, c.Y), r = applyH(cal.Hinv, c.X + c.c.w / 2, c.Y);
        if (!l || !r) continue;
        const pw = Math.abs(r[0] - l[0]);
        const ph = pw * (c.c.h / c.c.w) * (this.o.frameW / this.o.frameH);
        if (pw < 0.012 || foot[1] > 1.1 || foot[1] < 0.1 || foot[0] < -0.2 || foot[0] > 1.2) continue;
        dets.push({ x: foot[0] - pw / 2 + this.gauss() * nx, y: foot[1] - ph + this.gauss() * ny,
          w: pw, h: ph, cls: c.c.cls, score: 0.72 + this.rnd() * 0.25, sim: true, truth: c.kmh, simId: c.id });
      }
      return dets;
    }
  }

  /* ---------- helpers ---------- */
  function kmhTo(v, unit) { return unit === 'mph' ? v * 0.621371 : v; }

  /** Great-circle distance in metres. */
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  return { dirAllowed, DIRS, ARROWS, solveHomography, invert3, applyH, makeCalibration, quadQuality, Tracker, Sim, iou, kmhTo, haversine, DEFAULTS };
});
