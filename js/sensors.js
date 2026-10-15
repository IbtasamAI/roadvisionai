/* Phone sensors: GPS, orientation, motion, wake lock, network, battery, vibration. */
window.RVSensors = (function () {
  'use strict';
  const S = {
    gps: { state: 'off', lat: null, lng: null, acc: null, speed: null, heading: null, ts: 0, err: '' },
    orient: { state: 'off', heading: null, pitch: null, roll: null, absolute: false },
    motion: { state: 'off', stable: true, level: 0, rot: 0, acc: 0 },
    wake: { state: 'off' },
    net: { online: navigator.onLine, type: '', downlink: null, rtt: null, saveData: false },
    battery: { level: null, charging: null }
  };
  const subs = new Set();
  const emit = () => subs.forEach(f => { try { f(S); } catch (e) { /* ignore */ } });
  let gpsId = null, wl = null, unstableUntil = 0, rotEma = 0, accEma = 0, lastMotionTs = 0;

  /* ---- GPS ---- */
  function startGPS() {
    if (!('geolocation' in navigator)) { S.gps.state = 'unsupported'; emit(); return; }
    if (gpsId != null) return;
    S.gps.state = 'searching'; emit();
    gpsId = navigator.geolocation.watchPosition(p => {
      const c = p.coords;
      Object.assign(S.gps, { state: 'on', lat: c.latitude, lng: c.longitude, acc: c.accuracy, speed: c.speed, heading: c.heading, ts: p.timestamp, err: '' });
      emit();
    }, err => {
      S.gps.state = err.code === 1 ? 'denied' : 'error'; S.gps.err = err.message; emit();
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  function stopGPS() { if (gpsId != null) navigator.geolocation.clearWatch(gpsId); gpsId = null; S.gps.state = 'off'; emit(); }
  /** Phone itself is travelling (in a car, etc.) – speed readings from a moving camera are invalid. */
  const phoneMoving = () => S.gps.state === 'on' && S.gps.speed != null && S.gps.speed > 2.5 && (S.gps.acc == null || S.gps.acc < 40) && Date.now() - S.gps.ts < 6000;

  /* ---- orientation ---- */
  function onOrient(e) {
    let alpha = e.alpha, beta = e.beta, gamma = e.gamma;
    if (beta == null || gamma == null) return;
    let abs = e.absolute === true || e.type === 'deviceorientationabsolute';
    if (typeof e.webkitCompassHeading === 'number') { alpha = (360 - e.webkitCompassHeading) % 360; abs = true; }
    if (alpha == null) alpha = 0;
    const r = Math.PI / 180, a = alpha * r, b = beta * r, g = gamma * r;
    const c3 = [Math.cos(a) * Math.sin(g) + Math.sin(a) * Math.sin(b) * Math.cos(g),
                Math.sin(a) * Math.sin(g) - Math.cos(a) * Math.sin(b) * Math.cos(g),
                Math.cos(b) * Math.cos(g)];
    const d = [-c3[0], -c3[1], -c3[2]];                      // rear-camera direction in earth frame (E, N, Up)
    const o = S.orient;
    o.heading = (Math.atan2(d[0], d[1]) / r + 360) % 360;
    o.pitch = Math.asin(Math.max(-1, Math.min(1, d[2]))) / r;
    o.roll = gamma; o.absolute = abs; o.state = 'on';
  }
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (deg) => COMPASS[Math.round(deg / 22.5) % 16];

  /* ---- motion / shake guard ---- */
  function onMotion(e) {
    const now = performance.now();
    if (now - lastMotionTs < 40) return; lastMotionTs = now;
    const r = e.rotationRate, a = e.acceleration, ag = e.accelerationIncludingGravity;
    let rot = r ? Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0) : 0;
    let acc = 0;
    if (a && a.x != null) acc = Math.hypot(a.x, a.y, a.z);
    else if (ag && ag.x != null) acc = Math.abs(Math.hypot(ag.x, ag.y, ag.z) - 9.81);
    rotEma += 0.25 * (rot - rotEma); accEma += 0.25 * (acc - accEma);
    const m = S.motion;
    m.rot = rotEma; m.acc = accEma; m.state = 'on';
    m.level = Math.min(1, Math.max(rotEma / 12, accEma / 0.6));
    if (rotEma > 6 || accEma > 0.35) unstableUntil = now + 500;
    m.stable = now > unstableUntil;
  }

  let sensorsOn = false;
  async function requestMotionPermissions() {
    // Must be called synchronously from a user gesture (iOS).
    const res = { orient: 'granted', motion: 'granted' };
    const reqs = [];
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function')
      reqs.push(DeviceOrientationEvent.requestPermission().then(v => res.orient = v).catch(() => res.orient = 'denied'));
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function')
      reqs.push(DeviceMotionEvent.requestPermission().then(v => res.motion = v).catch(() => res.motion = 'denied'));
    await Promise.all(reqs);
    return res;
  }
  function startMotion(perm) {
    if (sensorsOn) return; sensorsOn = true;
    if (perm.orient === 'granted' && 'DeviceOrientationEvent' in window) {
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      window.addEventListener('deviceorientation', e => { if (!S.orient.absolute || typeof e.webkitCompassHeading === 'number') onOrient(e); }, true);
      S.orient.state = 'waiting';
    } else S.orient.state = perm.orient === 'denied' ? 'denied' : 'unsupported';
    if (perm.motion === 'granted' && 'DeviceMotionEvent' in window) {
      window.addEventListener('devicemotion', onMotion, true); S.motion.state = 'waiting';
    } else S.motion.state = perm.motion === 'denied' ? 'denied' : 'unsupported';
    // desktop browsers expose the API but never fire events
    setTimeout(() => {
      if (S.orient.state === 'waiting') S.orient.state = 'unsupported';
      if (S.motion.state === 'waiting') S.motion.state = 'unsupported';
      emit();
    }, 2500);
    emit();
  }

  /* ---- wake lock ---- */
  async function acquireWake() {
    try {
      if (!('wakeLock' in navigator)) { S.wake.state = 'unsupported'; emit(); return; }
      wl = await navigator.wakeLock.request('screen');
      S.wake.state = 'on'; wl.addEventListener('release', () => { S.wake.state = 'off'; emit(); });
    } catch (e) { S.wake.state = 'error'; }
    emit();
  }
  function releaseWake() { if (wl) { wl.release().catch(() => {}); wl = null; } S.wake.state = 'off'; emit(); }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.wake.want && !wl) acquireWake(); });

  /* ---- network + battery ---- */
  function readNet() {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    S.net.online = navigator.onLine;
    if (c) Object.assign(S.net, { type: c.effectiveType || '', downlink: c.downlink, rtt: c.rtt, saveData: !!c.saveData });
    emit();
  }
  window.addEventListener('online', readNet); window.addEventListener('offline', readNet);
  (navigator.connection || {}).onchange = readNet;
  if (navigator.getBattery) navigator.getBattery().then(b => {
    const u = () => { S.battery.level = b.level; S.battery.charging = b.charging; emit(); };
    b.addEventListener('levelchange', u); b.addEventListener('chargingchange', u); u();
  }).catch(() => {});
  readNet();

  function vibrate(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) { /* ignore */ } }

  return {
    state: S, on: f => { subs.add(f); return () => subs.delete(f); },
    startGPS, stopGPS, phoneMoving, requestMotionPermissions, startMotion,
    wake: { acquire: () => { S.wake.want = true; return acquireWake(); }, release: () => { S.wake.want = false; releaseWake(); } },
    vibrate, compass, readNet
  };
})();
