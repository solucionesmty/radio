import express from 'express';
import { Agent } from 'undici';
import { Readable } from 'node:stream';

// ---------- Config por variables de entorno ----------
const PORT = process.env.PORT || 10000;

// URL HTTPS del stream real (la de listen2myradio que funciona en navegador)
// EJEMPLO: https://uk5freenew.listen2myradio.com/live.mp3?typeportmount=s1_6345_stream_898887520
const UPSTREAM_STREAM = process.env.UPSTREAM_STREAM;

// Lista de endpoints de estado (coma separada). Ideal 7.html o 7?sid=1
// EJEMPLO: http://uk5freenew.listen2myradio.com:6345/7.html,http://uk5freenew.listen2myradio.com:6345/7?sid=1
const STATUS_URLS = (process.env.STATUS_URLS || '').split(',').map(s => s.trim()).filter(Boolean);

// CORS: deja vacío para *, o pon https://hombresgradio.com
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// Timeout de fetch al upstream (ms)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 12000);

// Undici Agent (mejor manejo de conexiones)
const agent = new Agent({ connect: { timeout: TIMEOUT_MS } });

// ---------- Utilidades ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Accept, Content-Type');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { dispatcher: agent, signal: ctrl.signal, ...opts });
    return r;
  } finally {
    clearTimeout(to);
  }
}

// convierte un ArrayBuffer que viene en ISO-8859-1 a UTF-8 legible
function latin1ToString(buf) {
  try {
    return new TextDecoder('latin1').decode(buf);
  } catch {
    return Buffer.from(buf).toString('latin1');
  }
}

function clean(s) {
  return (s || '')
    .replace(/\r/g, '')
    .replace(/\u0000/g, '')
    .trim();
}

function splitArtistTitle(line) {
  // formatos comunes: "Artista - Título" / "Artista – Título"
  const m = line.split(/\s[-–]\s/);
  if (m.length >= 2) return { artist: m[0].trim(), title: m.slice(1).join(' - ').trim() };
  return { artist: '', title: clean(line) };
}

// ---------- App ----------
const app = express();

// health check para Render
app.get('/health', (_req, res) => {
  cors(res);
  res.status(200).type('text/plain').send('ok');
});

// Devuelve canción actual, bitrate (si se puede) y fuente usada
app.get('/now', async (_req, res) => {
  cors(res);

  // Intento: leer 7.html / 7?sid=1 y parsear la línea del tema actual
  for (const url of STATUS_URLS) {
    try {
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': 'RadioOK/1.0' } });
      if (!r.ok) continue;

      const ab = await r.arrayBuffer();
      const txt = latin1ToString(ab);

      // Shoutcast 1.x suele incluir líneas tipo:
      // "Current Song: Hombre real - Hombres G" o una tabla con "Current Song"
      let line =
        (txt.match(/Current Song:\s*([^\n<]+)/i) || [])[1] ||
        (txt.match(/Stream Title:\s*([^\n<]+)/i) || [])[1] ||
        '';

      if (!line) {
        // otro formato: lista con artista <label> y titulo dentro de <a>
        const a = (txt.match(/<div class=["']list_title["'][^>]*>\s*<a[^>]*>([^<]+)<\/a>[\s\S]*?<label[^>]*>([^<]+)<\/label>/i) || []);
        if (a.length >= 3) line = `${a[2]} - ${a[1]}`;
      }

      line = clean(line);
      if (line) {
        const { artist, title } = splitArtistTitle(line);
        return res.json({
          artist, title,
          bitrate: '',
          source: url.split('?')[0].split('/').pop() // 7.html o 7
        });
      }
    } catch {
      // siguiente candidato
    }
  }

  // Fallback si nada funcionó: devuelve vacío
  res.json({ artist: '', title: '', bitrate: '', source: 'none' });
});

// Proxy del stream MP3 con soporte Range (para que el <audio> funcione bien)
app.get('/stream', async (req, res) => {
  cors(res);

  if (!UPSTREAM_STREAM) {
    return res.status(500).json({ error: 'missing UPSTREAM_STREAM' });
  }

  try {
    const headers = {
      'User-Agent': 'RadioOK/1.0',
      // si el navegador pide Range, lo pasamos al upstream
      ...(req.headers.range ? { Range: req.headers.range } : {})
    };

    const r = await fetchWithTimeout(UPSTREAM_STREAM, {
      headers,
      // no seguimos redirects con streaming por seguridad
      redirect: 'follow'
    });

    // Copia los headers importantes hacia el cliente
    const ct = r.headers.get('content-type') || 'audio/mpeg';
    const
