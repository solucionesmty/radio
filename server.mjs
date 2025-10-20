// server.mjs — ESM (type:module). Node 18+
// Rutas: /health, /now, /stream

import http from 'node:http';
import https from 'node:https';
import express from 'express';
import { Readable } from 'node:stream';

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const STATUS_URL = process.env.UPSTREAM_STATUS_URL || '';
const STREAM_URL = process.env.STREAM_URL || '';
const FALLBACK_TITLE = process.env.FALLBACK_TITLE || '';
const ALLOW_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ---------- CORS (lista blanca) ----------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOW_ORIGINS.length === 0) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOW_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- Utils ----------
function splitSong(str = '') {
  const s = String(str).trim();
  if (!s) return { artist: '', title: '' };
  const seps = [' - ', ' – ', ' — ', ' | ', ' ~ '];
  for (const sep of seps) {
    const i = s.indexOf(sep);
    if (i > -1) return { artist: s.slice(0, i).trim(), title: s.slice(i + sep.length).trim() };
  }
  const j = s.indexOf(',');
  if (j > -1) return { artist: s.slice(0, j).trim(), title: s.slice(j + 1).trim() };
  return { artist: '', title: s };
}

function parseNowText(txt) {
  // 1) JSON directo
  try {
    const j = JSON.parse(txt);
    const a = (j.artist || '').toString();
    const t = (j.title || '').toString();
    const br = (j.bitrate || j.bitrate_kbps || '').toString();
    if (a || t) return { artist: a, title: t, bitrate: br, source: 'json' };
  } catch {}

  // 2) Shoutcast 7.html u otros HTML/CSV simples
  const cleaned = txt.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const bySep = splitSong(cleaned);
  if (bySep.title || bySep.artist) return { ...bySep, bitrate: '', source: '7.html' };

  // 3) Nada útil
  return { artist: '', title: '', bitrate: '', source: 'unknown' };
}

async function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        ...(opts.headers || {}),
      },
    });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// ---------- Rutas ----------
app.get('/health', (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true }));
});

app.get('/now', async (_req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!STATUS_URL) {
    return res.end(JSON.stringify({
      artist: '',
      title: '',
      bitrate: '',
      source: 'misconfig',
      error: 'Missing UPSTREAM_STATUS_URL',
    }));
  }

  try {
    const r = await fetchWithTimeout(STATUS_URL, {}, 6000);
    const text = await r.text();

    const parsed = parseNowText(text);
    if (!parsed.title && FALLBACK_TITLE) parsed.title = FALLBACK_TITLE;

    return res.end(JSON.stringify(parsed));
  } catch (err) {
    return res.end(JSON.stringify({
      artist: '',
      title: FALLBACK_TITLE || '',
      bitrate: '',
      source: 'error',
      error: String(err?.message || err),
    }));
  }
});

app.get('/stream', async (req, res) => {
  if (!STREAM_URL) {
    res.status(500).setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Missing STREAM_URL' }));
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');

  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const upstream = await fetchWithTimeout(STREAM_URL, { headers }, 15000);

    res.status(upstream.status);
    const ct = upstream.headers.get('content-type');
    if (ct) res.setHeader('Content-Type', ct);
    const acceptRanges = upstream.headers.get('accept-ranges');
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    // Pipe: Web ReadableStream -> Node response
    const body = upstream.body;
    if (!body) return res.end();

    // Node 18+ util: convertir WebStream a Node Readable
    const nodeReadable = Readable.fromWeb(body);
    nodeReadable.on('error', () => res.end());
    nodeReadable.pipe(res);
  } catch (err) {
    res.status(502).setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'upstream', detail: String(err?.message || err) }));
  }
});

// ---------- Arranque ----------
http.globalAgent.keepAlive = true;
https.globalAgent.keepAlive = true;

app.listen(PORT, () => {
  console.log(`radio backend listening on ${PORT}`);
});
