# Rinkside DJ

A game-day soundboard for youth hockey: goal horns, penalty songs, the intro, game
music and the whistles, played from a phone or tablet to the rink speakers.

**Open it:** https://scalisec.github.io/rinkside/ — add it to the Home Screen
(iPhone: Safari › Share › Add to Home Screen; Android: Chrome menu › Add to Home screen)
and always open it from that icon.

**Full guide:** https://scalisec.github.io/rinkside/guide/ (the same answers are in the
app under the **?** button).

## How it works

- The app is a web page that installs like an app and plays everything offline. Internet
  is only needed to install it, download the music and get updates.
- The music and the button layout live in a **private Google Drive folder**. Each
  volunteer signs in with Google, and Drive sharing decides who can download (Viewer)
  and who can publish changes (Editor). The music is never in this repository.
- Teams can have their own Drive folder with their own goal horn, intro, tabs and songs,
  on top of the shared library.
- Updates to the app arrive by themselves: phones show "A new version is ready" (or switch
  over quietly for small fixes).

## What's in this repository

| File | What it is |
| --- | --- |
| `index.html`, `app.js`, `app.css` | The app (no libraries, no build step) |
| `sw.js` | Offline copy of the app; its `VERSION` changes on every release |
| `release-notes.json`, `version.js` | What's new in each version, and the build stamp shown in Help |
| `show.json` | The layout a brand-new install shows before the music is downloaded |
| `guide/` | The full guide web page |
| `manifest.webmanifest`, icons, `fonts/` | Home Screen icon, name and fonts |

Each release also has a `release-x.y.z` branch or tag, and older versions are kept as restore
points so a release can be rolled back.
