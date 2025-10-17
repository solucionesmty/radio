// server.js
import express from 'express';
import { Agent, fetch, request } from 'undici';
import iconv from 'iconv-lite';

const app = express();

// ---------- Undici Agent (keep-alive) ----------
const agent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 60_000,
});
const undiciOpts = { dispatcher: agent };

// ---------- Utilidades ----------
const CORS = (res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
};

const clean = (s = '') =>
  String(s)
    .replace(/\s+/g, ' ')
    .replace(/\0/g, '')
    .trim();

const splitSong = (s = '') => {
  // separadores comunes: " - ", " – ", "-" (con espacios), " | "
  const seps = [' - ', ' – ', ' — ', ' | '];
  for (const sep of seps) {
    const i = s.indexOf(sep);
    if (i > 0) {
      return { artist: s.slice(0, i).trim(), title: s.slice(i + sep.length).trim() };
    }
  }
  return { artist: '', title: s.trim() };
};

// ---------- Rutas ----------

// Salud / info
app.get('/', (_req, res) => {
  CORS(res);
  res.type('text/plain').send('radio-backend ok');
});

// Canción actual (usa el endpoint público del proveedor y normaliza)
app.get('/now', async (_req, res) => {
  CORS(res);
  res.type('application/json; charset=utf-8');

  try {
    // 1) Fuente AJAX del proveedor (la que ya te funcionaba)
    // Nota: responden con HTML/JSON según momento; normalizamos siempre a texto y parseamos.
    const ajaxURL = 'https://hombresg.radio12345.com/getRecentSong.ajax.php';

    const r = await fetch(ajaxURL, {
      ...undiciOpts,
      method: 'POST',
      // simula el request de su web (algunos WAF lo prefieren)
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Compatible; RadioOK/1.0)',
        'Origin': 'https://hombresg.radio12345.com',
        'Referer': 'https://hombresg.radio12345.com/index.php',
      },
      body: new URLSearchParams({ page_level: 'desktop' }).toString(),
    });

    const ct = r.headers.get('content-type') || '';
    let raw = await r.arrayBuffer();
    let txt;

    // ellos a veces emiten ISO-8859-1; intentamos UTF-8 y si hay carácter inválido
    // caemos a cp1252 para arreglar acentos
    try {
      txt = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      txt = iconv.decode(Buffer.from(raw), 'win1252'); // latin1/cp1252 tolerante
    }

    let artist = '';
    let title = '';
    let bitrate = '';

    // 2) Cuando devuelven JSON con fragmento HTML
    if (ct.includes('application/json') || txt.trim().startsWith('{')) {
      let data;
      try { data = JSON.parse(txt); } catch { data = null; }

      if (data && typeof data.html === 'string') {
        // HTML tiene <a>título</a><label>artista</label> y <strong>hh:mm:ss</strong>
        const mTitle = data.html.match(/<a[^>]*>\s*([^<]+)\s*<\/a>/i);
        const mArtist = data.html.match(/<label[^>]*>\s*([^<]+)\s*<\/label>/i);
        title = clean(mTitle?.[1] || '');
        artist = clean(mArtist?.[1] || '');
      }
    }

    // 3) Fallback: intenta “título - artista” si vino como texto plano
    if (!title && !artist) {
      const line = clean(txt);
      const { artist: a, title: t } = splitSong(line);
      artist = a; title = t;
    }

    // 4) Como último recurso, deja texto completo en title
    if (!title && !artist) {
      title = clean(txt);
    }

    // Puedes fijar bitrate estático si tu salida siempre es 128 kbps
    // o dejarlo vacío
    bitrate = '128 kbps';

    return res.json({
      artist, title, bitrate, source: 'r7.html',
    });
  } catch (err) {
    return res.status(502).json({
      artist: '', title: '', bitrate: '', error: 'now-failed', detail: String(err?.message || err),
    });
  }
});

// Proxy del stream para esquivar CORS/SSL y entregar audio/mpeg
app.get('/stream', async (req, res) => {
  CORS(res);

  // Tu URL del proveedor (no se expone en el HTML del cliente):
  const upstream = 'https://uk5freenew.listen2myradio.com/live.mp3?typeportmount=s1_6345_stream_898887520';

  try {
    // Pasar Range si el navegador lo envía (seek, prebuffer)
    const range = req.headers.range;

    const { body, statusCode, headers } = await request(upstream, {
      ...undiciOpts,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Compatible; RadioOK/1.0)',
        'Icy-MetaData': '1',
        ...(range ? { Range: range } : {}),
      },
      // El stream es chunked/long-lived:
      bodyTimeout: 0,
      headersTimeout: 0,
      maxRedirections: 2,
    });

    // Cabeceras hacia el cliente
    res.status(statusCode === 206 ? 206 : 200);
    res.set({
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-store, no-transform, must-revalidate, max-age=0',
      'Connection': 'keep-alive',
      'Accept-Ranges': 'bytes',
      // Si el origen devolvió Content-Range y pedimos Range, propágalo
      ...(headers['content-range'] ? { 'Content-Range': headers['content-range'] } : {}),
      ...(headers['content-length'] ? { 'Content-Length': headers['content-length'] } : {}),
      // Opcional: exponer cabeceras
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
    });

    // Pipe sin cierre prematuro
    body.on('error', (e) => {
      try { res.destroy(e); } catch (_) {}
    });
    req.on('close', () => {
      try { body.destroy(); } catch (_) {}
    });

    body.pipe(res);
  } catch (err) {
    res.status(502).json({ error: 'stream-failed', detail: String(err?.message || err) });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  // Render necesita que escuches en process.env.PORT
  console.log(`radio backend listening on ${PORT}`);
});
