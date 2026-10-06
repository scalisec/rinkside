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
Screen). Load music with **Add music files** (no folder picking on iPhone/iPad) or
open a show pack made on an Android tablet or a computer.

**Option B: a web address that installs like an app.** See "Hosting" below.
This is the best long-term setup: it installs like a real app with the hockey
icon (no Chrome badge, no address bar) and updates itself when you publish changes.

---

## Running a game

- **Pick the team** at the top left. The big GOAL! button, Pregame and Game music follow the team.
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

**Goal horn and team playlists.** In Edit, tap a team name at the top (or the
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

| File | What it is |
| --- | --- |
| `dist/Rinkside-Soundboard.html` | The whole app in one file, with the show built in. This is what you email. |
| `index.html` | The page for hosting on a web address. |
| `app.js` | All the behaviour, in sections marked with `====` banners. |
| `app.css` | All the styling. |
| `body.html` | The page layout, including the Help text. |
| `show.json` | The built-in show (tabs, buttons, teams, logos). |
| `build.py` | Rebuilds `index.html` and the single file after you change the files above. |
| `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-*.png`, `apple-touch-icon.png` | Let the hosted version install and run offline. |
| `logos/` | Original logo images (the show file has its own copies). |

To make the edits you did on a tablet the new built-in show: Settings > Save
layout file, rename it to `show.json`, put it in this folder, and run
`python3 build.py`.

---

## Hosting (installable app, free)

1. Create a free GitHub account and a new repository (for example `rinkside`).
2. Upload everything in this folder except `dist/` and `artifact.html`.
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
- **Storage on the device**: IndexedDB `rinkside` (store `kv` holds the show,
  store `audio` holds song files by path), and localStorage for small settings.
- **Defaults** (fade lengths and so on) are at the top of `app.js`.
