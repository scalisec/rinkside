/* Offline copy of the app. (Music lives in IndexedDB, not here.)

   - Each release is saved as one complete copy (VERSION). A new copy is downloaded in full and
     checked before it's used: if any file is missing, was redirected, or isn't the kind of file
     expected (for example a rink wifi "accept terms" page answering instead of GitHub), the
     update is skipped and the current version keeps working.
   - The app always opens straight from the saved copy, so weak wifi can't hold it up. A new
     version downloads in the background and is used the next time the app is opened (or, for a
     quiet release, as soon as the app is on screen with nothing playing; see activate below).

   Bump VERSION whenever you change app files. */
const VERSION = 'rinkside-v57';
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
    // A release marked "quiet": true in release-notes.json (small, behind-the-scenes changes) sends a
    // different message: versions before 3.1.2 ignore it (no banner; the new version is used the next
    // time the app is opened), and 3.1.2 and later switch over by themselves when nothing is playing.
    let quiet = false;
    try { const r = await caches.match(new URL('release-notes.json', self.location).href, { cacheName: VERSION }); quiet = !!(await r.json())[0].quiet; } catch (err) {}
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: quiet ? 'rinkside-updated-quiet' : 'rinkside-updated', version: VERSION });
  })());
});

const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 3.11: opening the app is sturdier. Before, if the saved copy couldn't be read for a moment (it has
   happened twice: a tablet at the rink and a computer, both fine after closing and reopening) and the
   internet didn't answer in 8 seconds, Chrome showed "This site can't be reached". Now: look in the saved
   copy twice, then the internet, then the saved copy once more; if the app page still can't be opened,
   show a small Rinkside page that tries again by itself. What went wrong is noted (the last 5 times, on this
   device only) and shown at the bottom of Help, so the cause can be found. */
const DIAG = 'diag-rinkside'; // not 'rinkside-…', so a new version doesn't delete it
const DIAG_KEY = HOME + '__diag.json';
async function note(what) {
  try {
    const c = await caches.open(DIAG);
    let list = [];
    try { const r = await c.match(DIAG_KEY); if (r) list = await r.json(); } catch (e) {}
    list = [{ at: new Date().toISOString(), what: String(what).slice(0, 200), v: VERSION }, ...(Array.isArray(list) ? list : [])].slice(0, 5);
    await c.put(DIAG_KEY, new Response(JSON.stringify(list), { headers: { 'content-type': 'application/json' } }));
  } catch (e) {}
}
// one look in the saved copy (this version first, then any): the response, null if it isn't there; throws if the look itself failed
async function lookSaved(key) {
  return await caches.match(key, { ignoreSearch: true, cacheName: VERSION }) || await caches.match(key, { ignoreSearch: true }) || null;
}
async function fromSaved(keys, tries, problems) {
  for (let i = 0; i < tries; i++) {
    for (const k of keys) {
      try { const r = await lookSaved(k); if (r) return r; }
      catch (err) { problems.push('saved copy: ' + (err && err.message || err)); }
    }
    if (i < tries - 1) await sleep(250);
  }
  return null;
}
// shown instead of Chrome's or Safari's error page; tries again by itself (3 times), then waits for a tap
const STARTING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rinkside DJ</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b131a;color:#e8eef3;font:17px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
main{max-width:440px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{margin:8px 0;color:#b5c3cf}button{margin-top:16px;font:inherit;font-weight:700;padding:14px 28px;border-radius:999px;border:0;background:#e5352b;color:#fff}
ol{text-align:left;color:#b5c3cf;padding-left:22px}</style></head><body><main>
<h1>Rinkside is starting…</h1><p id="msg">It didn't open on the first try. Trying again…</p>
<button id="again" type="button">Try again</button>
<ol id="tips" hidden><li>Close Rinkside completely, then open it again from its icon.</li><li>Still not opening? Turn on wifi or data for a moment, then open it again.</li><li>Your music and buttons are still saved on this device.</li></ol>
</main><script>
var n=0;try{n=+sessionStorage.getItem('rinksideRetry')||0}catch(e){}
function go(){try{sessionStorage.setItem('rinksideRetry',String(n+1))}catch(e){}location.reload()}
document.getElementById('again').onclick=function(){n=0;go()};
if(n<3)setTimeout(go,1500);else{document.getElementById('msg').textContent="It still didn't open.";document.getElementById('tips').hidden=false}
</script></body></html>`;
const startingPage = () => new Response(STARTING, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" } });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // only the app's own files: never Google Drive downloads or sign-in (songs are stored in IndexedDB)
  if (url.origin !== self.location.origin || !url.href.startsWith(HOME)) return;
  // the full guide (guide/) is a normal web page, updated without a new app version: never the app's saved copy
  if (url.href.startsWith(HOME + 'guide/')) return;
  const nav = req.mode === 'navigate';
  // the app page is saved as both "./" and "index.html"
  const keys = nav ? [HOME, HOME + 'index.html'] : [url.href.split('#')[0]];
  e.respondWith((async () => {
    const problems = [];
    const saved = await fromSaved(keys, 2, problems);
    if (saved) { if (problems.length && nav) await note('opened on the second look: ' + problems[0]); return saved; } // instant, whatever the wifi is doing
    // not in the saved copy (first visit, or a file the app doesn't need offline): network, but never hang
    try { const r = await timeout(fetch(req), nav ? 12000 : 8000); if (nav) await note('saved copy missing, opened from the internet' + (problems.length ? ': ' + problems[0] : '')); return r; }
    catch (err) { problems.push('internet: ' + (err && err.message || err)); }
    const late = await fromSaved(keys, 1, problems); // one last look
    if (late) { if (nav) await note('opened on the last look: ' + problems.join('; ')); return late; }
    if (!nav) return Response.error();
    await note('could not open: ' + (problems.join('; ') || 'no saved copy, no internet'));
    return startingPage();
  })().catch(async err => { if (nav) { await note('could not open: ' + (err && err.message || err)); return startingPage(); } return Response.error(); }));
});
