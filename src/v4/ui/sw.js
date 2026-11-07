/**
 * MAJIN V4 service worker.
 *
 * Caches the app shell only. API responses, conversation content, pairing
 * state and session cookies are never cached — a shared or public cache must
 * not hold private conversation data.
 */
// Bump this whenever the shell changes: an installed PWA otherwise keeps the
// old HTML/CSS/JS until every cache entry expires independently.
const VERSION = 'majin-v4-shell-15';
const SHELL = [
  '/',
  '/index.html',
  '/app.css?v=15',
  '/app.js?v=15',
  '/spirit.js?v=15',
  '/voice.js?v=15',
  '/recorder.js?v=15',
  '/strings.js?v=15',
  '/session.js?v=15',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let message;try{message=event.data?.json();}catch{return;}
    if(!message||typeof message.id!=='string')return;
    const target=new URL(message.url||'/',self.location.origin);
    if(target.origin!==self.location.origin)return;
    await self.registration.showNotification(String(message.title||'MAJIN').slice(0,80),{
      body:String(message.body||'Your task has an update.').slice(0,160),
      icon:'/icons/icon-192.png',tag:message.id,renotify:false,data:{url:target.href},
    });
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const target=new URL(event.notification.data?.url||'/',self.location.origin);
    if(target.origin!==self.location.origin)return;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const client=windows.find(w=>new URL(w.url).origin===target.origin);
    if(client){await client.navigate(target.href);await client.focus();}else await self.clients.openWindow(target.href);
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept API traffic: it carries private data and must be live.
  // That includes uploads and their previews — caching them would leave the
  // owner's photos in a shared cache after logout.
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.open(VERSION).then((cache) => cache.match('/index.html')).then((r) => r || Response.error())),
    );
    return;
  }

  if (!SHELL.includes(url.pathname + url.search)) return;
  // Mutable shell code must be fresh online. Read only this worker's cache:
  // an old in-flight worker can recreate an obsolete cache after activation.
  event.respondWith(caches.open(VERSION).then(async (cache) => {
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      return await cache.match(request) || Response.error();
    }
  }));
});
