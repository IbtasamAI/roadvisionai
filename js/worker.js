/* Detection worker: TF.js + COCO-SSD off the main thread. */
let model = null, ready = false;
const KEEP = { car: 1, truck: 1, bus: 1, motorcycle: 1 };
function post(type, extra) { self.postMessage(Object.assign({ type }, extra || {})); }

// 'local' = model bundled with the app (no external download); 'lite' = small online model (cached on device)
async function loadOne(kind) {
  if (kind === 'local') return cocoSsd.load({ base: 'mobilenet_v2', modelUrl: '../models/coco/model.json' });
  const key = 'indexeddb://rv-lite';
  try { const l = await tf.io.listModels(); if (l[key]) return await cocoSsd.load({ base: 'lite_mobilenet_v2', modelUrl: key }); } catch (e) { /* download below */ }
  const m = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  try { await m.model.save(key); } catch (e) { /* cache optional */ }
  return m;
}

async function init(opts) {
  try {
    // TF.js is strict-mode and assigns the undeclared global `regeneratorRuntime`; without this pre-declared
    // property it falls back to Function(...), which our CSP (no 'unsafe-eval') blocks and the whole bundle aborts.
    if (!('regeneratorRuntime' in self)) self.regeneratorRuntime = undefined;
    importScripts('../vendor/tf/tf.min.js', '../vendor/tf/coco-ssd.min.js');
    let backend = 'cpu';
    for (const b of ['webgl', 'cpu']) { try { if (await tf.setBackend(b)) { backend = b; break; } } catch (e) { /* next */ } }
    await tf.ready();
    const order = opts.model === 'lite' ? ['lite', 'local'] : ['local', 'lite'];
    const errs = [];
    for (const k of order) {
      try { post('status', { msg: k === 'local' ? 'Loading built-in model…' : 'Downloading lite model…' }); model = await loadOne(k); post('which', { kind: k }); break; }
      catch (e) { errs.push(k + ': ' + (e && e.message || e)); model = null; }
    }
    if (!model) throw new Error(errs.join(' | '));
    const c = new OffscreenCanvas(320, 240); c.getContext('2d').fillRect(0, 0, 320, 240);
    await model.detect(c, 3, 0.3);                                    // warm-up
    ready = true; post('ready', { backend });
  } catch (e) { post('error', { msg: String(e && e.message || e) }); }
}

async function detect(msg) {
  if (!ready) { if (msg.bitmap && msg.bitmap.close) msg.bitmap.close(); post('result', { id: msg.id, t: msg.t, dets: [], skipped: true }); return; }
  const t0 = performance.now();
  try {
    const bm = msg.bitmap, W = bm.width, H = bm.height;
    const preds = await model.detect(bm, 25, msg.minScore || 0.3);
    if (bm.close) bm.close();
    const dets = [];
    for (const p of preds) {
      if (!KEEP[p.class]) continue;
      const [x, y, w, h] = p.bbox;
      dets.push({ x: x / W, y: y / H, w: w / W, h: h / H, cls: p.class, score: p.score });
    }
    post('result', { id: msg.id, t: msg.t, dets, ms: performance.now() - t0 });
  } catch (e) { post('result', { id: msg.id, t: msg.t, dets: [], err: String(e && e.message || e) }); }
}
self.onmessage = (e) => { const m = e.data; if (m.type === 'init') init(m); else if (m.type === 'detect') detect(m); };
