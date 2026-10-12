# Subtitle Translator

A small web app that translates subtitle files with
[`@vitalets/google-translate-api`](https://github.com/vitalets/google-translate-api).

- Formats: SRT, WebVTT and ASS/SSA (upload, drag and drop, or paste)
- **Many files at once**: add up to 100 files, translate them all with one click, and download everything as a single ZIP
- 100+ target languages, with source language auto-detection
- Timings, cue order, italics and position tags are kept
- Side-by-side editor: fix any translated line before you download
- Save as the same format, or convert between SRT and WebVTT
- Optional bilingual output (translation on top, original underneath)
- Large jobs: lines are batched, duplicate lines are translated once (even across different files), and rate limits trigger an automatic retry with a countdown
- Light and dark theme, works on phones

## Translating several files

1. Drop or select any number of subtitle files (hold Ctrl or Shift in the file picker, or drop a whole selection).
2. Choose the languages and press **Translate all N files**. Progress is shown for each file.
3. Click a file in the list to review and edit its lines.
4. Press **Download all (ZIP)** for every file, or **Download this file** for the one you are viewing.

Each file keeps its own name with the language added, for example `episode1.srt` becomes `episode1.si.srt`.
**Save as** applies to every file: keep each file's own format, or convert them all to SRT or WebVTT.
Changing the target language and pressing Translate again translates everything into the new language.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000, drop in a subtitle file, choose a language, and press Translate.

Shortcut: double-click `start.bat` (Windows) or run `./start.sh` (macOS/Linux). They install the packages on the
first run and then start the server.

**Important:** always open the app through `npm start` (the address above). Serving the `public` folder with
`python -m http.server`, Live Server, or opening `index.html` directly will show the page but translation
fails, because nothing is listening for `POST /api/translate` (you will see `501 Unsupported method ('POST')`).

Other commands:

```bash
npm run dev   # restart the server when files change
npm test      # parser, exporter, ZIP and multi-file flow tests (no network needed)
```

## Settings

| Variable     | Default | Meaning                                                        |
| ------------ | ------- | -------------------------------------------------------------- |
| `PORT`       | `3000`  | Port the server listens on                                     |
| `MIN_GAP_MS` | `300`   | Minimum pause between requests to Google. Raise it if you see rate limits. |

Example: `MIN_GAP_MS=800 PORT=8080 npm start`

## How it works

```
Browser                               Server (Node + Express)
-------                               -----------------------
parse SRT / VTT / ASS
split tags from text
group identical lines
send batches of ~80 lines  ---->  POST /api/translate
                                      join lines with a separator
                                      translate() from @vitalets/google-translate-api
                                      split the result and check the count
                                      (if the count is off, translate each line alone)
show results, allow edits  <----  { translations, detected }
build SRT / VTT / ASS and download
```

The package talks to Google's public web endpoint and cannot run inside a browser page, which is why
the project has a small server.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `501 Unsupported method ('POST')` in the log, or a red notice on the page saying the server isn't running | A plain file server is running instead of `server.js`. Stop it, then run `npm install` and `npm start`. |
| `npm: command not found` | Install Node.js 18 or newer from https://nodejs.org. |
| "Google is rate limiting this server" | Wait a few minutes, press **Retry failed**, or start with a larger `MIN_GAP_MS`. |
| "The language ... is not supported" | Pick another language, or check the code against the package's supported list. |

## Things to know

- **It is an unofficial endpoint.** Google may rate limit or block a server that sends many requests.
  The app backs off and retries, and a **Retry failed** button appears if lines are left over.
  For a public or commercial site, switch `callGoogle()` in `server.js` to the official Cloud Translation API.
- **Hosting.** Use any host that runs Node (Render, Railway, Fly.io, a VPS). A static-only host such as
  GitHub Pages cannot run the server.
- **Mid-line tags** such as `<i>` around a single word are removed before translating, because Google
  mangles them. Tags at the start of a cue (`<i>`, `{\an8}`) are restored after translating.
- **Lines with no letters** (for example `♪♪` or `...`) and ASS drawing commands are left as they are.
- **Output encoding** is UTF-8. Turn on the byte order mark option if an older player shows broken characters.
- Limits: 100 files at a time, 5 MB per file. Files cannot be added or removed while a translation is running.
- Translations are machine translations. Read through them before publishing.

## Project layout

```
server.js               Express server and Google Translate calls
public/index.html       Page
public/styles.css       Styles (light and dark)
public/app.js           Upload, translate loop, editor, export
public/subtitles.js     Parsing, tag handling, batching, export (also used by tests)
public/zip.js           Small ZIP writer for "Download all"
public/languages.js     Language list
test/                   Tests: parsers and exporters, ZIP writer, and a fake-DOM run of the multi-file flow
```
