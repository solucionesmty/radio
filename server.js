// server.js
import express from 'express';
import { Agent, fetch } from 'undici';
import { Readable } from 'node:stream';

const app = express();
const PORT = process.env.PORT || 10000;

// Configura tus URLs en variables de entorno en Render
const UPSTREAM_STREAM = process.env.UPSTREAM_STREAM; // ej: https://uk5freenew.listen2myradio.com/live.mp3?typeportmount=...
const UPSTREAM_STATUS = process.env.UPSTREAM_STATUS || UPSTREAM_STREAM;

// Agente keep-alive hacia el host de Listen2MyRadio
const upstreamAgent = new Agent({
  connect: { timeout: 15_000 },
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 120_000
});

// ---------- Utilidades ----------
function noStore(res) {
  res.setHeader('Cache-Control', 'no-store, no-transform, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function passHeader(res, name, value) {
  if (!value) return;
  res.setHeader(name, value);
}

function isOk(status) { return status >= 200 && status < 300; }

// ---------- “Now playing” sencillo (ya lo tienes, dejo uno minimal) ----------
app.get('/now', async (req, res) => {
  try {
    const r = await fetch(UPSTREAM_STATUS, {
      method: 'GET',
      dispatcher: upstreamAgent,
      headers: { 'User-Agent': 'HGRadio-Backend/1.0', 'Accept': '*/*' }
    });
    // Aquí parseas lo que ya tenías; devuelvo dummy si no hay nada
    res.set('content-type', 'application/json; charset=utf-8');
    noStore(res);
    return res.status(200).send(JSON.stringify({ artist: '', title: '', bitrate: '128 kbps', source: 'status' }));
  } catch (e) {
    res.set('content-type', 'application/json; charset=utf-8');
    noStore(res);
    return res.status(200).send(JSON.stringify({ artist: '', title: '', bitrate: '', source: 'error' }));
  }
});

// ---------- Wake: HEAD/GET rápido para “despertar” el upstream ----------
app.get('/wake', async (req, res) => {
  try {
    const r = await fetch(UPSTREAM_STATUS, {
      method: 'HEAD',
      dispatcher: upstreamAgent,
      headers: { 'User-Agent': 'HGRadio-Backend/1.0', 'Accept': '*/*' }
    });
    noStore(res);
    return res.status(isOk(r.status) ? 200 : 502).send('ok');
  } catch {
    noStore(res);
    return res.status(502).send('bad');
  }
});

// ---------- Proxy de stream con soporte Range ----------
app.get('/stream', async (req, res) => {
  const range = req.headers.range;
  const headers = {
    'User-Agent': 'HGRadio-Backend/1.0',
    'Accept': '*/*',
    // No pedimos ICY metadata para evitar complicaciones con navegadores
    'Icy-MetaData': '0'
  };
  if (range) headers.Range = range;

  noStore(res);

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  let r;
  try {
    r = await fetch(UPSTREAM_STREAM, {
      method: 'GET',
      dispatcher: upstreamAgent,
      headers,
      signal: controller.signal
    });
  } catch (e) {
    res.status(502).end();
    return;
  }

  // Transferimos cabeceras críticas para playback
  passHeader(res, 'Content-Type', r.headers.get('content-type') || 'audio/mpeg');
  passHeader(res, 'Accept-Ranges', r.headers.get('accept-ranges'));
  passHeader(res, 'Content-Range', r.headers.get('content-range'));
  passHeader(res, 'Content-Length', r.headers.get('content-length'));
  passHeader(res, 'Connection', 'keep-alive');
  passHeader(res, 'X-Accel-Buffering', 'no');

  res.status(r.status); // puede ser 200 o 206

  const body = r.body;
  if (!body) { res.end(); return; }

  // Pipe estable Web->Node->Cliente
  Readable.fromWeb(body).on('error', () => {
    if (!res.headersSent) res.status(502);
    res.end();
  }).pipe(res);
});

app.listen(PORT, () => {
  console.log(`radio backend listening on ${PORT}`);
});
