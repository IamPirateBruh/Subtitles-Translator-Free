// Pure subtitle logic: parsing, tag handling, batching and export. No DOM access,
// so it runs in the browser and in Node tests.

const TAG_SRC = String.raw`\{[^}]*\}|<\/?[a-zA-Z][^>]*>`;
const TAG_G = new RegExp(TAG_SRC, 'g');
const LEAD_RE = new RegExp(String.raw`^(?:\s*(?:${TAG_SRC}))+`);
const TIME_LINE =
  /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})(.*)$/;

/* ---------- time ---------- */

export function parseTime(s) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(s).trim());
  if (!m) return 0;
  return (
    Number(m[1] || 0) * 3600000 +
    Number(m[2]) * 60000 +
    Number(m[3]) * 1000 +
    Number(m[4].padEnd(3, '0'))
  );
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

export function formatTime(ms, sep = ',') {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function formatAssTime(ms) {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${total % 60}s`;
  return `${total}s`;
}

/* ---------- parsing ---------- */

export function normalize(raw) {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]+$/gm, '');
}

export function detectFormat(name, text) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const head = text.trimStart().slice(0, 200);
  if (/^WEBVTT/.test(head) || ext === 'vtt') return 'vtt';
  if (/^\[Script Info\]/i.test(head) || ext === 'ass' || ext === 'ssa') return 'ass';
  return 'srt';
}

function parseCueBlocks(text) {
  const head = [];
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const ti = lines.findIndex((l) => l.includes('-->'));
    const m = ti >= 0 && ti <= 1 ? TIME_LINE.exec(lines[ti]) : null;
    if (!m) {
      if (!cues.length && block.trim()) head.push(block.trim());
      continue;
    }
    const body = lines.slice(ti + 1).join('\n').trim();
    if (!body) continue;
    let id = ti === 1 ? lines[0].trim() : '';
    if (/^WEBVTT/.test(id)) id = '';
    cues.push({
      id,
      start: parseTime(m[1]),
      end: parseTime(m[2]),
      settings: m[3].trim(),
      text: body,
    });
  }
  return { head, cues };
}

function splitN(str, n) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < n - 1; i++) {
    const j = str.indexOf(',', start);
    if (j < 0) break;
    parts.push(str.slice(start, j));
    start = j + 1;
  }
  parts.push(str.slice(start));
  return parts;
}

function parseAss(text) {
  const lines = [];
  const cues = [];
  let inEvents = false;
  let fields = null;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^\[.+\]$/.test(t)) {
      inEvents = /^\[events\]$/i.test(t);
      lines.push(line);
      continue;
    }
    if (inEvents && /^format:/i.test(t)) {
      fields = t.slice(7).split(',').map((s) => s.trim().toLowerCase());
      lines.push(line);
      continue;
    }
    if (inEvents && fields && /^dialogue:/i.test(t)) {
      const n = fields.length;
      const parts = splitN(t.slice(9).replace(/^\s/, ''), n);
      const si = fields.indexOf('start');
      const ei = fields.indexOf('end');
      const ti = fields.indexOf('text');
      if (parts.length === n && si >= 0 && ei >= 0 && ti === n - 1) {
        lines.push({ cue: cues.length });
        cues.push({
          start: parseTime(parts[si]),
          end: parseTime(parts[ei]),
          pre: parts.slice(0, n - 1).join(','),
          text: parts[ti].replace(/\\[Nn]/g, '\n'),
        });
        continue;
      }
    }
    lines.push(line);
  }
  return { format: 'ass', lines, cues };
}

export function parseSubtitles(raw, name = '') {
  const text = normalize(raw);
  const format = detectFormat(name, text);
  let doc;
  if (format === 'ass') {
    doc = parseAss(text);
  } else {
    const { head, cues } = parseCueBlocks(text);
    doc = { format, cues, head: format === 'vtt' ? head.join('\n\n') : '' };
  }
  doc.cues.forEach(prepareCue);
  return doc;
}

/* ---------- tags and translatable text ---------- */

/**
 * Splits a cue into leading tags (kept), closing tags (rebuilt) and plain text (translated).
 * Inline tags in the middle of a line are dropped so Google sees clean sentences.
 */
export function prepareCue(c) {
  const m = LEAD_RE.exec(c.text);
  let lead = '';
  let rest = c.text;
  if (m) {
    lead = (m[0].match(TAG_G) || []).filter((t) => !t.startsWith('</')).join('');
    rest = c.text.slice(m[0].length);
  }
  const closers = [...lead.matchAll(/<([a-zA-Z][\w-]*)(?:[\s.][^>]*)?>/g)]
    .map((x) => `</${x[1]}>`)
    .reverse()
    .join('');
  const core = rest
    .replace(TAG_G, '')
    .replace(/\\h/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  c.lead = lead;
  c.closers = closers;
  c.core = core;
  // Music symbols, "...", drawings and empty lines are left untouched.
  c.skip = !/[\p{L}\p{N}]/u.test(core) || /\\p[1-9]/.test(c.text);
  c.trans = null;
  c.status = c.skip ? 'skipped' : 'idle';
  return c;
}

export function groupByCore(cues) {
  const map = new Map();
  for (const c of cues) {
    if (c.skip) continue;
    if (!map.has(c.core)) map.set(c.core, []);
    map.get(c.core).push(c);
  }
  return map;
}

export function makeBatches(lines, { maxItems = 80, maxChars = 4500, delimLen = 5 } = {}) {
  const batches = [];
  let cur = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + (cur.length ? delimLen : 0);
    if (cur.length && (cur.length >= maxItems || len + add > maxChars)) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    len += line.length + (cur.length ? delimLen : 0);
    cur.push(line);
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/* ---------- export ---------- */

export function finalText(c, opts = {}) {
  if (c.skip || !c.trans) return c.text;
  const lead = opts.keepTags === false ? '' : c.lead;
  const close = opts.keepTags === false ? '' : c.closers;
  let out = lead + c.trans.trim() + close;
  if (opts.bilingual) out += '\n' + c.core;
  return out;
}

function adaptText(text, from, to) {
  if (from === to) return text;
  let t = text;
  if (to === 'vtt') t = t.replace(/\{[^}]*\}/g, '');
  else if (from === 'ass') t = t.replace(/\{(?!\\an\d\})[^}]*\}/g, '');
  if (from === 'vtt' && to === 'srt') {
    t = t
      .replace(/<\/?(?:v|c|lang|ruby|rt)(?:[ .][^>]*)?>/gi, '')
      .replace(/<\d{1,2}:\d{2}[:.]\d{2}(?:\.\d{3})?>/g, '');
  }
  if (to === 'vtt' && from !== 'vtt') t = t.replace(/<\/?font(?:\s[^>]*)?>/gi, '');
  return t;
}

export function buildOutput(doc, fmt, opts = {}) {
  const text = (c) =>
    adaptText(finalText(c, opts), doc.format, fmt)
      .replace(/\n{2,}/g, '\n')
      .trim();

  if (fmt === 'srt') {
    return (
      doc.cues
        .map((c, i) => {
          const extra = doc.format === 'srt' && c.settings ? ` ${c.settings}` : '';
          return `${i + 1}\n${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}${extra}\n${text(c)}`;
        })
        .join('\n\n') + '\n'
    );
  }

  if (fmt === 'vtt') {
    const same = doc.format === 'vtt';
    const head = same && /^WEBVTT/.test(doc.head) ? doc.head : 'WEBVTT';
    const body = doc.cues.map((c) => {
      const id = same && c.id ? `${c.id}\n` : '';
      const extra = same && c.settings ? ` ${c.settings}` : '';
      return `${id}${formatTime(c.start, '.')} --> ${formatTime(c.end, '.')}${extra}\n${text(c)}`;
    });
    return `${head}\n\n${body.join('\n\n')}\n`;
  }

  if (fmt === 'ass' && doc.format === 'ass') {
    return doc.lines
      .map((l) => {
        if (typeof l === 'string') return l;
        const c = doc.cues[l.cue];
        return `Dialogue: ${c.pre},${text(c).replace(/\n/g, '\\N')}`;
      })
      .join('\n');
  }

  throw new Error(`Cannot export ${doc.format} as ${fmt}`);
}
