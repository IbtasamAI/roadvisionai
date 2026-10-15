/* Static data + helpers for RoadVision */
window.RVData = (function () {
  'use strict';

  // Carried over from the original app (radar post names kept as location labels).
  const ROADS = {
    gulf_road:      { name: 'Arabian Gulf Road',              limit: 80,  lat: 29.3802, lng: 47.9892, post: 'Post AG-01' },
    jaber_causeway: { name: 'Sheikh Jaber Causeway',          limit: 100, lat: 29.4580, lng: 47.9250, post: 'Post JC-09' },
    fifth_ring:     { name: 'Fifth Ring Road',                limit: 80,  lat: 29.3080, lng: 47.9850, post: 'Post R5-14' },
    sixth_ring:     { name: 'Sixth Ring Road',                limit: 120, lat: 29.2710, lng: 47.9400, post: 'Post R6-22' },
    king_fahd:      { name: 'King Fahd Highway (Route 40)',   limit: 120, lat: 29.2150, lng: 48.0600, post: 'Post KF-05' },
    first_ring:     { name: 'First Ring Road',                limit: 80,  lat: 29.3650, lng: 47.9700, post: 'Post R1-03' },
    subiyah:        { name: 'Subiyah Highway (Route 801)',    limit: 120, lat: 29.6200, lng: 48.1100, post: 'Post SB-11' },
    custom:         { name: 'Custom location (GPS / manual)', limit: 60,  lat: null,    lng: null,    post: 'Custom' }
  };

  // Original fine tiers (KWD). Indicative only and user-editable in Settings.
  const DEFAULT_TARIFF = { t1: 20, t2: 30, t3: 50, a: 20, b: 30 };   // excess <=a:t1, <=b:t2, >b:t3
  function fineFor(excess, tariff) {
    const t = tariff || DEFAULT_TARIFF;
    return excess > t.b ? t.t3 : excess > t.a ? t.t2 : t.t1;
  }

  const PLATE_CODES = [3, 5, 7, 11, 14, 15, 18, 20, 22];
  const COLORS = ['Pearl White', 'Metallic Black', 'Granite Gray', 'Silver Metallic', 'Crimson Red', 'Navy Blue', 'Champagne Gold', 'Desert Sand', 'Matte Gray', 'Brown', 'Green', 'Orange', 'Yellow'];

  function toArabicDigits(str) {
    const m = { 0: '٠', 1: '١', 2: '٢', 3: '٣', 4: '٤', 5: '٥', 6: '٦', 7: '٧', 8: '٨', 9: '٩' };
    return String(str).replace(/[0-9]/g, c => m[c]);
  }
  function plateFull(code, num) { return (code || num) ? `${code || '?'} / ${num || '—'}` : '—'; }
  function plateArabic(code, num) { return (code || num) ? `${toArabicDigits(code || '?')} / ${toArabicDigits(num || '—')}` : '—'; }

  const TYPE_TO_CLASS = { sedan: 'car', hatchback: 'car', coupe: 'car', convertible: 'car', suv: 'car', crossover: 'car', wagon: 'car', minivan: 'car', van: 'car', pickup: 'car', truck: 'truck', bus: 'bus', motorcycle: 'motorcycle', scooter: 'motorcycle' };
  const TYPE_LABEL = { sedan: 'Sedan', hatchback: 'Hatchback', coupe: 'Coupe', convertible: 'Convertible', suv: 'SUV', crossover: 'Crossover', wagon: 'Wagon', minivan: 'Minivan', van: 'Van', pickup: 'Pickup', truck: 'Truck', bus: 'Bus', motorcycle: 'Motorcycle', scooter: 'Scooter' };
  const FUEL_LABEL = { petrol: 'Petrol', diesel: 'Diesel', hybrid: 'Hybrid', phev: 'Plug-in hybrid', electric: 'Electric' };

  let catalog = [], byMake = {}, loaded = false, loading = null;
  function loadCatalog() {
    if (loading) return loading;
    loading = fetch('./data/vehicles.json').then(r => r.json()).then(rows => {
      catalog = rows; byMake = {};
      for (const r of rows) (byMake[r.make] = byMake[r.make] || []).push(r);
      loaded = true; return rows;
    }).catch(() => { loading = null; return []; });
    return loading;
  }
  const makes = () => Object.keys(byMake).sort((a, b) => a.localeCompare(b));
  const modelsFor = (make, year) => (byMake[make] || []).filter(r => !year || (r.from <= year && r.to >= year));
  const search = (q, limit = 30) => {
    q = q.toLowerCase().trim(); if (!q) return [];
    const toks = q.split(/\s+/);
    const out = [];
    for (const r of catalog) {
      const hay = (r.make + ' ' + r.model + ' ' + r.gen).toLowerCase();
      if (toks.every(t => hay.includes(t))) { out.push(r); if (out.length >= limit) break; }
    }
    return out;
  };
  const vehicleLabel = (v) => v ? [v.year, v.make, v.model].filter(Boolean).join(' ') : '';

  return { ROADS, DEFAULT_TARIFF, fineFor, PLATE_CODES, COLORS, toArabicDigits, plateFull, plateArabic, TYPE_TO_CLASS, TYPE_LABEL, FUEL_LABEL,
    loadCatalog, makes, modelsFor, search, vehicleLabel, get catalog() { return catalog; }, get loaded() { return loaded; } };
})();
