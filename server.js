import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translate } from '@vitalets/google-translate-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Minimum gap between calls to Google. Raise it if you hit rate limits.
const MIN_GAP_MS = Number(process.env.MIN_GAP_MS) || 300;

const DELIM = '\n|||\n';
const MAX_ITEMS = 120;
const MAX_JOINED_CHARS = 5000; // Google's per-request text limit is about 5,000 characters
const CACHE_MAX = 20000;

const LANG_RE = /^(auto|[a-z]{2,3}(-[A-Za-z]{2,4})?)$/;
const ALIASES = { he: 'iw', jv: 'jw', zh: 'zh-CN', fil: 'tl' };
const normLang = (code) => ALIASES[code.toLowerCase()] ?? code;

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRateLimit = (err) =>
  err?.name === 'TooManyRequestsError' ||
  err?.code === 429 ||
  /too many requests/i.test(err?.message ?? '');

const isBadLanguage = (err) => /not supported/i.test(err?.message ?? '');

// One shared queue so concurrent visitors don't hammer Google.
let lastCall = 0;
let queue = Promise.resolve();
function throttled(fn) {
  const task = queue.then(async () => {
    const wait = Math.max(0, lastCall + MIN_GAP_MS - Date.now());
    if (wait) await sleep(wait);
    try {
      return await fn();
    } finally {
      lastCall = Date.now();
    }
  });
  queue = task.catch(() => {});
  return task;
}

async function callGoogle(text, from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await throttled(() => translate(text, { from, to }));
    } catch (err) {
      // Rate limits and bad language codes are reported to the client straight away.
      if (isRateLimit(err) || isBadLanguage(err) || attempt >= 2) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
}

const cache = new Map();
const cacheKey = (from, to, text) => `${from}\u0000${to}\u0000${text}`;
function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

/**
 * Translates many subtitle lines in as few Google requests as possible.
 * Lines are joined with a delimiter, translated together, then split again.
 * If Google changes the delimiter and the count no longer matches,
 * the lines in that batch are translated one by one instead.
 */
async function translateBatch(texts, from, to) {
  const out = new Array(texts.length).fill(null);
  const pending = [];
  let detected = null;
  let usedFallback = false;

  texts.forEach((text, i) => {
    if (!text.trim()) {
      out[i] = text;
      return;
    }
    const hit = cache.get(cacheKey(from, to, text));
    if (hit !== undefined) out[i] = hit;
    else pending.push(i);
  });

  if (pending.length) {
    const joined = pending.map((i) => texts[i]).join(DELIM);
    const res = await callGoogle(joined, from, to);
    detected = res.from?.language?.iso ?? res.raw?.src ?? null;
    const parts = res.text.split(/\s*\|\s*\|\s*\|\s*/).map((p) => p.trim());

    if (parts.length === pending.length) {
      pending.forEach((i, k) => {
        out[i] = parts[k];
        cacheSet(cacheKey(from, to, texts[i]), parts[k]);
      });
    } else {
      usedFallback = true;
      for (const i of pending) {
        try {
          const single = await callGoogle(texts[i], from, to);
          out[i] = single.text.trim();
          cacheSet(cacheKey(from, to, texts[i]), out[i]);
          detected ??= single.from?.language?.iso ?? null;
        } catch (err) {
          if (isRateLimit(err) || isBadLanguage(err)) throw err;
          out[i] = null; // reported to the client as a failed line
        }
      }
    }
  }

  return { translations: out, detected, fallback: usedFallback };
}

/* ---------- routes ---------- */

app.get('/api/health', (_req, res) => res.json({ ok: true, cached: cache.size }));

app.post('/api/translate', async (req, res) => {
  const { texts, from = 'auto', to } = req.body ?? {};

  if (!Array.isArray(texts) || texts.length === 0 || !texts.every((t) => typeof t === 'string')) {
    return res.status(400).json({ error: 'texts must be a non-empty array of strings.' });
  }
  if (texts.length > MAX_ITEMS) {
    return res.status(400).json({ error: `Send at most ${MAX_ITEMS} lines per request.` });
  }
  if (typeof from !== 'string' || typeof to !== 'string' || !LANG_RE.test(from) || !LANG_RE.test(to) || to === 'auto') {
    return res.status(400).json({ error: 'Invalid language code.' });
  }
  const joinedLength = texts.reduce((n, t) => n + t.length, 0) + DELIM.length * (texts.length - 1);
  if (joinedLength > MAX_JOINED_CHARS) {
    return res.status(400).json({ error: `Request is too long (limit ${MAX_JOINED_CHARS} characters).` });
  }

  try {
    res.json(await translateBatch(texts, normLang(from), normLang(to)));
  } catch (err) {
    if (isRateLimit(err)) {
      return res
        .status(429)
        .json({ error: 'Google Translate is rate limiting this server. Wait a minute and try again.' });
    }
    if (isBadLanguage(err)) return res.status(400).json({ error: err.message });
    console.error('Translate failed:', err);
    res.status(502).json({ error: `Google Translate request failed. ${err?.message ?? ''}`.trim() });
  }
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status === 413 ? 'Request body is too large.' : 'Server error.' });
});

app.listen(PORT, () => {
  console.log(`Subtitle Translator running at http://localhost:${PORT}`);
});
