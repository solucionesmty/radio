// server.js
// Backend mínimo para /now (metadatos) y /stream (proxy MP3) con CORS y healthcheck.
// Node 22 + ESM. Dep: undici.

import http from 'node:http';
import { request } from 'undici';

// ------------------------
// Config vía variables de entorno
// ------------------------
const PORT = Number(process.env.PORT || 10000);

// MP3 SSL del proveedor (el que funciona en tu web):
// p.ej: https://uk5freenew.listen2myradio.com/live.mp3?typeportmount=s1_6345_stream_898887520
const UPSTREAM_STREAM = process.env.UPSTREAM_STREAM || '';

/**
 * Lista de endpoints de estado (coma separados). Se prueban en orden:
 *  - 7.html          -> Shoutcast 1.x
 *  - 7?sid=1         -> cuando hay múltiples mounts
 *  - status-json.xsl -> Shoutcast 2 (si lo tienes)
 *  - index.html      -> fallback HTML para intentar extraer "Current Song"
 */
const STATUS_URLS = (process.env.STATUS_URLS || '').split(',').map(s => s.trim()).filter(Boolean);

// CORS
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// UA para endpoints “quisquillosos”
const UA = 'Mozilla/5.0 (compatible; RadioOK/1.0; +https://radio-ok.onrender.com)';

// ------------------------
// Utilidades
// ------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  cors(res);
  res.end(body);
}

function splitArtistTitle(song) {
  // Formatos comunes: "Artista - Título", "Artista – Título", "Artista: Título"
  const sep = [' - ', ' – ', ' — ', ' — ', ' —', ' –', ' – ', ' — ', ' : ', ': '];
  for (const s of sep) {
    const i = song.indexOf(s);
    if (i > 0) {
      return {
        artist: song.slice(0, i).trim(),
        title: song.slice(i + s.length).trim()
      };
    }
  }
  return { artist: '', title: song.trim() };
}

// 7.html de Shoutcast: devuelve una única línea con campos separados por coma.
// Campo 6/7 suele ser la canción.
function parse7Html(text) {
  const line = String(text).trim();
  const parts = line.split(',').map(s => s.trim());
  // formatos típicos:
  // v1: listeners,peak,max,reported,bitrate,song
  // v2: listeners,peak,max,reported,bitrate,?,song
  const song = parts[6] || parts[5] || '';
  const { artist, title } = splitArtistTitle(song);
  const br = (parts[4] && /^\d+$/.test(parts[4])) ? `${parts[4]} kbps` : '';
  return { artist, title, bitrate: br, source: '7.html' };
}

// status-json.xsl de Shoutcast 2.*
function parseStatusJsonXsl(obj) {
  try {
    const s = obj?.streamstatus;
    if (s === 1 || s === '1' || s === 'active') {
      const song = obj?.songtitle || obj?.song || '';
      const br = obj?.bitrate ? `${obj.bitrate} kbps` : '';
      const { artist, title } = splitArtistTitle(song);
      return { artist, title, bitrate: br, source: 'status-json.xsl' };
    }
  } catch {}
  return null;
}

// Fallback muy básico para index.html de Shoutcast 1.9.x
function parseIndexHtml(text) {
  const html = String(text);
  // Busca "Current Song" (inglés) o "Current Stream Information" y la línea de Song
  const m = html.match(/Current\s+Song<\/td>\s*<td[^>]*>(.*?)<\/td>/i);
  const raw = m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
  if (!raw) return null;
  const { artist, title } = splitArtistTitle(raw);
  return { artist, title, bitrate: '', source: 'index.html' };
}

// Intenta cada STATUS_URL en orden hasta obtener datos válidos
async function fetchNow() {
  for (const url of STATUS_URLS) {
    try {
      const r = await request(url, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept': '*/*' }
      });

      // content-type nos orienta
      const ct = String(r.headers['content-type'] || '').toLowerCase();
      const buf = await r.body.arrayBuffer();
      const text = Buffer.from(buf).toString('utf8'); // suele venir en utf-8; si no, el proveedor ya lo sirve así

      // status-json.xsl -> JSON
      if (ct.includes('json') || url.includes('status-json')) {
        const obj = JSON.parse(text);
        // 2 variantes: plano o con "data" dentro
        const hit =
          parseStatusJsonXsl(obj) ||
          parseStatusJsonXsl(obj?.data);
        if (hit && (hit.artist || hit.title)) return hit;
      }

      // 7.html -> texto plano con comas
      if (url.endsWith('/7.html') || url.includes('7?sid=')) {
        const hit = parse7Html(text);
        if (hit && (hit.artist || hit.title)) return hit;
      }

      // index.html -> HTML clásico
      if (url.endsWith('/index.html')) {
        const hit = parseIndexHtml(text);
        if (hit && (hit.artist || hit.title)) return hit;
      }
    } catch (e) {
      // continúa con el siguiente candidato
    }
  }
  return { artist: '', title: '', bitrate: '', source: 'none' };
}

// ------------------------
// Servidor HTTP
// ------------------------
const server = http.createServer(async (req, res) => {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      cors(res);
      res.statusCode = 204;
      return res.end();
    }

    if (req.url === '/health') {
      cors(res);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('ok');
    }

    if (req.url === '/now') {
      const data = await fetchNow();
      return json(res, data);
    }

    if (req.url === '/stream') {
      if (!UPSTREAM_STREAM) {
        return json(res, { error: 'stream-not-configured' }, 500);
      }

      // Proxifica el MP3
      const upstream = await request(UPSTREAM_STREAM, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          // Evita compresión accidental y headers conflictivos
          'Accept': '*/*',
          'Icy-MetaData': '0'
        },
        // importa: no sigas redirecciones infinitas si el proveedor cae
        maxRedirections: 2
      });

      // Encabezados para el navegador
      res.statusCode = 200;
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      // Para que “descargue” si el usuario abre /stream directamente:
      res.setHeader('Content-Disposition', 'inline; filename="live.mp3"');
      cors(res);

      // Pipe bruto de bytes
      upstream.body.on('error', () => {
        try { res.destroy(); } catch {}
      });
      res.on('close', () => {
        try { upstream.body.destroy(); } catch {}
      });

      return upstream.body.pipe(res);
    }

    // 404
    cors(res);
