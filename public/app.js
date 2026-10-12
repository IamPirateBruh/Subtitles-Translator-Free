import { LANGS } from './languages.js';
import {
  parseSubtitles,
  groupByCore,
  makeBatches,
  buildOutput,
  formatTime,
  formatDuration,
} from './subtitles.js';
import { makeZip, uniqueName } from './zip.js';

/* ---------- setup ---------- */

const PAGE_SIZE = 50;
const BATCH = { maxItems: 80, maxChars: 4500, delimLen: 5 };
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 100;
const SUBTITLE_EXT = /\.(srt|vtt|ass|ssa|txt)$/i;
const BACKEND_HINT =
  "The translation server isn't running. In the project folder, run \"npm install\" and then \"npm start\", " +
  'and open http://localhost:3000. A plain file server (such as python -m http.server) cannot translate.';

const $ = (sel) => document.querySelector(sel);
const el = Object.fromEntries(
  Object.entries({
    drop: '#drop', file: '#file', files: '#files', filesTitle: '#filesTitle', clearFiles: '#clearFiles',
    fileList: '#fileList', fileInfo: '#fileInfo', pasteArea: '#pasteArea', pasteLoad: '#pasteLoad',
    sample: '#sampleBtn', from: '#fromLang', to: '#toLang', swap: '#swapBtn',
    optTags: '#optTags', optBi: '#optBi', optBom: '#optBom',
    translate: '#translateBtn', cancel: '#cancelBtn', progress: '#progress', barFill: '#barFill', status: '#status',
    cueLabel: '#cueLabel', cueTime: '#cueTime', prevCue: '#prevCue', nextCue: '#nextCue',
    capOrig: '#capOrig', capTrans: '#capTrans',
    exportBar: '#exportBar', outFmt: '#outFmt', download: '#downloadBtn', downloadAll: '#downloadAllBtn', copy: '#copyBtn',
    cuesWrap: '#cuesWrap', activeName: '#activeName', search: '#search', retry: '#retryBtn', failCount: '#failCount',
    pgPrev: '#pgPrev', pgNext: '#pgNext', pgLabel: '#pgLabel', cueList: '#cueList',
    toast: '#toast', theme: '#themeBtn', serverWarn: '#serverWarn',
  }).map(([key, sel]) => [key, $(sel)]),
);

const state = {
  files: [], // [{ id, name, doc }]
  activeId: null,
  nextId: 1,
  pasted: 0,
  doc: null, // the file shown in the editor
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
const langName = (code) => LANG_NAMES.get(String(code).toLowerCase()) ?? code;
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
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 5000);
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

/** True when the cue already has a translation into language `to`. */
const isDoneFor = (c, to) => c.status === 'done' && c.lang === to;

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
  el.outFmt.value = store.get('st-out') || 'same';
  if (!el.outFmt.value) el.outFmt.value = 'same';
  syncSwap();
}

function saveSettings() {
  store.set('st-from', el.from.value);
  store.set('st-to', el.to.value);
  store.set('st-tags', el.optTags.checked ? '1' : '0');
  store.set('st-bi', el.optBi.checked ? '1' : '0');
  store.set('st-bom', el.optBom.checked ? '1' : '0');
  store.set('st-out', el.outFmt.value);
}

function syncSwap() {
  el.swap.disabled = el.from.value === 'auto';
}

/* ---------- file queue ---------- */

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

function busyToast() {
  toast('Wait for the translation to finish, or cancel it, before changing the files.');
}

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (state.running) return busyToast();

  const items = [];
  const notes = [];
  for (const f of files) {
    if (!SUBTITLE_EXT.test(f.name)) notes.push(`${f.name} isn't a subtitle file`);
    else if (f.size > MAX_FILE_BYTES) notes.push(`${f.name} is over 5 MB`);
    else items.push({ name: f.name, raw: decode(await f.arrayBuffer()) });
  }
  addFiles(items, notes);
}

function addFiles(items, notes = []) {
  if (state.running) return busyToast();

  const room = Math.max(0, MAX_FILES - state.files.length);
  if (items.length > room) {
    notes.push(`only ${MAX_FILES} files fit at once, so ${items.length - room} were not added`);
    items = items.slice(0, room);
  }

  const added = [];
  for (const { name, raw } of items) {
    try {
      const doc = parseSubtitles(raw, name);
      if (!doc.cues.length) {
        notes.push(`${name} has no subtitle cues`);
        continue;
      }
      const entry = { id: state.nextId++, name, doc };
      state.files.push(entry);
      added.push(entry);
    } catch (err) {
      console.error(err);
      notes.push(`${name} couldn't be read`);
    }
  }

  if (added.length) {
    el.progress.hidden = true;
    if (!state.activeId) activate(added[0].id);
  }
  refreshChrome();

  if (notes.length) {
    const shown = notes.slice(0, 2).join('. ');
    toast(`${shown}${notes.length > 2 ? `. And ${notes.length - 2} more problems` : ''}.`);
  } else if (added.length > 1) {
    toast(`${added.length} files added.`);
  }
}

function resetActive() {
  Object.assign(state, { activeId: null, doc: null, fileName: 'subtitles', selected: 0, page: 0, query: '' });
  el.search.value = '';
  el.progress.hidden = true;
  updatePreview();
}

function removeFile(id) {
  if (state.running) return busyToast();
  state.files = state.files.filter((f) => f.id !== id);
  if (state.activeId === id) {
    const next = state.files[0];
    if (next) activate(next.id);
    else resetActive();
  }
  refreshChrome();
}

function clearFiles() {
  if (state.running) return busyToast();
  state.files = [];
  resetActive();
  refreshChrome();
}

function activate(id) {
  const entry = state.files.find((f) => f.id === id);
  if (!entry) return;
  Object.assign(state, { activeId: id, doc: entry.doc, fileName: entry.name, selected: 0, page: 0, query: '' });
  el.search.value = '';
  el.activeName.textContent = entry.name;
  renderFiles();
  renderCues();
  updatePreview();
}

function fileStats(doc, to) {
  const s = { total: 0, done: 0, failed: 0, pending: 0 };
  for (const c of doc.cues) {
    if (c.skip) continue;
    s.total++;
    if (isDoneFor(c, to)) s.done++;
    else if (c.status === 'failed') s.failed++;
    else if (c.status === 'pending') s.pending++;
  }
  return s;
}

function statusLabel(s) {
  const pct = s.total ? Math.round((100 * s.done) / s.total) : 0;
  if (!s.total) return 'Nothing to translate';
  if (s.pending) return `Translating ${pct}%`;
  if (s.failed) return `${fmtNum(s.failed)} failed`;
  if (s.done === s.total) return 'Done';
  if (s.done) return `${pct}% translated`;
  return 'Ready';
}

function renderFiles() {
  const to = el.to.value;
  el.fileList.replaceChildren(
    ...state.files.map((entry) => {
      const s = fileStats(entry.doc, to);
      const active = entry.id === state.activeId;
      const pct = s.total ? Math.round((100 * s.done) / s.total) : 0;
      const li = h('li', { class: `file${active ? ' active' : ''}${s.failed ? ' has-failed' : ''}` });
      const main = h(
        'button',
        { type: 'button', class: 'file-main', 'aria-current': active ? 'true' : false, title: entry.name },
        h('span', { class: 'file-name' }, entry.name),
        h('span', { class: 'file-status' }, statusLabel(s)),
        h('span', { class: 'file-meta' }, `${entry.doc.format.toUpperCase()}, ${fmtNum(entry.doc.cues.length)} cues`),
        h('span', { class: 'file-bar', 'aria-hidden': 'true' }, h('i', { style: `width:${pct}%` })),
      );
      main.addEventListener('click', () => activate(entry.id));
      const remove = h(
        'button',
        { type: 'button', class: 'file-remove', 'aria-label': `Remove ${entry.name}`, disabled: state.running },
        '×',
      );
      remove.addEventListener('click', () => removeFile(entry.id));
      li.append(main, remove);
      return li;
    }),
  );
}

function renderSummary() {
  const docs = state.files.map((f) => f.doc);
  if (!docs.length) return el.fileInfo.replaceChildren();

  const to = el.to.value;
  const cues = docs.flatMap((d) => d.cues);
  const translatable = cues.filter((c) => !c.skip);
  const todo = translatable.filter((c) => !isDoneFor(c, to));
  const unique = groupByCore(todo).size;

  const first =
    docs.length === 1
      ? `${docs[0].format.toUpperCase()}, ${fmtNum(cues.length)} cues, ${formatDuration(docs[0].cues.at(-1)?.end ?? 0)} long`
      : `${fmtNum(cues.length)} cues in total`;
  let second;
  if (!translatable.length) second = 'No translatable text found';
  else if (!unique) second = `Everything is already translated into ${langName(to)}`;
  else second = `${fmtNum(unique)} unique lines will be sent to Google Translate`;

  el.fileInfo.replaceChildren(h('span', {}, first), h('span', {}, second));
}

/** Updates every control that depends on how many files are loaded. */
function refreshChrome() {
  const n = state.files.length;
  el.files.hidden = n === 0;
  el.exportBar.hidden = n === 0;
  el.cuesWrap.hidden = n === 0;
  el.filesTitle.textContent = n > 1 ? `${n} files` : 'File';
  el.clearFiles.disabled = state.running;
  el.drop.classList.toggle('disabled', state.running);
  el.translate.disabled = n === 0 || state.running;
  el.translate.textContent = n > 1 ? `Translate all ${n} files` : 'Translate';
  el.downloadAll.hidden = n < 2;
  el.download.textContent = n > 1 ? 'Download this file' : 'Download';
  el.download.classList.toggle('primary', n < 2);
  renderFiles();
  renderSummary();
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

    // 404, 405 or 501 on the API path means a plain file server is running instead of server.js.
    if ([404, 405, 501].includes(res.status)) {
      const err = new Error(BACKEND_HINT);
      err.fatal = true;
      throw err;
    }

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
  refreshChrome();
}

/**
 * Translates every loaded file in one pass: lines from all files are de-duplicated together,
 * sent in batches, then written back to the cues they came from.
 */
async function runTranslation({ onlyFailed = false } = {}) {
  if (!state.files.length || state.running) return;

  const from = el.from.value;
  const to = el.to.value;
  if (from === to) return toast('Choose two different languages.');

  const allCues = state.files.flatMap((f) => f.doc.cues);
  const targets = allCues.filter(
    (c) => !c.skip && (onlyFailed ? c.status === 'failed' : !isDoneFor(c, to)),
  );
  if (!targets.length) {
    return toast(
      onlyFailed
        ? 'There is nothing to retry.'
        : `Everything is already translated into ${langName(to)}. Pick another language to translate again.`,
    );
  }
  const targetSet = new Set(targets);
  const fileCount = state.files.filter((f) => f.doc.cues.some((c) => targetSet.has(c))).length;

  saveSettings();
  state.detected = null;
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
    renderFiles();
  };
  const key = (core) => `${from}\u0000${to}\u0000${core}`;
  const finish = (c, text) => { c.trans = text; c.status = 'done'; c.lang = to; };

  // Identical lines ("Yes.", "What?") are translated once, even across different files.
  const groups = groupByCore(targets);
  const todo = [];
  for (const [core, list] of groups) {
    const hit = state.cache.get(key(core));
    if (hit !== undefined) list.forEach((c) => finish(c, hit));
    else todo.push(core);
  }

  const batches = makeBatches(todo, BATCH);
  let rateLimited = false;
  let fatal = false;
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
      if (err.fatal) { fatal = true; break; }
    }
    progress();
    renderCues();
    await sleep(400, signal).catch(() => {});
  }

  const aborted = signal.aborted;
  for (const c of targets) {
    if (c.status === 'pending') c.status = aborted ? 'idle' : 'failed';
  }
  state.running = false;
  state.controller = null;
  setRunningUI(false);

  const done = countDone();
  const failed = targets.filter((c) => c.status === 'failed').length;
  const where = fileCount > 1 ? ` across ${fileCount} files` : '';
  const detected = state.detected ? ` Detected source language: ${langName(state.detected)}.` : '';
  let message;
  if (fatal) { message = lastError; checkServer(); }
  else if (aborted) message = `Cancelled. ${fmtNum(done)} lines were translated.`;
  else if (rateLimited) message = `Stopped: Google is rate limiting this server. ${fmtNum(failed)} lines are waiting. Wait a few minutes, then press Retry failed.`;
  else if (failed) message = `${fmtNum(done)} lines translated${where}, ${fmtNum(failed)} failed. ${lastError}`.trim();
  else message = `Done. ${fmtNum(done)} lines translated${where}.${detected}`;

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

/* ---------- cue list (the active file) ---------- */

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
      const before = c.status;
      c.trans = ta.value;
      c.status = ta.value.trim() ? 'done' : 'idle';
      c.lang = el.to.value;
      autosize(ta);
      if (state.selected === i) updatePreview();
      if (before !== c.status) {
        renderFiles();
        renderSummary();
      }
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

  // Failed lines are counted across all files, because Retry failed covers all of them.
  const failed = state.files.reduce((n, f) => n + f.doc.cues.filter((c) => c.status === 'failed').length, 0);
  el.failCount.textContent = fmtNum(failed);
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

const outputFormat = (doc) => (el.outFmt.value === 'same' ? doc.format : el.outFmt.value);

function outputName(name, fmt) {
  const base = name.replace(/\.[^.]+$/, '') || 'subtitles';
  return `${base}.${el.to.value}.${fmt}`;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function untranslatedCount(docs) {
  const to = el.to.value;
  return docs.reduce((n, d) => n + d.cues.filter((c) => !c.skip && !isDoneFor(c, to)).length, 0);
}

function download() {
  const doc = state.doc;
  if (!doc) return;
  const fmt = outputFormat(doc);
  const opts = readOpts();
  const content = buildOutput(doc, fmt, opts);
  saveBlob(
    new Blob([opts.bom ? `\uFEFF${content}` : content], { type: 'text/plain;charset=utf-8' }),
    outputName(state.fileName, fmt),
  );
  const left = untranslatedCount([doc]);
  if (left) toast(`Saved. ${fmtNum(left)} lines are not translated yet and keep their original text.`);
}

function downloadAll() {
  if (!state.files.length) return;
  const opts = readOpts();
  const used = new Set();
  const entries = state.files.map(({ name, doc }) => {
    const fmt = outputFormat(doc);
    const content = buildOutput(doc, fmt, opts);
    return { name: uniqueName(outputName(name, fmt), used), data: opts.bom ? `\uFEFF${content}` : content };
  });
  saveBlob(makeZip(entries), `subtitles-${el.to.value}.zip`);
  const left = untranslatedCount(state.files.map((f) => f.doc));
  if (left) toast(`Saved. ${fmtNum(left)} lines are not translated yet and keep their original text.`);
  else toast(`Saved ${entries.length} files in one ZIP.`);
}

async function copyOutput() {
  if (!state.doc) return;
  try {
    await navigator.clipboard.writeText(buildOutput(state.doc, outputFormat(state.doc), readOpts()));
    toast('Copied to the clipboard.');
  } catch {
    toast("Couldn't copy. Use Download instead.");
  }
}

/* ---------- events ---------- */

el.file.addEventListener('change', () => {
  const picked = [...(el.file.files ?? [])];
  el.file.value = '';
  loadFiles(picked);
});

el.drop.addEventListener('click', (e) => {
  if (state.running) { e.preventDefault(); busyToast(); }
});
el.drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (state.running) busyToast();
    else el.file.click();
  }
});
['dragenter', 'dragover'].forEach((t) =>
  el.drop.addEventListener(t, (e) => { e.preventDefault(); el.drop.classList.add('over'); }),
);
['dragleave', 'drop'].forEach((t) =>
  el.drop.addEventListener(t, () => el.drop.classList.remove('over')),
);
// Files dropped anywhere on the page are loaded; stop the browser from opening them instead.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  loadFiles(e.dataTransfer?.files ?? []);
});

el.pasteLoad.addEventListener('click', () => {
  if (!el.pasteArea.value.trim()) return toast('Paste some subtitle text first.');
  if (state.running) return busyToast();
  addFiles([{ name: `pasted-${++state.pasted}`, raw: el.pasteArea.value }]);
  el.pasteArea.value = '';
});
el.sample.addEventListener('click', () => {
  if (state.running) return busyToast();
  state.files = [];
  resetActive();
  addFiles([{ name: 'sample.srt', raw: SAMPLE }]);
});

el.from.addEventListener('change', () => { syncSwap(); saveSettings(); });
el.to.addEventListener('change', () => {
  saveSettings();
  refreshChrome();
  renderCues();
});
el.swap.addEventListener('click', () => {
  const f = el.from.value;
  el.from.value = el.to.value;
  el.to.value = f;
  syncSwap();
  saveSettings();
  refreshChrome();
  renderCues();
});
[el.optTags, el.optBi, el.optBom, el.outFmt].forEach((c) => c.addEventListener('change', saveSettings));

el.translate.addEventListener('click', () => runTranslation());
el.retry.addEventListener('click', () => runTranslation({ onlyFailed: true }));
el.cancel.addEventListener('click', () => state.controller?.abort());
el.clearFiles.addEventListener('click', clearFiles);

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
el.downloadAll.addEventListener('click', downloadAll);
el.copy.addEventListener('click', copyOutput);

el.theme.addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  store.set('st-theme', next);
});

/* ---------- start ---------- */

async function checkServer() {
  let ok = false;
  if (location.protocol !== 'file:') {
    try {
      const res = await fetch('/api/health');
      ok = res.ok && (await res.json()).ok === true;
    } catch {
      ok = false;
    }
  }
  el.serverWarn.textContent = ok ? '' : BACKEND_HINT;
  el.serverWarn.hidden = ok;
}

fillLanguages();
updatePreview();
refreshChrome();
checkServer();
