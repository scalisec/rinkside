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
  // fills in anything missing so older or hand-edited files still load
  normalise(s) {
    if (!s || s.format !== 'rinkside-show' || !Array.isArray(s.tabs)) throw new Error('not a show');
    s.name = s.name || 'Game Day Show';
    s.teams = Array.isArray(s.teams) && s.teams.length ? s.teams : Show.blank().teams;
    s.teams.forEach(t => { t.id = t.id || uid(); t.name = t.name || 'Team'; t.full = t.full || t.name; t.color = t.color || '#3563d8'; t.shape = t.shape || 'round'; });
    s.gameday = { situations: [], moments: [], endings: [], ...(s.gameday || {}) };
    for (const tab of s.tabs) {
      tab.id = tab.id || uid(); tab.name = tab.name || 'Tab'; tab.items = tab.items || [];
      for (const it of tab.items) {
        it.id = it.id || uid();
        if (it.type === 'sound') { it.start = +it.start || 0; it.stop = +it.stop || 0; it.volume = it.volume ?? 1; it.length = +it.length || 0; }
        if (it.type === 'playlist') it.songs = it.songs || [];
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
  async putBlob(key, blob) {
    this.mem.set(key, blob);
    this.add(key);
    try { await Store.put('audio', key, blob); return !!Store.db; } catch (e) { return false; }
  },
  async importFiles(fileList, onProgress) {
    const files = [...fileList].filter(f => AUDIO_EXT.test(f.name));
    const added = [];
    let failed = 0;
    try { await navigator.storage?.persist?.(); } catch (e) {}
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = norm(f.webkitRelativePath || f.name);
      if (!(await this.putBlob(key, f))) failed++;
      added.push({ file: f, key });
      onProgress?.(i + 1, files.length);
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
  if (urlCache.size > 60) { const [k, u] = urlCache.entries().next().value; URL.revokeObjectURL(u); urlCache.delete(k); }
  return url;
}

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
    if (team.logo) return `<span class="${cls} ${team.shape === 'square' ? 'square' : 'round'}"><img src="${team.logo}" alt="${esc(team.full)} logo"></span>`;
    return `<span class="${cls} mono" style="--tc:${esc(team.color)}">${esc(team.name.slice(0, 1))}</span>`;
  },
  apply() {
    const c = this.current.color;
    document.documentElement.style.setProperty('--team', c);
    document.documentElement.style.setProperty('--on-team', hexLight(c) ? '#0b131a' : '#ffffff');
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

    $('#teams').addEventListener('click', e => {
      const b = e.target.closest('[data-team]');
      if (!b) return;
      if (Edit.on) { Edit.team(show.teams.find(t => t.id === b.dataset.team)); return; }
      if (b.dataset.team === settings.team) return;
      settings.team = b.dataset.team; Prefs.save();
      Teams.apply(); this.renderHead(); this.renderMain(); this.renderDock();
      this.toast(`${Teams.current.full} selected.`);
    });

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
    $('#helpBtn').addEventListener('click', () => $('#help').showModal());
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
    if (act === 'tab-settings') Edit.tab(Show.tab(el.dataset.tabId));
    if (act === 'groups') Edit.groups(el.dataset.section);
    if (act === 'add-playlist') Edit.addPlaylist(Show.tab(el.dataset.tabId));
    if (act === 'add-next') Edit.addNext(Show.tab(el.dataset.tabId));
    if (act === 'team') { if (Edit.on || !settings.locked) Edit.team(Teams.current); }
    if (act === 'help') $('#help').showModal();
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
    $('#teams').innerHTML = show.teams.map(t => `<button class="team" data-team="${esc(t.id)}" aria-pressed="${t.id === Teams.current.id}"
      style="--tc:${esc(t.color)}">${Teams.badge(t)}<span class="team-name">${esc(t.name)}</span></button>`).join('');
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
      <p>The buttons below are ready. Load your music folders once and every button lights up.</p></div>
      <button class="btn admin" data-ui="settings">Load music</button></div>`;
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
  toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(this._t);
    this._t = setTimeout(() => { el.hidden = true; }, 3400);
  },
};

/* ==================================================================== 9. EDIT MODE */

const Edit = {
  on: false,
  cur: null, // what the editor dialog is showing: { kind, ref }

  toggle(force) {
    this.on = force ?? !this.on;
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
    if (f === 'color') { ref.color = el.value; Show.save(); if (kind === 'team') Teams.apply(); return; }
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
      ref.color = b.dataset.v || null;
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
    const { added, failed } = await Library.importFiles(files, (i, n) => say(`Adding ${i} of ${n} songs…`));
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

  saveLayout() {
    this.download(new Blob([JSON.stringify(show)], { type: 'application/json' }), `${this.base()}.rinkside.json`);
    return `Saved ${this.base()}.rinkside.json to Downloads.`;
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
    return { blob: new Blob(['RINKPACK1\n', String(header.length).padStart(12, '0'), header, ...blobs], { type: 'application/octet-stream' }), count: files.length };
  },
  async savePack(say) {
    const { blob, count } = await this.buildPack(say);
    this.download(blob, `${this.base()}.rinkpack`);
    return `Saved ${this.base()}.rinkpack (${(blob.size / 1e9).toFixed(2)} GB, ${count} songs) to Downloads.`;
  },

  async read(file) {
    const magic = await file.slice(0, 10).text();
    if (magic === 'RINKPACK1\n') {
      const len = parseInt(await file.slice(10, 22).text(), 10);
      const header = JSON.parse(await file.slice(22, 22 + len).text());
      let off = 22 + len;
      const files = header.files.map(f => { const blob = file.slice(off, off + f.size, f.type); off += f.size; return { key: f.key, blob }; });
      return { kind: 'pack', show: Show.normalise(header.show), files };
    }
    const json = JSON.parse((await file.text()).replace(/^﻿/, ''));
    return { kind: 'layout', show: Show.normalise(json), files: [] };
  },

  async apply(parsed, say) {
    let n = 0;
    for (const f of parsed.files) {
      await Library.putBlob(f.key, f.blob);
      if (++n % 10 === 0 || n === parsed.files.length) say(`Copying songs ${n} of ${parsed.files.length}…`);
    }
    setShow(parsed.show);
    await Store.put('kv', 'show', show).catch(() => {});
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
      const { added, failed } = await Library.importFiles(files, (i, n) => { prog.textContent = `Saving ${i} of ${n} songs to this device…`; });
      prog.textContent = failed
        ? `Added ${added.length} songs for this session. ${failed} couldn't be saved to the device, so load them again next time.`
        : `Added ${added.length} songs.`;
      e.target.value = '';
      UI.renderAll();
      this.render();
    };
    $('#musicFolder').addEventListener('change', onMusic);
    $('#musicFiles').addEventListener('change', onMusic);
    $('#clearMusic').addEventListener('click', e => {
      Edit.armed(e.currentTarget, 'Tap again to remove all stored music', async () => {
        stopAll(); await Library.clear(); UI.renderAll(); this.render();
      });
    });
    $('#showName').addEventListener('input', e => { show.name = e.target.value; Show.save(); });
    const say = m => { $('#shareProgress').textContent = m; };
    $('#saveLayout').addEventListener('click', () => say(Share.saveLayout()));
    $('#savePack').addEventListener('click', async () => {
      try { say(await Share.savePack(say)); } catch (err) { console.error(err); say('The show pack couldn\'t be made. Try saving the layout file instead.'); }
    });
    $('#openShow').addEventListener('change', async e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        this.pending = await Share.read(f);
        const p = this.pending;
        const buttons = p.show.tabs.reduce((n, t) => n + t.items.length, 0);
        $('#confirmText').textContent = `Open “${p.show.name}”? It has ${p.show.tabs.length} tabs and ${buttons} buttons` +
          (p.kind === 'pack' ? `, plus ${p.files.length} song files.` : '. Songs come from the music already on this device.') +
          ' It replaces the show on this device. Your music stays.';
        $('#confirmOpen').hidden = false;
        say('');
      } catch (err) {
        console.error(err);
        say('That file isn\'t a Rinkside layout (.rinkside.json) or show pack (.rinkpack).');
      }
    });
    $('#confirmYes').addEventListener('click', async () => {
      const p = this.pending;
      if (!p) return;
      $('#confirmOpen').hidden = true;
      await Share.apply(p, say);
      this.pending = null;
      say(`Opened “${show.name}”.`);
      this.render();
    });
    $('#confirmNo').addEventListener('click', () => { this.pending = null; $('#confirmOpen').hidden = true; });
    $('#resetShow').addEventListener('click', e => {
      Edit.armed(e.currentTarget, 'Tap again to replace your show with the built-in one', async () => {
        const s = await builtInShow();
        if (s) { setShow(s); await Store.put('kv', 'show', show).catch(() => {}); this.render(); UI.toast('Built-in show restored.'); }
        else UI.toast('This copy has no built-in show.');
      });
    });
    $('#blankShow').addEventListener('click', e => {
      Edit.armed(e.currentTarget, 'Tap again to start an empty show', async () => {
        setShow(Show.blank()); await Store.put('kv', 'show', show).catch(() => {}); this.render(); UI.toast('New empty show started.');
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
    // iPhone/iPad can't pick a whole folder: use Add music files or a show pack there
    if (IS_IOS || !('webkitdirectory' in document.createElement('input'))) $('#folderBtn').hidden = true;
  },
  async render() {
    const uniq = Show.uniqueSounds();
    const missing = uniq.filter(s => !Library.has(s));
    $('#libStat').innerHTML = `${uniq.length - missing.length} <small>of ${uniq.length} song files found on this device</small>`;
    $('#missingWrap').hidden = !missing.length;
    $('#missingCount').textContent = missing.length;
    $('#missingList').innerHTML = missing.slice(0, 400).map(s => `<li>${esc(s.file)}</li>`).join('');
    $('#storageWarn').hidden = !!Store.db;
    $('#showName').value = show.name;
    $('#teamList').innerHTML = show.teams.map(t => `<div class="team-line">${Teams.badge(t)}<b>${esc(t.full)}</b><button class="mini" data-edit-team="${esc(t.id)}">${ICONS.pen}Edit</button></div>`).join('');
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) $('#storageInfo').textContent = `Using ${(est.usage / 1e9).toFixed(2)} GB of about ${(est.quota / 1e9).toFixed(0)} GB available to this app.`;
    } catch (e) {}
  },
  open() { this.render(); $('#settings').showModal(); },
};

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
  $('#help').addEventListener('click', e => { if (e.target.closest('[data-close-help]')) $('#help').close(); });
  await Store.open();
  await Library.load();
  let s = null;
  try { const saved = await Store.get('kv', 'show'); if (saved) s = Show.normalise(saved); } catch (e) {}
  if (!s) s = await builtInShow();
  if (!s) s = Show.blank();
  setShow(s);
  setInterval(tick, 200);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* not available here (e.g. preview) */ });
  }
}

// Start the audio engine on the very first touch anywhere, so the first
// goal horn of the night doesn't pay the start-up delay.
document.addEventListener('pointerdown', () => { try { audioCtx(); } catch (e) {} }, { once: true, capture: true });

boot();
