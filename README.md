# PrintHub Mobile

Mobile web app (PWA) for **editing PDFs, scanning with the camera, signing and printing** — Android and iPhone,
Hebrew RTL UI, light/dark theme. Everything runs on the phone: files are never uploaded anywhere.

Companion to the PrintHub desktop app (private repo).

## Features

- Open any PDF and images from the phone, or receive them via **Share → PrintHub** (Android)
- **Camera scan**: photo → crop (auto-detect margins) → document enhancement (white background, sharper text)
- Merge, reorder (long-press and drag), rotate, crop, duplicate, delete, undo
- **Draw & mark**: pen, highlighter, Hebrew text, rectangle, ellipse, arrow — finger friendly
- **Signature**: draw once, stored on the phone (localStorage), place with a tap and drag into position
- Save / share as one PDF, selected pages only, one PDF per page, or JPG images
- **Print** through the phone's print dialog (AirPrint on iPhone, Mopria / Default Print Service on Android).
  On iPhone home-screen apps, printing goes through Share → Print.
- Works offline after the first visit (service worker)
- PDF pages stay vector; drawings are written as vector page content

## Install on the phone

Open the site URL on the phone, then:
- **Android (Chrome)**: menu ⋮ → *Install app* / *Add to Home screen*
- **iPhone (Safari)**: Share → *Add to Home Screen*

## Structure

| Path | Purpose |
|---|---|
| `index.html`, `css/app.css` | UI shell (RTL, mobile-first) |
| `js/app.js` | UI logic: page grid, selection, crop, drawing editor, signature pad, save/share/print |
| `js/core.js` | Document model, rendering (pdf.js), Hebrew visual ordering, PDF export (pdf-lib) |
| `sw.js`, `manifest.webmanifest` | Offline support, install, share target |
| `vendor/` | pdf.js 4.10.38 (legacy build), pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, SortableJS 1.15.6, Noto Sans Hebrew |
| `tests/placement.html` | Export accuracy tests (marks land where drawn, for every rotation/crop/source type) |

## Development

Any static server works, e.g. `python -m http.server 8765` and open `http://localhost:8765`.
Run `tests/placement.html` after changes to export code.

## Licenses

pdf.js (Apache-2.0), pdf-lib (MIT), fontkit (MIT), SortableJS (MIT), Noto Sans Hebrew (SIL OFL 1.1).
