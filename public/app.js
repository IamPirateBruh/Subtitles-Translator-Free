import { LANGS } from './languages.js';
import {
  parseSubtitles,
  groupByCore,
  makeBatches,
  buildOutput,
  formatTime,
  formatDuration,
} from './subtitles.js';

/* ---------- setup ---------- */

const PAGE_SIZE = 50;
const BATCH = { maxItems: 80, maxChars: 4500, delimLen: 5 };
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const $ = (sel) => document.querySelector(sel);
const el = Object.fromEntries(
  Object.entries({
    drop: '#drop', file: '#file', fileInfo: '#fileInfo', pasteArea: '#pasteArea', pasteLoad: '#pasteLoad',
    sample: '#sampleBtn', from: '#fromLang', to: '#toLang', swap: '#swapBtn',
    optTags: '#optTags', optBi: '#optBi', optBom: '#optBom',
    translate: '#translateBtn', cancel: '#cancelBtn', progress: '#progress', barFill: '#barFill', status: '#status',
    cueLabel: '#cueLabel', cueTime: '#cueTime', prevCue: '#prevCue', nextCue: '#nextCue',
    capOrig: '#capOrig', capTrans: '#capTrans',
    exportBar: '#exportBar', outFmt: '#outFmt', download: '#downloadBtn', copy: '#copyBtn',
    cuesWrap: '#cuesWrap', search: '#search', retry: '#retryBtn', failCount: '#failCount',
    pgPrev: '#pgPrev', pgNext: '#pgNext', pgLabel: '#pgLabel', cueList: '#cueList',
    toast: '#toast', theme: '#themeBtn',
  }).map(([key, sel]) => [key, $(sel)]),
);

const state = {
  doc: null,
  fileName: 'subtitles',
  cache: new Map(),
  running: false,
  controller: null,
  selected: 0,
  page: 0,
  query: '',
  detected: null,
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const LANG_NAMES = new Map(LANGS.map(([code, name]) => [code.toLowerCase(), name]));
const fmtNum = (n) => n.toLocaleString();

const SAMPLE = `1
00:00:01,000 --> 00:00:03,500
¿Adónde quieres ir esta noche?

2
00:00:03,800 --> 00:00:06,400
<i>No lo sé. Cualquier lugar
donde haya música.</i>

3
00:00:07,000 --> 00:00:08,200
♪♪

4
00:00:08,600 --> 00:00:11,000
Conozco un café pequeño cerca del río.

5
00:00:11,300 --> 00:00:13,200
Perfecto. Vamos.

6
00:00:14,000 --> 00:00:16,500
{\\an8}Pero primero tengo que encontrar mis llaves.
`;

/* ---------- small helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children);
  return node;
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4500);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

const readOpts = () => ({
  keepTags: el.optTags.checked,
  bilingual: el.optBi.checked,
  bom: el.optBom.checked,
});

/* ---------- languages and settings ---------- */

function fillLanguages() {
  const opt = (code, name) => `<option value="${code}">${name}</option>`;
  el.from.innerHTML = opt('auto', 'Detect language') + LANGS.map(([c, n]) => opt(c, n)).join('');
  el.to.innerHTML = LANGS.map(([c, n]) => opt(c, n)).join('');
  el.from.value = store.get('st-from') || 'auto';
  el.to.value = store.get('st-to') || 'en';
  if (!el.from.value) el.from.value = 'auto';
  if (!el.to.value) el.to.value = 'en';
  el.optTags.checked = store.get('st-tags') !== '0';
  el.optBi.checked = store.get('st-bi') === '1';
  el.optBom.checked = store.get('st-bom') === '1';
  syncSwap();
}

function saveSettings() {
  store.set('st-from', el.from.value);
  store.set('st-to', el.to.value);
  store.set('st-tags', el.optTags.checked ? '1' : '0');
  store.set('st-bi', el.optBi.checked ? '1' : '0');
  store.set('st-bom', el.optBom.checked ? '1' : '0');
}

function syncSwap() {
  el.swap.disabled = el.from.value === 'auto';
}

/* ---------- loading files ---------- */

function decode(buffer) {
  const b = new Uint8Array(buffer);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

async function loadFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    return toast('That file is over 5 MB. Subtitle files are usually far smaller.');
  }
  ingest(decode(await file.arrayBuffer()), file.name);
}

function ingest(raw, name) {
  if (state.running) state.controller?.abort();

  let doc;
  try {
    doc = parseSubtitles(raw, name);
  } catch (err) {
    console.error(err);
    return toast("That file couldn't be read as subtitles.");
  }
  if (!doc.cues.length) {
    return toast('No subtitle cues found. Check that the file is SRT, VTT or ASS.');
  }

  Object.assign(state, {
    doc,
    fileName: name || 'subtitles',
    selected: 0,
    page: 0,
    query: '',
    detected: null,
  });
  el.search.value = '';
  el.progress.hidden = true;
  el.exportBar.hidden = false;
  el.cuesWrap.hidden = false;
  el.translate.disabled = false;

  fillOutputFormats();
  renderFileInfo();
  renderCues();
  updatePreview();
}

function renderFileInfo() {
  const { doc } = state;
  const last = doc.cues.at(-1)?.end ?? 0;
  const unique = groupByCore(doc.cues).size;
  el.fileInfo.replaceChildren(
    h('b', {}, state.fileName),
    h('span', {}, `${doc.format.toUpperCase()}, ${fmtNum(doc.cues.length)} cues, ${formatDuration(last)} long`),
    h('span', {}, `${fmtNum(unique)} unique lines will be sent to Google Translate`),
  );
  el.fileInfo.hidden = false;
}

function fillOutputFormats() {
  const names = { srt: 'SRT', vtt: 'WebVTT', ass: 'ASS' };
  const f = state.doc.format;
  const order = f === 'ass' ? ['ass', 'srt', 'vtt'] : f === 'vtt' ? ['vtt', 'srt'] : ['srt', 'vtt'];
  el.outFmt.innerHTML = order
    .map((k) => `<option value="${k}">${names[k]}${k === f ? ' (same as source)' : ''}</option>`)
    .join('');
}

/* ---------- translation ---------- */

async function countdown(secs, signal, onTick) {
  for (let s = secs; s > 0; s--) {
    onTick(s);
    await sleep(1000, signal);
  }
}

async function postBatch(texts, from, to, signal, onWait) {
  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts, from, to }),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (++attempt >= 3) throw new Error('Could not reach the server.');
      await sleep(1500 * attempt, signal);
      continue;
    }

    if (res.ok) return res.json();

    const data = await res.json().catch(() => ({}));
    if (res.status === 429) {
      if (++attempt > 4) {
        const err = new Error(data.error || 'Rate limited by Google.');
        err.rateLimited = true;
        throw err;
      }
      await countdown(8 * 2 ** (attempt - 1), signal, onWait);
      continue;
    }
    if (res.status >= 500 && attempt < 2) {
      attempt++;
      await sleep(1000 * attempt, signal);
      continue;
    }
    throw new Error(data.error || `Server error (${res.status}).`);
  }
}

function setProgress(done, total, message) {
  el.progress.hidden = false;
  el.barFill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
  el.status.textContent = message;
}

function setRunningUI(running) {
  el.translate.hidden = running;
  el.cancel.hidden = !running;
  el.translate.disabled = running || !state.doc;
}

async function runTranslation({ onlyFailed = false } = {}) {
  const doc = state.doc;
  if (!doc || state.running) return;

  const from = el.from.value;
  const to = el.to.value;
  if (from === to) return toast('Choose two different languages.');

  const targets = doc.cues.filter((c) => !c.skip && (!onlyFailed || c.status === 'failed'));
  if (!targets.length) return toast('There is nothing to translate.');

  saveSettings();
  state.running = true;
  state.controller = new AbortController();
  const { signal } = state.controller;
  setRunningUI(true);

  for (const c of targets) {
    c.status = 'pending';
    if (!onlyFailed) c.trans = null;
  }

  const countDone = () => targets.filter((c) => c.status === 'done').length;
  const progress = (message) => {
    const done = countDone();
    setProgress(done, targets.length, message ?? `Translated ${fmtNum(done)} of ${fmtNum(targets.length)} lines`);
  };
  const key = (core) => `${from}\u0000${to}\u0000${core}`;
  const finish = (c, text) => { c.trans = text; c.status = 'done'; };

  // Identical lines ("Yes.", "What?") are translated once.
  const groups = groupByCore(targets);
  const todo = [];
  for (const [core, list] of groups) {
    const hit = state.cache.get(key(core));
    if (hit !== undefined) list.forEach((c) => finish(c, hit));
    else todo.push(core);
  }

  const batches = makeBatches(todo, BATCH);
  let rateLimited = false;
  let lastError = '';
  progress();
  renderCues();

  for (let b = 0; b < batches.length && !signal.aborted; b++) {
    const batch = batches[b];
    try {
      const data = await postBatch(batch, from, to, signal, (secs) =>
        progress(`Google is rate limiting requests. Retrying in ${secs}s…`),
      );
      batch.forEach((core, i) => {
        const text = data.translations[i];
        if (typeof text === 'string' && text) {
          state.cache.set(key(core), text);
          groups.get(core).forEach((c) => finish(c, text));
        } else {
          groups.get(core).forEach((c) => { c.status = 'failed'; });
        }
      });
      if (from === 'auto' && data.detected) state.detected = data.detected;
    } catch (err) {
      if (err.name === 'AbortError') break;
      batch.forEach((core) => groups.get(core).forEach((c) => { c.status = 'failed'; }));
      lastError = err.message;
      if (err.rateLimited) { rateLimited = true; break; }
    }
    progress();
    if (state.doc === doc) renderCues();
    await sleep(400, signal).catch(() => {});
  }

  const aborted = signal.aborted;
  for (const c of targets) {
    if (c.status === 'pending') c.status = aborted ? 'idle' : 'failed';
  }
  state.running = false;
  state.controller = null;
  setRunningUI(false);

  if (state.doc !== doc) return; // a new file was loaded meanwhile

  const done = countDone();
  const failed = targets.filter((c) => c.status === 'failed').length;
  const detected = state.detected
    ? ` Detected source language: ${LANG_NAMES.get(state.detected.toLowerCase()) ?? state.detected}.`
    : '';
  let message;
  if (aborted) message = `Cancelled. ${fmtNum(done)} lines were translated.`;
  else if (rateLimited) message = `Stopped: Google is rate limiting this server. ${fmtNum(failed)} lines are waiting. Wait a few minutes, then press Retry failed.`;
  else if (failed) message = `${fmtNum(done)} lines translated, ${fmtNum(failed)} failed. ${lastError}`.trim();
  else message = `Done. ${fmtNum(done)} lines translated.${detected}`;

  setProgress(done, targets.length, message);
  renderCues();
  updatePreview();
}

/* ---------- preview ---------- */

function updatePreview() {
  const { doc } = state;
  if (!doc) {
    el.cueLabel.textContent = 'Preview';
    el.cueTime.textContent = '';
    el.capOrig.textContent = '¿Adónde quieres ir?';
    el.capTrans.textContent = 'Where do you want to go?';
    el.capTrans.hidden = false;
    el.prevCue.disabled = el.nextCue.disabled = true;
    return;
  }
  const c = doc.cues[state.selected];
  el.cueLabel.textContent = `Cue ${fmtNum(state.selected + 1)} of ${fmtNum(doc.cues.length)}`;
  el.cueTime.textContent = formatTime(c.start);
  el.capOrig.textContent = c.core || c.text;
  el.capTrans.textContent = c.trans || '';
  el.capTrans.hidden = !c.trans;
  el.prevCue.disabled = el.nextCue.disabled = false;
}

/* ---------- cue list ---------- */

function visibleIndexes() {
  const cues = state.doc.cues;
  const q = state.query.trim().toLowerCase();
  if (!q) return cues.map((_, i) => i);
  const out = [];
  cues.forEach((c, i) => {
    if (c.core.toLowerCase().includes(q) || (c.trans || '').toLowerCase().includes(q)) out.push(i);
  });
  return out;
}

function rowFor(i) {
  const c = state.doc.cues[i];
  const row = h('div', { class: `cue is-${c.status}${i === state.selected ? ' selected' : ''}`, 'data-i': i });

  row.append(
    h('div', { class: 'cue-time' }, h('span', { class: 'cue-n' }, String(i + 1)), h('span', { class: 'mono' }, formatTime(c.start))),
    h('div', { class: 'cue-orig' }, c.skip ? c.core || c.text : c.core),
  );

  const cell = h('div', { class: 'cue-trans' });
  if (c.skip) {
    cell.append(h('span', { class: 'cue-msg' }, 'Kept as is'));
  } else if (c.status === 'pending') {
    cell.append(h('span', { class: 'cue-msg' }, 'Waiting…'));
  } else {
    const ta = h('textarea', {
      rows: 1,
      lang: el.to.value,
      'aria-label': `Translation for cue ${i + 1}`,
      placeholder: c.status === 'failed' ? 'Translation failed. Retry, or type one here.' : 'Not translated yet',
      readonly: state.running,
    });
    ta.value = c.trans ?? '';
    ta.addEventListener('input', () => {
      c.trans = ta.value;
      c.status = ta.value.trim() ? 'done' : 'idle';
      autosize(ta);
      if (state.selected === i) updatePreview();
    });
    cell.append(ta);
  }
  row.append(cell);
  row.addEventListener('click', () => select(i));
  return row;
}

function renderCues() {
  if (!state.doc) return;
  const idx = visibleIndexes();
  const pages = Math.max(1, Math.ceil(idx.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages - 1);
  const slice = idx.slice(state.page * PAGE_SIZE, (state.page + 1) * PAGE_SIZE);

  if (slice.length) el.cueList.replaceChildren(...slice.map(rowFor));
  else el.cueList.replaceChildren(h('p', { class: 'empty' }, 'No cues match your search.'));
  el.cueList.querySelectorAll('textarea').forEach(autosize);

  el.pgLabel.textContent = `Page ${state.page + 1} of ${pages}`;
  el.pgPrev.disabled = state.page === 0;
  el.pgNext.disabled = state.page >= pages - 1;

  const failed = state.doc.cues.filter((c) => c.status === 'failed').length;
  el.failCount.textContent = String(failed);
  el.retry.hidden = failed === 0 || state.running;
}

function select(i) {
  state.selected = i;
  el.cueList.querySelector('.cue.selected')?.classList.remove('selected');
  el.cueList.querySelector(`.cue[data-i="${i}"]`)?.classList.add('selected');
  updatePreview();
}

function stepCue(delta) {
  const idx = visibleIndexes();
  if (!idx.length) return;
  const pos = idx.indexOf(state.selected);
  const next = Math.min(idx.length - 1, Math.max(0, (pos < 0 ? 0 : pos) + delta));
  state.page = Math.floor(next / PAGE_SIZE);
  state.selected = idx[next];
  renderCues();
  updatePreview();
  el.cueList.querySelector('.cue.selected')?.scrollIntoView({ block: 'nearest' });
}

/* ---------- export ---------- */

function outputName(fmt) {
  const base = state.fileName.replace(/\.[^.]+$/, '') || 'subtitles';
  return `${base}.${el.to.value}.${fmt}`;
}

function download() {
  if (!state.doc) return;
  const fmt = el.outFmt.value;
  const opts = readOpts();
  const content = buildOutput(state.doc, fmt, opts);
  const blob = new Blob([opts.bom ? `\uFEFF${content}` : content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: outputName(fmt) });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);

  const untranslated = state.doc.cues.filter((c) => !c.skip && !c.trans).length;
  if (untranslated) toast(`Saved. ${fmtNum(untranslated)} lines are not translated yet and keep their original text.`);
}

async function copyOutput() {
  if (!state.doc) return;
  try {
    await navigator.clipboard.writeText(buildOutput(state.doc, el.outFmt.value, readOpts()));
    toast('Copied to the clipboard.');
  } catch {
    toast("Couldn't copy. Use Download instead.");
  }
}

/* ---------- events ---------- */

el.file.addEventListener('change', () => {
  const f = el.file.files?.[0];
  if (f) loadFile(f);
  el.file.value = '';
});

el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.file.click(); }
});
['dragenter', 'dragover'].forEach((t) =>
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }),
);
['dragleave', 'drop'].forEach((t) =>
  el.drop.addEventListener(t, () => el.drop.classList.remove('over')),
);
// A file dropped anywhere on the page is loaded; stop the browser from opening it instead.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

el.pasteLoad.addEventListener('click', () => {
  if (!el.pasteArea.value.trim()) return toast('Paste some subtitle text first.');
  ingest(el.pasteArea.value, '');
});
el.sample.addEventListener('click', () => ingest(SAMPLE, 'sample.srt'));

el.from.addEventListener('change', () => { syncSwap(); saveSettings(); });
el.to.addEventListener('change', () => { saveSettings(); renderCues(); });
el.swap.addEventListener('click', () => {
  const f = el.from.value;
  el.from.value = el.to.value;
  el.to.value = f;
  syncSwap();
  saveSettings();
});
[el.optTags, el.optBi, el.optBom].forEach((c) => c.addEventListener('change', saveSettings));

el.translate.addEventListener('click', () => runTranslation());
el.retry.addEventListener('click', () => runTranslation({ onlyFailed: true }));
el.cancel.addEventListener('click', () => state.controller?.abort());

el.search.addEventListener('input', () => {
  state.query = el.search.value;
  state.page = 0;
  renderCues();
});
el.pgPrev.addEventListener('click', () => { state.page--; renderCues(); });
el.pgNext.addEventListener('click', () => { state.page++; renderCues(); });
el.prevCue.addEventListener('click', () => stepCue(-1));
el.nextCue.addEventListener('click', () => stepCue(1));

el.download.addEventListener('click', download);
el.copy.addEventListener('click', copyOutput);

el.theme.addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  store.set('st-theme', next);
});

/* ---------- start ---------- */

fillLanguages();
updatePreview();
