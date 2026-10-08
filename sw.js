/* Offline copy of the app. (Music lives in IndexedDB, not here.)

   - Each release is saved as one complete copy (VERSION). A new copy is downloaded in full and
     checked before it's used: if any file is missing, was redirected, or isn't the kind of file
     expected (for example a rink wifi "accept terms" page answering instead of GitHub), the
     update is skipped and the current version keeps working.
   - The app always opens straight from the saved copy, so weak wifi can't hold it up. A new
     version downloads in the background and is used the next time the app is opened.

   Bump VERSION whenever you change app files. */
const VERSION = 'rinkside-v25';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'version.js', 'manifest.webmanifest', 'icon.svg', 'show.json', 'release-notes.json',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  'fonts/barlow-latin-400-normal.woff2', 'fonts/barlow-latin-500-normal.woff2', 'fonts/barlow-latin-600-normal.woff2',
  'fonts/barlow-latin-700-normal.woff2', 'fonts/barlow-condensed-latin-600-normal.woff2', 'fonts/barlow-condensed-latin-700-normal.woff2'];
const HOME = new URL('./', self.location).href;
// what each kind of file must say it is
const TYPES = { html: 'text/html', js: 'javascript', css: 'text/css', json: 'json', webmanifest: 'json', svg: 'image/svg', png: 'image/png', woff2: 'font' };

async function fetchChecked(path) {
  const url = new URL(path, self.location).href;
  const res = await fetch(url, { cache: 'reload' });
  const ext = url.endsWith('/') ? 'html' : url.split('?')[0].split('.').pop();
  const type = res.headers.get('content-type') || '';
  if (!res.ok || res.redirected || res.type !== 'basic' || new URL(res.url).origin !== self.location.origin) throw new Error('bad response: ' + url);
  if (TYPES[ext] && !type.includes(TYPES[ext])) throw new Error('unexpected type for ' + url + ': ' + type);
  if (ext === 'html' && !(await res.clone().text()).includes('app.js')) throw new Error('not the app page: ' + url);
  return res;
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    // all or nothing: fetch and check every file before saving any of them
    const files = await Promise.all(SHELL.map(async p => [new URL(p, self.location).href, await fetchChecked(p)]));
    const cache = await caches.open(VERSION);
    await Promise.all(files.map(([url, res]) => cache.put(url, res)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('rinkside-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'rinkside-updated', version: VERSION });
  })());
});

const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // only the app's own files: never Google Drive downloads or sign-in (songs are stored in IndexedDB)
  if (url.origin !== self.location.origin || !url.href.startsWith(HOME)) return;
  e.respondWith((async () => {
    const key = req.mode === 'navigate' ? HOME : url.href.split('#')[0];
    const saved = await caches.match(key, { ignoreSearch: true, cacheName: VERSION }) || await caches.match(key, { ignoreSearch: true });
    if (saved) return saved; // instant, whatever the wifi is doing
    // not in the saved copy (first visit, or a file the app doesn't need offline): network, but never hang
    try { return await timeout(fetch(req), 8000); }
    catch (err) { return Response.error(); }
  })());
});
