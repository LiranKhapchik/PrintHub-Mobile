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
- **Scan from the printer** (Android app): finds eSCL/AirScan scanners on the home Wi-Fi, shows each one's
  serial number, scans straight from the glass, and re-finds the printer by serial if its IP changes
- **Print** through the phone's print dialog (AirPrint on iPhone, Mopria / Default Print Service on Android).
  On iPhone home-screen apps, printing goes through Share → Print.
- Works offline after the first visit (service worker)
- PDF pages stay vector; drawings are written as vector page content

## Android app (scanning from the printer)

Browsers cannot read the printer's scanner (it sends no CORS headers), so scanning lives in an Android build of
the same web app (Capacitor 6). Requests to the printer go through Capacitor's native HTTP.

- Every push builds an APK with GitHub Actions and publishes it as the `android-latest` release.
- Signing: if the repository has the secrets `ANDROID_KEYSTORE_B64` (PKCS12, base64), `ANDROID_KEYSTORE_PASSWORD`
  and `ANDROID_KEY_ALIAS`, the APK is signed with that fixed key (updates install over the previous version).
  Without them it is debug-signed (uninstall the old build before installing a new one).
- Local build: `npm install && npm run android:sync`, then open `android/` in Android Studio.

## Install on the phone

Open the site URL on the phone, then:
- **Android (Chrome)**: menu ⋮ → *Install app* / *Add to Home screen*
- **iPhone (Safari)**: Share → *Add to Home Screen*

## Structure

| Path | Purpose |
|---|---|
| `index.html`, `css/app.css` | UI shell (RTL, mobile-first) |
| `js/app.js` | UI logic: page grid, selection, crop, drawing editor, signature pad, save/share/print |
| `js/scanner.js` | eSCL scanning: discovery, scan jobs, re-finding a printer by serial |
| `js/core.js` | Document model, rendering (pdf.js), Hebrew visual ordering, PDF export (pdf-lib) |
| `sw.js`, `manifest.webmanifest` | Offline support, install, share target |
| `vendor/` | pdf.js 4.10.38 (legacy build), pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, SortableJS 1.15.6, Noto Sans Hebrew |
| `tests/placement.html` | Export accuracy tests (marks land where drawn, for every rotation/crop/source type) - 48 checks |
| `tests/scan.html?serial=…` | Real-printer scan test through the UI (needs the test proxy) - 10 checks |
| `tests/e2e.html` | End-to-end UI test: drives the real app in a phone-sized frame (open, select, rotate, undo, move, duplicate, delete, draw, text, signature, crop, export, PWA) - 31 checks |

## Development

Any static server works, e.g. `python -m http.server 8765` and open `http://localhost:8765`.
Open `tests/e2e.html` and `tests/placement.html` on the local server; each page prints `RESULT n/n passed`
(and POSTs the result to `/__result`, so they can also run in headless Chrome/Edge).

## Licenses

pdf.js (Apache-2.0), pdf-lib (MIT), fontkit (MIT), SortableJS (MIT), Noto Sans Hebrew (SIL OFL 1.1).
