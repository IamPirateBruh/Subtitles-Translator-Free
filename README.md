# Subtitle Translator

A small web app that translates subtitle files with
[`@vitalets/google-translate-api`](https://github.com/vitalets/google-translate-api).

- Formats: SRT, WebVTT and ASS/SSA (upload, drag and drop, or paste)
- 100+ target languages, with source language auto-detection
- Timings, cue order, italics and position tags are kept
- Side-by-side editor: fix any translated line before you download
- Save as the same format, or convert between SRT and WebVTT
- Optional bilingual output (translation on top, original underneath)
- Large files: lines are batched, duplicates are translated once, and rate limits trigger an automatic retry with a countdown
- Light and dark theme, works on phones

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000, drop in a subtitle file, choose a language, and press Translate.

Other commands:

```bash
npm run dev   # restart the server when files change
npm test      # parser and exporter tests (no network needed)
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
- Translations are machine translations. Read through them before publishing.

## Project layout

```
server.js               Express server and Google Translate calls
public/index.html       Page
public/styles.css       Styles (light and dark)
public/app.js           Upload, translate loop, editor, export
public/subtitles.js     Parsing, tag handling, batching, export (also used by tests)
public/languages.js     Language list
test/subtitles.test.js  Tests
```
