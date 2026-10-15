const V='rv-v5-2026',SHELL=['./','./index.html','./css/app.css','./js/core.js','./js/data.js','./js/sensors.js','./js/app.js','./js/worker.js','./data/vehicles.json','./manifest.webmanifest','./icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./vendor/leaflet/leaflet.js','./vendor/leaflet/leaflet.css','./vendor/chart.umd.js','./vendor/tf/tf.min.js','./vendor/tf/coco-ssd.min.js','./fonts/barlow-condensed-latin-700-normal.woff2','./fonts/barlow-condensed-latin-600-normal.woff2','./fonts/barlow-latin-400-normal.woff2','./fonts/barlow-latin-500-normal.woff2','./fonts/barlow-latin-600-normal.woff2','./fonts/jetbrains-mono-latin-400-normal.woff2','./fonts/jetbrains-mono-latin-500-normal.woff2'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
 const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);if(u.search.indexOf('v=')>-1)return;   // cache-busted reloads go straight to the network
 if(u.origin===location.origin){
  // stale-while-revalidate for app files; cache-first is fine for versioned vendor/fonts
  const stat=/\/(vendor|fonts|icons|models)\//.test(u.pathname);
  e.respondWith(caches.open(V).then(async c=>{const hit=await c.match(r,{ignoreSearch:true});
   if(hit&&stat)return hit;                       // immutable assets: cache-first, no revalidation
   // app code (html/js/css/json): network first so a new deploy is never mixed with stale files; cache is the offline fallback
   try{const res=await fetch(r);if(res.ok&&res.status===200)c.put(r,res.clone());return res}catch(x){if(hit)return hit;throw x}}));
 } else if(/tile\.openstreetmap\.org/.test(u.host)){
  e.respondWith(caches.open('rv-tiles').then(async c=>{const hit=await c.match(r);if(hit)return hit;try{const res=await fetch(r);if(res.ok)c.put(r,res.clone());return res}catch(x){return hit||Response.error()}}));
 }
});
