/* Rinkside Soundboard
 * A touch-first game-day soundboard for hockey. Runs in Chrome on a tablet,
 * phone or PC. No server, no accounts, no libraries.
 *
 * Everything about a show (tabs, buttons, cut points, playlists, Game Day
 * groupings, teams and logos) lives in one "show" object that is saved on the
 * device and can be exported as a small layout file (.rinkside.json) or as a
 * full show pack that includes the music (.rinkpack).
 *
 * File layout (search for the "====" banners):
 *   1. CONFIG         defaults you might change
 *   2. STORAGE        IndexedDB (show + music) and localStorage (small settings)
 *   3. SHOW           the show data and helpers to find things in it
 *   4. MUSIC LIBRARY  matches song files on the device to buttons
 *   5. TEAMS
 *   6. GAME DAY       builds the Game Day screen from the show's groupings
 *   7. AUDIO ENGINE   playing, fading, playlists
 *   8. UI             tabs, buttons, now-playing panel
 *   9. EDIT MODE      editors for buttons, playlists, tabs, groupings, teams
 *  10. SHARING        layout files and show packs
 *  11. SETTINGS, HELP, STARTUP
 */
'use strict';

/* ==================================================================== 1. CONFIG */

const DEFAULTS = {
  fadeSeconds: 2.5,        // "Fade out all" and the fade applied to other sounds in One-at-a-time mode
  playlistXfade: 4,        // overlap between songs when a playlist moves on by itself
  oneAtATime: true,        // true: a new sound fades out whatever is playing. false: sounds layer.
  masterVolume: 1,
  playlistAuto: true,      // playlists continue to the next song by themselves
  playlistShuffle: false,
  skipPlayed: true,        // playlists and random buttons prefer songs not played yet this game
  team: null,              // selected team id
  locked: false,           // volunteer lock hides settings and editing
  driveFolder: '',         // Settings › Drive connection: overrides DRIVE.folder on this device
  driveClient: '',         // Settings › Drive connection: overrides DRIVE.clientId on this device
  driveApi: '',            // testing only: a stand-in for Google's server
  driveAuth: '',           // testing only: a stand-in for Google's sign-in page
  driveUpload: '',         // testing only: a stand-in for Google's upload server
  driveEditor: false,      // the signed-in Google account can edit the Drive folder (organizer): shows Publish to Drive
  localEdits: false,       // this device's layout was edited since it last came from (or went to) Drive
  driveLayout: null,       // { id, name, modifiedTime } of the last layout loaded from Drive
};

const APP_VERSION = '2.5.0';

/* Google Drive sync (Settings › Get Most Recent Updates).
   folder:   the Drive folder holding the layout file (.rinkside.json) and the music folders.
   clientId: a Google OAuth client ID ("Web application"). With it, people sign in with their
             own Google account and can only download the folder if it's shared with them.
             Access stays under your control: share or un-share the folder person by person. */
const DRIVE = {
  folder: '1Yme-C_z7clr8pQZ7nYsY5grGmgk_SL_v',
  clientId: '158874226220-itgi60humint1n9hgle5ki0u9cm5oshe.apps.googleusercontent.com',
  api: 'https://www.googleapis.com/drive/v3/',
  upload: 'https://www.googleapis.com/upload/drive/v3/',
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  scope: 'https://www.googleapis.com/auth/drive.readonly', // everyone: read the shared folder
  writeScope: 'https://www.googleapis.com/auth/drive',     // organizer only, asked for when publishing
};

const DEFAULT_SHOW_URL = 'show.json'; // built-in show for the hosted version
const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|flac|opus|webm)$/i;
// buttons whose names match this appear under "All goal horns" and in the goal horn pickers
const GOAL_HORN = { include: /goal horn|^home goal/i, exclude: /visitor/i };
const SWATCHES = ['#e53a2f', '#f07c2a', '#f0b43c', '#f3e45a', '#2f9e5b', '#7fd89a', '#5fc6ea', '#3563d8',
  '#8a5cf6', '#e056b5', '#dcbeff', '#8b95a1', '#4d4d4d', '#ffffff'];

/* ==================================================================== 2. STORAGE */

const Store = {
  db: null,
  async open() {
    if (!('indexedDB' in window)) return;
    try {
      this.db = await new Promise((res, rej) => {
        const r = indexedDB.open('rinkside', 1);
        r.onupgradeneeded = () => {
          r.result.createObjectStore('kv');
          r.result.createObjectStore('audio');
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } catch (e) { console.warn('IndexedDB unavailable', e); this.db = null; }
  },
  _req(store, mode, fn) {
    if (!this.db) return Promise.resolve(undefined);
    return new Promise((res, rej) => {
      const tx = this.db.transaction(store, mode);
      const r = fn(tx.objectStore(store));
      tx.oncomplete = () => res(r && r.result);
      tx.onerror = () => rej(tx.error);
      tx.onabort = () => rej(tx.error);
    });
  },
  get(store, key) { return this._req(store, 'readonly', s => s.get(key)).catch(() => undefined); },
  put(store, key, val) { return this._req(store, 'readwrite', s => s.put(val, key)); },
  del(store, key) { return this._req(store, 'readwrite', s => s.delete(key)).catch(() => {}); },
  keys(store) { return this._req(store, 'readonly', s => s.getAllKeys()).then(k => k || []).catch(() => []); },
  clear(store) { return this._req(store, 'readwrite', s => s.clear()).catch(() => {}); },
  // every key with the size of what's stored under it (songs are Blobs; reading .size doesn't load them)
  sizes(store) {
    if (!this.db) return Promise.resolve([]);
    return new Promise(res => {
      const out = [];
      try {
        const tx = this.db.transaction(store, 'readonly');
        const r = tx.objectStore(store).openCursor();
        r.onsuccess = () => { const c = r.result; if (c) { out.push({ key: c.key, size: c.value?.size || 0 }); c.continue(); } };
        tx.oncomplete = () => res(out);
        tx.onerror = tx.onabort = () => res(out);
      } catch (e) { res(out); }
    });
  },
};

const Prefs = {
  load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('rinkside.settings') || '{}'); } catch (e) {}
    return { ...DEFAULTS, ...saved };
  },
  save() { try { localStorage.setItem('rinkside.settings', JSON.stringify(settings)); } catch (e) {} },
  loadPlayed() {
    try { return new Set(JSON.parse(localStorage.getItem('rinkside.played') || '[]')); } catch (e) { return new Set(); }
  },
  savePlayed() { try { localStorage.setItem('rinkside.played', JSON.stringify([...played])); } catch (e) {} },
};

// set up before this page load? (checked before anything is saved; used for the one-time "what's new")
const HAD_SETTINGS = (() => { try { return !!localStorage.getItem('rinkside.settings'); } catch (e) { return false; } })();
let settings = Prefs.load();
let played = Prefs.loadPlayed(); // song file keys played this game

/* ==================================================================== 3. SHOW */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = p => String(p || '').normalize('NFC').replace(/\\/g, '/').replace(/\s+/g, ' ').trim().toLowerCase();
const keyOf = s => norm(s.file);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const fmt = s => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};
const hexLight = hex => {
  if (!hex || hex[0] !== '#') return false;
  const n = parseInt(hex.slice(1, 7), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55;
};
// Only plain #rrggbb-style colours and embedded images (data:image/…;base64) are allowed in a layout.
const safeColor = (c, fallback) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim()) ? c.trim() : fallback);
const safeImage = u => (typeof u === 'string' && u.length < 2e6 && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(u) ? u : null);
const prettyName = filename => filename.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

let show = null;
const idx = { items: new Map(), sounds: new Map(), playlists: new Map(), tabOf: new Map() };

const Show = {
  blank() {
    return {
      format: 'rinkside-show', version: 1, name: 'My Game Day Show',
      teams: [{ id: 'home', name: 'Home', full: 'Home team', color: '#e4492f', shape: 'round', logo: null, goalHorn: null, pregame: null, game: null }],
      gameday: {
        situations: [{ label: 'Penalty', prefix: 'Penalty', color: '#d9342b' }, { label: 'Icing', prefix: 'Icing', color: '#5fc6ea' },
          { label: 'Offside', prefix: 'Offside', color: '#f0b43c' }],
        moments: [],
        endings: [{ label: 'Home win', prefix: 'Home Win', color: '#2f9e5b' }, { label: 'Visitor win', prefix: 'Visitor Win', color: '#8b95a1' }],
      },
      tabs: [{ id: uid(), name: 'In Game', color: '#3563d8', items: [] }],
    };
  },
  /* Fills in anything missing so older or hand-edited files still load, and checks every value
     a layout file can carry before it goes on screen: text stays text, colours must be colours,
     logos must be embedded images, and unknown kinds of buttons are dropped. A layout file can come
     from anywhere (a download, a zip, someone's email), so nothing in it is trusted. */
  normalise(s) {
    if (!s || s.format !== 'rinkside-show' || !Array.isArray(s.tabs)) throw new Error('not a show');
    const str = (v, d, max = 200) => (typeof v === 'string' && v.trim() ? v : d).slice(0, max);
    const num = (v, d = 0) => (Number.isFinite(+v) && +v >= 0 ? +v : d);
    const id = v => (typeof v === 'string' || typeof v === 'number') && String(v).length <= 64 ? String(v) : uid();
    s.name = str(s.name, 'Game Day Show');
    s.teams = (Array.isArray(s.teams) && s.teams.length ? s.teams : Show.blank().teams).filter(t => t && typeof t === 'object');
    if (!s.teams.length) s.teams = Show.blank().teams;
    s.teams.forEach(t => {
      t.id = id(t.id); t.name = str(t.name, 'Team', 40); t.full = str(t.full, t.name, 80);
      t.color = safeColor(t.color, '#3563d8'); t.shape = t.shape === 'square' ? 'square' : 'round'; t.logo = safeImage(t.logo);
      for (const f of ['goalHorn', 'pregame', 'game']) t[f] = t[f] == null ? null : id(t[f]);
    });
    const gd = s.gameday && typeof s.gameday === 'object' ? s.gameday : {};
    const groups = list => (Array.isArray(list) ? list : []).filter(g => g && typeof g === 'object')
      .map(g => ({ label: str(g.label, '', 60), prefix: str(g.prefix, '', 60), color: safeColor(g.color, '#8b95a1') }));
    s.gameday = { situations: groups(gd.situations), moments: (Array.isArray(gd.moments) ? gd.moments : []).map(m => str(m, '', 60)), endings: groups(gd.endings) };
    s.tabs = s.tabs.filter(t => t && typeof t === 'object');
    for (const tab of s.tabs) {
      tab.id = id(tab.id); tab.name = str(tab.name, 'Tab', 60); tab.color = safeColor(tab.color, null);
      tab.items = (Array.isArray(tab.items) ? tab.items : []).filter(it => it && ['sound', 'playlist', 'next'].includes(it.type));
      for (const it of tab.items) {
        it.id = id(it.id); it.name = str(it.name, it.type === 'next' ? 'Next song' : 'Untitled', 200); it.color = safeColor(it.color, null);
        if (it.type === 'sound') {
          it.file = str(it.file, '', 400); it.start = num(it.start); it.stop = num(it.stop); it.length = num(it.length);
          it.volume = Math.min(1.5, num(it.volume ?? 1, 1));
        }
        if (it.type === 'playlist') it.songs = (Array.isArray(it.songs) ? it.songs : []).map(id);
      }
    }
    return s;
  },
  reindex() {
    idx.items.clear(); idx.sounds.clear(); idx.playlists.clear(); idx.tabOf.clear();
    for (const tab of show.tabs) for (const it of tab.items) {
      idx.items.set(it.id, it); idx.tabOf.set(it.id, tab);
      if (it.type === 'sound') idx.sounds.set(it.id, it);
      if (it.type === 'playlist') idx.playlists.set(it.id, it);
    }
  },
  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => Store.put('kv', 'show', show).catch(() => {}), 250);
  },
  changed() { this.reindex(); this.save(); },
  playlistSongs(pl) { return pl.songs.map(id => idx.sounds.get(id)).filter(Boolean); },
  uniqueSounds() {
    const seen = new Set();
    return [...idx.sounds.values()].filter(s => { const k = keyOf(s); return !seen.has(k) && seen.add(k); });
  },
  tab(id) { return show.tabs.find(t => t.id === id); },
  removeItem(id) {
    const tab = idx.tabOf.get(id);
    if (tab) tab.items = tab.items.filter(i => i.id !== id);
    for (const pl of idx.playlists.values()) pl.songs = pl.songs.filter(s => s !== id);
    for (const t of show.teams) for (const f of ['goalHorn', 'pregame', 'game']) if (t[f] === id) t[f] = null;
    for (const tr of [...tracks]) if (tr.sound.id === id) tr.stop();
    if (activePL && activePL.pl.id === id) activePL = null;
    this.changed();
  },
};

/* ==================================================================== 4. MUSIC LIBRARY */

const Library = {
  mem: new Map(),     // key -> File picked this session
  byTail: new Map(),  // "folder/file.mp3" -> key
  byBase: new Map(),  // "file.mp3" -> key
  add(key) {
    const parts = key.split('/');
    this.byTail.set(parts.slice(-2).join('/'), key);
    const base = parts[parts.length - 1];
    if (!this.byBase.has(base)) this.byBase.set(base, key);
  },
  resolve(sound) {
    const parts = keyOf(sound).split('/');
    return this.byTail.get(parts.slice(-2).join('/')) || this.byBase.get(parts[parts.length - 1]) || null;
  },
  has(sound) { return !!this.resolve(sound); },
  async load() { (await Store.keys('audio')).forEach(k => this.add(k)); },
  async blobByKey(key) { return this.mem.get(key) || await Store.get('audio', key) || null; },
  async blob(sound) { const k = this.resolve(sound); return k ? this.blobByKey(k) : null; },
  // keep: also hold it for this session (picked files are cheap to hold; downloaded ones are not)
  async putBlob(key, blob, keep = true) {
    if (keep) this.mem.set(key, blob);
    let ok = false;
    this.lastError = null;
    try { await Store.put('audio', key, blob); ok = !!Store.db; } catch (e) { this.lastError = e; }
    if (ok || keep) this.add(key);
    return ok;
  },
  async remove(keys) {
    for (const k of keys) {
      await Store.del('audio', k);
      this.mem.delete(k);
      if (urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)); urlCache.delete(k); }
    }
    this.byTail.clear(); this.byBase.clear();
    const all = new Set([...(await Store.keys('audio')), ...this.mem.keys()]);
    all.forEach(k => this.add(k));
  },
  /* Songs being added that are already on this device: the same folder and file name (any
     parent folders), or, for a loose file with no folder, the same file name and size.
     Asks once whether to replace the copies on the device or keep them; either way no
     second copy is saved. items: [{ key, size }]; marks each with .existing and .skip.
     Returns false if the person cancelled. */
  async sortDuplicates(items) {
    if (!Store.db || !items.length) return true;
    const stored = await Store.sizes('audio');
    if (!stored.length) return true;
    const sizeOf = new Map(stored.map(s => [s.key, s.size]));
    const tailOf = k => k.split('/').slice(-2).join('/');
    const byTail = new Map(), byBase = new Map();
    for (const { key } of stored) {
      if (!byTail.has(tailOf(key))) byTail.set(tailOf(key), key);
      const base = key.split('/').pop();
      byBase.set(base, [...(byBase.get(base) || []), key]);
    }
    for (const it of items) {
      const parts = it.key.split('/');
      if (sizeOf.has(it.key)) it.existing = it.key;
      else if (parts.length > 1) { const cur = this.byTail.get(tailOf(it.key)); it.existing = cur && sizeOf.has(cur) ? cur : byTail.get(tailOf(it.key)) || null; }
      else it.existing = (byBase.get(it.key) || []).find(k => sizeOf.get(k) === it.size) || null;
    }
    const dup = items.filter(it => it.existing);
    if (!dup.length) return true;
    const n = dup.length, all = n === items.length;
    const choice = await Ask.choose({
      title: 'Already on this device',
      text: `${all ? (n === 1 ? 'This song is' : `All ${n} of these songs are`) : `<b>${n} of the ${items.length} songs</b> you picked ${n === 1 ? 'is' : 'are'}`} already on this device. Saving ${n === 1 ? 'it' : 'them'} again would use extra space.`
        + `<br><br><b>Replace</b> swaps the copies on this device for the files you picked. <b>Keep</b> leaves the copies on this device as they are. Either way, no second copy is saved${all ? '' : `, and the other ${items.length - n} song${items.length - n === 1 ? ' is' : 's are'} added as usual`}.`,
      list: dup.map(it => it.existing), listLabel: `See the ${n} song${n === 1 ? '' : 's'}`,
      buttons: [
        { label: `Replace ${n === 1 ? 'it' : 'them'}`, value: 'replace' },
        { label: 'Keep the ones on this device', value: 'keep', primary: true },
        { label: 'Cancel', value: 'cancel' },
      ],
    });
    if (choice === 'cancel') return false;
    for (const it of dup) { if (choice === 'replace') it.key = it.existing; else it.skip = true; }
    return true;
  },
  async importFiles(fileList, onProgress) {
    const files = [...fileList].filter(f => AUDIO_EXT.test(f.name));
    const items = files.map(f => ({ file: f, key: norm(f.webkitRelativePath || f.name), size: f.size }));
    if (!(await this.sortDuplicates(items))) return { added: [], failed: 0, cancelled: true };
    const added = [];
    let failed = 0;
    try { await navigator.storage?.persist?.(); } catch (e) {}
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.skip) { added.push({ file: it.file, key: it.existing, kept: true }); onProgress?.(i + 1, items.length); continue; }
      if (urlCache.has(it.key)) { URL.revokeObjectURL(urlCache.get(it.key)); urlCache.delete(it.key); }
      if (!(await this.putBlob(it.key, it.file))) failed++;
      added.push({ file: it.file, key: it.key, replaced: !!it.existing });
      onProgress?.(i + 1, items.length);
    }
    return { added, failed };
  },
  async clear() {
    await Store.clear('audio');
    this.mem.clear(); this.byTail.clear(); this.byBase.clear();
    urlCache.forEach(u => URL.revokeObjectURL(u)); urlCache.clear();
  },
};

const urlCache = new Map();
async function urlFor(sound) {
  const key = Library.resolve(sound);
  if (!key) return null;
  if (urlCache.has(key)) return urlCache.get(key);
  const blob = await Library.blobByKey(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(key, url);
  if (urlCache.size > 60) {
    // drop the oldest song that isn't one of the always-ready ones (goal horn, whistles)
    for (const [k, u] of urlCache) if (!Warm.pinned.has(k) && k !== key) { URL.revokeObjectURL(u); urlCache.delete(k); break; }
  }
  return url;
}

/* A question with a few answers, shown over everything else. Resolves to the chosen value
   ('cancel' if closed with Escape / Back). */
const Ask = {
  choose({ title, text, list = [], listLabel = '', buttons }) {
    const d = $('#ask'), box = $('#askBtns');
    $('#askTitle').textContent = title;
    $('#askText').innerHTML = text;
    $('#askListWrap').hidden = !list.length; $('#askListWrap').open = false;
    $('#askListSum').textContent = listLabel;
    $('#askList').innerHTML = list.slice(0, 500).map(x => `<li>${esc(x)}</li>`).join('') + (list.length > 500 ? `<li>…and ${list.length - 500} more</li>` : '');
    box.innerHTML = buttons.map((b, i) => `<button type="button" class="btn${b.primary ? ' primary' : ''}" data-i="${i}">${esc(b.label)}</button>`).join('');
    return new Promise(res => {
      const done = v => { d.removeEventListener('cancel', onCancel); box.onclick = null; d.close(); res(v); };
      const onCancel = e => { e.preventDefault(); done('cancel'); };
      d.addEventListener('cancel', onCancel);
      box.onclick = e => { const b = e.target.closest('button'); if (b) done(buttons[+b.dataset.i].value); };
      d.showModal();
      box.querySelector('.primary')?.focus();
    });
  },
};

const size$ = b => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : `${b > 0 ? Math.max(1, Math.round(b / 1e6)) : 0} MB`);

/* Clean up storage: finds extra copies of songs and songs nothing uses, shows exactly what
   would be removed, and removes only what the person ticks. Never touches a copy a button
   plays: of each set of copies, the one downloaded from Drive (or the one playing now) stays. */
const Cleanup = {
  plan: null,
  async scan() {
    const stored = await Store.sizes('audio');
    const manifest = (await Store.get('kv', 'driveManifest')) || {};
    const size = new Map(stored.map(s => [s.key, s.size]));
    const tailOf = k => k.split('/').slice(-2).join('/');
    const baseOf = k => k.split('/').pop();
    // 1. copies of the same song: same folder and file name, whatever folders are above them
    const groups = new Map();
    for (const { key } of stored) groups.set(tailOf(key), [...(groups.get(tailOf(key)) || []), key]);
    // a loose file (no folder) is a copy if a song with the same file name and size is in a folder
    for (const [t, keys] of [...groups]) {
      if (t.includes('/')) continue;
      const k = keys[0];
      const into = [...groups.entries()].find(([t2, ks]) => t2.includes('/') && baseOf(t2) === t && ks.some(x => size.get(x) === size.get(k)));
      if (into) { into[1].push(k); groups.delete(t); }
    }
    const keep = new Set(), dupes = [];
    for (const [t, keys] of groups) {
      if (keys.length === 1) { keep.add(keys[0]); continue; }
      const now = Library.byTail.get(t);
      const playing = keys.includes(now) ? now : keys[0];
      // the team's copy from Drive wins; otherwise keep the one the buttons play now
      const kept = keys.find(k => manifest[k] && size.get(k) === size.get(playing)) || keys.find(k => manifest[k]) || playing;
      keep.add(kept);
      for (const k of keys) if (k !== kept) dupes.push({ key: k, size: size.get(k), kept });
    }
    // 2. songs no button or playlist uses, judged with only the kept copies on the device
    const kTail = new Map(), kBase = new Map();
    for (const k of keep) { kTail.set(tailOf(k), k); if (!kBase.has(baseOf(k))) kBase.set(baseOf(k), k); }
    const used = new Set();
    for (const s of idx.sounds.values()) {
      const p = keyOf(s).split('/');
      const k = kTail.get(p.slice(-2).join('/')) || kBase.get(p[p.length - 1]);
      if (k) used.add(k);
    }
    const unused = [], spare = [];
    for (const k of keep) if (!used.has(k)) (manifest[k] ? spare : unused).push({ key: k, size: size.get(k) });
    const sum = a => a.reduce((n, x) => n + (x.size || 0), 0);
    this.plan = { count: stored.length, total: sum(stored), dupes, unused, spare, drive: Object.keys(manifest).length > 0,
      dupBytes: sum(dupes), unusedBytes: sum(unused) };
    return this.plan;
  },
  render() {
    const p = this.plan;
    const s = n => (n === 1 ? '' : 's');
    const useDup = !$('#cleanDupRow').hidden && $('#cleanDupOpt').checked;
    const useUnused = !$('#cleanUnusedRow').hidden && $('#cleanUnusedOpt').checked;
    const n = (useDup ? p.dupes.length : 0) + (useUnused ? p.unused.length : 0);
    const freed = (useDup ? p.dupBytes : 0) + (useUnused ? p.unusedBytes : 0);
    const kept = p.count - n;
    $('#cleanKept').innerHTML = `<b>Kept:</b> ${kept} song${s(kept)} (${size$(p.total - freed)}). Every button and playlist keeps working.`
      + (p.spare.length ? ` ${p.spare.length} song${s(p.spare.length)} in the team's Drive folder that no button uses yet ${p.spare.length === 1 ? 'is' : 'are'} kept too.` : '')
      + (!useUnused && p.unused.length ? ` Songs no button uses stay unless you tick them.` : '');
    $('#cleanAfter').innerHTML = n
      ? `<b>After:</b> about ${size$(p.total - freed)} used, freeing ${size$(freed)}. This can't be undone on this device, but anything removed can be downloaded again with <b>Check for updates</b> or added again.`
      : 'Nothing is ticked, so nothing will be removed.';
    $('#cleanGo').disabled = !n;
    $('#cleanGo').textContent = n ? `Remove ${n} song${s(n)}` : 'Remove';
  },
  show() {
    const p = this.plan;
    const s = n => (n === 1 ? '' : 's');
    const li = (k, extra = '') => `<li>${esc(k.key)} <small>(${size$(k.size)})${extra}</small></li>`;
    const nothing = !p.dupes.length && !p.unused.length;
    $('#cleanIntro').innerHTML = `This device has <b>${p.count} song${s(p.count)}</b> using <b>${size$(p.total)}</b>.`
      + (nothing ? ` Nothing to clean up: there are no extra copies, and every song is on a button${p.drive ? ' or in the team\'s Drive folder' : ''}.` : ' Nothing is removed until you tap Remove.');
    $('#cleanDupRow').hidden = $('#cleanDupList').hidden = !p.dupes.length;
    $('#cleanDupLbl').textContent = `Remove ${p.dupes.length} extra cop${p.dupes.length === 1 ? 'y' : 'ies'} (${size$(p.dupBytes)})`;
    $('#cleanDupOpt').checked = true;
    $('#cleanDupList ul').innerHTML = p.dupes.slice(0, 600).map(d => li(d, ` · keeping ${esc(d.kept)}`)).join('');
    $('#cleanUnusedRow').hidden = $('#cleanUnusedList').hidden = !p.unused.length;
    $('#cleanUnusedLbl').textContent = `Remove ${p.unused.length} song${s(p.unused.length)} no button uses (${size$(p.unusedBytes)})`;
    $('#cleanUnusedWhy').textContent = p.drive
      ? 'Not on any button or playlist, and not in the team\'s Drive folder (as of your last Check for updates). If you need one later, add it again.'
      : 'Not on any button or playlist. If you need one later, add it again.';
    $('#cleanUnusedOpt').checked = false;
    $('#cleanUnusedList ul').innerHTML = p.unused.slice(0, 600).map(d => li(d)).join('');
    $('#cleanDupList').open = $('#cleanUnusedList').open = false;
    $('#cleanKept').hidden = $('#cleanAfter').hidden = $('#cleanGo').hidden = nothing;
    $('#cleanNo').textContent = nothing ? 'Close' : 'Cancel';
    $('#cleanPlan').hidden = false;
    if (!nothing) this.render();
  },
  async run(say) {
    const p = this.plan;
    let keys = [...($('#cleanDupOpt').checked ? p.dupes : []), ...($('#cleanUnusedOpt').checked ? p.unused : [])].map(x => x.key);
    if (!keys.length) return '';
    if (tracks.some(t => t.state !== 'done')) return 'Stop the music first (Fade out all or Stop), then tap Remove again.';
    // check again right before removing, in case songs or buttons changed since the summary
    const now = await this.scan();
    const still = new Map([...now.dupes, ...now.unused].map(x => [x.key, x]));
    keys = keys.filter(k => still.has(k));
    const freed = keys.reduce((n, k) => n + (still.get(k).size || 0), 0);
    for (let i = 0; i < keys.length; i += 25) {
      say(`Removing songs: ${Math.min(i + 25, keys.length)} of ${keys.length}…`);
      await Library.remove(keys.slice(i, i + 25));
    }
    // forget Drive details for copies that are gone (and any left over from earlier)
    const manifest = (await Store.get('kv', 'driveManifest')) || {};
    const left = new Set(await Store.keys('audio'));
    for (const k of Object.keys(manifest)) if (!left.has(k)) delete manifest[k];
    await Store.put('kv', 'driveManifest', manifest).catch(() => {});
    this.plan = null;
    return `Removed ${keys.length} song${keys.length === 1 ? '' : 's'} and freed about ${size$(freed)}. Every button that played before still plays.`;
  },
};

function probeDuration(blob) {
  return new Promise(res => {
    const a = new Audio();
    const url = URL.createObjectURL(blob);
    const done = v => { URL.revokeObjectURL(url); res(v); };
    const t = setTimeout(() => done(0), 5000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { clearTimeout(t); done(isFinite(a.duration) ? Math.round(a.duration * 1000) / 1000 : 0); };
    a.onerror = () => { clearTimeout(t); done(0); };
    a.src = url;
  });
}

/* ==================================================================== 5. TEAMS */

const Teams = {
  get current() { return show.teams.find(t => t.id === settings.team) || show.teams[0]; },
  goalHorn(team) {
    return (team.goalHorn && idx.sounds.get(team.goalHorn)) || this.allGoalHorns()[0] || null;
  },
  playlist(team, kind) { return (team[kind] && idx.playlists.get(team[kind])) || null; },
  allGoalHorns() { return Show.uniqueSounds().filter(s => GOAL_HORN.include.test(s.name) && !GOAL_HORN.exclude.test(s.name)); },
  badge(team, cls = 'badge') {
    if (team.logo) return `<span class="${cls} ${team.shape === 'square' ? 'square' : 'round'}"><img src="${esc(safeImage(team.logo) || '')}" alt="${esc(team.full)} logo"></span>`;
    return `<span class="${cls} mono" style="--tc:${esc(team.color)}">${esc(team.name.slice(0, 1))}</span>`;
  },
  apply() {
    const c = this.current.color;
    document.documentElement.style.setProperty('--team', c);
    document.documentElement.style.setProperty('--on-team', hexLight(c) ? '#0b131a' : '#ffffff');
    Warm.soon();
  },
};

/* Get the songs that must start instantly ready ahead of time: the current team's goal horn
   and the whistle songs (Penalty, Icing…). Done when the app opens, when the team changes and
   after music or the layout changes, so the first tap of the night doesn't wait on storage. */
const Warm = {
  pinned: new Set(),   // song keys kept ready (never dropped from the ready list)
  soon() { clearTimeout(this._t); this._t = setTimeout(() => this.run().catch(() => {}), 400); },
  async run() {
    const team = show.teams.length ? Teams.current : null;
    const horn = team ? Teams.goalHorn(team) : null;
    const whistles = (gameDaySections()[0]?.items || []).flatMap(g => g.sounds || []);
    const list = [horn, ...whistles].filter(s => s && Library.has(s)).slice(0, 40);
    this.pinned = new Set(list.map(s => Library.resolve(s)));
    for (const s of list) await urlFor(s);
    // the goal horn: let the browser read the start of the file now
    const key = horn && Library.resolve(horn);
    if (key && key !== this.hornKey) {
      this.hornKey = key;
      const a = new Audio(); a.preload = 'auto'; a.muted = true; a.src = await urlFor(horn); a.load();
      this.hornEl = a;
    }
  },
};

// Shrinks an uploaded logo so it fits in the show file, and finds its main colour.
function processLogo(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const size = 256;
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const s = Math.min(size / img.width, size / img.height);
      const w = img.width * s, h = img.height * s;
      g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      let color = null;
      try {
        const d = g.getImageData(0, 0, size, size).data;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 16) {
          const r = d[i], gg = d[i + 1], b = d[i + 2], a = d[i + 3];
          const max = Math.max(r, gg, b), min = Math.min(r, gg, b);
          if (a < 200 || max < 50 || max - min < 60) continue;
          const k = (r >> 5) << 6 | (gg >> 5) << 3 | (b >> 5);
          const e = buckets.get(k) || { n: 0, r: 0, g: 0, b: 0 };
          e.n++; e.r += r; e.g += gg; e.b += b; buckets.set(k, e);
        }
        const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
        if (best && best.n > 20) color = '#' + [best.r, best.g, best.b].map(v => Math.round(v / best.n).toString(16).padStart(2, '0')).join('');
      } catch (e) {}
      const png = file.type === 'image/png' || file.type === 'image/svg+xml';
      const data = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86);
      URL.revokeObjectURL(url);
      res({ data, color });
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(null); };
    img.src = url;
  });
}

/* ==================================================================== 6. GAME DAY */

const startsWith = (s, prefix) => {
  const p = String(prefix || '').trim().toLowerCase();
  return !!p && s.name.toLowerCase().startsWith(p);
};

function gameDaySections() {
  const all = Show.uniqueSounds();
  const gd = show.gameday;
  const groups = (list, key) => list.map((g, i) => ({
    id: `g:${key}:${i}`, type: 'group', name: g.label || g.prefix, cssColor: g.color,
    sounds: all.filter(s => startsWith(s, g.prefix)),
  }));
  const out = [];
  out.push({ key: 'situations', title: 'Whistles', big: true, items: groups(gd.situations, 's'), editable: true });
  out.push({ key: 'moments', title: 'Moments', items: all.filter(s => gd.moments.some(p => startsWith(s, p))), editable: true });
  const pls = [...idx.playlists.values()];
  if (pls.length) out.push({ key: 'playlists', title: 'Playlists', items: [{ id: 'next', type: 'next', name: 'Next song', color: '#bfef45' }, ...pls] });
  out.push({ key: 'endings', title: 'Game over', big: true, items: groups(gd.endings, 'e'), editable: true });
  out.push({ key: 'horns', title: 'All goal horns', items: Teams.allGoalHorns() });
  return out;
}

/* ==================================================================== 7. AUDIO ENGINE */

let ctx = null, master = null;
let useElements = true; // falls back to decoded buffers if <audio> playback is blocked
const tracks = [];      // everything currently audible (or fading)

// iPhone and iPad
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function audioCtx() {
  if (!ctx) {
    // iPhone/iPad: play even when the ring/silent switch is on silent (Safari 16.4 and later)
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = settings.masterVolume;
    master.connect(ctx.destination);
  }
  // Safari also uses an 'interrupted' state (phone call, Siri, switching apps)
  if (ctx.state !== 'running') ctx.resume().catch(() => {});
  return ctx;
}

function ramp(param, to, secs) {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setValueAtTime(param.value, t);
  param.linearRampToValueAtTime(to, t + Math.max(0.02, secs));
}

let trackSeq = 0;
class Track {
  constructor(sound, playlist = null, opts = {}) {
    this.sound = sound;
    this.playlist = playlist;
    this.preview = !!opts.preview;
    this.uid = ++trackSeq;
    this.userVol = 1;
    this.state = 'loading'; // loading | playing | fading | done
  }
  get level() { return (this.sound.volume ?? 1) * this.userVol; }
  get end() {
    const d = this.el ? this.el.duration : (this.buffer ? this.buffer.duration : this.sound.length);
    const len = isFinite(d) && d > 0 ? d : (this.sound.length || 600);
    if (this.preview) return len;
    return this.sound.stop && this.sound.stop < len ? this.sound.stop : len;
  }
  get time() {
    if (this.el) return this.el.currentTime;
    if (this.src) return this.offset + (ctx.currentTime - this.t0);
    return this.sound.start || 0;
  }
  async start(fadeIn = 0) {
    audioCtx();
    this.gain = ctx.createGain();
    this.gain.gain.value = fadeIn ? 0 : this.level;
    this.gain.connect(master);
    if (useElements) {
      try { await this._startElement(); }
      catch (e) {
        if (this.state === 'done') return;
        if (e && e.message === 'missing') throw e;
        console.warn('Audio element playback failed, switching to decoded playback', e);
        useElements = false;
        this._cleanupElement();
        await this._startBuffer();
      }
    } else {
      await this._startBuffer();
    }
    if (this.state === 'done') { this._teardown(); return; }
    this.state = 'playing';
    if (fadeIn) ramp(this.gain.gain, this.level, fadeIn);
  }
  async _startElement() {
    const url = await urlFor(this.sound);
    if (!url) throw new Error('missing');
    const a = new Audio();
    a.preload = 'auto';
    this.el = a;
    a.src = url;
    await new Promise((res, rej) => {
      a.onloadedmetadata = res;
      a.onerror = () => rej(a.error || new Error('load failed'));
    });
    this.node = ctx.createMediaElementSource(a);
    this.node.connect(this.gain);
    // Always seek, even for songs with no start point: Safari's engine can stall when
    // a song routed through the mixer starts without a seek. 10 ms is inaudible.
    a.currentTime = Math.max(0.01, Math.min(this.sound.start || 0, Math.max(0, (a.duration || 1e9) - 0.5)));
    a.onended = () => this.stop();
    await a.play();
    this._watch(a.currentTime);
  }
  // If the song hasn't moved after 2.5 s, switch this browser to decoded playback.
  _watch(t0) {
    setTimeout(async () => {
      if (this.state !== 'playing' || !this.el || this.el.currentTime > t0 + 0.05) return;
      console.warn('Playback stalled, switching to decoded playback');
      useElements = false;
      this._cleanupElement();
      try { await this._startBuffer(); } catch (e) { this.stop(); }
    }, 2500);
  }
  _cleanupElement() {
    try { this.el?.pause(); } catch (e) {}
    try { this.node?.disconnect(); } catch (e) {}
    this.el = null; this.node = null;
  }
  async _startBuffer() {
    const blob = await Library.blob(this.sound);
    if (!blob) throw new Error('missing');
    this.buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (this.state === 'done') return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    this.offset = Math.min(this.sound.start || 0, Math.max(0, this.buffer.duration - 0.5));
    this.t0 = ctx.currentTime;
    src.onended = () => this.stop();
    src.start(0, this.offset);
    this.src = src;
  }
  setUserVol(v) {
    this.userVol = v;
    if (this.state === 'playing') this.gain.gain.setTargetAtTime(this.level, ctx.currentTime, 0.05);
  }
  fadeOut(secs = settings.fadeSeconds) {
    if (this.state === 'done' || this.state === 'fading') return;
    if (this.state === 'loading' || !this.gain) { this.stop(); return; }
    this.state = 'fading';
    ramp(this.gain.gain, 0, secs);
    clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => this.stop(), secs * 1000 + 60);
    UI.renderDock();
  }
  stop() {
    if (this.state === 'done') return;
    this.state = 'done';
    clearTimeout(this._fadeTimer);
    this._teardown();
    const i = tracks.indexOf(this);
    if (i >= 0) tracks.splice(i, 1);
    if (this.playlist && this.playlist.track === this) this.playlist.track = null;
    UI.renderDock();
    UI.refreshPads();
  }
  _teardown() {
    this._cleanupElement();
    try { this.src?.stop(); } catch (e) {}
    try { this.src?.disconnect(); } catch (e) {}
    try { this.gain?.disconnect(); } catch (e) {}
    this.src = null; this.buffer = null;
  }
}

function markPlayed(sound) { played.add(keyOf(sound)); Prefs.savePlayed(); }
function fadeAll(secs = settings.fadeSeconds, except = null) { for (const t of [...tracks]) if (t !== except) t.fadeOut(secs); }
function stopAll() { for (const t of [...tracks]) t.stop(); }

async function playSound(sound, { preview = false } = {}) {
  if (!Library.has(sound)) {
    UI.toast('That song file isn\'t on this device yet. Add your music in Settings.');
    return null;
  }
  const live = tracks.find(t => t.sound.id === sound.id && !t.playlist && t.state !== 'fading');
  if (live && !preview) { live.fadeOut(); return null; }
  if (live && preview) live.stop();
  if (settings.oneAtATime || preview) fadeAll();
  const t = new Track(sound, null, { preview });
  tracks.push(t);
  UI.renderDock();
  try {
    await t.start();
    if (!preview) markPlayed(sound);
  } catch (e) {
    console.error(e);
    t.stop();
    UI.toast(e.message === 'missing' ? 'That song file isn\'t on this device yet.' : 'Couldn\'t play that file.');
    return null;
  }
  UI.renderDock();
  UI.refreshPads();
  return t;
}

function playGroup(group) {
  const avail = group.sounds.filter(s => Library.has(s));
  if (!avail.length) { UI.toast(`No songs for “${group.name}” are on this device yet.`); return; }
  const live = tracks.find(t => group.sounds.includes(t.sound) && t.state === 'playing' && !t.playlist);
  if (live) { live.fadeOut(); return; }
  const fresh = settings.skipPlayed ? avail.filter(s => !played.has(keyOf(s))) : avail;
  const pool = fresh.length ? fresh : avail;
  playSound(pool[Math.floor(Math.random() * pool.length)]);
}

/* A playlist is a queue that survives interruptions: fading it out keeps its
   place, and Next song picks up where it left off. */
let activePL = null; // { pl, order: [sound], pos, track }

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function startPlaylist(pl) {
  if (activePL && activePL.pl.id === pl.id && activePL.track && activePL.track.state === 'playing') {
    activePL.track.fadeOut();
    return;
  }
  if (!activePL || activePL.pl.id !== pl.id) {
    const songs = Show.playlistSongs(pl);
    activePL = { pl, order: settings.playlistShuffle ? shuffled(songs) : songs, pos: -1, track: null };
  }
  playlistNext();
}

async function playlistNext({ auto = false } = {}) {
  const A = activePL;
  if (!A) { UI.toast('Start a playlist first.'); return; }
  const n = A.order.length;
  const ok = s => Library.has(s);
  const fresh = s => ok(s) && (!settings.skipPlayed || !played.has(keyOf(s)));
  let next = -1;
  for (const test of [fresh, ok]) {
    for (let k = 1; k <= n; k++) {
      const i = (A.pos + k) % n;
      if (test(A.order[i])) { next = i; break; }
    }
    if (next >= 0) break;
  }
  if (next < 0) { UI.toast('None of this playlist\'s songs are on this device yet.'); return; }
  if (next <= A.pos && settings.playlistShuffle) A.order = shuffled(A.order);
  A.pos = next;

  const old = A.track;
  const t = new Track(A.order[next], A);
  A.track = t;
  tracks.push(t);
  if (auto && old) old.fadeOut(settings.playlistXfade);
  else if (settings.oneAtATime) fadeAll(settings.fadeSeconds, t);
  else old?.fadeOut();
  UI.renderDock();
  try {
    await t.start(auto ? settings.playlistXfade : 0);
    markPlayed(t.sound);
  } catch (e) {
    console.error(e);
    t.stop();
  }
  UI.renderDock();
  UI.refreshPads();
}

// one loop keeps stop points, playlist crossfades and progress displays in step
function tick() {
  for (const t of [...tracks]) {
    if (t.state === 'loading' || t.state === 'done') continue;
    const remaining = t.end - t.time;
    if (remaining <= 0.05) { t.stop(); continue; }
    if (t.playlist && t.playlist === activePL && t.playlist.track === t && settings.playlistAuto &&
        t.state === 'playing' && !t._advanced && remaining <= settings.playlistXfade) {
      t._advanced = true;
      playlistNext({ auto: true });
    }
    // a stop point gets a short fade so it doesn't click off
    if (t.sound.stop && !t.preview && t.state === 'playing' && remaining <= 0.6 && !t.playlist) t.fadeOut(0.5);
  }
  UI.updateProgress();
  Edit.tick();
}

/* ==================================================================== 8. UI */

// "Penalty - Sabotage - Beastie Boys" -> label PENALTY, title Sabotage, artist Beastie Boys
function splitName(name) {
  const parts = String(name).split(/\s+[-–]\s+/).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 3) return { eyebrow: parts[0], title: parts[1], artist: parts.slice(2).join(' - ') };
  if (parts.length === 2) return { eyebrow: '', title: parts[0], artist: parts[1] };
  return { eyebrow: '', title: String(name), artist: '' };
}

const ICONS = {
  shuffle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  list: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h13M3 12h13M3 18h9M19 14v7l-3-2"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l10 7-10 7zM19 5v14"/></svg>',
  horn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l6 5V5L7 10zM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14"/></svg>',
  pen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
};

function buzz(ms = 12) { try { navigator.vibrate?.(ms); } catch (e) {} }

const UI = {
  view: 'gameday', // 'gameday' or a tab id
  query: '',
  itemsById: new Map(),

  init() {
    $('#search').addEventListener('input', e => { this.query = e.target.value.trim(); this.renderMain(); });
    $('#fadeAll').addEventListener('click', () => { buzz(); fadeAll(); });
    $('#stopAll').addEventListener('click', () => { buzz(); stopAll(); });
    $('#master').value = settings.masterVolume;
    $('#master').addEventListener('input', e => {
      settings.masterVolume = +e.target.value; Prefs.save();
      if (master) master.gain.setTargetAtTime(settings.masterVolume, ctx.currentTime, 0.05);
    });
    document.querySelectorAll('#mode button').forEach(b => b.addEventListener('click', () => {
      settings.oneAtATime = b.dataset.mode === 'one'; Prefs.save(); this.renderMode();
    }));
    this.renderMode();

    // Team picker: one button showing the current team; tap it for a list of all teams.
    // In Edit, the list opens a team's settings instead, and has "Add a team".
    $('#teams').addEventListener('click', () => this.teamMenu(true));

    const ng = $('#newGame');
    ng.addEventListener('click', () => {
      if (ng.dataset.armed) {
        played.clear(); Prefs.savePlayed(); delete ng.dataset.armed;
        ng.classList.remove('warn'); this.renderHead(); this.refreshPads();
        this.toast('New game. Every song is fresh again.');
      } else {
        ng.dataset.armed = '1'; ng.classList.add('warn');
        ng.textContent = `Tap again to clear ${played.size} played`;
        setTimeout(() => { delete ng.dataset.armed; ng.classList.remove('warn'); this.renderHead(); }, 3500);
      }
    });

    // Volunteer lock: tap to lock, press and hold for 1.5 s to unlock
    const lock = $('#lockBtn');
    let holdTimer = null;
    const cancelHold = () => { clearTimeout(holdTimer); lock.classList.remove('holding'); };
    lock.addEventListener('pointerdown', () => {
      if (!settings.locked) return;
      lock.classList.add('holding');
      holdTimer = setTimeout(() => { cancelHold(); lock.dataset.justUnlocked = '1'; this.setLocked(false); buzz(30); }, 1500);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => lock.addEventListener(ev, cancelHold));
    lock.addEventListener('click', () => {
      if (lock.dataset.justUnlocked) { delete lock.dataset.justUnlocked; return; }
      if (settings.locked) { this.toast('Press and hold the lock to unlock.'); return; }
      this.setLocked(true);
    });
    this.setLocked(settings.locked, true);

    $('#main').addEventListener('click', e => {
      const act = e.target.closest('[data-ui]');
      if (act) { this.uiAction(act.dataset.ui, act); return; }
      const b = e.target.closest('[data-id]');
      if (!b) return;
      const item = this.itemsById.get(b.dataset.id);
      if (!item) return;
      if (Edit.on) { Edit.openFor(item, b); return; }
      audioCtx();
      buzz();
      b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
      if (item.type === 'sound') playSound(item);
      else if (item.type === 'group') playGroup(item);
      else if (item.type === 'playlist') startPlaylist(item);
      else if (item.type === 'next') playlistNext();
      else if (item.type === 'gamemusic') {
        if (activePL && activePL.pl.id === item.pl.id) playlistNext();
        else startPlaylist(item.pl);
      }
    });
    $('#main').addEventListener('change', e => {
      if (e.target.matches('[data-add-songs]')) Edit.addSongs(Show.tab(e.target.dataset.addSongs), e.target.files, e.target);
    });
    $('#tabs').addEventListener('click', e => {
      if (e.target.closest('[data-new-tab]')) { Edit.newTab(); return; }
      const b = e.target.closest('[data-tab]');
      if (!b) return;
      this.view = b.dataset.tab;
      $('#search').value = ''; this.query = '';
      this.renderTabs(); this.renderMain();
      $('#main').scrollTop = 0;
    });
    $('#dockList').addEventListener('input', e => {
      const uid = +e.target.closest('[data-uid]')?.dataset.uid;
      const t = tracks.find(x => x.uid === uid);
      if (t && e.target.type === 'range') t.setUserVol(+e.target.value);
    });
    $('#dockList').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      const uid = +b.closest('[data-uid]')?.dataset.uid;
      const t = tracks.find(x => x.uid === uid);
      if (act === 'fade' && t) t.fadeOut();
      if (act === 'next') playlistNext();
      if (act === 'shuffle') {
        settings.playlistShuffle = !settings.playlistShuffle; Prefs.save();
        if (activePL) {
          const cur = activePL.order[activePL.pos];
          const songs = Show.playlistSongs(activePL.pl);
          activePL.order = settings.playlistShuffle ? shuffled(songs) : songs;
          activePL.pos = Math.max(-1, activePL.order.indexOf(cur));
        }
        this.renderDock();
      }
      if (act === 'auto') { settings.playlistAuto = !settings.playlistAuto; Prefs.save(); this.renderDock(); }
      if (act === 'close') { activePL?.track?.fadeOut(); activePL = null; this.renderDock(); this.refreshPads(); }
    });
    $('#settingsBtn').addEventListener('click', () => Settings.open());
    $('#helpBtn').addEventListener('click', () => { renderAbout(); Notes.renderHelp(); $('#help').showModal(); });
    $('#editBtn').addEventListener('click', () => Edit.toggle());
    // Full screen hides Chrome's address bar. Not needed (or offered) when installed as an app.
    const fb = $('#fullBtn');
    const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
    const canFull = !!document.documentElement.requestFullscreen;
    fb.hidden = standalone || !canFull;
    fb.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      } catch (e) { this.toast('Full screen isn\'t available here.'); }
    });
    document.addEventListener('fullscreenchange', () => {
      fb.setAttribute('aria-pressed', String(!!document.fullscreenElement));
      fb.setAttribute('aria-label', document.fullscreenElement ? 'Leave full screen' : 'Full screen');
    });
  },

  uiAction(act, el) {
    if (act === 'settings') Settings.open();
    if (act === 'drive') { Settings.open(); setTimeout(() => { $('#driveSection').scrollIntoView({ block: 'start' }); if (Drive.ready()) $('#driveCheck').click(); }, 50); }
    if (act === 'tab-settings') Edit.tab(Show.tab(el.dataset.tabId));
    if (act === 'groups') Edit.groups(el.dataset.section);
    if (act === 'add-playlist') Edit.addPlaylist(Show.tab(el.dataset.tabId));
    if (act === 'add-next') Edit.addNext(Show.tab(el.dataset.tabId));
    if (act === 'team') { if (Edit.on || !settings.locked) Edit.team(Teams.current); }
    if (act === 'help') { renderAbout(); $('#help').showModal(); }
  },

  setLocked(on, quiet = false) {
    settings.locked = on; Prefs.save();
    if (on && Edit.on) Edit.toggle(false);
    document.body.classList.toggle('locked', on);
    const lock = $('#lockBtn');
    lock.setAttribute('aria-pressed', String(on));
    lock.setAttribute('aria-label', on ? 'Locked. Press and hold to unlock' : 'Lock controls for volunteers');
    lock.querySelector('span').textContent = on ? 'Locked' : 'Lock';
    if (!quiet) this.toast(on ? 'Locked. Settings and editing are hidden.' : 'Unlocked.');
  },

  renderAll() {
    Teams.apply();
    this.renderHead(); this.renderTabs(); this.renderMain(); this.renderDock();
  },
  renderMode() {
    document.querySelectorAll('#mode button').forEach(b =>
      b.setAttribute('aria-pressed', String((b.dataset.mode === 'one') === settings.oneAtATime)));
  },
  renderHead() {
    const uniq = Show.uniqueSounds();
    const loaded = uniq.filter(s => Library.has(s)).length;
    const cur = Teams.current;
    $('#teams').innerHTML = `<button class="team tpick" aria-haspopup="menu" aria-expanded="false" aria-label="Team: ${esc(cur.full)}. Change team"
      style="--tc:${esc(cur.color)}">${Teams.badge(cur)}<span class="team-name">${esc(cur.name)}</span><svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>`;
    $('#projMeta').innerHTML = `<span>${loaded}/${uniq.length} songs</span><span>${played.size} played</span>`;
    $('#search').placeholder = `Search ${uniq.length} songs`;
    const ng = $('#newGame');
    if (!ng.dataset.armed) ng.textContent = 'New game';
  },
  renderTabs() {
    const tabs = [`<button class="tab gameday" role="tab" data-tab="gameday" aria-selected="${this.view === 'gameday'}">${ICONS.horn}Game Day</button>`];
    for (const t of show.tabs) {
      tabs.push(`<button class="tab" role="tab" data-tab="${esc(t.id)}" aria-selected="${this.view === t.id}"
        style="--c:${esc(t.color || '#4d4d4d')};--on:${hexLight(t.color) ? '#0b131a' : '#fff'}"><i></i>${esc(t.name)}<em class="num">${t.items.length}</em></button>`);
    }
    if (Edit.on) tabs.push(`<button class="tab new-tab" data-new-tab>${ICONS.plus}New tab</button>`);
    $('#tabs').innerHTML = tabs.join('');
  },
  padHtml(item) {
    this.itemsById.set(item.id, item);
    const bg = item.cssColor || item.color;
    const light = hexLight(bg);
    const cls = ['pad', item.type];
    let top = '', meta = '';
    if (item.type === 'sound') {
      if (!Library.has(item)) cls.push('is-missing');
      if (played.has(keyOf(item))) cls.push('is-played');
      const n = splitName(item.name);
      top = `${n.eyebrow ? `<span class="eyebrow">${esc(n.eyebrow)}</span>` : ''}<span class="name">${esc(n.title)}</span>${n.artist ? `<span class="artist">${esc(n.artist)}</span>` : ''}`;
      const cut = item.start ? `from ${fmt(item.start)}` : '';
      const dur = item.length > 0 ? fmt(Math.max(0, (item.stop || item.length) - item.start)) : '';
      meta = `<span>${cut}</span><span>${dur}</span>`;
    } else if (item.type === 'group') {
      const avail = item.sounds.filter(s => Library.has(s));
      const fresh = avail.filter(s => !played.has(keyOf(s))).length;
      top = `<span class="eyebrow">${ICONS.shuffle}Random</span><span class="name">${esc(item.name)}</span>`;
      meta = `<span class="count">${fresh} of ${item.sounds.length} fresh</span><span class="dots">${item.sounds.map(s => `<i class="${played.has(keyOf(s)) ? 'used' : ''}"></i>`).join('')}</span>`;
    } else if (item.type === 'playlist') {
      top = `<span class="eyebrow">${ICONS.list}Playlist</span><span class="name">${esc(item.name)}</span>`;
      meta = `<span>${item.songs.length} songs</span><span></span>`;
    } else if (item.type === 'next') {
      top = `<span class="eyebrow">${ICONS.next}Playlist</span><span class="name">${esc(item.name || 'Next song')}</span>`;
      meta = `<span>continues the playlist</span><span></span>`;
    }
    const style = bg && !cls.includes('is-missing') ? `style="--bg-pad:${esc(bg)};--fg-pad:${light ? '#0b131a' : '#fff'}"` : '';
    return `<button class="${cls.join(' ')}" data-id="${esc(item.id)}" ${style}>
      <span class="top">${top}</span><span class="meta">${meta}</span><span class="edit-mark" aria-hidden="true">${ICONS.pen}</span></button>`;
  },
  heroHtml() {
    const team = Teams.current;
    const horn = Teams.goalHorn(team);
    const pre = Teams.playlist(team, 'pregame');
    const game = Teams.playlist(team, 'game');
    let html = `<section class="hero" aria-label="${esc(team.full)} quick buttons">`;
    if (horn) {
      this.itemsById.set(horn.id, horn);
      html += `<button class="hero-pad goal${Library.has(horn) ? '' : ' is-missing'}" data-id="${esc(horn.id)}" data-hero="team">
        ${Teams.badge(team, 'hero-logo')}
        <span class="hero-k">${ICONS.horn}Goal · ${esc(team.name)}</span>
        <span class="hero-big">GOAL!</span>
        <span class="hero-sub">${esc(horn.name.replace(/^(our\s+)?goal horn\s*-?\s*/i, '') || horn.name)}</span></button>`;
    } else {
      html += `<button class="hero-pad goal is-missing" data-ui="team">${Teams.badge(team, 'hero-logo')}<span class="hero-k">Goal horn</span><span class="hero-big small">Pick one</span><span class="hero-sub">Choose ${esc(team.name)}'s goal horn</span></button>`;
    }
    const plPad = (pl, label, kind) => {
      if (!pl) return `<button class="hero-pad pl is-missing" data-ui="team"><span class="hero-k">${label}</span><span class="hero-big small">Not set</span><span class="hero-sub">Pick a playlist for ${esc(team.name)}</span></button>`;
      const item = kind === 'gamemusic' ? { id: 'gm:' + pl.id, type: 'gamemusic', pl, name: pl.name } : pl;
      this.itemsById.set(item.id, item);
      const live = activePL && activePL.pl.id === pl.id;
      const verb = kind === 'gamemusic' ? (live ? 'Next song' : 'Start') : (live ? 'Playing' : 'Start');
      return `<button class="hero-pad pl" data-id="${esc(item.id)}" data-hero="team">
        <span class="hero-k">${kind === 'gamemusic' ? ICONS.next : ICONS.list}${label}</span>
        <span class="hero-big small">${verb}</span>
        <span class="hero-sub">${esc(pl.name)} · ${pl.songs.length} songs</span></button>`;
    };
    html += plPad(pre, 'Pregame', 'playlist');
    html += plPad(game, 'Game music', 'gamemusic');
    html += `</section>`;
    return html;
  },
  banner() {
    if (Edit.on) {
      return `<div class="banner edit"><div><strong>Edit mode.</strong>
        <p>Tap any button to change it. Changes save on this device as you go. Tap Done when you're finished.</p></div>
        <button class="btn" data-ui="help">How to edit</button></div>`;
    }
    const any = Show.uniqueSounds().some(s => Library.has(s));
    if (any || !idx.sounds.size) return '';
    return `<div class="banner"><div><strong>No music on this device yet.</strong>
      <p>The buttons below are ready. Download the music from the team's Google Drive folder and open it in Settings, and every button lights up.</p></div>
      <button class="btn admin" data-ui="drive">Load music</button></div>`;
  },
  renderMain() {
    this.itemsById.clear();
    const main = $('#main');
    let html = this.banner();
    if (this.query) {
      const q = this.query.toLowerCase();
      const seen = new Set();
      const hits = [];
      for (const t of show.tabs) for (const i of t.items) {
        const k = i.type === 'sound' ? keyOf(i) : i.id;
        if (i.type === 'next' || seen.has(k)) continue;
        if (i.name.toLowerCase().includes(q)) { seen.add(k); hits.push(i); }
      }
      html += `<h2 class="section-title">${hits.length} match${hits.length === 1 ? '' : 'es'} for “${esc(this.query)}”</h2>`;
      html += `<div class="grid">${hits.slice(0, 150).map(i => this.padHtml(i)).join('')}</div>`;
    } else if (this.view === 'gameday') {
      html += this.heroHtml();
      for (const sec of gameDaySections()) {
        if (!sec.items.length && !(Edit.on && sec.editable)) continue;
        const editBtn = Edit.on && sec.editable ? `<button class="mini" data-ui="groups" data-section="${sec.key}">${ICONS.pen}Edit groups</button>` : '';
        html += `<h2 class="section-title">${esc(sec.title)}<span>${sec.items.length}</span>${editBtn}</h2>`;
        html += sec.items.length
          ? `<div class="grid${sec.big ? ' big' : ''}">${sec.items.map(i => this.padHtml(i)).join('')}</div>`
          : `<p class="hint">Nothing here yet. Tap Edit groups to add some.</p>`;
      }
    } else {
      const tab = Show.tab(this.view) || show.tabs[0];
      if (!tab) { this.view = 'gameday'; return this.renderMain(); }
      const editBtn = Edit.on ? `<button class="mini" data-ui="tab-settings" data-tab-id="${esc(tab.id)}">${ICONS.pen}Tab settings</button>` : '';
      html += `<h2 class="section-title tab-title" style="--c:${esc(tab.color || '#8ea2b3')}">${esc(tab.name)}<span>${tab.items.length} buttons</span>${editBtn}</h2>`;
      let tiles = '';
      if (Edit.on) {
        tiles = `<label class="pad add-tile">${ICONS.plus}<span>Add songs</span><small>Pick song files</small><input type="file" multiple accept="audio/*,.mp3,.m4a,.wav" data-add-songs="${esc(tab.id)}"></label>
          <button class="pad add-tile" data-ui="add-playlist" data-tab-id="${esc(tab.id)}">${ICONS.list}<span>Add playlist</span></button>
          <button class="pad add-tile" data-ui="add-next" data-tab-id="${esc(tab.id)}">${ICONS.next}<span>Add Next-song button</span></button>`;
      }
      html += `<div class="grid">${tab.items.map(i => this.padHtml(i)).join('')}${tiles}</div>`;
      if (!tab.items.length && !Edit.on) html += `<p class="hint">This tab is empty. Tap Edit, then Add songs.</p>`;
    }
    main.innerHTML = html;
    this.refreshPads();
  },
  refreshPads() {
    const live = new Set(tracks.filter(t => t.state !== 'done').map(t => t.sound.id));
    const livePl = activePL && activePL.track && activePL.track.state !== 'done' ? activePL.pl.id : null;
    document.querySelectorAll('#main [data-id]').forEach(el => {
      const item = this.itemsById.get(el.dataset.id);
      if (!item) return;
      let on = false;
      if (item.type === 'sound') {
        on = live.has(item.id);
        el.classList.toggle('is-played', played.has(keyOf(item)) && !el.classList.contains('hero-pad'));
      } else if (item.type === 'group') {
        on = item.sounds.some(s => live.has(s.id));
        const avail = item.sounds.filter(s => Library.has(s));
        const c = el.querySelector('.count');
        if (c) c.textContent = `${avail.filter(s => !played.has(keyOf(s))).length} of ${item.sounds.length} fresh`;
        const dots = el.querySelectorAll('.dots i');
        item.sounds.forEach((s, i) => dots[i]?.classList.toggle('used', played.has(keyOf(s))));
      } else if (item.type === 'playlist' || item.type === 'gamemusic') {
        const pl = item.pl || item;
        on = pl.id === livePl;
        const big = el.querySelector('.hero-big');
        if (big) big.textContent = item.type === 'gamemusic'
          ? (activePL && activePL.pl.id === pl.id ? 'Next song' : 'Start')
          : (on ? 'Playing' : 'Start');
      }
      el.classList.toggle('is-playing', on);
      if (!on) el.style.setProperty('--p', 0);
    });
    this.renderHead();
  },
  updateProgress() {
    for (const t of tracks) {
      if (t.state === 'loading') continue;
      const span = Math.max(0.1, t.end - (t.sound.start || 0));
      const p = Math.min(1, Math.max(0, (t.time - (t.sound.start || 0)) / span));
      const card = document.querySelector(`#dockList [data-uid="${t.uid}"]`);
      if (card) {
        card.querySelector('.bar i').style.width = (p * 100).toFixed(1) + '%';
        const left = t.end - t.time;
        const r = card.querySelector('.remain');
        r.textContent = '-' + fmt(left);
        r.classList.toggle('ending', left < 10 && t.state === 'playing');
      }
      document.querySelectorAll(`#main [data-id="${CSS.escape(t.sound.id)}"]`).forEach(el => el.style.setProperty('--p', p.toFixed(3)));
    }
  },
  trackCard(t, sub, lead) {
    const n = splitName(t.sound.name);
    const tab = idx.tabOf.get(t.sound.id);
    const sw = t.sound.color || tab?.color || 'var(--raised)';
    const status = t.state === 'loading' ? 'Loading…' : t.state === 'fading' ? 'Fading out' : t.preview ? 'Preview' : (sub || tab?.name || '');
    return `<div class="card${t.state === 'fading' ? ' fading' : ''}${lead ? ' lead' : ''}" data-uid="${t.uid}" style="--c:${esc(sw)}">
      <div class="card-top">
        <span class="t">${n.eyebrow ? `<b>${esc(n.eyebrow)}</b>` : ''}${esc(n.title)}<small>${esc(n.artist ? n.artist + ' · ' : '')}${esc(status)}</small></span>
        <span class="remain num">-${fmt(t.end - t.time)}</span></div>
      <div class="bar"><i></i></div>
      <div class="card-row"><input type="range" min="0" max="1.5" step="0.01" value="${t.userVol}" aria-label="Volume for ${esc(t.sound.name)}">
        <button class="mini" data-act="fade">Fade</button></div>
    </div>`;
  },
  renderDock() {
    const list = $('#dockList');
    let html = '';
    const visible = tracks.filter(t => t.state !== 'done').slice().reverse(); // newest first
    visible.forEach((t, i) => { html += this.trackCard(t, t.playlist ? t.playlist.pl.name : '', i === 0 && t.state !== 'fading'); });
    if (activePL) {
      const A = activePL;
      const cur = A.track && A.track.state !== 'done' ? A.track : null;
      const upNext = A.order.find((s, i) => i > A.pos && Library.has(s) && (!settings.skipPlayed || !played.has(keyOf(s))));
      html += `<div class="card pl" data-pl="${esc(A.pl.id)}">
        <div class="card-top"><span class="t"><b>Playlist</b>${esc(A.pl.name)}<small>${cur ? `Song ${A.pos + 1} of ${A.order.length}` : 'Paused. Next song picks up where it left off.'}</small></span></div>
        ${upNext ? `<div class="upnext"><span>Up next</span>${esc(splitName(upNext.name).title)}</div>` : ''}
        <div class="pl-actions">
          <button class="mini primary" data-act="next">${ICONS.next}Next song</button>
          <button class="mini" data-act="auto" aria-pressed="${settings.playlistAuto}">Auto</button>
          <button class="mini" data-act="shuffle" aria-pressed="${settings.playlistShuffle}">${ICONS.shuffle}Shuffle</button>
          <button class="mini" data-act="close">End</button>
        </div></div>`;
    }
    if (!html) html = `<div class="empty">${Teams.badge(Teams.current, 'empty-logo')}<span>Quiet. Tap a button to start a sound.</span></div>`;
    list.innerHTML = html;
    document.body.classList.toggle('has-audio', visible.length > 0);
    this.updateProgress();
  },
  teamMenu(open) {
    document.querySelector('.tmenu')?.remove(); document.querySelector('.tscrim')?.remove();
    const btn = $('#teams .tpick');
    if (btn) btn.setAttribute('aria-expanded', String(!!open));
    if (!open) return;
    const r = btn.getBoundingClientRect();
    const scrim = Object.assign(document.createElement('div'), { className: 'tscrim' });
    const m = document.createElement('div');
    m.className = 'tmenu'; m.setAttribute('role', 'menu');
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - 290)) + 'px';
    m.style.top = (r.bottom + 6) + 'px';
    const cur = Teams.current.id;
    m.innerHTML = `<h4>${Edit.on ? 'Edit a team' : 'Team'}</h4>` + show.teams.map(t => `<button class="trow${t.id === cur ? ' on' : ''}" role="menuitemradio" aria-checked="${t.id === cur}" data-team="${esc(t.id)}">
        ${Teams.badge(t)}<span>${esc(t.name)}<small>${esc(t.full)}</small></span>${Edit.on ? `<span class="tick">${ICONS.pen}</span>` : (t.id === cur ? '<span class="tick">✓</span>' : '')}</button>`).join('')
      + (Edit.on ? `<button class="trow add" role="menuitem" data-add-team>${ICONS.plus}<span>Add a team</span></button>` : '');
    document.body.append(scrim, m);
    const close = () => { this.teamMenu(false); btn.focus(); };
    scrim.addEventListener('click', close);
    m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    m.addEventListener('click', e => {
      const add = e.target.closest('[data-add-team]');
      const row = e.target.closest('[data-team]');
      if (!add && !row) return;
      this.teamMenu(false);
      if (add) { Edit.team(Teams.current); setTimeout(() => $('[data-act="teamAdd"]')?.click(), 0); return; }
      const id = row.dataset.team;
      if (Edit.on) { Edit.team(show.teams.find(t => t.id === id)); return; }
      if (id === settings.team) return;
      settings.team = id; Prefs.save();
      Teams.apply(); this.renderHead(); this.renderMain(); this.renderDock();
      this.toast(`${Teams.current.full} selected.`);
    });
    (m.querySelector('.trow.on') || m.querySelector('.trow'))?.focus();
  },
  toast(msg, ms = 3400) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(this._t);
    this._t = setTimeout(() => { el.hidden = true; }, ms);
  },
};

/* ==================================================================== 9. EDIT MODE */

const Edit = {
  on: false,
  cur: null, // what the editor dialog is showing: { kind, ref }

  toggle(force) {
    const want = force ?? !this.on;
    if (want && !this.on) this._before = JSON.stringify(show);
    // leaving Edit: if anything changed, this device now has its own version of the layout
    if (!want && this.on && this._before && this._before !== JSON.stringify(show)) { settings.localEdits = true; Prefs.save(); }
    this.on = want;
    document.body.classList.toggle('editing', this.on);
    const b = $('#editBtn');
    b.setAttribute('aria-pressed', String(this.on));
    b.querySelector('span').textContent = this.on ? 'Done' : 'Edit';
    UI.renderTabs(); UI.renderMain();
  },

  /* ---------- the editor dialog ---------- */
  init() {
    const dlg = $('#editor');
    $('#edDone').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => {
      this.previewTrack?.stop(); this.previewTrack = null;
      this.cur = null; Show.changed(); UI.renderAll();
    });
    const body = $('#edBody');
    body.addEventListener('input', e => this.onField(e, false));
    body.addEventListener('change', e => this.onField(e, true));
    body.addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (b) this.onAct(b.dataset.act, b);
    });
  },
  show(title, html) {
    $('#edTitle').textContent = title;
    $('#edBody').innerHTML = html;
    const dlg = $('#editor');
    if (!dlg.open) dlg.showModal();
  },
  rerender() {
    if (!this.cur) return;
    const { kind, ref } = this.cur;
    const scroll = $('#edBody').scrollTop;
    this[kind](ref, true);
    $('#edBody').scrollTop = scroll;
  },
  swatches(cur, allowNone = true) {
    return `<div class="swatches">${allowNone ? `<button class="sw none${!cur ? ' on' : ''}" data-act="color" data-v="" aria-label="No colour">×</button>` : ''}
      ${SWATCHES.map(c => `<button class="sw${cur === c ? ' on' : ''}" data-act="color" data-v="${c}" style="--c:${c}" aria-label="Colour ${c}"></button>`).join('')}
      <label class="sw custom" aria-label="Custom colour"><input type="color" data-f="color" value="${esc(cur || '#3563d8')}"></label></div>`;
  },
  armed(b, label, fn) {
    if (b.dataset.armed) { delete b.dataset.armed; fn(); return; }
    const old = b.textContent;
    b.dataset.armed = '1'; b.textContent = label; b.classList.add('warn');
    setTimeout(() => { if (b.isConnected && b.dataset.armed) { delete b.dataset.armed; b.textContent = old; b.classList.remove('warn'); } }, 3500);
  },

  openFor(item, el) {
    if (el && el.dataset.hero === 'team') { this.team(Teams.current); return; }
    if (item.type === 'sound') this.sound(item);
    else if (item.type === 'playlist') this.playlist(item);
    else if (item.type === 'next') { if (item.id === 'next') UI.toast('This Next song button is built in. Add your own to a tab with Add Next-song button.'); else this.next(item); }
    else if (item.type === 'group') this.groups(item.id.startsWith('g:e') ? 'endings' : 'situations');
    else if (item.type === 'gamemusic') this.team(Teams.current);
  },

  /* ---------- sound button ---------- */
  sound(s) {
    this.cur = { kind: 'sound', ref: s };
    const tab = idx.tabOf.get(s.id);
    const has = Library.has(s);
    const tabsOpt = show.tabs.map(t => `<option value="${esc(t.id)}"${t === tab ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    const copyOpt = show.tabs.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
    this.show('Edit button', `
      <label class="field">Button name<input type="text" data-f="name" value="${esc(s.name)}" autocomplete="off"></label>
      <p class="hint">Tip: start the name with a situation, like “Penalty - Song - Artist”, and it joins that Game Day group.</p>
      <div class="field">Song file
        <div class="file-row"><span class="file-state ${has ? 'ok' : 'miss'}">${has ? '✓ On this device' : '✗ Not on this device'}: ${esc(s.file)}</span>
        <label class="mini file-btn">Choose a different file<input type="file" accept="audio/*,.mp3,.m4a,.wav" data-f="file"></label></div></div>
      <div class="field">Colour ${this.swatches(s.color)}</div>
      <div class="cut">
        <div class="cut-head"><b>Cut points</b><span id="edPos" class="num">Not playing</span></div>
        <div class="two">
          <label class="field">Start at (seconds)<input type="number" inputmode="decimal" step="0.25" min="0" data-f="start" value="${s.start || 0}"></label>
          <label class="field">Stop at (seconds, 0 = play to the end)<input type="number" inputmode="decimal" step="0.25" min="0" data-f="stop" value="${s.stop || 0}"></label>
        </div>
        <div class="row">
          <button class="mini primary" data-act="listen">${ICONS.next}Listen from start point</button>
          <button class="mini" data-act="listenTop">Play from 0:00</button>
          <button class="mini" data-act="markStart">Set start here</button>
          <button class="mini" data-act="markStop">Set stop here</button>
          <button class="mini" data-act="stopPreview">Stop</button>
        </div>
        <p class="hint">Play the song, then tap “Set start here” the moment the good part hits.</p>
      </div>
      <label class="field">Volume <b id="edVol" class="num">${Math.round((s.volume ?? 1) * 100)}%</b>
        <input type="range" min="0" max="1.5" step="0.05" data-f="volume" value="${s.volume ?? 1}"></label>
      <div class="two">
        <label class="field">Tab<select data-f="tab">${tabsOpt}</select></label>
        <label class="field">Also put a copy on<select data-f="copyTo"><option value="">Choose a tab…</option>${copyOpt}</select></label>
      </div>
      <div class="row">
        <button class="mini" data-act="moveUp">← Move earlier</button>
        <button class="mini" data-act="moveDown">Move later →</button>
        <span class="spacer"></span>
        <button class="mini danger" data-act="delete">Delete button</button>
      </div>`);
  },

  /* ---------- playlist ---------- */
  playlist(pl, keep) {
    this.cur = { kind: 'playlist', ref: pl };
    const songs = pl.songs.map(id => idx.sounds.get(id)).filter(Boolean);
    const q = keep ? ($('#plSearch')?.value || '') : '';
    this.show('Edit playlist', `
      <label class="field">Playlist name<input type="text" data-f="name" value="${esc(pl.name)}" autocomplete="off"></label>
      <div class="field">Colour ${this.swatches(pl.color)}</div>
      <h4>${songs.length} songs, in play order</h4>
      <ol class="song-list">${songs.map((s, i) => `<li><span>${esc(s.name)}</span>
        <button class="mini icon" data-act="plUp" data-i="${i}" aria-label="Move up">↑</button>
        <button class="mini icon" data-act="plDown" data-i="${i}" aria-label="Move down">↓</button>
        <button class="mini icon" data-act="plRemove" data-i="${i}" aria-label="Remove">✕</button></li>`).join('') || '<li class="hint">No songs yet. Add some below.</li>'}</ol>
      <h4>Add songs</h4>
      <input type="search" id="plSearch" data-f="plSearch" placeholder="Search your songs" value="${esc(q)}" autocomplete="off">
      <div id="plPick" class="pick-list">${this.pickList(pl, q)}</div>
      <div class="row"><button class="mini" data-act="moveUp">← Move earlier</button><button class="mini" data-act="moveDown">Move later →</button>
        <span class="spacer"></span><button class="mini danger" data-act="delete">Delete playlist</button></div>`);
  },
  pickList(pl, q) {
    const ql = q.trim().toLowerCase();
    const list = Show.uniqueSounds().filter(s => !pl.songs.includes(s.id) && (!ql || s.name.toLowerCase().includes(ql)));
    return list.slice(0, 60).map(s => `<button class="pick" data-act="plAdd" data-id="${esc(s.id)}">+ ${esc(s.name)}</button>`).join('')
      + (list.length > 60 ? `<p class="hint">${list.length - 60} more. Type to narrow the list.</p>` : '')
      + (!list.length ? '<p class="hint">No matching songs.</p>' : '');
  },

  /* ---------- next-song button ---------- */
  next(it) {
    this.cur = { kind: 'next', ref: it };
    this.show('Edit Next-song button', `
      <p class="hint">This button plays the next song of whichever playlist is running.</p>
      <label class="field">Button name<input type="text" data-f="name" value="${esc(it.name || 'Next song')}"></label>
      <div class="field">Colour ${this.swatches(it.color)}</div>
      <div class="row"><button class="mini" data-act="moveUp">← Move earlier</button><button class="mini" data-act="moveDown">Move later →</button>
      <span class="spacer"></span><button class="mini danger" data-act="delete">Delete button</button></div>`);
  },

  /* ---------- tab ---------- */
  tab(tab) {
    this.cur = { kind: 'tab', ref: tab };
    this.show('Tab settings', `
      <label class="field">Tab name<input type="text" data-f="name" value="${esc(tab.name)}"></label>
      <div class="field">Colour ${this.swatches(tab.color, false)}</div>
      <div class="field">Add songs to this tab
        <div class="row"><label class="mini file-btn">${ICONS.plus}Pick song files<input type="file" multiple accept="audio/*,.mp3,.m4a,.wav" data-f="addSongs"></label>
        <label class="mini file-btn">${ICONS.plus}Pick a whole folder<input type="file" webkitdirectory multiple data-f="addSongs"></label></div>
        <p id="edProgress" class="progress"></p></div>
      <div class="row">
        <button class="mini" data-act="tabLeft">← Move tab left</button>
        <button class="mini" data-act="tabRight">Move tab right →</button>
        <span class="spacer"></span>
        <button class="mini danger" data-act="delete">Delete tab and its ${tab.items.length} buttons</button>
      </div>`);
  },

  /* ---------- Game Day groups ---------- */
  groups(section, keep) {
    this.cur = { kind: 'groups', ref: section };
    const gd = show.gameday;
    const all = Show.uniqueSounds();
    const count = p => { const n = all.filter(s => startsWith(s, p)).length; return `${n} song${n === 1 ? '' : 's'}`; };
    const rows = key => gd[key].map((g, i) => `<div class="grp-row" data-list="${key}" data-i="${i}">
        <label class="field">Button label<input type="text" data-g="label" value="${esc(g.label)}"></label>
        <label class="field">Plays songs whose names start with<input type="text" data-g="prefix" value="${esc(g.prefix)}"></label>
        <label class="field colour-field">Colour<input type="color" data-g="color" value="${esc(g.color || '#8b95a1')}"></label>
        <span class="cnt num">${count(g.prefix)}</span>
        <button class="mini icon danger" data-act="grpDel" aria-label="Remove group">✕</button></div>`).join('');
    const moments = gd.moments.map((p, i) => `<div class="grp-row moment" data-list="moments" data-i="${i}">
        <label class="field">Show every song whose name starts with<input type="text" data-g="prefix" value="${esc(p)}"></label>
        <span class="cnt num">${count(p)}</span>
        <button class="mini icon danger" data-act="grpDel" aria-label="Remove">✕</button></div>`).join('');
    this.show('Game Day groups', `
      <p class="hint">Groups are built from button names. A group whose text is “Penalty” plays a random song from every button whose name starts with “Penalty”, like “Penalty - Sabotage - Beastie Boys”. To put a song in a group, rename its button.</p>
      <h4 id="grp-situations">Whistles (random buttons)</h4>${rows('situations')}
      <button class="mini" data-act="grpAdd" data-list="situations">${ICONS.plus}Add a whistle group</button>
      <h4 id="grp-moments">Moments (one button per song)</h4>${moments}
      <button class="mini" data-act="grpAdd" data-list="moments">${ICONS.plus}Add a moment</button>
      <h4 id="grp-endings">Game over (random buttons)</h4>${rows('endings')}
      <button class="mini" data-act="grpAdd" data-list="endings">${ICONS.plus}Add a game-over group</button>`);
    if (section && !keep) setTimeout(() => $('#grp-' + section)?.scrollIntoView({ block: 'start' }), 30);
  },

  /* ---------- team ---------- */
  team(team) {
    this.cur = { kind: 'team', ref: team };
    const horns = Teams.allGoalHorns();
    const pls = [...idx.playlists.values()];
    const opt = (list, cur, none) => `<option value="">${esc(none)}</option>` +
      list.map(x => `<option value="${esc(x.id)}"${x.id === cur ? ' selected' : ''}>${esc(x.name)}</option>`).join('');
    const autoHorn = horns[0];
    this.show('Team', `
      <div class="team-id">${Teams.badge(team, 'badge lg')}
        <div class="row">
          <label class="mini file-btn">${team.logo ? 'Replace logo' : 'Upload logo'}<input type="file" accept="image/*" data-f="logo"></label>
          ${team.logo ? '<button class="mini" data-act="removeLogo">Remove logo</button>' : ''}
          <label class="mini">Logo shape <select data-f="shape"><option value="round"${team.shape !== 'square' ? ' selected' : ''}>Round</option><option value="square"${team.shape === 'square' ? ' selected' : ''}>Square</option></select></label>
        </div></div>
      <div class="two">
        <label class="field">Short name (header)<input type="text" data-f="name" value="${esc(team.name)}"></label>
        <label class="field">Full name<input type="text" data-f="full" value="${esc(team.full)}"></label>
      </div>
      <div class="field">Team colour ${this.swatches(team.color, false)}</div>
      <label class="field">Goal horn<select data-f="goalHorn">${opt(horns, team.goalHorn, 'Automatic: ' + (autoHorn ? autoHorn.name : 'none'))}</select></label>
      <p class="hint">Only buttons with “Goal Horn” in the name are listed. Rename a button to add it.</p>
      <div class="two">
        <label class="field">Pregame playlist<select data-f="pregame">${opt(pls, team.pregame, 'None')}</select></label>
        <label class="field">Game music playlist<select data-f="game">${opt(pls, team.game, 'None')}</select></label>
      </div>
      <div class="row"><button class="mini" data-act="teamAdd">${ICONS.plus}Add another team</button><span class="spacer"></span>
        ${show.teams.length > 1 ? '<button class="mini danger" data-act="delete">Delete team</button>' : ''}</div>`);
  },

  /* ---------- field changes ---------- */
  async onField(e, committed) {
    const el = e.target;
    const f = el.dataset.f, g = el.dataset.g;
    if (!this.cur || (!f && !g)) return;
    const { kind, ref } = this.cur;

    if (g) { // Game Day group rows
      const row = el.closest('.grp-row');
      const list = show.gameday[row.dataset.list];
      const i = +row.dataset.i;
      if (row.dataset.list === 'moments') list[i] = el.value;
      else list[i][g] = el.value;
      const p = row.dataset.list === 'moments' ? list[i] : list[i].prefix;
      const n = Show.uniqueSounds().filter(s => startsWith(s, p)).length;
      row.querySelector('.cnt').textContent = `${n} song${n === 1 ? '' : 's'}`;
      Show.save();
      return;
    }
    if (f === 'plSearch') { if (!committed) $('#plPick').innerHTML = this.pickList(ref, el.value); return; }
    if (f === 'name' || f === 'full') { ref[f] = el.value; Show.save(); return; }
    if (f === 'color') { ref.color = safeColor(el.value, ref.color); Show.save(); if (kind === 'team') Teams.apply(); return; }
    if (f === 'start' || f === 'stop') { if (committed) { ref[f] = Math.max(0, Math.round((+el.value || 0) * 100) / 100); Show.save(); } return; }
    if (f === 'volume') { ref.volume = +el.value; $('#edVol').textContent = Math.round(ref.volume * 100) + '%'; tracks.filter(t => t.sound === ref).forEach(t => t.setUserVol(t.userVol)); Show.save(); return; }
    if (!committed) return;

    if (f === 'tab') {
      const from = idx.tabOf.get(ref.id), to = Show.tab(el.value);
      if (from && to && from !== to) { from.items = from.items.filter(i => i !== ref); to.items.push(ref); Show.changed(); UI.toast(`Moved to ${to.name}.`); }
    } else if (f === 'copyTo') {
      const to = Show.tab(el.value);
      if (to) { to.items.push({ ...ref, id: uid() }); Show.changed(); UI.toast(`Copied to ${to.name}.`); }
      el.value = '';
    } else if (f === 'file' && el.files[0]) {
      const { added } = await Library.importFiles([el.files[0]]);
      if (added[0]) {
        ref.file = added[0].file.webkitRelativePath || added[0].file.name;
        ref.length = await probeDuration(added[0].file) || ref.length;
        Show.changed(); this.rerender(); UI.toast('Song file updated.');
      }
    } else if (f === 'addSongs') {
      await this.addSongs(ref, el.files, el);
    } else if (f === 'logo' && el.files[0]) {
      const r = await processLogo(el.files[0]);
      if (!r) { UI.toast('That image couldn\'t be read.'); return; }
      ref.logo = r.data;
      if (r.color) ref.color = r.color;
      Show.changed(); this.rerender(); Teams.apply(); UI.renderHead();
    } else if (f === 'shape') { ref.shape = el.value; Show.changed(); this.rerender(); UI.renderHead(); }
    else if (['goalHorn', 'pregame', 'game'].includes(f)) { ref[f] = el.value || null; Show.changed(); }
  },

  /* ---------- buttons inside the editor ---------- */
  onAct(act, b) {
    if (!this.cur) return;
    const { kind, ref } = this.cur;
    const move = (arr, i, d) => { const j = i + d; if (i < 0 || j < 0 || j >= arr.length) return false; [arr[i], arr[j]] = [arr[j], arr[i]]; return true; };

    if (act === 'color') {
      ref.color = safeColor(b.dataset.v, null);
      Show.save(); this.rerender();
      if (kind === 'team') { Teams.apply(); UI.renderHead(); }
    } else if (act === 'listen' || act === 'listenTop') {
      audioCtx();
      this.previewTrack?.stop();
      const s = act === 'listenTop' ? Object.assign(Object.create(ref), { start: 0, stop: 0 }) : ref;
      playSound(s, { preview: true }).then(t => { this.previewTrack = t; });
    } else if (act === 'stopPreview') {
      this.previewTrack?.stop(); this.previewTrack = null;
      tracks.filter(t => t.sound === ref || Object.getPrototypeOf(t.sound) === ref).forEach(t => t.stop());
    } else if (act === 'markStart' || act === 'markStop') {
      const t = this.liveTrackFor(ref);
      if (!t) { UI.toast('Play the song first, then tap this at the right moment.'); return; }
      const v = Math.round(t.time * 4) / 4;
      if (act === 'markStart') ref.start = v; else ref.stop = v;
      $(`[data-f="${act === 'markStart' ? 'start' : 'stop'}"]`).value = v;
      Show.save();
      UI.toast(`${act === 'markStart' ? 'Start' : 'Stop'} set to ${fmt(v)} (${v}s).`);
    } else if (act === 'moveUp' || act === 'moveDown') {
      const tab = idx.tabOf.get(ref.id);
      if (tab && move(tab.items, tab.items.indexOf(ref), act === 'moveUp' ? -1 : 1)) { Show.changed(); UI.renderMain(); UI.toast('Moved.'); }
    } else if (act === 'delete') {
      this.armed(b, kind === 'tab' ? 'Tap again to delete this tab' : 'Tap again to delete', () => {
        if (kind === 'tab') {
          for (const it of [...ref.items]) Show.removeItem(it.id);
          show.tabs = show.tabs.filter(t => t !== ref);
          if (!show.tabs.length) show.tabs.push({ id: uid(), name: 'Sounds', color: '#3563d8', items: [] });
          UI.view = 'gameday';
          Show.changed();
        } else if (kind === 'team') {
          show.teams = show.teams.filter(t => t !== ref);
          settings.team = show.teams[0].id; Prefs.save();
          Show.changed();
        } else {
          Show.removeItem(ref.id);
        }
        $('#editor').close();
        UI.toast('Deleted.');
      });
    } else if (act === 'plAdd') {
      ref.songs.push(b.dataset.id); Show.save(); this.rerender();
    } else if (act === 'plRemove') {
      ref.songs.splice(+b.dataset.i, 1); Show.save(); this.rerender();
    } else if (act === 'plUp' || act === 'plDown') {
      if (move(ref.songs, +b.dataset.i, act === 'plUp' ? -1 : 1)) { Show.save(); this.rerender(); }
    } else if (act === 'tabLeft' || act === 'tabRight') {
      if (move(show.tabs, show.tabs.indexOf(ref), act === 'tabLeft' ? -1 : 1)) { Show.changed(); UI.renderTabs(); }
    } else if (act === 'grpAdd') {
      const list = b.dataset.list;
      if (list === 'moments') show.gameday.moments.push('');
      else show.gameday[list].push({ label: 'New group', prefix: '', color: SWATCHES[show.gameday[list].length % SWATCHES.length] });
      Show.save(); this.groups(this.cur.ref, true);
      const rows = document.querySelectorAll(`.grp-row[data-list="${list}"]`);
      const last = rows[rows.length - 1];
      last?.scrollIntoView({ block: 'center' });
      last?.querySelector('input')?.focus();
    } else if (act === 'grpDel') {
      const row = b.closest('.grp-row');
      show.gameday[row.dataset.list].splice(+row.dataset.i, 1);
      Show.save();
      const scroll = $('#edBody').scrollTop;
      this.groups(this.cur.ref, true);
      $('#edBody').scrollTop = scroll;
    } else if (act === 'removeLogo') {
      ref.logo = null; Show.changed(); this.rerender(); UI.renderHead();
    } else if (act === 'teamAdd') {
      const t = { id: uid(), name: 'New team', full: 'New team', color: SWATCHES[show.teams.length % SWATCHES.length], shape: 'round', logo: null, goalHorn: null, pregame: null, game: null };
      show.teams.push(t); settings.team = t.id; Prefs.save();
      Show.changed(); this.team(t); UI.renderHead(); Teams.apply();
    }
  },
  liveTrackFor(s) {
    return tracks.find(t => (t.sound === s || Object.getPrototypeOf(t.sound) === s) && t.state === 'playing') || null;
  },
  tick() {
    if (!this.cur || this.cur.kind !== 'sound') return;
    const el = $('#edPos');
    if (!el) return;
    const t = this.liveTrackFor(this.cur.ref);
    el.textContent = t ? `Playing at ${fmt(t.time)} (${(Math.round(t.time * 4) / 4).toFixed(2)} s)` : 'Not playing';
  },

  /* ---------- adding things ---------- */
  async addSongs(tab, files, input) {
    if (!tab || !files || !files.length) return;
    const say = m => { const p = $('#edProgress'); if (p && $('#editor').open) p.textContent = m; else UI.toast(m); };
    const { added, failed, cancelled } = await Library.importFiles(files, (i, n) => say(`Adding ${i} of ${n} songs…`));
    if (cancelled) { if (input) input.value = ''; say('Cancelled. Nothing was added.'); return; }
    for (const { file } of added) {
      tab.items.push({
        type: 'sound', id: uid(), name: prettyName(file.name), file: file.webkitRelativePath || file.name,
        start: 0, stop: 0, volume: 1, length: await probeDuration(file), color: null,
      });
    }
    if (input) input.value = '';
    Show.changed();
    UI.renderTabs(); UI.renderMain(); UI.renderHead();
    say(added.length
      ? `Added ${added.length} song${added.length === 1 ? '' : 's'} to ${tab.name}.${failed ? ` ${failed} couldn't be saved on this device.` : ''}`
      : 'No song files were picked. Use MP3, M4A or WAV files.');
  },
  newTab() {
    const t = { id: uid(), name: 'New tab', color: SWATCHES[show.tabs.length % SWATCHES.length], items: [] };
    show.tabs.push(t);
    Show.changed();
    UI.view = t.id;
    UI.renderTabs(); UI.renderMain();
    this.tab(t);
  },
  addPlaylist(tab) {
    const pl = { type: 'playlist', id: uid(), name: 'New playlist', color: '#2f9e5b', songs: [] };
    tab.items.push(pl);
    Show.changed(); UI.renderMain();
    this.playlist(pl);
  },
  addNext(tab) {
    tab.items.push({ type: 'next', id: uid(), name: 'Next song', color: '#bfef45' });
    Show.changed(); UI.renderMain();
    UI.toast('Next-song button added.');
  },
};

/* ==================================================================== 10. SHARING */

const Share = {
  download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 120000);
  },
  base() { return (show.name || 'show').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'show'; },

  /* Saving: on computers (Chrome or Edge on Windows, Mac, ChromeOS) a "Save as"
     window lets you pick the folder and file name. Phones, tablets and Safari
     don't allow that, so the file goes to Downloads like any other download. */
  canPickFolder() {
    if (typeof window.showSaveFilePicker !== 'function') return false;
    try { return window.self === window.top; } catch (e) { return false; } // not inside a preview frame
  },
  // must be called straight from the button tap, before any waiting
  async pickTarget(name, kind) {
    if (!this.canPickFolder()) return null;
    const types = kind === 'pack'
      ? [{ description: 'Rinkside show pack', accept: { 'application/octet-stream': ['.rinkpack'] } }]
      : [{ description: 'Rinkside layout', accept: { 'application/json': ['.json'] } }];
    try {
      return await window.showSaveFilePicker({ suggestedName: name, types, id: 'rinkside-' + kind, startIn: 'downloads' });
    } catch (e) {
      if (e && e.name === 'AbortError') return 'cancelled';
      console.warn('Save picker unavailable, using a normal download', e);
      return null;
    }
  },
  async writeTo(handle, parts, say) {
    const w = await handle.createWritable();
    let done = 0;
    const total = parts.reduce((n, p) => n + (p.size ?? p.byteLength ?? p.length), 0);
    try {
      for (const p of parts) {
        await w.write(p);
        done += p.size ?? p.byteLength ?? p.length;
        if (total > 50e6) say?.(`Saving… ${Math.round(done / total * 100)}%`);
      }
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (err) {}
      throw e;
    }
  },
  downloadHint() {
    return /Android|iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      ? ' Phones and tablets always save to the Downloads folder.'
      : ' To choose the folder every time, turn on your browser\'s “Ask where to save each file” setting (Chrome: Settings › Downloads).';
  },

  async saveLayout(say) {
    const name = `${this.base()}.rinkside.json`;
    const target = await this.pickTarget(name, 'layout');
    if (target === 'cancelled') return 'Save cancelled.';
    const blob = new Blob([JSON.stringify(show)], { type: 'application/json' });
    if (target) { await this.writeTo(target, [blob], say); return `Saved ${target.name}.`; }
    this.download(blob, name);
    return `Saved ${name} to Downloads.` + this.downloadHint();
  },

  /* A show pack is: "RINKPACK1\n", a 12-digit header length, a JSON header
     (the show plus a list of files with their sizes), then the song files
     back to back. No compression: MP3s don't shrink, and this keeps it fast. */
  async buildPack(say) {
    const keys = [...new Set(Show.uniqueSounds().map(s => Library.resolve(s)).filter(Boolean))];
    const files = [], blobs = [];
    for (let i = 0; i < keys.length; i++) {
      const b = await Library.blobByKey(keys[i]);
      if (!b) continue;
      files.push({ key: keys[i], size: b.size, type: b.type || 'audio/mpeg' });
      blobs.push(b);
      if (i % 20 === 0) say?.(`Gathering songs ${i + 1} of ${keys.length}…`);
    }
    const header = new TextEncoder().encode(JSON.stringify({ format: 'rinkside-pack', version: 1, show, files }));
    const parts = [new Blob(['RINKPACK1\n', String(header.length).padStart(12, '0'), header]), ...blobs];
    return { parts, blob: new Blob(parts, { type: 'application/octet-stream' }), count: files.length };
  },
  async savePack(say) {
    const name = `${this.base()}.rinkpack`;
    const target = await this.pickTarget(name, 'pack'); // ask first, while the tap still counts
    if (target === 'cancelled') return 'Save cancelled.';
    const { parts, blob, count } = await this.buildPack(say);
    const size = `${(blob.size / 1e9).toFixed(2)} GB, ${count} songs`;
    if (target) { await this.writeTo(target, parts, say); return `Saved ${target.name} (${size}).`; }
    this.download(blob, name);
    return `Saved ${name} (${size}) to Downloads.` + this.downloadHint();
  },

  async read(file) {
    const gb = n => (n / 1e9).toFixed(2) + ' GB';
    const magic = await file.slice(0, 10).text();
    if (magic === 'RINKPACK1\n') {
      const len = parseInt(await file.slice(10, 22).text(), 10);
      if (!(len > 0) || 22 + len > file.size) throw new Error('incomplete:' + file.size + ':' + (22 + len));
      const header = JSON.parse(await file.slice(22, 22 + len).text());
      let off = 22 + len;
      const expected = off + header.files.reduce((n, f) => n + f.size, 0);
      // a download that stopped early leaves a short file: catch it here rather than half-loading
      if (file.size < expected) throw new Error('incomplete:' + file.size + ':' + expected);
      const files = header.files.map(f => { const blob = file.slice(off, off + f.size, f.type); off += f.size; return { key: f.key, blob }; });
      return { kind: 'pack', show: Show.normalise(header.show), files, size: file.size };
    }
    // never read a big non-pack file as text: it can freeze a phone
    if (file.size > 20e6) throw new Error('notpack');
    const json = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    return { kind: 'layout', show: Show.normalise(json), files: [], size: file.size };
  },

  async apply(parsed, say) {
    try { await navigator.storage?.persist?.(); } catch (e) {}
    const items = parsed.files.map(f => ({ ...f, size: f.blob.size }));
    if (!(await Library.sortDuplicates(items))) return { failed: 0, cancelled: true };
    let n = 0, failed = 0;
    for (const f of items) {
      if (f.skip) { n++; continue; }
      if (urlCache.has(f.key)) { URL.revokeObjectURL(urlCache.get(f.key)); urlCache.delete(f.key); }
      if (!(await Library.putBlob(f.key, f.blob))) failed++;
      if (++n % 10 === 0 || n === parsed.files.length) say(`Copying songs ${n} of ${parsed.files.length}…`);
    }
    setShow(parsed.show);
    await Store.put('kv', 'show', show).catch(() => {});
    return { failed };
  },
};

/* ==================================================================== 10b. GOOGLE DRIVE DOWNLOADS AND SYNC */

/* Zip reading, for folders downloaded from Google Drive (Drive zips a folder when you
   download it, in parts of about 2 GB). Only the zip's table of contents is read up front;
   each song is pulled out when it's copied, so a 2 GB zip never has to fit in memory. */
const AUDIO_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/ogg', webm: 'audio/webm' };
const audioType = name => AUDIO_TYPES[String(name).split('.').pop().toLowerCase()] || '';

const Zip = {
  async entries(file) {
    const tailLen = Math.min(file.size, 65557 + 20);
    const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
    let e = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('zip:bad'); // no table of contents: usually a download that stopped early
    let count = tail.getUint16(e + 10, true), cdSize = tail.getUint32(e + 12, true), cdOff = tail.getUint32(e + 16, true);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) { // zip64
      const loc = e - 20;
      if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('zip:bad');
      const at = Number(tail.getBigUint64(loc + 8, true));
      const z = new DataView(await file.slice(at, at + 56).arrayBuffer());
      if (z.getUint32(0, true) !== 0x06064b50) throw new Error('zip:bad');
      count = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
    }
    if (cdOff + cdSize > file.size) throw new Error('zip:incomplete');
    const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const utf8 = new TextDecoder('utf-8');
    const out = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('zip:bad');
      const flags = cd.getUint16(p + 8, true), method = cd.getUint16(p + 10, true);
      const time = cd.getUint16(p + 12, true), date = cd.getUint16(p + 14, true);
      let csize = cd.getUint32(p + 20, true), usize = cd.getUint32(p + 24, true);
      const nl = cd.getUint16(p + 28, true), xl = cd.getUint16(p + 30, true), cl = cd.getUint16(p + 32, true);
      let off = cd.getUint32(p + 42, true);
      const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nl)).replace(/\\/g, '/');
      for (let x = p + 46 + nl, end = x + xl; x + 4 <= end;) { // zip64 sizes and offsets
        const id = cd.getUint16(x, true), sz = cd.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(cd.getBigUint64(q, true)); q += 8; }
          if (off === 0xffffffff) { off = Number(cd.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + sz;
      }
      p += 46 + nl + xl + cl;
      if (name.endsWith('/') || /(^|\/)(__MACOSX|\.)/.test(name)) continue; // folders and hidden files
      const mtime = new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
      out.push({ file, name, method, csize, usize, off, flags, mtime });
    }
    return out;
  },
  async blob(en, type = '') {
    if (en.flags & 1) throw new Error('zip:encrypted');
    const h = new DataView(await en.file.slice(en.off, en.off + 30).arrayBuffer());
    if (h.byteLength < 30 || h.getUint32(0, true) !== 0x04034b50) throw new Error('zip:bad');
    const start = en.off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    if (start + en.csize > en.file.size) throw new Error('zip:incomplete');
    const raw = en.file.slice(start, start + en.csize);
    if (en.method === 0) return new Blob([raw], { type });
    if (en.method !== 8) throw new Error('zip:method');
    if (typeof DecompressionStream !== 'function') throw new Error('zip:unsupported');
    let out;
    try { out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob(); }
    catch (e) { throw new Error(e instanceof TypeError && /deflate-raw|not supported|Unsupported/i.test(e.message) ? 'zip:unsupported' : 'zip:bad'); }
    if (en.usize && out.size !== en.usize) throw new Error('zip:bad');
    return new Blob([out], { type });
  },
};

/* Google sign-in, for a Drive folder shared only with named people. Uses Google's full-page
   sign-in (a redirect, not a pop-up: pop-ups are unreliable in Home Screen apps on iPhone).
   Google sends the person back here with a one-hour access token, which is kept on this
   device only. Nothing is ever sent anywhere except to Google. */
const Auth = {
  KEY: 'rinkside.google',
  PENDING: 'rinkside.signin',
  clientId() { return String(settings.driveClient || DRIVE.clientId || '').trim(); },
  enabled() { return !!this.clientId(); },
  canRedirect() { return location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname); },
  redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ''); },
  _entry() {
    try { const t = JSON.parse(localStorage.getItem(this.KEY) || 'null'); if (t && t.exp > Date.now() + 60000) return t; } catch (e) {}
    return null;
  },
  token() { return this._entry()?.token || null; },
  // the current sign-in also allows writing to Drive (asked for only when the organizer publishes)
  canWrite() { return String(this._entry()?.scope || '').split(/\s+/).includes(DRIVE.writeScope); },
  forget() { try { localStorage.removeItem(this.KEY); } catch (e) {} },
  // leaves the app for Google's sign-in page; consume() picks up the answer when it comes back
  signIn(resume, chooseAccount = false, scope = DRIVE.scope) {
    const state = uid() + uid();
    try { localStorage.setItem(this.PENDING, JSON.stringify({ state, resume, at: Date.now() })); } catch (e) {}
    const u = new URL(settings.driveAuth || DRIVE.auth);
    const q = { client_id: this.clientId(), redirect_uri: this.redirectUri(), response_type: 'token', scope,
      include_granted_scopes: 'true', state };
    if (chooseAccount) q.prompt = 'select_account';
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    // save any just-made layout change before leaving the page for Google
    clearTimeout(Show._t);
    Store.put('kv', 'show', show).catch(() => {}).finally(() => location.assign(u.toString()));
  },
  // called at start-up: handles the "#access_token=…" (or "#error=…") Google sends back
  consume() {
    const h = location.hash;
    if (!/[#&](access_token|error)=/.test(h)) return null;
    const p = new URLSearchParams(h.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(this.PENDING) || 'null'); localStorage.removeItem(this.PENDING); } catch (e) {}
    if (!pending || pending.state !== p.get('state') || Date.now() - pending.at > 30 * 60000) return { error: 'state' };
    if (p.get('error')) return { error: p.get('error'), resume: pending.resume };
    const ttl = +p.get('expires_in') || 3600;
    try { localStorage.setItem(this.KEY, JSON.stringify({ token: p.get('access_token'), scope: p.get('scope') || '', exp: Date.now() + ttl * 1000 })); } catch (e) {}
    return { ok: true, resume: pending.resume };
  },
};

/* Two ways in, one plan and one copy step:
   - check: signs in with the person's Google account and reads the team's private Drive
     folder. Only accounts the folder is shared with get in. This is the normal way.
   - fromFiles: zip files (or a layout file and loose songs) downloaded from Google Drive
     in a browser. Drive still decides who can download.
   Check builds a plan (new layout? which songs are new or changed?); Run downloads it.
   Songs already on the device are skipped, so a sync that was interrupted (screen locked,
   wifi dropped) picks up where it stopped. There is deliberately no "anyone with the
   link" mode: access is always per person. */
const Drive = {
  busy: false,
  stopped: false,
  plan: null,

  folderId() {
    const v = String(settings.driveFolder || '').trim();
    const m = v.match(/folders\/([\w-]{10,})/) || v.match(/[?&]id=([\w-]{10,})/) || v.match(/^([\w-]{10,})$/);
    return m ? m[1] : DRIVE.folder;
  },
  // online checking needs Google sign-in, which only works from the web address
  ready() { return !!this.folderId() && Auth.enabled() && Auth.canRedirect(); },
  url(path, params = {}) {
    const u = new URL(path, settings.driveApi || DRIVE.api);
    u.searchParams.set('supportsAllDrives', 'true');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  },
  async get(path, params) {
    const t = Auth.token();
    if (!t) throw new Error('drive:signin');
    const opts = { cache: 'no-store', headers: { Authorization: 'Bearer ' + t } };
    let r;
    try { r = await fetch(this.url(path, params), opts); }
    catch (e) { throw new Error('drive:offline'); }
    if (r.status === 401 && Auth.enabled()) { Auth.forget(); throw new Error('drive:signin'); }
    if (!r.ok) {
      let reason = '';
      try { const j = await r.json(); reason = j.error?.errors?.[0]?.reason || j.error?.details?.[0]?.reason || j.error?.status || ''; } catch (e) {}
      throw new Error(`drive:${r.status}:${reason}`);
    }
    return r;
  },
  // writes (publishing): always signed in, always with the organizer's write permission
  async send(method, url, body, headers = {}) {
    const t = Auth.token();
    if (!t) throw new Error('drive:signin');
    let r;
    try { r = await fetch(url, { method, body, headers: { ...headers, Authorization: 'Bearer ' + t } }); }
    catch (e) { throw new Error('drive:offline'); }
    if (r.status === 401) { Auth.forget(); throw new Error('drive:signin'); }
    if (!r.ok) {
      let reason = '';
      try { const j = await r.json(); reason = j.error?.errors?.[0]?.reason || j.error?.status || ''; } catch (e) {}
      throw new Error(`drive:${r.status}:${reason}`);
    }
    return r;
  },
  upUrl(path, params = {}) {
    const u = new URL(path, settings.driveUpload || DRIVE.upload);
    u.searchParams.set('supportsAllDrives', 'true');
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  },
  async createFolder(name, parent) {
    return (await this.send('POST', this.url('files', { fields: 'id,name' }), JSON.stringify({ name, parents: [parent], mimeType: 'application/vnd.google-apps.folder' }),
      { 'Content-Type': 'application/json; charset=UTF-8' })).json();
  },
  // a new file, in two steps: Google gives an upload address, then the bytes go there
  async uploadNew(name, parent, blob, type) {
    const init = await this.send('POST', this.upUrl('files', { uploadType: 'resumable', fields: 'id,name,size,md5Checksum,modifiedTime' }),
      JSON.stringify({ name, parents: [parent] }), { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type });
    const loc = init.headers.get('Location');
    if (!loc) throw new Error('drive:upload');
    return (await this.send('PUT', loc, blob, { 'Content-Type': type })).json();
  },
  // new contents for an existing file (Drive keeps the earlier version in its version history)
  async replace(id, blob, type) {
    return (await this.send('PATCH', this.upUrl('files/' + id, { uploadType: 'media', fields: 'id,name,modifiedTime' }), blob, { 'Content-Type': type })).json();
  },

  // every file under the folder, with its path inside it ("Hockey Songs/Rock/Song.mp3")
  async listAll(withFolders = false) {
    const out = [], folders = [];
    const queue = [{ id: this.folderId(), path: '' }];
    while (queue.length) {
      const f = queue.shift();
      let token = '';
      do {
        const p = { q: `'${f.id}' in parents and trashed = false`, pageSize: '1000', includeItemsFromAllDrives: 'true',
          fields: 'nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)' };
        if (token) p.pageToken = token;
        const j = await (await this.get('files', p)).json();
        for (const x of j.files || []) {
          const path = f.path ? `${f.path}/${x.name}` : x.name;
          if (x.mimeType === 'application/vnd.google-apps.folder') { queue.push({ id: x.id, path }); folders.push({ id: x.id, name: x.name, path, parent: f.path }); }
          else out.push({ id: x.id, name: x.name, path, size: +x.size || 0, md5: x.md5Checksum || '', modifiedTime: x.modifiedTime || '' });
        }
        token = j.nextPageToken || '';
      } while (token);
    }
    return withFolders ? { files: out, folders } : out;
  },
  pickLayout(files) {
    return files.filter(f => /\.rinkside\.json$/i.test(f.name))
      .sort((a, b) => (a.path.includes('/') - b.path.includes('/')) || b.modifiedTime.localeCompare(a.modifiedTime))[0] || null;
  },

  async check(say) {
    if (!this.ready()) throw new Error('drive:nosignin');
    if (navigator.onLine === false) throw new Error('drive:offline'); // never send someone to a sign-in page that can't load
    if (Auth.enabled() && !Auth.token()) throw new Error('drive:signin');
    say('Looking at the Google Drive folder…');
    const folder = await (await this.get('files/' + this.folderId(), { fields: 'id,name,capabilities(canAddChildren)' })).json();
    if (Auth.enabled()) this.setEditor(!!folder.capabilities?.canAddChildren);
    const files = await this.listAll();
    const songs = files.filter(f => AUDIO_EXT.test(f.name));
    const layouts = files.filter(f => /\.rinkside\.json$/i.test(f.name))
      .sort((a, b) => (a.path.includes('/') - b.path.includes('/')) || b.modifiedTime.localeCompare(a.modifiedTime));
    const layout = layouts[0] || null;
    const last = settings.driveLayout;
    const layoutNew = !!layout && !(last && last.id === layout.id && last.modifiedTime === layout.modifiedTime);

    say(`Comparing ${songs.length} songs with this device…`);
    const manifest = (await Store.get('kv', 'driveManifest')) || {};
    const tail = k => k.split('/').slice(-2).join('/');
    const get = [], update = [], tails = new Set();
    for (const s of songs) {
      const key = norm(s.path);
      tails.add(tail(key));
      const have = Library.byTail.get(tail(key));
      s.load = () => this.get('files/' + s.id, { alt: 'media' }).then(r => r.blob());
      if (!have) { get.push({ ...s, key }); continue; }
      const m = manifest[have];
      let changed;
      if (m) changed = s.md5 && m.md5 ? s.md5 !== m.md5 : s.size !== m.size;
      else { // loaded from a folder or show pack: same size means same file
        const b = await Library.blobByKey(have);
        changed = !!b && !!s.size && b.size !== s.size;
        if (!changed) manifest[have] = { id: s.id, md5: s.md5, size: s.size };
      }
      if (changed) update.push({ ...s, key, old: have });
    }
    await Store.put('kv', 'driveManifest', manifest).catch(() => {});
    const local = [...new Set([...(await Store.keys('audio')), ...Library.mem.keys()])];
    const extra = songs.length ? local.filter(k => !tails.has(tail(k))) : []; // never offer to empty the device
    if (layout) layout.load = () => this.get('files/' + layout.id, { alt: 'media' }).then(r => r.text());
    this.plan = { source: 'drive', folder, layout, layoutNew, songs, get, update, extra };
    return this.plan;
  },

  // Plan an import from files picked on the device: Drive zips, a layout file, loose songs.
  async fromFiles(files, say) {
    const songs = [], layouts = [];
    for (const f of files) {
      if (/\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed') {
        say(`Reading ${f.name}…`);
        for (const en of await Zip.entries(f)) {
          if (AUDIO_EXT.test(en.name)) songs.push({ path: en.name, name: en.name.split('/').pop(), size: en.usize, load: () => Zip.blob(en, audioType(en.name)) });
          else if (/\.rinkside\.json$/i.test(en.name)) layouts.push({ path: en.name, name: en.name.split('/').pop(), when: en.mtime, load: async () => (await Zip.blob(en)).text() });
        }
      } else if (AUDIO_EXT.test(f.name)) {
        songs.push({ path: f.webkitRelativePath || f.name, name: f.name, size: f.size, load: async () => f });
      } else if (/\.json$/i.test(f.name) && f.size < 20e6) {
        layouts.push({ path: f.name, name: f.name, when: new Date(f.lastModified || Date.now()), load: () => f.text() });
      }
    }
    if (!songs.length && !layouts.length) throw new Error('files:none');
    // the layout nearest the top of the folder wins, then the newest
    const depth = l => l.path.split('/').length;
    layouts.sort((a, b) => depth(a) - depth(b) || b.when - a.when);
    const layout = layouts[0] || null;
    let layoutShow = null, layoutNew = false;
    if (layout) {
      layoutShow = Show.normalise(JSON.parse((await layout.load()).replace(/^﻿/, '')));
      layout.modifiedTime = layout.when.toISOString();
      layoutNew = JSON.stringify(layoutShow) !== JSON.stringify(show);
    }
    say(`Comparing ${songs.length} songs with this device…`);
    const seen = new Set(), get = [], update = [], tails = new Set(), bases = new Set();
    for (const s of songs) {
      const key = norm(s.path);
      if (seen.has(key)) continue;
      seen.add(key);
      const parts = key.split('/');
      const tl = parts.slice(-2).join('/'), base = parts[parts.length - 1];
      tails.add(tl); bases.add(base);
      // with a folder, match folder/file exactly; a loose song matches by file name
      const have = parts.length > 1 ? Library.byTail.get(tl) : Library.byBase.get(base);
      if (!have) { get.push({ ...s, key }); continue; }
      const b = await Library.blobByKey(have);
      if (b && s.size && b.size !== s.size) update.push({ ...s, key, old: have });
    }
    // songs on the device that aren't in this download: only worth removing after a whole-folder download
    const local = [...new Set([...(await Store.keys('audio')), ...Library.mem.keys()])];
    const extra = songs.length >= 20 ? local.filter(k => { const p = k.split('/'); return !tails.has(p.slice(-2).join('/')) && !(p.length === 1 && bases.has(k)); }) : [];
    this.plan = { source: 'files', layout, layoutShow, layoutNew, songs, get, update, extra, files: files.length };
    return this.plan;
  },

  // Organizer: Edit and Publish only appear for Google accounts that can edit the Drive folder.
  setEditor(on) {
    if (settings.driveEditor === on) return;
    settings.driveEditor = on; Prefs.save();
    applyRole();
  },

  /* Publish: send this device's layout, and any songs it uses that Drive doesn't have yet,
     to the Drive folder. Songs go into the matching category folder under Hockey Songs.
     Nothing in Drive is ever deleted. */
  async publishPlan(say) {
    if (navigator.onLine === false) throw new Error('drive:offline');
    if (!Auth.token() || !Auth.canWrite()) throw new Error('drive:needwrite');
    say('Looking at the Google Drive folder…');
    const root = this.folderId();
    const folder = await (await this.get('files/' + root, { fields: 'id,name,capabilities(canAddChildren)' })).json();
    this.setEditor(!!folder.capabilities?.canAddChildren);
    if (!folder.capabilities?.canAddChildren) throw new Error('drive:noteditor');
    const { files, folders } = await this.listAll(true);
    const layout = this.pickLayout(files);
    const songsRoot = folders.find(f => !f.parent && f.name.toLowerCase() === 'hockey songs') || { id: root, path: '', name: folder.name };
    const tails = new Set(), bases = new Set();
    for (const f of files) if (AUDIO_EXT.test(f.name)) { const k = norm(f.path).split('/'); tails.add(k.slice(-2).join('/')); bases.add(k[k.length - 1]); }
    say('Comparing this device with Drive…');
    const uploads = [], seen = new Set();
    for (const s of Show.uniqueSounds()) {
      const key = Library.resolve(s);
      if (!key || seen.has(key)) continue;
      const orig = String(s.file).replace(/\\/g, '/').split('/').filter(Boolean);
      const k = norm(s.file).split('/');
      const there = k.length > 1 ? tails.has(k.slice(-2).join('/')) : bases.has(k[k.length - 1]);
      if (there) continue;
      seen.add(key);
      const blob = await Library.blobByKey(key);
      if (!blob) continue;
      const folderName = orig.length > 1 ? orig[orig.length - 2] : (idx.tabOf.get(s.id)?.name || 'New Songs');
      uploads.push({ key, file: norm(s.file), name: orig[orig.length - 1], folderName, size: blob.size, type: blob.type || audioType(s.file) || 'audio/mpeg' });
    }
    let layoutChanged = true;
    if (layout) {
      try { layoutChanged = JSON.stringify(Show.normalise(JSON.parse((await (await this.get('files/' + layout.id, { alt: 'media' })).text()).replace(/^﻿/, '')))) !== JSON.stringify(show); } catch (e) {}
    }
    if (uploads.length) layoutChanged = true; // the songs' new places go into the layout
    this.pub = { root, folder, layout, songsRoot, folders, uploads, layoutChanged };
    return this.pub;
  },

  async publish(say, meter) {
    const P = this.pub;
    if (!P || this.busy) return '';
    this.busy = true; this.stopped = false;
    const gb = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
    const total = P.uploads.reduce((n, u) => n + u.size, 0);
    let done = 0, bytes = 0, failed = 0, lastErr = null;
    try {
      const manifest = (await Store.get('kv', 'driveManifest')) || {};
      const folderFor = async name => {
        const base = P.songsRoot.path;
        let f = P.folders.find(x => x.parent === base && x.name.toLowerCase() === name.toLowerCase());
        if (!f) { const c = await this.createFolder(name, P.songsRoot.id); f = { id: c.id, name: c.name, path: base ? `${base}/${c.name}` : c.name, parent: base }; P.folders.push(f); }
        return f;
      };
      for (const u of P.uploads) {
        if (this.stopped) break;
        say(`Uploading songs: ${done + 1} of ${P.uploads.length} (${gb(bytes)} of ${gb(total)})…`);
        try {
          const f = await folderFor(u.folderName);
          const blob = await Library.blobByKey(u.key);
          const r = await this.uploadNew(u.name, f.id, blob, u.type);
          // the song now lives at "Category/Song.mp3": point the buttons and the stored copy there
          const newFile = `${f.name}/${u.name}`, newKey = norm(`${f.path}/${u.name}`);
          for (const s of idx.sounds.values()) if (norm(s.file) === u.file) s.file = newFile;
          if (newKey !== u.key) { await Library.putBlob(newKey, blob, false); await Library.remove([u.key]); }
          manifest[newKey] = { id: r.id, md5: r.md5Checksum || '', size: +r.size || u.size };
        } catch (e) {
          failed++; lastErr = e;
          if (e.message === 'drive:signin' || /drive:(403|429)/.test(e.message)) this.stopped = true;
        }
        done++; bytes += u.size;
        meter(total ? bytes / total : 1);
      }
      await Store.put('kv', 'driveManifest', manifest).catch(() => {});
      Show.changed();
      await Store.put('kv', 'show', show).catch(() => {});
      // a layout that points at songs Drive doesn't have would leave volunteers with missing buttons
      if (failed || this.stopped) {
        UI.renderAll();
        const why = lastErr?.message === 'drive:signin' ? ' Your Google sign-in ran out.' : '';
        return `${done - failed} of ${P.uploads.length} songs uploaded.${why} The layout wasn't published yet, so volunteers won't see half a change. Tap Publish to Drive again to finish.`;
      }
      let published = '';
      if (P.layoutChanged || !P.layout) {
        say('Publishing the layout…');
        const blob = new Blob([JSON.stringify(show)], { type: 'application/json' });
        let r;
        if (P.layout) r = await this.replace(P.layout.id, blob, 'application/json');
        else {
          const c = await (await this.send('POST', this.url('files', { fields: 'id' }), JSON.stringify({ name: 'Hockey-Game-Day.rinkside.json', parents: [P.root], mimeType: 'application/json' }),
            { 'Content-Type': 'application/json; charset=UTF-8' })).json();
          r = await this.replace(c.id, blob, 'application/json');
        }
        settings.driveLayout = { id: r.id, name: r.name, modifiedTime: r.modifiedTime };
        settings.localEdits = false;
        Prefs.save();
        published = `Layout published (${r.name}).`;
      }
      UI.renderAll();
      const parts = [];
      if (published) parts.push(published);
      if (P.uploads.length) parts.push(`${P.uploads.length} song${P.uploads.length === 1 ? '' : 's'} uploaded.`);
      parts.push(published || P.uploads.length ? 'Volunteers get it the next time they tap Check for updates.' : 'Drive already matches this device.');
      return parts.join(' ');
    } finally {
      this.busy = false;
      this.pub = null;
      // the publish sign-in can change everything in the organizer's Drive: don't keep it around
      if (Auth.canWrite()) Auth.forget();
    }
  },

  async run(opts, say, meter) {
    const plan = this.plan;
    if (!plan || this.busy) return '';
    this.busy = true; this.stopped = false;
    const gb = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
    const jobs = opts.songs ? [...plan.get, ...plan.update] : [];
    const total = jobs.reduce((n, f) => n + f.size, 0);
    let bytes = 0, done = 0, failed = 0, full = false, lastErr = null;
    try {
      try { await navigator.storage?.persist?.(); } catch (e) {}
      try {
        const est = await navigator.storage?.estimate?.();
        if (est && est.quota && est.quota - est.usage < total * 1.05) {
          throw new Error(`drive:room:${gb(total)}:${gb(Math.max(0, est.quota - est.usage))}`);
        }
      } catch (e) { if (String(e.message).startsWith('drive:room')) throw e; }

      // the layout first: it's small, and it's the part people notice
      let newShow = null;
      if (opts.layout && plan.layout) {
        say('Reading the layout…');
        newShow = plan.layoutShow || Show.normalise(JSON.parse((await plan.layout.load()).replace(/^\uFEFF/, '')));
      }

      const manifest = (await Store.get('kv', 'driveManifest')) || {};
      const removeOld = [];
      const worker = async () => {
        while (jobs.length && !this.stopped) {
          const f = jobs.shift();
          try {
            const blob = await f.load();
            if (f.size && blob.size !== f.size) throw new Error('drive:short');
            if (!(await Library.putBlob(f.key, blob, false))) {
              if (Library.lastError?.name === 'QuotaExceededError') { full = true; this.stopped = true; }
              throw Library.lastError || new Error('store');
            }
            manifest[f.key] = { id: f.id || '', md5: f.md5 || '', size: f.size };
            if (f.old && f.old !== f.key) { removeOld.push(f.old); delete manifest[f.old]; }
          } catch (e) {
            failed++; lastErr = e;
            if (/drive:(403|429):.*(Quota|RateLimit|rateLimit|quota)/.test(e.message) || e.message === 'drive:signin') this.stopped = true;
          }
          done++; bytes += f.size;
          meter(total ? bytes / total : done / Math.max(1, done + jobs.length));
          say(`${plan.source === 'drive' ? 'Downloading' : 'Adding'} songs: ${done} of ${done + jobs.length} · ${total ? Math.round(bytes / total * 100) : 100}% (${gb(bytes)} of ${gb(total)})`);
          if (done % 10 === 0) await Store.put('kv', 'driveManifest', manifest).catch(() => {});
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      await Store.put('kv', 'driveManifest', manifest).catch(() => {});
      if (removeOld.length) await Library.remove(removeOld);

      let pruned = 0;
      if (opts.prune && !this.stopped && plan.extra.length) {
        say('Removing songs that are no longer in Drive…');
        await Library.remove(plan.extra);
        for (const k of plan.extra) delete manifest[k];
        await Store.put('kv', 'driveManifest', manifest).catch(() => {});
        pruned = plan.extra.length;
      }

      if (newShow) {
        setShow(newShow);
        await Store.put('kv', 'show', show).catch(() => {});
        settings.driveLayout = { id: plan.layout.id || '', name: plan.layout.name, modifiedTime: plan.layout.modifiedTime };
        settings.localEdits = false;
        Prefs.save();
      }
      UI.renderAll();

      const got = done - failed;
      const again = plan.source === 'drive' ? 'Tap Check for updates' : 'Open the same download again';
      const parts = [];
      if (newShow) parts.push(`Layout updated (${plan.layout.name}).`);
      if (got) parts.push(`${got} song${got === 1 ? '' : 's'} ${plan.source === 'drive' ? 'downloaded' : 'added'}.`);
      if (pruned) parts.push(`${pruned} old song${pruned === 1 ? '' : 's'} removed.`);
      const left = jobs.length + failed;
      if (lastErr?.message === 'drive:signin') parts.push(`Your Google sign-in ran out with ${left} songs left. Tap Check for updates to sign in again and finish. Songs already downloaded are kept.`);
      else if (full) parts.push(`This device ran out of storage space with ${left} songs left. Free up space (deleting the downloaded zip files helps), then ${again.toLowerCase()}.`);
      else if (this.stopped && jobs.length) parts.push(`Stopped with ${left} songs left. ${again} to finish. Songs already added are kept.`);
      else if (failed && /^zip:/.test(lastErr?.message || '')) parts.push(`${failed} song${failed === 1 ? '' : 's'} couldn't be read. ${Drive.explain(lastErr)}`);
      else if (failed) parts.push(`${failed} song${failed === 1 ? '' : 's'} didn't ${plan.source === 'drive' ? 'download' : 'copy'}${lastErr && /drive:(403|429)/.test(lastErr.message) ? ' (Google is limiting downloads right now)' : ''}. ${again} to try again.`);
      if (!parts.length) parts.push('Everything is already up to date.');
      else if (!left) parts.push('Everything is up to date.');
      return parts.join(' ');
    } finally {
      this.busy = false;
      this.plan = null;
    }
  },

  // plain-English message for a failed check or download
  explain(err) {
    const m = String(err && err.message || err || '');
    if (m === 'drive:signin') return 'Sign in with Google to continue.';
    if (m === 'drive:needwrite') return 'Publishing needs your Google permission to change files in Drive.';
    if (m === 'drive:noteditor') return 'This Google account can view the team folder but not change it. Only the organizer (an Editor of the folder) can publish.';
    if (m === 'drive:upload') return 'Google Drive didn\'t accept the upload. Try again.';
    if (m === 'drive:nosignin') return 'Signing in to Google only works in the installed app (from the web address), not in a downloaded copy of the app. Open the app from your Home Screen icon.';
    if (/drive:404/.test(m)) return 'Your Google account can\'t see the team\'s music folder. Ask the organizer to share “Hockey Music App” with your Google account, or tap Switch Google account if you signed in with a different one.';
    if (m === 'drive:offline') return 'No internet connection, so updates can\'t be checked right now. The music already on this device still works. Try again on wifi.';
    if (m.startsWith('drive:room:')) { const [, , need, free] = m.split(':'); return `Not enough storage space: the download needs ${need} and the app has about ${free} free. Free up space on the device and try again.`; }
    if (/drive:(403|429)/.test(m) && /quota|ratelimit/i.test(m)) return 'Google is limiting downloads from this folder right now. Try again in an hour or so.';
    if (/drive:403/.test(m)) return 'Google refused access to the music folder for this account. Ask the organizer to check it\'s shared with you, or tap Switch Google account.';
    if (/accessNotConfigured|SERVICE_DISABLED/i.test(m)) return 'The Google Drive API isn\'t turned on for the Rinkside project in Google Cloud. The organizer needs to turn it on.';
    if (/drive:400/.test(m)) return 'Google didn\'t understand the request. Try again; if it keeps happening, tell the organizer.';
    if (m === 'zip:bad' || m === 'zip:incomplete') return 'That zip file looks incomplete or damaged. The download probably didn\'t finish: delete it and download it again.';
    if (m === 'zip:encrypted') return 'That zip file is password-protected. Download the folder from Google Drive again.';
    if (m === 'zip:unsupported' || m === 'zip:method') return 'This browser can\'t open that kind of zip file. Update the browser (Chrome, or iOS 16.4 or newer), or unzip it and use Add music folder.';
    if (m === 'files:none') return 'Nothing to add. Pick the zip files you downloaded from Google Drive (a layout file or song files work too).';
    if (err && (err.name === 'NotReadableError' || err.name === 'NotFoundError' || err.name === 'SecurityError')) return 'The device wouldn\'t let the app read that file. Make sure the download finished, and pick it from Downloads (not from inside Google Drive).';
    if (err instanceof SyntaxError || m === 'not a show') return 'The layout file in Drive isn\'t a valid Rinkside layout. Save it again from the app and upload it.';
    return 'Something went wrong talking to Google Drive. Try again.';
  },
};

/* ==================================================================== 11. SETTINGS, HELP, STARTUP */

const Settings = {
  pending: null,
  init() {
    $('#closeSettings').addEventListener('click', () => $('#settings').close());
    const onMusic = async e => {
      const files = e.target.files;
      if (!files || !files.length) return;
      const prog = $('#importProgress');
      const { added, failed, cancelled } = await Library.importFiles(files, (i, n) => { prog.textContent = `Saving ${i} of ${n} songs to this device…`; });
      const kept = added.filter(a => a.kept).length, replaced = added.filter(a => a.replaced).length;
      const fresh = added.length - kept - replaced;
      const s = n => (n === 1 ? '' : 's');
      prog.textContent = cancelled ? 'Cancelled. Nothing was added.'
        : failed ? `Added ${added.length - kept} songs for this session. ${failed} couldn't be saved to the device, so load them again next time.`
        : [fresh && `Added ${fresh} new song${s(fresh)}.`, replaced && `Replaced ${replaced} song${s(replaced)} already on this device.`, kept && `Kept ${kept} song${s(kept)} already on this device.`].filter(Boolean).join(' ') || 'No song files were picked.';
      e.target.value = '';
      UI.renderAll();
      this.render();
    };
    // Clean up storage: look first, show what would go, remove only after Remove is tapped
    const cleanSay = m => { $('#cleanProgress').textContent = m; };
    $('#cleanCheck').addEventListener('click', async () => {
      const b = $('#cleanCheck'); b.disabled = true; $('#cleanPlan').hidden = true;
      cleanSay('Checking the songs on this device…');
      try { await Cleanup.scan(); cleanSay(''); Cleanup.show(); $('#cleanPlan').scrollIntoView({ block: 'nearest' }); }
      catch (e) { console.error(e); cleanSay('Couldn\'t check the songs on this device. Try again.'); }
      b.disabled = false;
    });
    $('#cleanDupOpt').addEventListener('change', () => Cleanup.render());
    $('#cleanUnusedOpt').addEventListener('change', () => Cleanup.render());
    $('#cleanNo').addEventListener('click', () => { $('#cleanPlan').hidden = true; Cleanup.plan = null; cleanSay(''); });
    $('#cleanGo').addEventListener('click', async () => {
      const go = $('#cleanGo'); go.disabled = true;
      try {
        const msg = await Cleanup.run(cleanSay);
        cleanSay(msg);
        if (!Cleanup.plan) { $('#cleanPlan').hidden = true; UI.renderAll(); this.render(); cleanSay(msg); }
      } catch (e) { console.error(e); cleanSay('Something went wrong while removing songs. Tap Clean up storage to check again.'); }
      go.disabled = false;
    });
    $('#musicFolder').addEventListener('change', onMusic);
    $('#musicFiles').addEventListener('change', onMusic);
    $('#clearMusic').addEventListener('click', e => {
      Edit.armed(e.currentTarget, 'Tap again to remove all stored music', async () => {
        stopAll(); await Library.clear(); UI.renderAll(); this.render();
      });
    });
    $('#showName').addEventListener('input', e => { show.name = e.target.value; Show.save(); });
    const say = m => { $('#shareProgress').textContent = m; };
    $('#saveLayout').addEventListener('click', async () => {
      try { say(await Share.saveLayout(say)); } catch (err) { console.error(err); say('The layout file couldn\'t be saved. Try again, or pick a different folder.'); }
    });
    $('#savePack').addEventListener('click', async () => {
      try { say(await Share.savePack(say)); } catch (err) { console.error(err); say('The show pack couldn\'t be made. Try saving the layout file instead.'); }
    });
    const onOpenShow = async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const prog = $('#shareProgress');
      const gb = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
      $('#confirmOpen').hidden = true;
      say(`Reading “${f.name}” (${gb(f.size)})…`);
      prog.scrollIntoView({ block: 'center' });
      const slow = setTimeout(() => say(`Still reading “${f.name}”… If you picked it from Google Drive inside the file picker, download it to this device first, then pick it from Downloads.`), 15000);
      try {
        this.pending = await Share.read(f);
        clearTimeout(slow);
        const p = this.pending;
        const buttons = p.show.tabs.reduce((n, t) => n + t.items.length, 0);
        let room = '';
        try {
          const est = await navigator.storage?.estimate?.();
          if (est && p.kind === 'pack' && est.quota - est.usage < p.size * 1.05) {
            room = ` Warning: this device may not have room for it (needs ${gb(p.size)}, about ${gb(Math.max(0, est.quota - est.usage))} free for the app). Free up space first.`;
          }
        } catch (err) {}
        $('#confirmText').textContent = `Open “${p.show.name}”? It has ${p.show.tabs.length} tabs and ${buttons} buttons` +
          (p.kind === 'pack' ? `, plus ${p.files.length} song files (${gb(p.size)}).` : '. Songs come from the music already on this device.') +
          ' It replaces the show on this device. Your music stays.' + room;
        $('#confirmOpen').hidden = false;
        say('');
        $('#confirmOpen').scrollIntoView({ block: 'center' });
      } catch (err) {
        clearTimeout(slow);
        console.error(err);
        const m = String(err && err.message || '');
        if (m.startsWith('incomplete:')) {
          const [, have, need] = m.split(':').map(Number);
          say(`This show pack is incomplete (${gb(have)} of ${gb(need)}). The download probably didn't finish. Delete it, download it again, and wait until it's done.`);
        } else if (m === 'notpack') {
          say(`“${f.name}” isn't a Rinkside show pack. Pick the file that ends in .rinkpack.`);
        } else if (err && (err.name === 'NotReadableError' || err.name === 'NotFoundError' || err.name === 'SecurityError')) {
          say(`The phone wouldn't let the app read “${f.name}”. Save it to this device first (the Files app on iPhone, Downloads on Android), then pick it from there.`);
        } else {
          say(`“${f.name}” isn't a Rinkside layout (.rinkside.json) or show pack (.rinkpack), or it's damaged. Try downloading it again.`);
        }
        prog.scrollIntoView({ block: 'center' });
      }
    };
    $('#openShow').addEventListener('change', onOpenShow);
    $('#openPack').addEventListener('change', onOpenShow);
    $('#confirmYes').addEventListener('click', async () => {
      const p = this.pending;
      if (!p) return;
      $('#confirmOpen').hidden = true;
      say('Copying songs…');
      try {
        const { failed, cancelled } = await Share.apply(p, say);
        if (cancelled) { say('Cancelled. Nothing was changed.'); this.pending = null; return; }
        settings.driveLayout = null; settings.localEdits = false; Prefs.save();
        say(failed
          ? `Opened “${show.name}”, but ${failed} of ${p.files.length} songs couldn't be saved on this device (it may be out of space). They'll work until the app is closed. Free up space and open the pack again.`
          : `Opened “${show.name}”.`);
      } catch (err) {
        console.error(err);
        say('Something went wrong while copying the songs. Make sure the device has enough free space and try again.');
      }
      this.pending = null;
      this.render();
    });
    $('#confirmNo').addEventListener('click', () => { this.pending = null; $('#confirmOpen').hidden = true; });
    $('#resetShow').addEventListener('click', e => {
      Edit.armed(e.currentTarget, 'Tap again to replace your show with the built-in one', async () => {
        const s = await builtInShow();
        if (s) { setShow(s); settings.driveLayout = null; settings.localEdits = false; Prefs.save(); await Store.put('kv', 'show', show).catch(() => {}); this.render(); UI.toast('Built-in show restored.'); }
        else UI.toast('This copy has no built-in show.');
      });
    });
    $('#blankShow').addEventListener('click', e => {
      Edit.armed(e.currentTarget, 'Tap again to start an empty show', async () => {
        setShow(Show.blank()); settings.driveLayout = null; settings.localEdits = false; Prefs.save(); await Store.put('kv', 'show', show).catch(() => {}); this.render(); UI.toast('New empty show started.');
      });
    });
    $('#teamList').addEventListener('click', e => {
      const b = e.target.closest('[data-edit-team]');
      if (b) { $('#settings').close(); Edit.team(show.teams.find(t => t.id === b.dataset.editTeam)); }
    });
    const bind = (id, key, out, f = v => v) => {
      const el = $('#' + id);
      el.value = settings[key];
      const showV = () => { $('#' + out).textContent = f(settings[key]); };
      el.addEventListener('input', () => { settings[key] = +el.value; Prefs.save(); showV(); });
      showV();
    };
    bind('fadeLen', 'fadeSeconds', 'fadeLenOut', v => v + ' s');
    bind('xfadeLen', 'playlistXfade', 'xfadeLenOut', v => v + ' s');
    for (const key of ['skipPlayed']) {
      const el = $('#' + key);
      el.checked = settings[key];
      el.addEventListener('change', () => {
        settings[key] = el.checked; Prefs.save();
        UI.refreshPads();
      });
    }
    // Folder picking works in Chrome, Edge and Safari (iPhone/iPad from iOS 18.4). Hide it only where the browser can't do it.
    if (!('webkitdirectory' in document.createElement('input'))) $('#folderBtn').hidden = true;
    this.initDrive();
  },

  initDrive() {
    const say = m => { $('#driveProgress').textContent = m; };
    // the bar: an animated "working" stripe while checking, then it fills as songs arrive
    const meter = p => {
      const m = $('#driveMeter');
      m.classList.remove('working');
      const pct = Math.max(0, Math.min(1, p)) * 100;
      m.querySelector('i').style.width = pct.toFixed(1) + '%';
      m.setAttribute('aria-valuenow', String(Math.round(pct)));
      m.dataset.pct = Math.round(pct) + '%';
    };
    const busy = on => {
      $('#driveCheck').disabled = on; $('#driveFiles').disabled = on; $('#drivePublish').disabled = on;
      if (on) { $('#driveCheck').dataset.label = $('#driveCheck').textContent; $('#driveCheck').textContent = 'Working…'; }
      else if ($('#driveCheck').dataset.label) { $('#driveCheck').textContent = $('#driveCheck').dataset.label; delete $('#driveCheck').dataset.label; }
      $('#driveFilesBtn').classList.toggle('disabled', on);
      $('#driveMeter').hidden = !on; $('#driveStopRow').hidden = !on;
      if (on) { const m = $('#driveMeter'); m.classList.add('working'); m.dataset.pct = ''; m.querySelector('i').style.width = ''; }
      document.body.classList.toggle('syncing', on);
      // keep it in view: the progress sits right under the buttons
      if (on) setTimeout(() => $('#driveStatus').scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 30);
    };
    const gb = n => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB';
    const date = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

    const showPlan = p => {
      const songBytes = [...p.get, ...p.update].reduce((n, f) => n + f.size, 0);
      const nSongs = p.get.length + p.update.length;
      const lines = [];
      lines.push(p.source === 'drive'
        ? `Found ${p.songs.length} songs${p.layout ? ' and a layout' : ''} in “${p.folder.name}”.`
        : `Found ${p.songs.length} song${p.songs.length === 1 ? '' : 's'}${p.layout ? ' and a layout' : ''} in ${p.files === 1 ? 'the file' : `the ${p.files} files`} you picked.`);
      if (!p.layout) lines.push('There\'s no layout file (.rinkside.json), so only songs will be added.');
      $('#driveLayoutRow').hidden = !p.layoutNew;
      $('#driveLayoutOpt').checked = true;
      if (p.layoutNew) $('#driveLayoutLbl').textContent = `Update the layout: ${p.layout.name}, saved ${date(p.layout.modifiedTime)}. It replaces the buttons and playlists on this device.`
        + (settings.localEdits ? ' You changed the layout on this device: those changes will be replaced. Untick this to keep them.' : '');
      $('#driveSongsRow').hidden = !nSongs;
      $('#driveSongsOpt').checked = true;
      const verb = p.source === 'drive' ? 'Download' : 'Add';
      if (nSongs) $('#driveSongsLbl').textContent = `${verb} ${p.get.length ? `${p.get.length} new` : ''}${p.get.length && p.update.length ? ' and ' : ''}${p.update.length ? `${p.update.length} changed` : ''} song${nSongs === 1 ? '' : 's'} (${gb(songBytes)})`;
      $('#drivePruneRow').hidden = !p.extra.length;
      $('#drivePruneOpt').checked = false;
      if (p.extra.length) $('#drivePruneLbl').textContent = `Also remove ${p.extra.length} song${p.extra.length === 1 ? '' : 's'} from this device that ${p.extra.length === 1 ? 'isn\'t' : 'aren\'t'} in ${p.source === 'drive' ? 'Drive' : 'this download'} any more${p.source === 'drive' ? '' : ' (only if you downloaded the whole folder, all parts)'}`;
      if (!p.layoutNew && !nSongs && !p.extra.length) { say(p.source === 'drive' ? 'Everything is up to date.' : 'Everything in it is already on this device.'); return; }
      if (!p.layoutNew && p.layout) lines.push('The layout on this device is already the same.');
      if (!nSongs) lines.push('All the songs are already on this device.');
      $('#drivePlanText').textContent = lines.join(' ');
      $('#driveGo').textContent = p.source === 'drive' ? 'Download now' : 'Add to this device';
      $('#drivePlan').hidden = false;
      say('');
      $('#drivePlan').scrollIntoView({ block: 'center' });
    };
    const plan = async make => {
      if (Drive.busy) return;
      $('#drivePlan').hidden = true;
      busy(true); $('#driveStopRow').hidden = true; // the bar shows "working" until the plan is ready
      try { showPlan(await make()); }
      catch (err) {
        if (err.message === 'drive:signin' && Auth.enabled()) { // off to Google's sign-in page, then straight back here
          if (!Auth.canRedirect()) { say(Drive.explain('drive:nosignin')); return; }
          say('Opening Google sign-in…'); Auth.signIn('check'); return;
        }
        console.error(err); say(Drive.explain(err));
      }
      finally { busy(false); }
      this.renderDrive();
    };
    // Organizer: publish this device's layout and new songs to Drive
    $('#drivePublish').addEventListener('click', async () => {
      if (Drive.busy) return;
      $('#pubPlan').hidden = true; $('#drivePlan').hidden = true;
      busy(true); $('#driveStopRow').hidden = true;
      try {
        const P = await Drive.publishPlan(say);
        const n = P.uploads.length, bytes = P.uploads.reduce((t, u) => t + u.size, 0);
        if (!n && !P.layoutChanged) { say('Drive already matches this device. Nothing to publish.'); return; }
        const lines = [];
        if (P.layoutChanged) lines.push(P.layout ? `Publish this device's layout, replacing ${P.layout.name} in “${P.folder.name}”. Drive keeps the old version in its version history.` : `Publish this device's layout as a new file in “${P.folder.name}”.`);
        if (n) {
          const list = P.uploads.slice(0, 6).map(u => `${u.folderName}/${u.name}`).join(', ');
          lines.push(`Upload ${n} song${n === 1 ? '' : 's'} (${gb(bytes)}): ${list}${n > 6 ? `, and ${n - 6} more` : ''}.`);
        }
        lines.push('Nothing in Drive is deleted.');
        $('#pubPlanText').textContent = lines.join(' ');
        $('#pubPlan').hidden = false; say('');
        $('#pubPlan').scrollIntoView({ block: 'center' });
      } catch (err) {
        if (['drive:needwrite', 'drive:signin'].includes(err.message) && Auth.enabled()) {
          if (!Auth.canRedirect()) { say(Drive.explain('drive:nosignin')); return; }
          say('Opening Google sign-in…'); Auth.signIn('publish', false, DRIVE.writeScope); return;
        }
        console.error(err); say(Drive.explain(err));
      } finally { busy(false); }
    });
    $('#pubNo').addEventListener('click', () => { $('#pubPlan').hidden = true; Drive.pub = null; });
    $('#pubGo').addEventListener('click', async () => {
      $('#pubPlan').hidden = true;
      busy(true); $('#driveStopRow').hidden = true; meter(0);
      try { say(await Drive.publish(say, meter)); }
      catch (err) { console.error(err); say(Drive.explain(err)); }
      finally { busy(false); }
      this.render();
    });
    $('#driveSwitch').addEventListener('click', () => {
      if (Drive.busy) return;
      Auth.forget(); say('Opening Google sign-in…'); Auth.signIn('check', true);
    });
    $('#driveCheck').addEventListener('click', () => plan(() => Drive.check(say)));
    $('#driveFiles').addEventListener('change', e => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) plan(() => Drive.fromFiles(files, say));
    });
    $('#driveNo').addEventListener('click', () => { $('#drivePlan').hidden = true; Drive.plan = null; });
    $('#driveGo').addEventListener('click', async () => {
      const opts = {
        layout: !$('#driveLayoutRow').hidden && $('#driveLayoutOpt').checked,
        songs: !$('#driveSongsRow').hidden && $('#driveSongsOpt').checked,
        prune: !$('#drivePruneRow').hidden && $('#drivePruneOpt').checked,
      };
      $('#drivePlan').hidden = true;
      busy(true); meter(0);
      try { say(await Drive.run(opts, say, meter)); }
      catch (err) { console.error(err); say(Drive.explain(err)); }
      finally { busy(false); }
      this.render();
    });
    $('#driveStop').addEventListener('click', () => { Drive.stopped = true; say('Stopping after the songs in progress…'); });
    const conn = (id, key) => {
      const el = $('#' + id);
      el.value = settings[key] || '';
      el.addEventListener('change', () => { settings[key] = el.value.trim(); Prefs.save(); this.renderDrive(); });
    };
    conn('driveFolder', 'driveFolder');
    conn('driveClient', 'driveClient');
    // Leaving the app mid-download (or a screen lock on iPhone) can pause it. Say how to finish.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Drive.busy) say($('#driveProgress').textContent + ' (If this stopped moving, tap Stop and start it again. Songs already added are kept.)');
    });
  },
  renderDrive() {
    const L = settings.driveLayout;
    const parts = [];
    // online checking appears once a sign-in client ID (or a link-sharing key) is set up (see DRIVE)
    const online = Drive.ready();
    const empty = !Show.uniqueSounds().some(x => Library.has(x));
    $('#driveCheck').hidden = !online;
    $('#driveCheck').textContent = empty ? 'Download all music' : 'Check for updates';
    $('#driveSwitch').hidden = !(online && Auth.enabled() && Auth.token());
    $('#driveFilesBtn').classList.toggle('primary', !online);
    $('#driveIntroOnline').hidden = !online;
    $('#driveIntroFiles').hidden = online;
    $('#driveFilesLead').hidden = !online;
    // the connection settings are for the organizer (or the optional link-sharing key setup), not volunteers
    $('#driveConn').hidden = !settings.driveEditor;
    applyRole();
    if (L) parts.push(`Layout on this device: ${L.name}, saved ${new Date(L.modifiedTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}.`);
    $('#driveLast').textContent = parts.join(' ');
  },
  async render() {
    const uniq = Show.uniqueSounds();
    const missing = uniq.filter(s => !Library.has(s));
    $('#libStat').innerHTML = `${uniq.length - missing.length} <small>of ${uniq.length} song files found on this device</small>`;
    $('#missingWrap').hidden = !missing.length;
    $('#missingCount').textContent = missing.length;
    $('#missingList').innerHTML = missing.slice(0, 400).map(s => `<li>${esc(s.file)}</li>`).join('');
    $('#storageWarn').hidden = !!Store.db;
    this.renderDrive();
    renderAbout();
    $('#showName').value = show.name;
    $('#teamList').innerHTML = show.teams.map(t => `<div class="team-line">${Teams.badge(t)}<b>${esc(t.full)}</b><button class="mini" data-edit-team="${esc(t.id)}">${ICONS.pen}Edit</button></div>`).join('');
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) $('#storageInfo').textContent = `Using ${(est.usage / 1e9).toFixed(2)} GB of about ${(est.quota / 1e9).toFixed(0)} GB available to this app.`;
    } catch (e) {}
  },
  open() { this.render(); $('#settings').showModal(); },
};

// With Google sign-in on, only the organizer (an Editor of the Drive folder) can edit and publish.
// Volunteers can't change the show by accident, and their next update would replace it anyway.
function applyRole() {
  // Everyone can edit their own copy; only Editors of the Drive folder can publish it for everyone.
  const pub = $('#publishBox');
  if (pub) pub.hidden = !(Auth.enabled() && settings.driveEditor && Auth.canRedirect());
}

// "Rinkside Soundboard v2.0 · Layout: Hockey-Game-Day.rinkside.json (Oct 6, 2026)": tells you over the phone what a tablet has
function versionText() {
  const B = window.RINKSIDE_BUILD || {};
  const copy = document.getElementById('default-show') ? 'downloaded single-file copy' : 'web app';
  return `Version ${APP_VERSION}${B.built ? ` · built ${B.built}` : ''} · ${copy}`;
}
function renderAbout() {
  const L = settings.driveLayout;
  const layout = L ? `${L.name} (${new Date(L.modifiedTime).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })})` : show.name;
  document.querySelectorAll('[data-version]').forEach(el => { el.textContent = versionText(); });
  document.querySelectorAll('[data-about]').forEach(el => { el.textContent = `Rinkside Soundboard ${versionText()} · Layout: ${layout}`; });
}

async function builtInShow() {
  const embedded = document.getElementById('default-show'); // present in the single-file version
  if (embedded) { try { return Show.normalise(JSON.parse(embedded.textContent)); } catch (e) {} }
  try {
    const r = await fetch(DEFAULT_SHOW_URL);
    if (r.ok) return Show.normalise(await r.json());
  } catch (e) {}
  return null;
}

function setShow(s) {
  stopAll();
  activePL = null;
  show = s;
  Show.reindex();
  if (!show.teams.some(t => t.id === settings.team)) { settings.team = show.teams[0].id; Prefs.save(); }
  if (UI.view !== 'gameday' && !Show.tab(UI.view)) UI.view = 'gameday';
  UI.renderAll();
}

async function boot() {
  UI.init();
  Edit.init();
  Settings.init();
  applyRole();
  $('#help').addEventListener('click', e => { if (e.target.closest('[data-close-help]')) $('#help').close(); });
  await Store.open();
  await Library.load();
  let s = null;
  try { const saved = await Store.get('kv', 'show'); if (saved) s = Show.normalise(saved); } catch (e) {}
  if (!s) s = await builtInShow();
  if (!s) s = Show.blank();
  setShow(s);
  setInterval(tick, 200);

  // back from Google's sign-in page: carry on with what the person tapped
  const signin = Auth.consume();
  if (signin) {
    Settings.open();
    setTimeout(() => {
      $('#driveSection').scrollIntoView({ block: 'start' });
      if (signin.ok && signin.resume === 'check') $('#driveCheck').click();
      else if (signin.ok && signin.resume === 'publish') $('#drivePublish').click();
      else $('#driveProgress').textContent = signin.error === 'access_denied'
        ? 'Google sign-in was cancelled. Tap the button to try again.'
        : 'Google sign-in didn\'t finish. Tap the button to try again.';
    }, 60);
  }

  News.check(!!signin);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // The app opens from its saved copy; a newer version downloads in the background (sw.js).
    // Tell the volunteer once it's ready, but not on the very first install.
    const hadCopy = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('message', e => {
      if (hadCopy && e.data && e.data.type === 'rinkside-updated') Update.ready();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* not available here (e.g. preview) */ });
  }
}

/* Release notes (release-notes.json, built into version.js as RINKSIDE_NOTES): newest first. */
const cmpVer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
const Notes = {
  TAG: { new: 'New', improved: 'Better', fixed: 'Fixed' },
  date(d) { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return d; } },
  // versions after `from` up to and including `to`
  between(list, from, to) { return (list || []).filter(n => (!from || cmpVer(n.version, from) > 0) && (!to || cmpVer(n.version, to) <= 0)); },
  items(n) { return `<ul class="rn">${n.notes.map(i => `<li><span class="rn-tag ${esc(i.type)}">${esc(this.TAG[i.type] || i.type)}</span>${esc(i.text)}</li>`).join('')}</ul>`; },
  // one version: heading + list; several: a heading per version
  html(list, headings = list.length > 1) {
    return list.map(n => (headings ? `<p class="rn-head">Version ${esc(n.version)} · ${esc(this.date(n.date))}</p>` : '') + this.items(n)).join('');
  },
  // Help › What's new: every version, newest open
  renderHelp() {
    const list = window.RINKSIDE_NOTES || [];
    $('#whatsNew').hidden = !list.length;
    $('#notesList').innerHTML = list.map((n, i) => `<details class="rn-ver"${i === 0 ? ' open' : ''}><summary>Version ${esc(n.version)} · ${esc(this.date(n.date))}${n.version === APP_VERSION ? ' <small>(this version)</small>' : ''}</summary>${this.items(n)}</details>`).join('');
  },
  openHelp() {
    renderAbout(); this.renderHelp();
    $('#help').showModal(); $('#whatsNew').open = true;
    $('#whatsNew').scrollIntoView({ block: 'start' });
  },
};

// Keep a bottom bar clear of Fade out all / Stop: on phones and portrait tablets it sits just
// above them; with the dock down the right side, it centres on the rest of the screen.
function placeBar(el) {
  const place = () => {
    const a = $('.dock-actions')?.getBoundingClientRect();
    const below = a && a.width > innerWidth * 0.6 && a.top > innerHeight / 2;
    const beside = a && !below && a.left > innerWidth / 2;
    el.style.bottom = below ? `${Math.round(innerHeight - a.top + 10)}px` : '';
    el.style.left = beside ? `${Math.round(a.left / 2)}px` : '';
    el.style.width = beside ? `min(520px, ${Math.round(a.left - 32)}px)` : '';
  };
  place(); addEventListener('resize', place);
}
const quiet = () => !tracks.some(t => t.state !== 'done') && !document.body.classList.contains('syncing');

/* A new version has downloaded (sw.js). Offer it with a banner, but never while a song is
   playing or music is downloading: wait until things are quiet. The banner shows what's in
   the new version (its release notes, read from the new offline copy). "Later" keeps the
   current version until the app is next opened (it's already saved, so that happens by itself). */
const Update = {
  async ready() {
    if (this.shown) return;
    clearTimeout(this._w);
    if (!quiet()) { this._w = setTimeout(() => this.ready(), 2000); return; }
    this.shown = true;
    let fresh = [];
    try { fresh = Notes.between(await (await fetch('release-notes.json', { cache: 'no-cache' })).json(), APP_VERSION); } catch (e) {}
    $('#updateVer').textContent = fresh.length ? ` (version ${fresh[0].version})` : '';
    $('#updateNotes').hidden = !fresh.length;
    $('#updateNotesList').innerHTML = Notes.html(fresh);
    const el = $('#updateBar'); el.hidden = false;
    placeBar(el);
    $('#updateNow').onclick = async () => {
      $('#updateNow').disabled = true; $('#updateNow').textContent = 'Updating…';
      stopAll(); clearTimeout(Show._t);
      await Store.put('kv', 'show', show).catch(() => {});
      location.reload();
    };
    $('#updateLater').onclick = () => { el.hidden = true; };
  },
};

/* Once, right after an update: "Rinkside updated to 2.5.0 · See what's new". Not on a brand
   new install, and not while coming back from Google sign-in (it shows next time instead). */
const News = {
  KEY: 'rinkside.seenVersion',
  check(signingIn) {
    let seen = null;
    try { seen = localStorage.getItem(this.KEY); } catch (e) {}
    // set up before release notes existed (2.4.0 or earlier): treat as 2.4.0
    if (!seen && HAD_SETTINGS) seen = '2.4.0';
    if (!seen || cmpVer(APP_VERSION, seen) <= 0) { this.mark(); return; }
    if (signingIn) return;
    const fresh = Notes.between(window.RINKSIDE_NOTES, seen, APP_VERSION);
    if (!fresh.length) { this.mark(); return; }
    const show = () => {
      if (!quiet() || document.querySelector('dialog[open]')) { setTimeout(show, 2000); return; }
      this.mark();
      const el = $('#newsBar'); $('#newsVer').textContent = APP_VERSION; el.hidden = false; placeBar(el);
      $('#newsSee').onclick = () => { el.hidden = true; Notes.openHelp(); };
      $('#newsOk').onclick = () => { el.hidden = true; };
    };
    setTimeout(show, 1200);
  },
  mark() { try { localStorage.setItem(this.KEY, APP_VERSION); } catch (e) {} },
};

// Start the audio engine on the very first touch anywhere, so the first
// goal horn of the night doesn't pay the start-up delay.
document.addEventListener('pointerdown', () => { try { audioCtx(); } catch (e) {} }, { once: true, capture: true });

boot();
