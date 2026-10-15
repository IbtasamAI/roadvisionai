/* RoadVision AI – main application */
(function () {
  'use strict';
  const C = window.RVCore, D = window.RVData, SN = window.RVSensors;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DEFAULT_QUAD = [[0.12, 0.93], [0.88, 0.93], [0.60, 0.46], [0.40, 0.46]];

  /* =========================================================
     Settings
     ========================================================= */
  const DEF = {
    unit: 'kmh', factor: 1, tol: 3, minConf: 60, grid: true, audio: true, vib: true, wake: true, guard: true,
    autoRoad: true, geo: true, model: 'local', roi: true, dirMode: 'all', detRes: 640, camRes: 1080, fps: 60,
    tariff: Object.assign({}, D.DEFAULT_TARIFF), road: 'sixth_ring', limit: 120, theme: 'dark', cameraId: '',
    cal: { quad: DEFAULT_QUAD, W: 11, D: 40, userSet: false, pitch: null, heading: null },
    op: { name: '', terminal: '' }
  };
  let S;
  try { S = Object.assign({}, DEF, JSON.parse(localStorage.getItem('rv.settings') || '{}')); } catch (e) { S = Object.assign({}, DEF); }
  if (S.model !== 'local' && S.model !== 'lite') S.model = 'local';
  S.tariff = Object.assign({}, DEF.tariff, S.tariff); S.cal = Object.assign({}, DEF.cal, S.cal); S.op = Object.assign({}, DEF.op, S.op);
  const save = () => { try { localStorage.setItem('rv.settings', JSON.stringify(S)); } catch (e) { /* storage unavailable */ } };
  const fmtSpeed = (kmh) => kmh == null ? '--' : String(Math.round(S.unit === 'mph' ? kmh * 0.621371 : kmh));
  const unitLbl = () => S.unit === 'mph' ? 'mph' : 'km/h';

  /* =========================================================
     Event storage (IndexedDB with in-memory fallback)
     ========================================================= */
  const DB = {
    db: null,
    open() {
      return new Promise((res) => {
        try {
          const r = indexedDB.open('roadvision', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('ev', { keyPath: 'id' });
          r.onsuccess = () => { DB.db = r.result; res(); };
          r.onerror = () => res();
        } catch (e) { res(); }
      });
    },
    store(mode) { return DB.db.transaction('ev', mode).objectStore('ev'); },
    all() { return new Promise(res => { if (!DB.db) return res([]); const q = DB.store('readonly').getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => res([]); }); },
    put(rec) { if (DB.db) try { DB.store('readwrite').put(rec); } catch (e) { /* ignore */ } },
    del(id) { if (DB.db) try { DB.store('readwrite').delete(id); } catch (e) { /* ignore */ } },
    clear() { if (DB.db) try { DB.store('readwrite').clear(); } catch (e) { /* ignore */ } }
  };
  let events = [];                                         // newest first
  const MAX_PASSAGES = 3000;

  /* =========================================================
     Runtime state
     ========================================================= */
  const R = {
    src: null,                                             // 'cam' | 'file' | 'sim' | null
    stream: null, track: null, torch: false,
    tracker: new C.Tracker(), cal: null, sim: null, simT: 0, simLast: 0, simDets: [], simTimer: null,
    selected: null, calMode: false, drag: -1, vw: 1280, vh: 720,
    session: Date.now(), alertTimer: 0, lastAlertT: 0,
    fps: 0, detHz: 0, lastDetAt: 0, modelState: 'idle', backend: '', frameId: 0, lastSend: 0,
    calMoved: false, issue: '', lastRoadAuto: 0, manualRoadAt: 0
  };
  window.__rv = { S, R, C, D, SN, get events() { return events; } };

  /* =========================================================
     Calibration helpers
     ========================================================= */
  function rebuildCal() {
    const c = S.cal, q = C.quadQuality(c.quad);
    if (!q.ok) return q;
    const cal = C.makeCalibration(c.quad, +c.W, +c.D);
    if (!cal) return { ok: false, msg: 'Zone cannot be solved – adjust corners.' };
    R.cal = cal; R.tracker.setCalibration(cal); R.tracker.setFactor(S.factor);
    if (R.sim) R.sim.cal = cal;
    return q;
  }

  /* =========================================================
     Detector (worker, with main-thread fallback)
     ========================================================= */
  const Det = {
    worker: null, ready: false, busy: false, main: null, mode: 'worker', scratch: document.createElement('canvas'), initFor: null, roi: null, triedMain: false, lastErr: '',
    async init() {
      if (Det.initFor === S.model && (Det.ready || R.modelState === 'loading')) return;
      Det.dispose(); Det.initFor = S.model; R.modelState = 'loading'; R.modelMsg = ''; setModelChip();
      try {
        const w = new Worker('./js/worker.js');
        Det.worker = w; Det.mode = 'worker';
        w.onmessage = (e) => Det.onMsg(e.data);
        w.onerror = (e) => Det.fallback('Worker failed: ' + (e && e.message || ''));
        w.postMessage({ type: 'init', model: S.model });
      } catch (e) { Det.fallback(String(e)); }
    },
    onMsg(m) {
      if (m.type === 'status') { R.modelMsg = m.msg; setModelChip(); }
      else if (m.type === 'ready') {
        R.backend = m.backend;
        if (m.backend === 'cpu' && !Det.triedMain) {
          Det.triedMain = true;
          let gl = false; try { const c = document.createElement('canvas'); gl = !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { /* none */ }
          if (gl) { Det.fallback('Worker has no GPU backend'); return; }       // main thread can use the GPU; keep the worker only when it cannot
        }
        Det.ready = true; R.modelState = 'ready'; setModelChip();
      } else if (m.type === 'error') Det.fallback(m.msg);
      else if (m.type === 'result') Det.onResult(m);
    },
    fallback(why) {                                            // single-flight: concurrent triggers share one attempt
      if (Det.fbP) return Det.fbP;
      Det.fbP = Det._fallback(why).finally(() => { Det.fbP = null; });
      return Det.fbP;
    },
    loadScript(src) {
      return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src)); document.head.appendChild(s); });
    },
    async ensureTf() {
      const ok = () => window.tf && typeof window.tf.setBackend === 'function' && typeof window.tf.loadGraphModel === 'function';
      if (!('regeneratorRuntime' in window)) window.regeneratorRuntime = undefined;   // see worker.js: avoids TF.js's CSP-blocked eval fallback
      if (!ok()) { try { delete window.tf; } catch (e) { window.tf = undefined; } await Det.loadScript('./vendor/tf/tf.min.js?v=' + Date.now()); }
      if (!ok()) throw new Error('TensorFlow.js did not initialise (' + (window.tf ? 'keys=' + Object.keys(window.tf).length : 'missing') + ')');
      if (!(window.cocoSsd && typeof window.cocoSsd.load === 'function')) { try { delete window.cocoSsd; } catch (e) { window.cocoSsd = undefined; } await Det.loadScript('./vendor/tf/coco-ssd.min.js?v=' + Date.now()); }
      if (!(window.cocoSsd && typeof window.cocoSsd.load === 'function')) throw new Error('COCO-SSD did not initialise');
    },
    async _fallback(why) {
      console.warn('Detector fallback:', why); Det.workerErr = String(why).slice(0, 140);
      if (Det.worker) { Det.worker.terminate(); Det.worker = null; }
      Det.mode = 'main'; R.modelState = 'loading'; R.modelMsg = 'Loading on main thread…'; setModelChip();
      try {
        await Det.ensureTf();
        for (const b of ['webgl', 'cpu']) { try { if (await tf.setBackend(b)) break; } catch (e) { /* next */ } }
        if (typeof tf.ready === 'function') await tf.ready();
        const order = S.model === 'lite' ? ['lite', 'local'] : ['local', 'lite'], errs = [];
        let model = null;
        for (const k of order) {
          try {
            model = k === 'local' ? await cocoSsd.load({ base: 'mobilenet_v2', modelUrl: './models/coco/model.json' }) : await cocoSsd.load({ base: 'lite_mobilenet_v2' });
            break;
          } catch (e) { errs.push(k + ': ' + (e && e.message || e)); }
        }
        if (!model) throw new Error(errs.join(' | '));
        Det.main = model; Det.ready = true; R.backend = tf.getBackend(); R.modelState = 'ready'; setModelChip();
      } catch (e) {
        Det.lastErr = (String(e && e.message || e) + ' [worker: ' + (Det.workerErr || 'n/a') + ']').slice(0, 300); console.error('Model load failed:', Det.lastErr);
        R.modelState = 'error'; setModelChip();
        toast('Detection model failed: ' + Det.lastErr + ' — tap the red MODEL chip to retry, or use Simulation.', 'bad', 12000);
      }
    },
    dispose() { if (Det.worker) Det.worker.terminate(); Det.worker = null; Det.main = null; Det.ready = false; Det.busy = false; Det.triedMain = false; },
    /** region of interest (normalised) around the calibrated zone: vehicles there get far more pixels than a full-frame 300 px SSD input */
    computeRoi() {
      if (!S.roi || !S.cal.userSet || R.src === 'file' && false) return { x: 0, y: 0, w: 1, h: 1 };
      const q = S.cal.quad; let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
      for (const p of q) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      const mx = Math.max(0.08, (x1 - x0) * 0.25), my = Math.max(0.1, (y1 - y0) * 0.35);       // room for vehicles entering the zone
      x0 = clamp(x0 - mx, 0, 1); x1 = clamp(x1 + mx, 0, 1); y0 = clamp(y0 - my, 0, 1); y1 = clamp(y1 + my, 0, 1);
      let w = x1 - x0, h = y1 - y0;
      if (w < 0.45) { const c = (x0 + x1) / 2; x0 = clamp(c - 0.225, 0, 0.55); w = 0.45; }
      if (h < 0.45) { const c = (y0 + y1) / 2; y0 = clamp(c - 0.225, 0, 0.55); h = 0.45; }
      return { x: x0, y: y0, w: Math.min(w, 1 - x0), h: Math.min(h, 1 - y0) };
    },
    /** grab a (cropped, downscaled) frame and run detection; one in flight at a time */
    send(video, t) {
      if (!Det.ready || Det.busy) return;
      const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return;
      const roi = Det.computeRoi(); Det.roi = roi;
      const sx = roi.x * vw, sy = roi.y * vh, sw = roi.w * vw, sh = roi.h * vh;
      const sc = Math.min(1, S.detRes / sw), w = Math.max(32, Math.round(sw * sc)), h = Math.max(32, Math.round(sh * sc));
      const cv = Det.scratch; if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const ctx = cv.getContext('2d', { alpha: false });
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      Det.busy = true; const id = ++R.frameId;
      if (Det.mode === 'worker' && Det.worker) {
        createImageBitmap(cv).then(bm => Det.worker && Det.worker.postMessage({ type: 'detect', id, t, bitmap: bm, minScore: 0.3 }, [bm]))
          .catch(() => { Det.busy = false; });
      } else if (Det.main) {
        const t0 = performance.now();
        Det.main.detect(cv, 25, 0.3).then(preds => {
          const dets = [];
          for (const p of preds) { if (!['car', 'truck', 'bus', 'motorcycle'].includes(p.class)) continue; const [x, y, bw, bh] = p.bbox; dets.push({ x: x / w, y: y / h, w: bw / w, h: bh / h, cls: p.class, score: p.score }); }
          Det.onResult({ t, dets, ms: performance.now() - t0 });
        }).catch(() => { Det.busy = false; });
      } else Det.busy = false;
    },
    onResult(m) {
      Det.busy = false;
      const now = performance.now();
      if (R.lastDetAt) { const hz = 1000 / (now - R.lastDetAt); R.detHz = R.detHz ? R.detHz * 0.8 + hz * 0.2 : hz; }
      R.lastDetAt = now;
      if (m.skipped || !R.src || R.src === 'sim') return;
      const r = Det.roi || { x: 0, y: 0, w: 1, h: 1 };
      const dets = (m.dets || []).map(d => ({ x: r.x + d.x * r.w, y: r.y + d.y * r.h, w: d.w * r.w, h: d.h * r.h, cls: d.cls, score: d.score }));
      onDetections(dets, m.t);
    }
  };

  window.__rv.Det = Det;

  /* =========================================================
     Detection → tracker → violations
     ========================================================= */
  function guardState() {
    let issue = '';
    if (R.src !== 'sim') {
      if (!S.cal.userSet) issue = 'CALIBRATE FIRST';
      else if (R.calMoved) issue = 'CAMERA MOVED';
      else if (S.guard && SN.phoneMoving()) issue = 'PHONE MOVING';
      else if (S.guard && SN.state.motion.state === 'on' && !SN.state.motion.stable) issue = 'HOLD STEADY';
    }
    return issue;
  }
  function onDetections(dets, t) {
    const issue = guardState(); R.issue = issue;
    const sampleOK = !(issue === 'PHONE MOVING' || issue === 'HOLD STEADY' || issue === 'CAMERA MOVED');
    const res = R.tracker.update(dets, t, { sample: sampleOK });
    for (const tr of res.ended) finalizeTrack(tr);
    if (issue) return;
    const lim = S.limit, tol = S.tol, minConf = S.minConf / 100;
    for (const tr of res.active) {
      if (tr.logged || !tr.est || tr.rep == null || tr.repN < 4) continue;
      if (tr.rep > lim + tol && tr.est.conf >= minConf && C.dirAllowed(tr.est, S.dirMode)) logEvent(tr, true);
    }
  }

  function currentLocation() {
    const g = SN.state.gps, r = D.ROADS[S.road];
    const road = S.road !== 'custom' ? r.name : (g.state === 'on' ? `GPS ${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}` : r.name);
    return { road, lat: S.geo && g.state === 'on' ? g.lat : null, lng: S.geo && g.state === 'on' ? g.lng : null, acc: g.acc, heading: SN.state.orient.heading };
  }

  function grabThumb(tr) {
    try {
      if (R.src === 'sim' || !cam.videoWidth) return null;
      const vw = cam.videoWidth, vh = cam.videoHeight, ld = tr.lastDet || tr;
      const pad = 0.25, bw = ld.w * (1 + pad), bh = ld.h * (1 + pad);
      let sx = (ld.x + ld.w / 2 - bw / 2) * vw, sy = (ld.y + ld.h / 2 - bh / 2) * vh, sw = bw * vw, sh = bh * vh;
      const ar = 3 / 2; if (sw / sh < ar) { const nw = sh * ar; sx -= (nw - sw) / 2; sw = nw; } else { const nh = sw / ar; sy -= (nh - sh) / 2; sh = nh; }
      sx = clamp(sx, 0, vw - 2); sy = clamp(sy, 0, vh - 2); sw = Math.min(sw, vw - sx); sh = Math.min(sh, vh - sy);
      const cv = document.createElement('canvas'); cv.width = 240; cv.height = 160;
      cv.getContext('2d').drawImage(cam, sx, sy, sw, sh, 0, 0, 240, 160);
      return cv.toDataURL('image/jpeg', 0.62);
    } catch (e) { return null; }
  }

  function makeRecord(tr, violation) {
    const loc = currentLocation(), est = tr.est || {}, speed = tr.rep != null ? tr.rep : (tr.speed || 0);
    const excess = Math.max(0, speed - S.limit);
    return {
      id: 'E' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5).toUpperCase(), ts: Date.now(),
      violation, sim: !!tr.sim || R.src === 'sim', source: R.src, cls: tr.cls,
      speed, margin: est.margin || 0, conf: est.conf || tr.peakConf || 0, dir: est.dir || '', arrow: est.arrow || '', n: est.n || 0,
      limit: S.limit, excess, fine: violation ? D.fineFor(excess - S.tol > 0 ? excess : excess, S.tariff) : 0,
      road: loc.road, roadKey: S.road, lat: loc.lat, lng: loc.lng, gacc: loc.acc, az: loc.heading,
      cal: { W: S.cal.W, D: S.cal.D, factor: S.factor, tol: S.tol },
      plate: { code: '', num: '' }, vehicle: null, color: '', notes: '', thumb: violation ? grabThumb(tr) : null
    };
  }
  function logEvent(tr, violation) {
    const rec = makeRecord(tr, violation); tr.logged = true; tr.rec = rec;
    events.unshift(rec); DB.put(rec); onEventsChanged(true);
    if (violation) fireAlert(rec);
  }
  function finalizeTrack(tr) {
    if (tr.rep == null || tr.peakConf < 0.45) return;
    if (tr.rec) {                                          // update the logged event with the final median
      const rec = tr.rec; rec.speed = tr.rep; rec.excess = Math.max(0, tr.rep - rec.limit);
      rec.margin = tr.est ? tr.est.margin : rec.margin;
      if (!(rec.speed > rec.limit + rec.cal.tol)) { rec.violation = false; rec.fine = 0; rec.thumb = null; }
      else rec.fine = D.fineFor(rec.excess, S.tariff);
      DB.put(rec); onEventsChanged(false);
    } else if (!R.issue) {
      const over = tr.rep > S.limit + S.tol && tr.est && tr.est.conf >= S.minConf / 100 && C.dirAllowed(tr.est, S.dirMode);
      logEvent(tr, !!over);
      if (!over) { tr.rec.thumb = null; DB.put(tr.rec); }
      if (over) fireAlert(tr.rec);
    }
    pruneEvents();
  }
  function pruneEvents() {
    const passages = events.filter(e => !e.violation);
    if (passages.length > MAX_PASSAGES) {
      const drop = passages.slice(MAX_PASSAGES);
      for (const d of drop) { DB.del(d.id); }
      const ids = new Set(drop.map(d => d.id)); events = events.filter(e => !ids.has(e.id));
    }
  }

  /* ---------- alerts ---------- */
  let audioCtx = null;
  function chime() {
    if (!S.audio) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain(), t = audioCtx.currentTime;
      o.type = 'sine'; o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1320, t + 0.15);
      g.gain.setValueAtTime(0.3, t); g.gain.exponentialRampToValueAtTime(0.01, t + 0.35);
      o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(t + 0.35);
    } catch (e) { /* audio blocked */ }
  }
  function fireAlert(rec) {
    if (!rec.violation) return;
    const now = performance.now(); if (now - R.lastAlertT < 700) return; R.lastAlertT = now;
    chime(); if (S.vib) SN.vibrate([120, 60, 120]);
    $('alSpeed').textContent = fmtSpeed(rec.speed);
    $('alTitle').textContent = `OVER LIMIT +${fmtSpeed(rec.excess)} ${unitLbl()}` + (rec.sim ? ' · SIMULATED' : '');
    $('alMeta').textContent = `${rec.cls} · limit ${fmtSpeed(rec.limit)} · ±${fmtSpeed(rec.margin)} · conf ${Math.round(rec.conf * 100)}%`;
    const bar = $('alertBar'), st = $('stage');
    bar.classList.add('show'); st.classList.remove('alert'); void st.offsetWidth; st.classList.add('alert');
    clearTimeout(R.alertTimer); R.alertTimer = setTimeout(() => bar.classList.remove('show'), 3400);
  }

  /* =========================================================
     Sources: camera, video file, simulation
     ========================================================= */
  const cam = $('cam'), ov = $('ov'), g2 = ov.getContext('2d'), stage = $('stage');
  let rvfcId = 0, pollId = 0, lastMediaT = -1;

  function setStageAspect() {
    const w = R.src === 'sim' ? 1280 : cam.videoWidth, h = R.src === 'sim' ? 720 : cam.videoHeight;
    if (w && h) { R.vw = w; R.vh = h; stage.style.aspectRatio = `${w} / ${h}`; }
    resizeCanvas();
  }
  cam.addEventListener('loadedmetadata', setStageAspect);
  cam.addEventListener('resize', setStageAspect);

  function nowT() { return R.src === 'file' ? cam.currentTime : R.src === 'sim' ? R.simT + (performance.now() - R.simLast) / 1000 : performance.now() / 1000; }

  function armFrames() {
    cancelFrames();
    const onFrame = (now, meta) => {
      if (!R.src || R.src === 'sim') return;
      if (R.src === 'file' && cam.paused) return;
      const t = R.src === 'file' ? (meta && meta.mediaTime != null ? meta.mediaTime : cam.currentTime) : ((meta && (meta.captureTime || meta.expectedDisplayTime)) || now) / 1000;
      Det.send(cam, t);
    };
    if ('requestVideoFrameCallback' in cam) {
      const loop = (now, meta) => { onFrame(now, meta); rvfcId = cam.requestVideoFrameCallback(loop); };
      rvfcId = cam.requestVideoFrameCallback(loop);
    } else {
      const poll = () => { pollId = requestAnimationFrame(poll); if (cam.currentTime !== lastMediaT) { lastMediaT = cam.currentTime; onFrame(performance.now(), null); } };
      pollId = requestAnimationFrame(poll);
    }
  }
  function cancelFrames() {
    if (rvfcId && cam.cancelVideoFrameCallback) try { cam.cancelVideoFrameCallback(rvfcId); } catch (e) { /* ignore */ }
    if (pollId) cancelAnimationFrame(pollId); rvfcId = 0; pollId = 0;
  }

  function stopAll() {
    cancelFrames(); clearInterval(R.simTimer); R.simTimer = null;
    if (R.stream) { R.stream.getTracks().forEach(t => t.stop()); R.stream = null; R.track = null; }
    if (cam.src && cam.src.startsWith('blob:')) URL.revokeObjectURL(cam.src);
    cam.srcObject = null; cam.removeAttribute('src'); cam.controls = false; cam.load();
    R.src = null; R.sim = null; R.simDets = []; R.tracker.reset(); R.selected = null; R.torch = false; R.issue = '';
    SN.wake.release(); SN.stopGPS && 0;
    $('emptyPanel').classList.remove('hide'); $('btnStop').style.display = 'none'; $('btnTorch').style.display = 'none';
    $('camRow').classList.remove('show'); stage.style.aspectRatio = '';
    refreshHud(true); renderTargets(true);
  }
  function afterStart() {
    $('emptyPanel').classList.add('hide'); $('btnStop').style.display = ''; setStageAspect(); refreshHud(true);
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('Camera needs HTTPS and a supported browser.', 'bad', 5000); return; }
    stopAll();
    // Kick off every permission request synchronously inside the tap (iOS requires this for motion sensors).
    const motionP = SN.requestMotionPermissions();
    SN.startGPS();
    Det.init();
    if (S.wake) SN.wake.acquire();
    const res = +S.camRes, dims = res === 2160 ? [3840, 2160] : res === 720 ? [1280, 720] : [1920, 1080];
    const base = { width: { ideal: dims[0] }, height: { ideal: dims[1] }, frameRate: { ideal: res === 2160 ? 30 : 60, min: 24 } };
    const dev = $('camSel').value || S.cameraId;
    const cons = { audio: false, video: dev ? Object.assign({ deviceId: { exact: dev } }, base) : Object.assign({ facingMode: { ideal: 'environment' } }, base) };
    try {
      const [stream, perm] = await Promise.all([navigator.mediaDevices.getUserMedia(cons).catch(async err => { if (dev && (err.name === 'OverconstrainedError' || err.name === 'NotFoundError')) { toast('Selected camera unavailable; using default camera.', 'warn'); return navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'}}}); } throw err; }), motionP]);
      SN.startMotion(perm);
      R.stream = stream; R.track = stream.getVideoTracks()[0]; R.src = 'cam';
      cam.srcObject = stream; await cam.play().catch(() => {});
      await tuneTrack(); await listCameras(); armFrames(); afterStart(); showCamInfo();
      R.tracker.reset();
    } catch (e) {
      stopAll();
      toast(e && e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in the browser’s site settings and try again.' : 'Could not start the camera: ' + (e && e.message || e), 'bad', 6000);
    }
  }
  async function tuneTrack() {
    const t = R.track; if (!t || !t.getCapabilities) return;
    const cap = t.getCapabilities(), adv = {};
    if (cap.focusMode && cap.focusMode.includes('continuous')) adv.focusMode = 'continuous';
    if (cap.exposureMode && cap.exposureMode.includes('continuous')) adv.exposureMode = 'continuous';
    if (cap.whiteBalanceMode && cap.whiteBalanceMode.includes('continuous')) adv.whiteBalanceMode = 'continuous';
    if (Object.keys(adv).length) try { await t.applyConstraints({ advanced: [adv] }); } catch (e) { /* unsupported */ }
    const zw = $('zoomWrap');
    if (cap.zoom) { const z = $('zoomRange'); z.min = cap.zoom.min; z.max = cap.zoom.max; z.step = cap.zoom.step || 0.1; z.value = t.getSettings().zoom || cap.zoom.min; zw.style.display = ''; $('zoomVal').textContent = (+z.value).toFixed(1) + '×'; } else zw.style.display = 'none';
    $('btnTorch').style.display = cap.torch ? '' : 'none';
    $('camRow').classList.add('show');
  }
  function showCamInfo() {
    const s = R.track && R.track.getSettings ? R.track.getSettings() : {};
    $('camInfo').textContent = `${s.width || cam.videoWidth}×${s.height || cam.videoHeight} @ ${Math.round(s.frameRate || 0)} fps · ${R.track ? R.track.label : ''}`;
  }
  async function listCameras() {
    const sel = $('camSel');
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const active = R.track?.getSettings?.().deviceId || S.cameraId || '';
      const old = sel.value;
      sel.replaceChildren();
      const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Automatic · rear camera'; sel.append(auto);
      devs.forEach((d,i) => {
        const opt = document.createElement('option'); opt.value = d.deviceId;
        opt.textContent = d.label || `Camera ${i+1}${i === 0 ? ' · default' : ''}`;
        sel.append(opt);
      });
      sel.value = devs.some(d => d.deviceId === active) ? active : (devs.some(d=>d.deviceId===old) ? old : '');
      $('camCount').textContent = `${devs.length} camera input${devs.length === 1 ? '' : 's'} exposed by browser`;
    } catch(e) { $('camCount').textContent = 'Camera enumeration unavailable'; }
  }
  $('camSel').addEventListener('change', () => {
    S.cameraId = $('camSel').value; save();
    if (R.src === 'cam') startCamera();
  });
  $('btnScanCameras').addEventListener('click', async () => {
    if (!R.stream) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({video:true,audio:false});
        stream.getTracks().forEach(t=>t.stop());
      } catch(e) { toast('Camera permission required to reveal camera names.', 'warn'); }
    }
    await listCameras();
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => listCameras());
  $('zoomRange').addEventListener('input', async (e) => {
    $('zoomVal').textContent = (+e.target.value).toFixed(1) + '×';
    try { await R.track.applyConstraints({ advanced: [{ zoom: +e.target.value }] }); } catch (err) { /* ignore */ }
    R.tracker.reset(); toast('Zoom changed – re-check calibration', 'warn');
  });
  $('btnTorch').addEventListener('click', async () => {
    R.torch = !R.torch;
    try { await R.track.applyConstraints({ advanced: [{ torch: R.torch }] }); $('btnTorch').classList.toggle('on', R.torch); } catch (e) { R.torch = false; }
  });

  function startFile(file) {
    stopAll(); Det.init(); R.src = 'file';
    cam.src = URL.createObjectURL(file); cam.muted = true; cam.controls = true; cam.loop = false;
    cam.onended = () => toast('Video finished');
    cam.play().catch(() => {});
    armFrames(); afterStart(); R.tracker.reset();
    toast('Analysing video. Calibrate the zone on a frame, then play.');
  }

  function startSim() {
    stopAll(); R.src = 'sim';
    const q = rebuildCal(); if (!q.ok) { S.cal.quad = DEFAULT_QUAD.map(p => p.slice()); rebuildCal(); }
    R.sim = new C.Sim(R.cal, { limit: S.limit, frameW: 1280, frameH: 720, seed: (Date.now() & 0xffff) | 1 });
    R.simT = 0; R.simLast = performance.now(); R.tracker.reset();
    afterStart();
    R.simTimer = setInterval(() => {
      const n = performance.now(), dt = Math.min(0.2, (n - R.simLast) / 1000); R.simLast = n; R.simT += dt;
      R.simDets = R.sim.step(dt);
      const res = R.tracker.update(R.simDets, R.simT);
      for (const tr of res.ended) finalizeTrack(tr);
      const minConf = S.minConf / 100;
      for (const tr of res.active) if (!tr.logged && tr.est && tr.rep != null && tr.repN >= 4 && tr.rep > S.limit + S.tol && tr.est.conf >= minConf && C.dirAllowed(tr.est, S.dirMode)) logEvent(tr, true);
      R.detHz = 1 / Math.max(dt, 0.001);
    }, 83);
    toast('Simulation: synthetic traffic. Events are flagged SIMULATED.');
  }

  /* =========================================================
     Overlay rendering (60 fps loop, diffed + capped)
     ========================================================= */
  let cw = 0, ch = 0, dpr = 1, fit = { ox: 0, oy: 0, dw: 1, dh: 1 };
  function resizeCanvas() {
    const r = stage.getBoundingClientRect(); dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = Math.max(1, Math.round(r.width)); ch = Math.max(1, Math.round(r.height));
    ov.width = Math.round(cw * dpr); ov.height = Math.round(ch * dpr);
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sc = Math.min(cw / R.vw, ch / R.vh); fit = { dw: R.vw * sc, dh: R.vh * sc }; fit.ox = (cw - fit.dw) / 2; fit.oy = (ch - fit.dh) / 2;
  }
  new ResizeObserver(resizeCanvas).observe(stage);
  const px = (u, v) => [fit.ox + u * fit.dw, fit.oy + v * fit.dh];
  const unpx = (x, y) => [(x - fit.ox) / fit.dw, (y - fit.oy) / fit.dh];

  let lastDraw = 0, frames = 0, fpsT = performance.now();
  function frame(ts) {
    requestAnimationFrame(frame);
    if (document.hidden) { lastDraw = ts; fpsT = ts; frames = 0; return; }
    const gap = 1000 / (+S.fps || 60);
    if (ts - lastDraw < gap - 2) return;
    lastDraw = ts; frames++;
    if (ts - fpsT >= 1000) { R.fps = frames * 1000 / (ts - fpsT); frames = 0; fpsT = ts; }
    if (!$('p-live').classList.contains('on')) return;
    draw();
  }
  requestAnimationFrame(frame);

  function polyPath(pts) { g2.beginPath(); pts.forEach((p, i) => { const [x, y] = px(p[0], p[1]); i ? g2.lineTo(x, y) : g2.moveTo(x, y); }); g2.closePath(); }
  function gline(a, b) { const A = C.applyH(R.cal.Hinv, a[0], a[1]), B = C.applyH(R.cal.Hinv, b[0], b[1]); if (!A || !B) return; const [x1, y1] = px(A[0], A[1]), [x2, y2] = px(B[0], B[1]); g2.moveTo(x1, y1); g2.lineTo(x2, y2); }

  function drawSimBackdrop() {
    const cal = R.cal; if (!cal) return;
    const sky = g2.createLinearGradient(0, 0, 0, ch); sky.addColorStop(0, '#0b1220'); sky.addColorStop(0.5, '#1a2436'); sky.addColorStop(1, '#0b0e14');
    g2.fillStyle = sky; g2.fillRect(0, 0, cw, ch);
    const W = cal.W, Dd = cal.D, road = [[-W * 0.25, -Dd * 0.2], [W * 1.25, -Dd * 0.2], [W * 1.25, Dd * 1.4], [-W * 0.25, Dd * 1.4]];
    g2.beginPath();
    road.forEach((p, i) => { const q = C.applyH(cal.Hinv, p[0], p[1]); if (!q) return; const [x, y] = px(q[0], q[1]); i ? g2.lineTo(x, y) : g2.moveTo(x, y); });
    g2.closePath(); g2.fillStyle = '#1a202b'; g2.fill();
    g2.strokeStyle = 'rgba(255,255,255,.55)'; g2.lineWidth = 2; g2.beginPath(); gline([0, -Dd * 0.2], [0, Dd * 1.4]); gline([W, -Dd * 0.2], [W, Dd * 1.4]); g2.stroke();
    g2.strokeStyle = 'rgba(255,255,255,.4)'; g2.lineWidth = 1.5; g2.setLineDash([10, 14]); g2.beginPath();
    gline([W / 3, -Dd * 0.2], [W / 3, Dd * 1.4]); gline([2 * W / 3, -Dd * 0.2], [2 * W / 3, Dd * 1.4]); g2.stroke(); g2.setLineDash([]);
    // vehicles (drawn from the simulated ground truth, far to near)
    const ds = R.simDets.slice().sort((a, b) => a.y - b.y);
    for (const d of ds) {
      const [x, y] = px(d.x, d.y), w = d.w * fit.dw, h = d.h * fit.dh;
      g2.fillStyle = d.cls === 'truck' || d.cls === 'bus' ? '#566274' : d.truth > S.limit + S.tol ? '#c8cfdb' : '#6f87a8';
      g2.beginPath(); g2.roundRect ? g2.roundRect(x, y, w, h, Math.min(8, w * .14)) : g2.rect(x, y, w, h); g2.fill();
      g2.fillStyle = 'rgba(0,0,0,.35)'; g2.fillRect(x + w * .1, y + h * .12, w * .8, h * .3);
      g2.fillStyle = '#ffd89a'; g2.fillRect(x + w * .08, y + h * .78, w * .16, h * .08); g2.fillRect(x + w * .76, y + h * .78, w * .16, h * .08);
    }
  }

  function drawBracket(x, y, w, h, color, lw) {
    const l = Math.min(w, h) * 0.28;
    g2.strokeStyle = color; g2.lineWidth = lw; g2.lineCap = 'round'; g2.beginPath();
    g2.moveTo(x, y + l); g2.lineTo(x, y); g2.lineTo(x + l, y);
    g2.moveTo(x + w - l, y); g2.lineTo(x + w, y); g2.lineTo(x + w, y + l);
    g2.moveTo(x + w, y + h - l); g2.lineTo(x + w, y + h); g2.lineTo(x + w - l, y + h);
    g2.moveTo(x + l, y + h); g2.lineTo(x, y + h); g2.lineTo(x, y + h - l); g2.stroke();
  }

  function draw() {
    g2.clearRect(0, 0, cw, ch);
    if (!R.src) return;
    if (R.src === 'sim') drawSimBackdrop();
    const cal = R.cal;
    // zone + grid
    if (cal && (R.calMode || S.grid)) {
      polyPath(S.cal.quad); g2.fillStyle = R.calMode ? 'rgba(255,180,0,.10)' : 'rgba(255,180,0,.05)'; g2.fill();
      g2.strokeStyle = 'rgba(255,180,0,.85)'; g2.lineWidth = R.calMode ? 2.2 : 1.4; g2.stroke();
      g2.strokeStyle = 'rgba(255,200,80,.30)'; g2.lineWidth = 1; g2.beginPath();
      const n = 8; for (let i = 1; i < n; i++) gline([0, cal.D * i / n], [cal.W, cal.D * i / n]);
      for (let i = 1; i < 4; i++) gline([cal.W * i / 4, 0], [cal.W * i / 4, cal.D]);
      g2.stroke();
      if (R.calMode) {
        const lbl = ['BL', 'BR', 'TR', 'TL'];
        S.cal.quad.forEach((p, i) => {
          const [x, y] = px(p[0], p[1]);
          g2.beginPath(); g2.arc(x, y, 15, 0, 6.2832); g2.fillStyle = 'rgba(10,12,15,.75)'; g2.fill();
          g2.lineWidth = 3; g2.strokeStyle = '#ffb400'; g2.stroke();
          g2.fillStyle = '#ffb400'; g2.font = '700 12px "JetBrains Mono",monospace'; g2.textAlign = 'center'; g2.textBaseline = 'middle'; g2.fillText(lbl[i], x, y + 1);
        });
        g2.fillStyle = 'rgba(255,255,255,.8)'; g2.font = '600 12px Barlow,sans-serif'; g2.textAlign = 'center';
        const [mx, my] = px((S.cal.quad[0][0] + S.cal.quad[1][0]) / 2, S.cal.quad[0][1]); g2.fillText(`${(+S.cal.W).toFixed(1)} m`, mx, my - 22);
        const [lx, ly] = px((S.cal.quad[0][0] + S.cal.quad[3][0]) / 2, (S.cal.quad[0][1] + S.cal.quad[3][1]) / 2); g2.save(); g2.translate(lx - 18, ly); g2.fillText(`${(+S.cal.D).toFixed(0)} m`, 0, 0); g2.restore();
      }
    }
    // tracks with interpolation between detections
    const tn = nowT(), lim = S.limit + S.tol, maxAge = R.tracker.o.maxAge;
    g2.textBaseline = 'alphabetic';
    for (const tr of R.tracker.tracks) {
      if (tr.hits < R.tracker.o.minHits) continue;
      const age = tn - tr.t; if (age > maxAge || age < -1) continue;
      const dt = clamp(age, 0, 0.3);
      const bx = tr.x + tr.vx * dt, by = tr.y + tr.vy * dt;
      const [x, y] = px(bx, by), w = tr.w * fit.dw, h = tr.h * fit.dh;
      const spd = tr.speed, okDir = C.dirAllowed(tr.est, S.dirMode), over = okDir && spd != null && spd > lim && tr.est && tr.est.conf >= S.minConf / 100;
      const col = spd == null ? '#5cc8ff' : !okDir ? '#7d8799' : over ? '#ff4d4f' : '#2ee59d';
      const sel = R.selected === tr.id;
      drawBracket(x, y, w, h, col, sel ? 3.2 : over ? 2.8 : 2);
      if (over) { g2.fillStyle = 'rgba(255,77,79,.08)'; g2.fillRect(x, y, w, h); }
      const txt = spd == null ? '…' : fmtSpeed(spd);
      g2.font = '700 18px "Barlow Condensed",sans-serif';
      const lw = Math.max(46, g2.measureText(txt).width + 38);
      const tx = clamp(x, 2, cw - lw - 2), ty = Math.max(2, y - 26);
      g2.fillStyle = col; g2.beginPath(); g2.roundRect ? g2.roundRect(tx, ty, lw, 24, 7) : g2.rect(tx, ty, lw, 24); g2.fill();
      g2.fillStyle = over || spd == null ? '#fff' : '#06150f'; g2.textAlign = 'left'; g2.fillText(txt, tx + 8, ty + 18);
      g2.font = '600 10px "JetBrains Mono",monospace'; g2.fillText(S.unit === 'mph' ? 'MPH' : 'KMH', tx + lw - 32, ty + 16);
      if (tr.est) { g2.fillStyle = 'rgba(255,255,255,.75)'; g2.font = '500 10px "JetBrains Mono",monospace'; g2.fillText(`${tr.est.arrow} ${tr.cls} #${tr.id} ±${fmtSpeed(tr.est.margin)}`, x + 2, y + h + 12); }
    }
  }

  /* ---------- calibration pointer interaction ---------- */
  function pointerPos(e) { const r = ov.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  ov.addEventListener('pointerdown', (e) => {
    if (!R.calMode) return;
    const [x, y] = pointerPos(e); let best = -1, bd = 34;
    S.cal.quad.forEach((p, i) => { const [qx, qy] = px(p[0], p[1]); const d = Math.hypot(qx - x, qy - y); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) { R.drag = best; ov.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  ov.addEventListener('pointermove', (e) => {
    if (R.drag < 0) return;
    const [x, y] = pointerPos(e); const [u, v] = unpx(x, y);
    const old = S.cal.quad[R.drag].slice(); S.cal.quad[R.drag] = [clamp(u, 0.01, 0.99), clamp(v, 0.01, 0.99)];
    const q = rebuildCal();
    if (!q.ok) { S.cal.quad[R.drag] = old; calMsg(q.msg, true); rebuildCal(); } else calMsg('Zone OK. Enter the real width and length below.');
    S.cal.userSet = true;
  });
  const endDrag = () => { if (R.drag >= 0) { R.drag = -1; save(); } };
  ov.addEventListener('pointerup', endDrag); ov.addEventListener('pointercancel', endDrag);
  function calMsg(t, bad) { const m = $('calMsg'); m.textContent = t; m.classList.toggle('bad', !!bad); }
  function setCalMode(on) {
    R.calMode = on; ov.style.pointerEvents = on ? 'auto' : 'none'; $('calPanel').style.display = on ? '' : 'none'; $('btnCal').classList.toggle('on', on);
    if (on) { $('zoneW').value = S.cal.W; $('zoneD').value = S.cal.D; }
    else { S.cal.userSet = true; S.cal.pitch = SN.state.orient.state === 'on' ? SN.state.orient.pitch : null; S.cal.heading = SN.state.orient.state === 'on' ? SN.state.orient.heading : null; save(); R.tracker.reset(); }
    ov.style.pointerEvents = on ? 'auto' : 'none';
  }
  ov.style.pointerEvents = 'none';
  $('btnCal').onclick = () => setCalMode(!R.calMode);
  $('btnCalDone').onclick = () => { setCalMode(false); toast('Calibration saved', 'good'); };
  $('btnCalReset').onclick = () => { S.cal.quad = DEFAULT_QUAD.map(p => p.slice()); S.cal.W = 11; S.cal.D = 40; S.cal.userSet = false; $('zoneW').value = 11; $('zoneD').value = 40; rebuildCal(); save(); };
  for (const id of ['zoneW', 'zoneD']) $(id).addEventListener('change', () => {
    const v = parseFloat($(id).value); if (!(v > 0)) return;
    S.cal[id === 'zoneW' ? 'W' : 'D'] = v; S.cal.userSet = true; rebuildCal(); save();
  });
  // Assisted monocular perspective estimate. NOT a metric depth measurement.
  function estimateZone() {
    const height = Number($('mountHeight').value);
    const pitch = Number($('mountPitch').value);
    const vfov = Number($('cameraFov').value);
    if (!(height >= 0.5 && height <= 20 && pitch > 5 && pitch < 85 && vfov >= 25 && vfov <= 120)) {
      return calMsg('Enter valid mounting height, downward tilt and camera vertical FOV.', true);
    }
    const q = S.cal.quad;
    const nearY = (q[0][1] + q[1][1])/2, farY = (q[2][1]+q[3][1])/2;
    const rayDistance = y => {
      const angle = (pitch + (y - 0.5) * vfov) * Math.PI / 180;
      return angle > 0.035 ? height / Math.tan(angle) : null;
    };
    const near = rayDistance(nearY), far = rayDistance(farY);
    if (!near || !far || far <= near || far > 1500) return calMsg('Horizon/tilt geometry invalid. Aim lower or adjust FOV and zone corners.', true);
    const aspect = cam.videoWidth && cam.videoHeight ? cam.videoWidth / cam.videoHeight : 16/9;
    const hfov = 2*Math.atan(Math.tan(vfov*Math.PI/360)*aspect);
    const widthAt = y => 2*rayDistance(y)*Math.tan(hfov/2);
    const width = widthAt(nearY)*Math.abs(q[1][0]-q[0][0]);
    const depth = far-near;
    if (!(width >= 1 && width <= 60 && depth >= 5 && depth <= 300)) return calMsg(`Estimated width ${width.toFixed(1)}m / length ${depth.toFixed(1)}m outside supported calibration limits. Adjust zone.`,true);
    S.cal.W = +width.toFixed(2); S.cal.D = +depth.toFixed(2); S.cal.userSet = false;
    $('zoneW').value = S.cal.W; $('zoneD').value = S.cal.D;
    rebuildCal(); save(); R.tracker.reset();
    $('distanceEstimate').textContent = `Near edge ≈ ${near.toFixed(1)} m · far edge ≈ ${far.toFixed(1)} m · zone ≈ ${depth.toFixed(1)} m. Assumes level road and accurately entered lens FOV/tilt.`;
    calMsg('Assisted zone applied. ESTIMATE ONLY — verify against measured road markings before trusting speed.');
  }
  $('btnEstimateZone').onclick = estimateZone;
  $('btnBuiltInZone').onclick = () => { $('btnCalReset').click(); calMsg('Original built-in zone restored (11 × 40 m).'); };
  $('btnAutoCal').onclick = () => {
    const tr = R.tracker.tracks.find(t => t.id === R.selected), truth = parseFloat($('trueSpd').value);
    if (!tr || tr.rep == null) return calMsg('Tap a target in the list first (it needs a speed reading).', true);
    if (!(truth > 5)) return calMsg('Enter the known true speed in km/h.', true);
    const nf = S.factor * truth / tr.rep;
    if (nf < 0.5 || nf > 1.5) return calMsg(`That would need a ${nf.toFixed(2)}× correction – too large. Re-measure the zone width/length instead.`, true);
    S.factor = +nf.toFixed(3); R.tracker.setFactor(S.factor); $('factor').value = S.factor; $('factorVal').textContent = S.factor.toFixed(2) + '×'; save();
    calMsg(`Scale correction set to ${S.factor.toFixed(3)}×. Verify with another known pass.`);
  };

  /* =========================================================
     HUD / sensors / targets (throttled DOM updates)
     ========================================================= */
  const cache = new Map();
  function setText(el, txt) { if (cache.get(el) !== txt) { cache.set(el, txt); el.textContent = txt; } }
  function setCls(el, cls) { const k = el.id + ':c'; if (cache.get(k) !== cls) { cache.set(k, cls); el.className = cls; } }
  function setModelChip() {
    const m = $('hModel'); m.style.display = R.src === 'sim' ? 'none' : '';
    const t = R.modelState === 'ready' ? `AI READY · ${R.backend.toUpperCase()}` : R.modelState === 'loading' ? (R.modelMsg || 'LOADING MODEL…') : R.modelState === 'error' ? 'MODEL ERROR · TAP TO RETRY' : 'MODEL IDLE';
    setText(m, t); setCls(m, 'hchip ' + (R.modelState === 'ready' ? 'good' : R.modelState === 'error' ? 'bad' : 'warn'));
  }
  function refreshHud(force) {
    const g = SN.state.gps, o = SN.state.orient, road = D.ROADS[S.road];
    // status
    let st = 'IDLE', dot = '';
    if (R.src) {
      st = R.src === 'sim' ? 'SIMULATION' : R.src === 'file' ? 'VIDEO' : 'SCANNING'; dot = 'on';
      if (R.src !== 'sim' && R.modelState === 'error') { st = 'MODEL ERROR'; dot = 'bad'; }
      else if (R.src !== 'sim' && R.modelState !== 'ready') { st = 'LOADING MODEL'; dot = 'warn'; }
      else if (R.issue) { st = R.issue; dot = 'warn'; }
    }
    setText($('hStatusTxt'), st); setCls($('hDot'), 'dot ' + dot);
    setText($('hFps'), `${Math.round(R.fps)} FPS · ${R.detHz ? R.detHz.toFixed(0) : '—'} Hz`);
    const gu = $('hGuard'); const issue = R.src && R.src !== 'sim' ? R.issue : '';
    gu.style.display = issue ? '' : 'none'; setText(gu, issue); setCls(gu, 'hchip ' + (issue ? 'warn' : ''));
    // gps
    const gTxt = g.state === 'on' ? `GPS ±${Math.round(g.acc)}m${g.speed != null ? ' · ' + (g.speed * 3.6).toFixed(0) + ' km/h' : ''}` : g.state === 'searching' ? 'GPS searching…' : g.state === 'denied' ? 'GPS denied' : 'GPS off';
    setText($('hGps'), gTxt); setCls($('hGps'), 'hchip ' + (g.state === 'on' ? (g.acc < 25 ? 'good' : 'warn') : g.state === 'denied' ? 'bad' : ''));
    setText($('gpsTxt'), g.state === 'on' ? `±${Math.round(g.acc)} m` : g.state === 'searching' ? 'Locating…' : g.state === 'denied' ? 'GPS denied' : 'GPS off');
    setCls($('gpsDot'), 'dot ' + (g.state === 'on' ? (g.acc < 25 ? 'on' : 'warn') : g.state === 'denied' ? 'bad' : ''));
    setText($('hAz'), o.state === 'on' && o.heading != null ? `AZ ${String(Math.round(o.heading)).padStart(3, '0')}° ${SN.compass(o.heading)}${o.absolute ? '' : ' (rel)'}` : 'AZ —');
    setText($('hPitch'), o.state === 'on' && o.pitch != null ? `PITCH ${o.pitch >= 0 ? '+' : ''}${o.pitch.toFixed(1)}°` : 'PITCH —');
    // calibration status
    let calTxt = 'CAL DEFAULT', calCls = 'hchip warn';
    if (S.cal.userSet) { calTxt = `CAL ${(+S.cal.W).toFixed(1)}×${(+S.cal.D).toFixed(0)} m · ${S.factor.toFixed(2)}×`; calCls = 'hchip good'; }
    R.calMoved = false;
    if (S.cal.userSet && S.cal.pitch != null && o.state === 'on' && o.pitch != null && Math.abs(o.pitch - S.cal.pitch) > 2.5) { R.calMoved = true; calTxt = 'CAL ⚠ CAMERA MOVED'; calCls = 'hchip bad'; }
    setText($('hCal'), calTxt); setCls($('hCal'), calCls);
    setText($('hRoad'), `${road.name} · ${fmtSpeed(S.limit)} ${unitLbl()}`);
    setText($('limitVal'), fmtSpeed(S.limit)); setText($('limitUnit'), S.unit === 'mph' ? 'MPH' : 'KM/H');
    // net chip
    const n = SN.state.net, nc = $('netChip'); nc.style.display = n.online ? 'none' : ''; setText($('netTxt'), 'Offline');
    setCls($('netDot'), 'dot bad');
  }

  const SENS_DEF = [
    ['gps', 'GPS', 'i-gps'], ['orient', 'Compass', 'i-compass'], ['motion', 'Motion', 'i-motion'], ['wake', 'Screen lock', 'i-sun'], ['net', 'Network', 'i-wifi'], ['bat', 'Battery', 'i-battery']
  ];
  const sensEls = {};
  function buildSens() {
    const host = $('sensGrid'); host.innerHTML = '';
    for (const [k, label, ic] of SENS_DEF) {
      const d = document.createElement('div'); d.className = 'sens';
      d.innerHTML = `<svg class="ic sm"><use href="#${ic}"/></svg><div style="min-width:0"><div class="k">${label}</div><div class="v" id="sv-${k}">—</div></div>`;
      host.appendChild(d); sensEls[k] = d.querySelector('.v');
    }
  }
  function refreshSens() {
    const s = SN.state, g = s.gps, o = s.orient, m = s.motion, n = s.net, b = s.battery;
    setText(sensEls.gps, g.state === 'on' ? `±${Math.round(g.acc)} m · ${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}` : g.state);
    setText(sensEls.orient, o.state === 'on' ? `${Math.round(o.heading)}° ${SN.compass(o.heading)} · ${o.pitch.toFixed(0)}°` : o.state);
    setText(sensEls.motion, m.state === 'on' ? (m.stable ? 'steady' : 'shaking') + ` · ${(m.level * 100).toFixed(0)}%` : m.state);
    setText(sensEls.wake, s.wake.state === 'on' ? 'awake' : s.wake.state);
    setText(sensEls.net, n.online ? (n.type ? n.type.toUpperCase() + (n.downlink ? ` · ${n.downlink} Mb/s` : '') : 'online') : 'offline');
    setText(sensEls.bat, b.level != null ? `${Math.round(b.level * 100)}%${b.charging ? ' ⚡' : ''}` : 'n/a');
  }

  /* active targets list (diffed) */
  const tgtEls = new Map();
  function renderTargets(force) {
    const host = $('targets'), list = R.tracker.tracks.filter(t => t.hits >= R.tracker.o.minHits).sort((a, b) => b.id - a.id).slice(0, 8);
    setText($('tgtCount'), String(list.length)); $('tgtEmpty').style.display = list.length ? 'none' : '';
    const alive = new Set(list.map(t => t.id)), lim = S.limit + S.tol;
    for (const [id, el] of tgtEls) if (!alive.has(id)) { el.remove(); tgtEls.delete(id); }
    for (const tr of list) {
      let el = tgtEls.get(tr.id);
      if (!el) {
        el = document.createElement('div'); el.className = 'tgt'; el.dataset.id = tr.id;
        el.innerHTML = '<span class="id"></span><div style="min-width:0"><div class="nm"></div><div class="cf"><i></i></div></div><span class="sp">--</span>';
        el.onclick = () => { R.selected = R.selected === tr.id ? null : tr.id; };
        host.insertBefore(el, host.firstChild); tgtEls.set(tr.id, el);
      }
      const spd = tr.speed, over = C.dirAllowed(tr.est, S.dirMode) && spd != null && spd > lim && tr.est && tr.est.conf >= S.minConf / 100;
      const cls = 'tgt' + (over ? ' over' : '') + (R.selected === tr.id ? ' sel' : '');
      if (el.className !== cls) el.className = cls;
      el.style.outline = R.selected === tr.id ? '2px solid var(--amber)' : '';
      setText(el.children[0], '#' + tr.id);
      setText(el.children[1].children[0], `${tr.cls}${tr.est ? ' · ±' + fmtSpeed(tr.est.margin) + ' · ' + tr.est.arrow + ' ' + tr.est.dir : ' · measuring…'}${tr.sim ? ' · SIM' : ''}`);
      const cf = el.children[1].children[1].firstChild; const c = tr.est ? tr.est.conf : 0; cf.style.transform = `scaleX(${c.toFixed(2)})`; cf.style.background = c > 0.7 ? 'var(--green)' : c > 0.5 ? 'var(--amber)' : 'var(--red)';
      setText(el.children[2], fmtSpeed(spd));
    }
    // top stats
    const sp = list.map(t => t.speed).filter(v => v != null);
    setText($('sTracked'), String(list.length)); setText($('sAvg'), sp.length ? fmtSpeed(sp.reduce((a, b) => a + b, 0) / sp.length) : '--'); setText($('sAvgU'), unitLbl());
  }
  setInterval(() => { if ($('p-live').classList.contains('on')) { renderTargets(); refreshHud(); refreshSens(); } else refreshHud(); }, 250);
  SN.on(() => { /* state read on the 250 ms tick; heavy work is auto-road below */ });

  /* auto-select nearest road from GPS */
  setInterval(() => {
    const g = SN.state.gps;
    if (!S.autoRoad || g.state !== 'on' || g.acc > 150 || performance.now() - R.manualRoadAt < 600000) return;
    let bk = null, bd = 3000;
    for (const [k, r] of Object.entries(D.ROADS)) { if (r.lat == null) continue; const d = C.haversine(g.lat, g.lng, r.lat, r.lng); if (d < bd) { bd = d; bk = k; } }
    if (bk && bk !== S.road) { setRoad(bk, true); toast(`Nearest known road: ${D.ROADS[bk].name} (limit ${fmtSpeed(D.ROADS[bk].limit)}). Check the posted sign.`, '', 5000); }
  }, 5000);

  /* =========================================================
     Road / limit controls
     ========================================================= */
  function buildRoads() {
    $('roadSel').innerHTML = Object.entries(D.ROADS).map(([k, r]) => `<option value="${k}">${esc(r.name)}${r.lat != null ? ` (${r.limit} km/h)` : ''}</option>`).join('');
    $('roadSel').value = S.road;
    const chips = $('limitChips'); chips.innerHTML = '';
    for (const l of [40, 60, 80, 100, 120]) { const b = document.createElement('button'); b.className = 'btn sm'; b.dataset.l = l; b.textContent = fmtSpeed(l); b.onclick = () => { setLimit(l); R.manualRoadAt = performance.now(); }; chips.appendChild(b); }
    syncLimitChips();
  }
  function syncLimitChips() { $('limitChips').querySelectorAll('button').forEach(b => { b.classList.toggle('on', +b.dataset.l === S.limit); b.textContent = fmtSpeed(+b.dataset.l); }); }
  function setLimit(l) { S.limit = clamp(Math.round(l), 10, 200); save(); syncLimitChips(); if (R.sim) R.sim.o.limit = S.limit; refreshHud(); }
  function setRoad(k, auto) { S.road = k; $('roadSel').value = k; if (!auto) R.manualRoadAt = performance.now(); setLimit(D.ROADS[k].limit); if (mapReady) updateMapMarkers(); }
  $('roadSel').onchange = (e) => setRoad(e.target.value);
  $('limitSet').onclick = () => { const v = parseFloat($('limitCustom').value); if (v > 0) { setLimit(S.unit === 'mph' ? v / 0.621371 : v); R.manualRoadAt = performance.now(); } };

  /* =========================================================
     Records, analytics, map, operator
     ========================================================= */
  const vehLabel = (e) => e.vehicle ? [e.vehicle.year, e.vehicle.make, e.vehicle.model].filter(Boolean).join(' ') + (e.color ? ` · ${e.color}` : '') : (e.cls || 'vehicle') + (e.color ? ` · ${e.color}` : '');
  const plateHtml = (e) => {
    const c = e.plate.code, n = e.plate.num, has = c || n;
    return `<div class="kuwait-plate ${has ? '' : 'empty'}"><div class="hdr">دولة الكويت • KUWAIT</div><div class="num"><span>${esc(c || '–')}</span><span>${esc(n || '–––––')}</span></div>${has ? `<div class="ar">${esc(D.plateArabic(c, n))}</div>` : ''}</div>`;
  };
  const when = (ts) => new Date(ts).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fineTxt = (e) => e.violation ? `${e.fine} KWD` : '—';

  let fltType = 'all', fltQ = '';
  function recordsHtml() {
    const q = fltQ.toLowerCase();
    const list = events.filter(e => (fltType === 'all' || (fltType === 'over' ? e.violation : !e.violation)) && (!q || `${vehLabel(e)} ${e.plate.code} ${e.plate.num} ${e.road} ${e.notes}`.toLowerCase().includes(q)));
    $('recCount').textContent = `${list.length} of ${events.length} records` + (list.length > 200 ? ' (showing newest 200)' : '');
    return list.slice(0, 200).map(e => `<tr>
      <td>${e.thumb ? `<img class="thumb" src="${e.thumb}" alt="">` : `<div class="thumb" style="display:grid;place-items:center;color:var(--tx3)"><svg class="ic"><use href="#i-${e.sim ? 'bolt' : 'snap'}"/></svg></div>`}</td>
      <td class="mono" style="white-space:nowrap">${when(e.ts)}${e.sim ? ' <span class="pill sim">SIM</span>' : ''}</td>
      <td>${plateHtml(e)}</td>
      <td>${esc(vehLabel(e))}<div class="dim" style="font-size:11px">${esc(e.cls || '')} · conf ${Math.round(e.conf * 100)}%</div></td>
      <td><b class="mono" style="font-size:16px;color:${e.violation ? 'var(--red)' : 'var(--green)'}">${fmtSpeed(e.speed)}</b> <span class="dim mono" style="font-size:11px">±${fmtSpeed(e.margin)}</span></td>
      <td class="mono">${fmtSpeed(e.limit)}</td>
      <td>${esc(e.road)}${e.lat != null ? `<div class="dim mono" style="font-size:10.5px">${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}</div>` : ''}</td>
      <td class="mono" style="color:var(--amber)">${fineTxt(e)}</td>
      <td style="white-space:nowrap"><button class="btn sm" data-edit="${e.id}"><svg class="ic sm"><use href="#i-edit"/></svg></button> <button class="btn sm" data-rep="${e.id}"><svg class="ic sm"><use href="#i-print"/></svg></button></td></tr>`).join('') || `<tr><td colspan="9" class="dim" style="padding:28px;text-align:center">No records yet. Start the camera or run the simulation.</td></tr>`;
  }
  function renderRecords() { $('recBody').innerHTML = recordsHtml(); }
  function renderRecent() {
    const v = events.filter(e => e.violation).slice(0, 8);
    $('recentBody').innerHTML = v.map(e => `<tr><td class="mono">${when(e.ts)}</td><td>${plateHtml(e)}</td><td>${esc(vehLabel(e))}</td><td class="mono" style="color:var(--red)"><b>${fmtSpeed(e.speed)}</b></td><td class="mono">${fmtSpeed(e.limit)}</td><td class="mono" style="color:var(--amber)">+${fmtSpeed(e.excess)}</td><td>${esc(e.road)}</td></tr>`).join('') || `<tr><td colspan="7" class="dim" style="padding:22px;text-align:center">No infractions recorded.</td></tr>`;
  }
  function renderStats() {
    const total = events.length, over = events.filter(e => e.violation).length;
    setText($('aScanned'), String(total)); setText($('aViol'), String(over));
    setText($('aComp'), total ? Math.round((total - over) / total * 100) + '%' : '100%');
    const mean = total ? events.reduce((a, e) => a + e.speed, 0) / total : 0; setText($('aMean'), fmtSpeed(mean));
    const top = events.reduce((m, e) => e.speed > (m ? m.speed : 0) ? e : m, null);
    setText($('aTop'), top ? `Top: ${fmtSpeed(top.speed)} ${unitLbl()}` : '—');
    // operator
    setText($('opReports'), String(over)); setText($('opFines'), events.filter(e => e.violation).reduce((a, e) => a + (e.fine || 0), 0) + ' KWD');
    setText($('opMax'), top ? fmtSpeed(top.speed) : '--'); setText($('opMeasured'), String(total));
    const b = $('recBadge'); b.textContent = over > 99 ? '99+' : over; b.classList.toggle('show', over > 0);
  }
  let chartsReady = false, chSpeed = null, chRoad = null, chartLoading = false;
  function ensureCharts() {
    if (chartsReady) return updateCharts();
    if (chartLoading) return; chartLoading = true;
    const s = document.createElement('script'); s.src = './vendor/chart.umd.js';
    s.onload = () => {
      const txt = getComputedStyle(document.documentElement).getPropertyValue('--tx2').trim() || '#9aa6b8';
      Chart.defaults.color = txt; Chart.defaults.font.family = 'Barlow, system-ui, sans-serif'; Chart.defaults.animation.duration = 500;
      const grid = 'rgba(128,140,160,.18)';
      chSpeed = new Chart($('chSpeed'), { type: 'bar', data: { labels: [], datasets: [{ data: [], backgroundColor: ['#2ee59d', '#5cc8ff', '#9d8cff', '#ffb400', '#ff4d4f'], borderRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { color: grid } }, y: { grid: { color: grid }, beginAtZero: true, ticks: { precision: 0 } } } } });
      chRoad = new Chart($('chRoad'), { type: 'doughnut', data: { labels: [], datasets: [{ data: [], backgroundColor: ['#ffb400', '#5cc8ff', '#9d8cff', '#ff4d4f', '#2ee59d', '#f472b6', '#94a3b8'], borderWidth: 0 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'right', labels: { boxWidth: 10, font: { size: 11 } } } } } });
      chartsReady = true; updateCharts();
    };
    document.head.appendChild(s);
  }
  function updateCharts() {
    if (!chartsReady) return;
    const edges = [0, 80, 100, 120, 140, Infinity], bins = [0, 0, 0, 0, 0];
    for (const e of events) for (let i = 0; i < 5; i++) if (e.speed >= edges[i] && e.speed < edges[i + 1]) { bins[i]++; break; }
    const cv = (v) => S.unit === 'mph' ? Math.round(v * 0.621371) : v;
    chSpeed.data.labels = [`< ${cv(80)}`, `${cv(80)}–${cv(100)}`, `${cv(100)}–${cv(120)}`, `${cv(120)}–${cv(140)}`, `${cv(140)}+ ${unitLbl()}`];
    chSpeed.data.datasets[0].data = bins; chSpeed.update();
    const by = {}; for (const e of events) if (e.violation) by[e.road] = (by[e.road] || 0) + 1;
    const ent = Object.entries(by).sort((a, b) => b[1] - a[1]);
    chRoad.data.labels = ent.length ? ent.map(x => x[0]) : ['No violations yet'];
    chRoad.data.datasets[0].data = ent.length ? ent.map(x => x[1]) : [1];
    chRoad.data.datasets[0].backgroundColor = ent.length ? ['#ffb400', '#5cc8ff', '#9d8cff', '#ff4d4f', '#2ee59d', '#f472b6', '#94a3b8'] : ['#2a3342'];
    chRoad.update();
  }
  let evTimer = 0;
  function onEventsChanged(immediate) {
    clearTimeout(evTimer);
    const run = () => {
      renderStats();
      const tab = currentTab;
      if (tab === 'records') renderRecords(); if (tab === 'analytics') { renderRecent(); updateCharts(); } if (tab === 'map' && mapReady) updateMapMarkers();
    };
    if (immediate) run(); else evTimer = setTimeout(run, 400);
  }

  /* ---------- map ---------- */
  let map = null, mapReady = false, roadLayer = null, evLayer = null, meMarker = null;
  function ensureMap() {
    if (mapReady) { setTimeout(() => map.invalidateSize(), 50); return updateMapMarkers(); }
    L.Icon.Default.imagePath = './vendor/leaflet/images/';
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([29.3375, 47.9744], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    roadLayer = L.layerGroup().addTo(map); evLayer = L.layerGroup().addTo(map); mapReady = true;
    buildRoadCards(); updateMapMarkers(); setTimeout(() => map.invalidateSize(), 80);
  }
  function updateMapMarkers() {
    roadLayer.clearLayers(); evLayer.clearLayers();
    for (const [k, r] of Object.entries(D.ROADS)) {
      if (r.lat == null) continue;
      L.circleMarker([r.lat, r.lng], { radius: k === S.road ? 11 : 8, color: '#ffb400', weight: k === S.road ? 4 : 2, fillColor: '#10141a', fillOpacity: 0.9 })
        .bindPopup(`<b>${esc(r.name)}</b><br>Reference point ${esc(r.post)}<br>Limit ${fmtSpeed(r.limit)} ${unitLbl()}`).addTo(roadLayer);
    }
    for (const e of events.filter(e => e.violation).slice(0, 150)) {
      const r = D.ROADS[e.roadKey]; const lat = e.lat != null ? e.lat : r && r.lat, lng = e.lng != null ? e.lng : r && r.lng;
      if (lat == null) continue;
      L.circleMarker([lat + (e.lat == null ? (Math.random() - .5) * 0.002 : 0), lng], { radius: 6, color: '#ff4d4f', weight: 2, fillColor: '#ff4d4f', fillOpacity: 0.55 })
        .bindPopup(`<b>${fmtSpeed(e.speed)} ${unitLbl()}</b> (limit ${fmtSpeed(e.limit)})<br>${esc(vehLabel(e))}<br>${when(e.ts)}`).addTo(evLayer);
    }
    const g = SN.state.gps;
    if (g.state === 'on') {
      if (!meMarker) meMarker = L.circleMarker([g.lat, g.lng], { radius: 8, color: '#5cc8ff', weight: 3, fillColor: '#5cc8ff', fillOpacity: 0.7 }).addTo(map);
      else meMarker.setLatLng([g.lat, g.lng]);
    }
  }
  function buildRoadCards() {
    $('roadCards').innerHTML = Object.entries(D.ROADS).filter(([, r]) => r.lat != null).map(([k, r]) => `<button class="li" data-road="${k}"><span class="ico"><svg class="ic"><use href="#i-gps"/></svg></span><span style="flex:1"><b>${esc(r.name)}</b><br><span class="dim" style="font-size:12.5px">${esc(r.post)}</span></span><span class="pill amber">${fmtSpeed(r.limit)} ${unitLbl()}</span></button>`).join('');
  }
  $('roadCards').addEventListener('click', (e) => { const b = e.target.closest('[data-road]'); if (!b) return; const r = D.ROADS[b.dataset.road]; setRoad(b.dataset.road); map.flyTo([r.lat, r.lng], 12, { duration: 0.8 }); });
  $('btnLocate').onclick = () => { SN.startGPS(); const g = SN.state.gps; if (g.state === 'on' && map) { map.flyTo([g.lat, g.lng], 14); updateMapMarkers(); } else toast('Waiting for GPS fix… allow location access.'); };

  /* ---------- edit / annotate ---------- */
  let editing = null, hitMap = {};
  function openModal(id) { $(id).classList.add('on'); }
  function closeModals() { document.querySelectorAll('.modal.on').forEach(m => m.classList.remove('on')); }
  document.querySelectorAll('.modal').forEach(m => m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModals(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  function fillMakes(sel) { $('eMake').innerHTML = '<option value="">— unspecified —</option>' + D.makes().map(m => `<option>${esc(m)}</option>`).join(''); if (sel) $('eMake').value = sel; }
  function fillModels(make, selKey) {
    const rows = D.modelsFor(make).slice().sort((a, b) => (b.common - a.common) || a.model.localeCompare(b.model) || a.from - b.from);
    $('eModel').innerHTML = '<option value="">— unspecified —</option>' + rows.map(r => { const k = `${r.model}||${r.gen}||${r.from}`; return `<option value="${esc(k)}">${esc(r.model)} · ${esc(r.gen)} (${r.from}–${r.to})</option>`; }).join('');
    if (selKey) $('eModel').value = selKey;
    fillYears();
  }
  function selectedEntry() { const k = $('eModel').value; if (!k) return null; const [model, gen, from] = k.split('||'); return D.modelsFor($('eMake').value).find(r => r.model === model && r.gen === gen && String(r.from) === from) || null; }
  function fillYears(sel) {
    const r = selectedEntry(), a = r ? r.from : 2000, b = r ? r.to : 2026;
    let h = '<option value="">—</option>'; for (let y = b; y >= a; y--) h += `<option>${y}</option>`;
    $('eYear').innerHTML = h; if (sel) $('eYear').value = sel; else if (r) $('eYear').value = String(b);
  }
  $('eMake').onchange = () => fillModels($('eMake').value);
  $('eModel').onchange = () => fillYears();
  $('eSearch').addEventListener('input', () => {
    const hits = D.search($('eSearch').value, 25); hitMap = {};
    $('eHits').innerHTML = hits.map(r => { const l = `${r.make} ${r.model} ${r.gen} (${r.from}–${r.to})`; hitMap[l] = r; return `<option value="${esc(l)}"></option>`; }).join('');
    const hit = hitMap[$('eSearch').value];
    if (hit) { $('eMake').value = hit.make; fillModels(hit.make, `${hit.model}||${hit.gen}||${hit.from}`); $('eSearch').value = ''; }
  });
  $('codeList').innerHTML = D.PLATE_CODES.map(c => `<option value="${c}">`).join('');
  $('eColor').innerHTML = '<option value="">—</option>' + D.COLORS.map(c => `<option>${esc(c)}</option>`).join('');

  async function openEdit(id) {
    const e = events.find(x => x.id === id); if (!e) return; editing = e;
    await D.loadCatalog(); fillMakes(e.vehicle && e.vehicle.make);
    if (e.vehicle && e.vehicle.make) { fillModels(e.vehicle.make, e.vehicle.model ? `${e.vehicle.model}||${e.vehicle.gen}||${e.vehicle.from}` : ''); fillYears(e.vehicle.year ? String(e.vehicle.year) : ''); } else fillModels('');
    $('eColor').value = e.color || ''; $('eCode').value = e.plate.code || ''; $('eNum').value = e.plate.num || ''; $('eNotes').value = e.notes || '';
    $('eThumb').src = e.thumb || ''; $('eThumb').style.visibility = e.thumb ? '' : 'hidden';
    $('eSpeed').textContent = `${fmtSpeed(e.speed)} ${unitLbl()}`; $('eSpeed').style.color = e.violation ? 'var(--red)' : 'var(--green)';
    $('eMeta').textContent = `${when(e.ts)} · detected as ${e.cls} · limit ${fmtSpeed(e.limit)} · ±${fmtSpeed(e.margin)}${e.sim ? ' · SIMULATED' : ''}`;
    $('eSearch').value = ''; openModal('mEdit');
  }
  $('eSave').onclick = () => {
    const e = editing; if (!e) return;
    const ent = selectedEntry(), make = $('eMake').value;
    e.vehicle = make ? { make, model: ent ? ent.model : '', gen: ent ? ent.gen : '', from: ent ? ent.from : null, year: $('eYear').value ? +$('eYear').value : null, type: ent ? ent.type : '', len: ent ? ent.len : null, wid: ent ? ent.wid : null } : null;
    e.color = $('eColor').value; e.plate = { code: $('eCode').value.trim(), num: $('eNum').value.trim() }; e.notes = $('eNotes').value.trim();
    DB.put(e); closeModals(); onEventsChanged(true); renderRecords(); toast('Saved', 'good');
  };
  $('eDelete').onclick = () => { if (!editing) return; if (!confirm('Delete this record?')) return; DB.del(editing.id); events = events.filter(x => x !== editing); closeModals(); onEventsChanged(true); renderRecords(); };
  $('eReport').onclick = () => { $('eSave').click(); showReport(editing.id); };
  $('recBody').addEventListener('click', (e) => { const b = e.target.closest('[data-edit],[data-rep]'); if (!b) return; if (b.dataset.edit) openEdit(b.dataset.edit); else showReport(b.dataset.rep); });

  /* ---------- evidence report (unofficial) ---------- */
  function reportHtml(e) {
    const dir = e.az != null ? `${Math.round(e.az)}° ${SN.compass(e.az)}` : '—';
    return `<div class="report"><h2>Speed measurement report</h2><div class="wm">UNOFFICIAL · NOT A TRAFFIC CITATION</div>
      <div class="row sb" style="align-items:flex-start;gap:16px"><div><div class="big" style="color:${e.violation ? '#b00020' : '#116b3a'}">${fmtSpeed(e.speed)} ${unitLbl()}</div><div>Posted limit ${fmtSpeed(e.limit)} ${unitLbl()} · excess ${fmtSpeed(e.excess)} · estimated error ±${fmtSpeed(e.margin)}</div></div>${e.thumb ? `<img src="${e.thumb}" style="width:150px" alt="">` : ''}</div>
      <dl><dt>Report ID</dt><dd class="mono">${esc(e.id)}</dd><dt>Date &amp; time</dt><dd>${new Date(e.ts).toLocaleString()}</dd>
      <dt>Location</dt><dd>${esc(e.road)}${e.lat != null ? ` · ${e.lat.toFixed(5)}, ${e.lng.toFixed(5)} (±${Math.round(e.gacc || 0)} m)` : ''}</dd><dt>Camera heading</dt><dd>${dir}</dd>
      <dt>Vehicle</dt><dd>${esc(vehLabel(e))}${e.vehicle && e.vehicle.type ? ' · ' + esc(D.TYPE_LABEL[e.vehicle.type] || e.vehicle.type) : ''}</dd>
      <dt>Plate (manual entry)</dt><dd>${e.plate.code || e.plate.num ? esc(D.plateFull(e.plate.code, e.plate.num)) + ' · ' + esc(D.plateArabic(e.plate.code, e.plate.num)) : 'Not entered'}</dd>
      <dt>Measurement</dt><dd>${e.n} samples · confidence ${Math.round(e.conf * 100)}% · zone ${(+e.cal.W).toFixed(1)}×${(+e.cal.D).toFixed(0)} m · scale ${(+e.cal.factor).toFixed(2)}× · tolerance ${e.cal.tol} km/h</dd>
      <dt>Indicative fine</dt><dd>${e.violation ? e.fine + ' KWD (editable estimate, not an assessment)' : 'n/a'}</dd>${e.notes ? `<dt>Notes</dt><dd>${esc(e.notes)}</dd>` : ''}${e.sim ? '<dt>Source</dt><dd><b>SIMULATED DATA</b></dd>' : ''}</dl>
      <div class="note">Produced by RoadVision AI, an independent phone-camera tool. Speed is estimated from a camera-to-road calibration and is not certified, calibrated against a reference, or admissible as an official measurement. It is not issued by or connected to any traffic authority. Verify the posted limit and use certified equipment for enforcement.</div></div>`;
  }
  function showReport(id) { const e = events.find(x => x.id === id); if (!e) return; $('reportBody').innerHTML = reportHtml(e); $('btnPrint').onclick = () => printHtml(reportHtml(e)); openModal('mReport'); }
  function printHtml(h) { $('printarea').innerHTML = h; window.print(); }
  $('qaSummary').onclick = () => {
    const ov = events.filter(e => e.violation), top = events.reduce((m, e) => e.speed > (m ? m.speed : 0) ? e : m, null);
    printHtml(`<div class="report"><h2>Session summary</h2><div class="wm">UNOFFICIAL</div><dl><dt>Operator</dt><dd>${esc(S.op.name || '—')} · ${esc(S.op.terminal || '—')}</dd><dt>Session start</dt><dd>${new Date(R.session).toLocaleString()}</dd><dt>Measured</dt><dd>${events.length}</dd><dt>Over limit</dt><dd>${ov.length}</dd><dt>Peak speed</dt><dd>${top ? fmtSpeed(top.speed) + ' ' + unitLbl() : '—'}</dd></dl>
    <table style="width:100%;min-width:0;font-size:12px"><tr><th>Time</th><th>Plate</th><th>Vehicle</th><th>Speed</th><th>Limit</th><th>Location</th></tr>${ov.slice(0, 100).map(e => `<tr><td>${when(e.ts)}</td><td>${esc(D.plateFull(e.plate.code, e.plate.num))}</td><td>${esc(vehLabel(e))}</td><td>${fmtSpeed(e.speed)}</td><td>${fmtSpeed(e.limit)}</td><td>${esc(e.road)}</td></tr>`).join('')}</table>
    <div class="note">Independent measurement tool output – not an official record.</div></div>`);
  };
  $('qaDocket').onclick = () => showTab('records');

  /* ---------- export ---------- */
  function download(name, mime, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }
  $('btnCSV').onclick = () => {
    if (!events.length) return toast('No records to export', 'warn');
    const H = ['ID', 'Timestamp', 'Violation', 'Simulated', 'Class', 'Make', 'Model', 'Year', 'Colour', 'Plate_Code', 'Plate_Number', 'Speed_kmh', 'Margin_kmh', 'Confidence', 'Limit_kmh', 'Excess_kmh', 'Indicative_Fine_KWD', 'Location', 'Lat', 'Lng', 'Notes'];
    const q = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = events.map(e => [e.id, new Date(e.ts).toISOString(), e.violation, e.sim, e.cls, e.vehicle && e.vehicle.make, e.vehicle && e.vehicle.model, e.vehicle && e.vehicle.year, e.color, e.plate.code, e.plate.num, e.speed.toFixed(1), e.margin.toFixed(1), e.conf.toFixed(2), e.limit, e.excess.toFixed(1), e.fine, e.road, e.lat, e.lng, e.notes].map(q).join(','));
    download(`roadvision_${Date.now()}.csv`, 'text/csv;charset=utf-8', '﻿' + [H.join(','), ...rows].join('\n'));
  };
  $('btnJSON').onclick = () => { if (!events.length) return toast('No records to export', 'warn'); download(`roadvision_${Date.now()}.json`, 'application/json', JSON.stringify(events.map(e => Object.assign({}, e, { thumb: undefined })), null, 2)); };
  $('fltSearch').addEventListener('input', (e) => { fltQ = e.target.value; renderRecords(); });
  $('fltSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; fltType = b.dataset.f; $('fltSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); renderRecords(); });

  /* =========================================================
     Settings wiring
     ========================================================= */
  function bind(id, key, kind, after) {
    const el = $(id); if (!el) return;
    const get = () => kind === 'bool' ? el.checked : kind === 'num' ? parseFloat(el.value) : el.value;
    if (kind === 'bool') el.checked = !!S[key]; else el.value = S[key];
    el.addEventListener('change', () => { const v = get(); if (kind === 'num' && !(v >= 0)) return; S[key] = v; save(); after && after(v); });
  }
  bind('tol', 'tol', 'num'); bind('minConf', 'minConf', 'num'); bind('gridChk', 'grid', 'bool'); bind('audioChk', 'audio', 'bool', (v) => { if (v) chime(); });
  bind('vibChk', 'vib', 'bool', (v) => v && SN.vibrate(80)); bind('guardChk', 'guard', 'bool'); bind('autoRoad', 'autoRoad', 'bool'); bind('geoChk', 'geo', 'bool');
  bind('wakeChk', 'wake', 'bool', (v) => { if (R.src) v ? SN.wake.acquire() : SN.wake.release(); });
  bind('fpsSel', 'fps', 'num'); bind('resSel', 'camRes', 'num', () => { if (R.src === 'cam') startCamera(); });
  bind('detRes', 'detRes', 'num');
  bind('modelSel', 'model', 'str', () => { Det.initFor = null; if (R.src && R.src !== 'sim') Det.init(); });
  bind('roiChk', 'roi', 'bool'); bind('dirSel', 'dirMode', 'str', () => { renderTargets(); });
  $('hModel').addEventListener('click', () => { if (R.modelState === 'error' || R.modelState === 'idle') { Det.initFor = null; Det.init(); } });
  $('factor').value = S.factor; $('factorVal').textContent = (+S.factor).toFixed(2) + '×';
  $('factor').addEventListener('input', (e) => { S.factor = +e.target.value; $('factorVal').textContent = S.factor.toFixed(2) + '×'; R.tracker.setFactor(S.factor); });
  $('factor').addEventListener('change', save);
  $('unitSeg').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.u === S.unit); b.onclick = () => { S.unit = b.dataset.u; save(); $('unitSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); syncLimitChips(); buildRoadCards && mapReady && buildRoadCards(); refreshHud(true); renderStats(); if (currentTab === 'records') renderRecords(); if (currentTab === 'analytics') { renderRecent(); updateCharts(); } }; });
  for (const [id, k] of [['t1', 't1'], ['t2', 't2'], ['t3', 't3'], ['ta', 'a'], ['tb', 'b']]) { $(id).value = S.tariff[k]; $(id).addEventListener('change', () => { const v = parseFloat($(id).value); if (v >= 0) { S.tariff[k] = v; save(); } }); }
  $('opName').value = S.op.name; $('opTerminal').value = S.op.terminal;
  $('opName').addEventListener('input', (e) => { S.op.name = e.target.value; save(); }); $('opTerminal').addEventListener('input', (e) => { S.op.terminal = e.target.value; save(); });
  $('opStart').textContent = new Date(R.session).toLocaleString();
  $('btnClear').onclick = () => { if (!confirm('Delete ALL saved records on this device?')) return; DB.clear(); events = []; onEventsChanged(true); renderRecords(); toast('All records cleared', 'good'); };
  $('btnModelReset').onclick = async () => {
    try { indexedDB.deleteDatabase('tensorflowjs'); } catch (e) { /* ignore */ }
    Det.dispose(); Det.initFor = null; R.modelState = 'idle'; setModelChip(); toast('Model cache cleared.', 'good');
  };
  $('btnPerm').onclick = async () => { const p = await SN.requestMotionPermissions(); SN.startGPS(); SN.startMotion(p); toast('Requesting GPS and motion sensors…'); };

  /* =========================================================
     Navigation, theme, install, toast
     ========================================================= */
  let currentTab = 'live';
  function showTab(t) {
    currentTab = t;
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    document.querySelectorAll('.page').forEach(p => p.classList.toggle('on', p.id === 'p-' + t));
    if (t === 'analytics') { renderStats(); renderRecent(); ensureCharts(); }
    if (t === 'map') ensureMap();
    if (t === 'records') renderRecords();
    if (t === 'live') setTimeout(resizeCanvas, 50);
    try { history.replaceState(null, '', '#' + t); } catch (e) { /* ignore */ }
  }
  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); });

  function applyTheme() { document.documentElement.dataset.theme = S.theme; const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = S.theme === 'light' ? '#eef1f5' : '#0a0c0f'; }
  const themes = ['dark','light','midnight','aurora','graphite','neon'];
  $('themeBtn').onclick = () => { S.theme = themes[(themes.indexOf(S.theme)+1)%themes.length]; $('themeSel').value = S.theme; save(); applyTheme(); };
  $('themeSel').value = themes.includes(S.theme) ? S.theme : 'dark';
  $('themeSel').onchange = () => { S.theme = $('themeSel').value; save(); applyTheme(); };

  let toastT = 0;
  function toast(msg, kind, ms) {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show ' + (kind || '');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms || 3200);
  }

  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; $('installBtn').style.display = ''; });
  window.addEventListener('appinstalled', () => { $('installBtn').style.display = 'none'; deferredInstall = null; });
  $('installBtn').onclick = async () => { if (deferredInstall) { deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => {}); deferredInstall = null; $('installBtn').style.display = 'none'; } };
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIOS && !standalone) { $('installBtn').style.display = ''; $('installBtn').onclick = () => toast('To install: tap Share, then “Add to Home Screen”.', '', 5000); }

  $('btnStart').onclick = startCamera;
  $('btnSim').onclick = startSim;
  $('btnFile').onclick = () => $('fileIn').click();
  $('fileIn').onchange = (e) => { const f = e.target.files[0]; if (f) startFile(f); e.target.value = ''; };
  $('btnStop').onclick = stopAll;
  $('btnSnap').onclick = () => {
    if (!R.src || R.src === 'sim' && false) return toast('Start the camera first', 'warn');
    const cv = document.createElement('canvas'); cv.width = ov.width; cv.height = ov.height; const c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
    if (R.src !== 'sim' && cam.videoWidth) c.drawImage(cam, fit.ox * dpr, fit.oy * dpr, fit.dw * dpr, fit.dh * dpr);
    c.drawImage(ov, 0, 0);
    const a = document.createElement('a'); a.href = cv.toDataURL('image/jpeg', 0.92); a.download = `roadvision_snapshot_${Date.now()}.jpg`; a.click(); toast('Snapshot saved', 'good');
  };

  /* =========================================================
     Boot
     ========================================================= */
  async function boot() {
    applyTheme(); buildRoads(); buildSens(); rebuildCal(); setModelChip(); refreshHud(true); refreshSens();
    $('hFps').textContent = '— FPS';
    await DB.open(); events = (await DB.all()).sort((a, b) => b.ts - a.ts); renderStats();
    const tab = (location.hash || '').slice(1); if (['analytics', 'map', 'records', 'operator', 'settings'].includes(tab)) showTab(tab);
    (window.requestIdleCallback || setTimeout)(() => D.loadCatalog());
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
    // resume GPS silently if permission was already granted (no prompt)
    try { if (navigator.permissions) { const p = await navigator.permissions.query({ name: 'geolocation' }); if (p.state === 'granted') SN.startGPS(); } } catch (e) { /* ignore */ }
    // pause heavy work when the tab is hidden
    document.addEventListener('visibilitychange', () => { if (document.hidden) R.tracker.reset(); });
  }
  boot();
})();
