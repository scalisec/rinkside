# Rinkside Soundboard

A game-day soundboard for hockey: goal horns, penalty songs, playlists and
announcements, built for an Android tablet (a phone works as a backup).
It runs in Chrome, needs no internet at the rink, and needs no other software.

Everything is edited inside the app: songs, cut points, tabs, playlists,
Game Day groupings and teams. A show can be shared as a small layout file or
as a full show pack that includes the music.

---

## Getting started (for a new volunteer or tablet)

**Option A: one file (easiest).**
1. Get `Rinkside-Soundboard.html` (by email, Google Drive or USB) and save it to the tablet.
2. Open **Chrome** and go to `file:///sdcard/Download/Rinkside-Soundboard.html`
   (or Chrome menu > Downloads > tap the file).
3. Chrome menu > **Add to Home screen** puts the crossed-sticks hockey icon on the home screen
   (with a small Chrome badge). Tap the full-screen button (four corners) in the app to hide
   Chrome's address bar.
4. Load the music:
   - Someone sent you a **show pack** (`.rinkpack`)? Tap the gear > **Open a layout file or show pack**. Done.
   - Otherwise tap the gear > **Add music folder** (or **Add music files**) and pick your music.

Open the file from Chrome's Downloads, not straight from Gmail or a Files app.
Opened those other ways, Chrome may not be able to keep the music, and Settings
will warn you.

**iPhone or iPad.** The single file can't run on an iPhone or iPad: use Option B.
Open the web address in Safari > Share > **Add to Home Screen**, and always open it
from that icon (Safari may clear saved music for websites that aren't on the Home
Screen). Load music with **Add music folder** (iOS 18.4 or newer), **Add music files**, or
open a show pack made on an Android tablet or a computer.

**Option B: a web address that installs like an app.** See "Hosting" below.
This is the best long-term setup: it installs like a real app with the hockey
icon (no Chrome badge, no address bar) and updates itself when you publish changes.

---

## Updating from Google Drive (v2.0)

The music and layout live in the team's Google Drive folder, shared only with
the people who run the soundboard. Drive decides who can download; the app
never signs in to Google.

```
Hockey Music App (shared folder)
├── Hockey-Game-Day.rinkside.json   the layout (the newest one at the top wins)
└── Hockey Songs/
    ├── In Game Action/…mp3
    ├── Rock/…mp3
    └── …                           one folder per category, like the buttons expect
```

**To load or update a device:**
1. Download the Hockey Songs folder and the layout file from the team's Google Drive folder (computer: right-click >
   Download; tablet/phone: use the browser's desktop site, because the Drive app
   can't download folders). Hockey Songs arrives as one or more zip files.
2. In the app: Settings > **Open Drive download**, pick all the zip files.
3. Check the summary and tap **Add to this device**. Only new or changed songs
   are copied. Delete the zip files afterwards.

A layout file or loose MP3s can be opened the same way, so for small updates
you can download just those.

**To publish an update:** put new MP3s in the right category folder, give them
buttons in the app (Edit > Add songs, picking the same file), then Settings >
Save layout file and put it in the Drive folder in place of the old one. Keep
show packs and other big files out of the Rinkside folder so downloads stay small.

**Download all music / Check for updates (Google sign-in, v2.1).** With
`DRIVE.clientId` set, Settings shows one button: volunteers sign in with Google
(full-page redirect, no pop-up), and the app downloads the newest layout and only
new or changed songs straight from the folder. Only Google accounts the folder is
shared with can download, and in Google Cloud's "Testing" mode only the listed
test users can sign in at all. Works from the web address, not the single file.

One-time setup: Google Cloud project > enable Google Drive API > Google Auth
Platform (External, Testing, add each volunteer as a test user, scope
`drive.readonly`) > Clients > Web application with origin
`https://scalisec.github.io` and redirect URI `https://scalisec.github.io/rinkside/`.
Put the client ID in `DRIVE.clientId`, run `python3 build.py`, publish.

**Publish to Drive (organizer).** Accounts with Editor access to the folder
(detected from the folder's `capabilities.canAddChildren`) get Edit and a
**Publish to Drive** button; Viewers get neither. Publishing asks for the full
`drive` scope (organizer only), uploads songs the layout uses that Drive lacks
into `Hockey Songs/<category>/`, then replaces the layout file. If any song
fails, the layout is not published. Nothing in Drive is deleted. Add the
`.../auth/drive` scope next to `drive.readonly` in Google Auth Platform > Data Access.

(Alternative: `DRIVE.key` reads a folder shared as "Anyone with the link" with an
API key, no sign-in. Not used, because it can't control who has access.)

---

## Versions

The version shows at the top of Help (the ? button), for example
"Version 2.1.2 · built 2026-10-07 23:04 · web app", and again at the bottom of
Settings and Help with the layout's date. `APP_VERSION` in `app.js` is the version
number; `build.py` adds the build date and time and writes `version.js` (the
single-file copy has it built in). Bump `APP_VERSION` and `VERSION` in `sw.js`
for every release.
v1.0 (before Drive sync) is kept on the `v1.0-stable` branch on GitHub, and as
`dist/Rinkside-Soundboard-v1-stable.html`. To go back: on GitHub, Settings >
Pages > set the branch to `v1.0-stable`.

---

## Running a game

- **Pick the team** with the team button at the top left (it opens a list of all teams). The big GOAL! button, Pregame and Game music follow the team.
- **Tap a button to play it**, and tap it again to fade it out.
- **Fade out all** (big red button) at puck drop. **Stop** cuts everything instantly.
- **Game music**: the first tap starts the team's playlist, and every tap after that plays the next song.
- **Random buttons** (Penalty, Icing, Offside…) pick a song not yet played this game.
- **New game** (tap twice) clears the "Played" marks.
- **Lock** hides Settings, New game and Edit. Press and hold it for 1.5 seconds to unlock.
- **One at a time / Layer**: with One at a time, a new sound fades out whatever is playing.

---

## FAQ: changing the show

All editing happens in **Edit mode**: unlock, tap **Edit** (the pencil), make
changes, tap **Edit** again (it says Done) when finished. Changes save on the
device as you go. The same answers are in the app under the **?** button.

**Add a new song.** In Edit, open a tab and tap **Add songs**. Pick one or more
MP3 files. Each becomes a button named after its file. Tap it to rename it and
set its start point.

**Make a song start at the good part.** In Edit, tap the button, tap **Play from
0:00**, and tap **Set start here** when the good part hits. Check it with
**Listen from start point**. For a short clip, also use **Set stop here**. You
can type exact seconds instead.

**Replace the song on a button.** In Edit, tap the button > **Choose a
different file**. The name, colour and place stay the same.

**Game Day groups (Penalty, Icing…).** They are built from button names. The
Penalty group plays a random song from every button whose name starts with
"Penalty", on any tab. To put a song in a group, rename its button, for example
`Penalty - Sabotage - Beastie Boys`. To make a new group, go to Game Day > Edit
> **Edit groups**, add a group, and type the starting text. The count shows how
many songs matched.

| Section on Game Day | What a group does |
| --- | --- |
| Whistles | One random button per group (Penalty, Icing, Offside…) |
| Moments | Every matching song gets its own button (Big Hit, Long Shift…) |
| Game over | One random button per group (Home win, Visitor win…) |
| All goal horns | Every button with "Goal Horn" in its name |

**Goal horn and team playlists.** In Edit, tap the team button at the top and pick a team (or the
GOAL! button). Pick the goal horn, pregame playlist and game-music playlist.
Upload or change the logo and colour here too.

**Playlists.** In Edit, open a tab > **Add playlist**, or tap an existing
playlist. Search and tap songs to add them. Use the arrows to reorder and ✕ to remove.

**Tabs.** In Edit, **New tab** is at the end of the tab row. Open a tab >
**Tab settings** to rename it, recolour it, move it, add a whole folder of
songs, or delete it.

**Move or copy a button.** In Edit, tap the button. Change **Tab** to move it,
or use **Also put a copy on** to show it on two tabs.

**Edit on a computer.** Open the app in Chrome on your PC, make changes, then
save a layout file and open it on the tablet.

**Undo a mess.** Open a layout file you saved earlier, or use **Restore the
built-in show**. Music on the device is never touched by either.

---

## Sharing and backups

Settings > **Share and back up**:

| | Layout file (`.rinkside.json`) | Show pack (`.rinkpack`) |
| --- | --- | --- |
| Contains | Tabs, buttons, cut points, playlists, groups, teams, logos | All of that plus the music |
| Size | About 300 KB | Usually 1–4 GB |
| Send by | Email, text, anything | USB stick, Google Drive, cable |
| Other person needs | Their own copy of the music, same file names | Nothing else |

Songs are matched to buttons by folder and file name (for example
`In Game Action/Sound of da Police - KRS-One.mp3`), then by file name alone.
Keep file names the same when you copy music between devices.

On a computer (Chrome or Edge on Windows, Mac or ChromeOS), saving opens a
"Save as" window so you can pick the folder and file name. Phones, tablets and
Safari always save to the Downloads folder.

Save a layout file after big changes. It is also your backup.

Before you share a show pack outside your own teams, remember the music in it
is licensed to you, not to them.

---

## What's in this folder

See `PROJECT-OVERVIEW.md` for status, decisions and open items.

| File | What it is |
| --- | --- |
| `app.js` | All the behaviour, in sections marked with `====` banners. |
| `app.css` | All the styling. |
| `body.html` | The page layout, including the Help text. |
| `show.json` | The built-in show (tabs, buttons, teams, logos). |
| `build.py` | Rebuilds `index.html` and the single file after you change the files above. |
| `index.html` | The page for hosting on a web address. |
| `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-*.png`, `apple-touch-icon.png` | Let the hosted version install and run offline. |
| `dist/` | Single-file copies of the app (current, v2.1, and v1 stable). |
| `docs/guides/` | Volunteer setup guide PDFs (current, previous, archive) and the guide builder in `source/`. |
| `docs/architecture/` | The architecture diagram page. |
| `tests/` | A stand-in for Google Drive and sign-in, plus browser tests (sign-in, publish, offline, zip import). |
| `logos/` | Original logo images (the show file has its own copies). |

To make the edits you did on a tablet the new built-in show: Settings > Save
layout file, rename it to `show.json`, put it in this folder, and run
`python3 build.py`.

--- | --- |
| `dist/Rinkside-Soundboard.html` | The whole app in one file, with the show built in. This is what you email. |
| `index.html` | The page for hosting on a web address. |
| `app.js` | All the behaviour, in sections marked with `====` banners. |
| `app.css` | All the styling. |
| `body.html` | The page layout, including the Help text. |
| `show.json` | The built-in show (tabs, buttons, teams, logos). |
| `dist/Rinkside-Soundboard-v1-stable.html` | v1.0, the last version before Drive sync, kept as a fallback. |
| `build.py` | Rebuilds `index.html` and the single file after you change the files above. |
| `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-*.png`, `apple-touch-icon.png` | Let the hosted version install and run offline. |
| `logos/` | Original logo images (the show file has its own copies). |

To make the edits you did on a tablet the new built-in show: Settings > Save
layout file, rename it to `show.json`, put it in this folder, and run
`python3 build.py`.

---

## Hosting (installable app, free)

1. Create a free GitHub account and a new repository (for example `rinkside`).
2. Upload everything in this folder except `dist/`.
3. Settings > Pages > Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
4. After a minute the app is at `https://<your-username>.github.io/rinkside/`.
5. On each tablet, open that address in Chrome > menu > **Add to Home screen** > Install.

To publish a change, upload the changed files and bump `VERSION` in `sw.js`
(for example `rinkside-v6`). Tablets pick it up the next time they open the
app with wifi. A public repository shows your layout (song names and logos,
not the music).

---

## For whoever maintains the code

Plain HTML, CSS and JavaScript. No build tools or libraries beyond Python for `build.py`.

- **Show data** (`show.json` and exported layouts): `{ format: "rinkside-show", version, name, teams[], gameday{situations[], moments[], endings[]}, tabs[] }`.
  Tab items are `sound` (`name`, `file`, `start`, `stop`, `volume`, `length`, `color`),
  `playlist` (`name`, `songs`: list of sound ids) or `next`.
- **Show pack**: the text `RINKPACK1\n`, a 12-digit header length, a JSON header
  `{ show, files: [{ key, size, type }] }`, then the song files back to back.
- **Storage on the device**: IndexedDB `rinkside` (store `kv` holds the show and
  `driveManifest`, the Drive id/md5/size of each downloaded song; store `audio`
  holds song files by path), and localStorage for small settings.
- **Drive imports** (`Zip` and `Drive` in app.js): reads Drive's zip downloads
  in place (stored or deflate via DecompressionStream, zip64, UTF-8 names), picks
  the top-most newest `.rinkside.json`, and compares songs by folder/file name and
  size. The optional online check uses Drive API v3 with an API key and md5.
- **Defaults** (fade lengths and so on) are at the top of `app.js`.
