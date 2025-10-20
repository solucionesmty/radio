// server.cjs
const http = require('node:http');
const { fetch, Headers } = require('undici');
const { TextDecoder } = require('node:util');

const PORT = process.env.PORT || 10000;

// ---- Config preferente: URL completa (recomendado)
const FULL_URL = (process.env.UPSTREAM_STATUS_URL || '').trim();

// ---- Alternativa: host/port (si no hay FULL_URL)
const HOST = (process.env.UPSTREAM_HOST || '').trim();         // p.ej. "uk5freenew.listen2myradio.com"
const SPORT = (process.env.UPSTREAM_PORT || '6345').trim();    // p.ej. "6345"
const PATH = (process.env.UPSTREAM_PATH || '/7.html').trim();  // casi siempre "/7.html"

// ---- Util
const JSON = (obj, code = 200) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*'
    }
  });

function buildDirectUrl() {
  if (FULL_URL) return FULL_URL;
  if (!HOST) return null;
  const scheme = 'http'; // 7.html de SHOUTcast suele ser claro; no fuerces https en listen2myradio
  return `${scheme}://${HOST}:${SPORT}${PATH}`;
}

function buildProxyUrl(directUrl) {
  // Fallback por proxy público de solo lectura (r.jina.ai)
  // Convierte "http://host:port/7.html" => "https://r.jina.ai/http://host:port/7.html"
  if (!directUrl) return null;
  return `https://r.jina.ai/${directUrl.replace(/^https?:\/\//, 'http://')}`;
}

// Decodifica como latin1 para limpiar acentos rotos
async function readAsLatin1(res) {
  const ab = await res.arrayBuffer();
  return new TextDecoder('latin1', { fatal: false }).decode(ab);
}

// Limpia y extrae "artist - title" desde 7.html
function parse7html(raw) {
  // El 7.html suele verse como: "1,1,8,10000,1,320,Hombres G - Rita"
  // A veces incluye tags o saltos; limpiamos:
  const line = String(raw).replace(/<[^>]*>/g, '').trim();

  // Toma la última parte después de las comas: es “artist - title”
  const parts = line.split(',');
  const last = parts[parts.length - 1] ? parts[parts.length - 1].trim() : '';

  // Si todavía quedaron números al inicio, quítalos
  const cleaned = last.replace(/^(?:\d+\s*,?)*\s*/, '');

  // Separa por “ - ” (con espacios) o por “-” simple si no hay espacios
  let artist = '', title = '';
  if (cleaned.includes(' - ')) {
    const i = cleaned.indexOf(' - ');
    artist = cleaned.slice(0, i).trim();
    title = cleaned.slice(i + 3).trim();
  } else if (cleaned.includes('-')) {
    const i = cleaned.indexOf('-');
    artist = cleaned.slice(0, i).trim();
    title = cleaned.slice(i + 1).trim();
  } else {
    // Si no hay guion, asume todo como title y artista desconocido
    title = cleaned.trim();
  }

  // Normaliza espacios
  artist = artist.replace(/\s+/g, ' ');
  title = title.replace(/\s+/g, ' ');

  return { artist, title };
}

async function fetch7htmlOnce(url, signal) {
  const headers = new Headers({
    'Accept': 'text/plain, text/html;q=0.9, */*;q=0.8',
    'User-Agent': 'Mozilla/5.0 (NodeUndici) RadioOK/1.0',
    'Cache-Control': 'no-cache'
  });

  const res = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    // timeouts “blandos” (undici usa AbortSignal)
    signal
  });

  if (!res.ok) {
    throw new Error(`upstream ${res.status} ${res.statusText}`);
  }

  const text = await readAsLatin1(res);
  return text;
}

// Intenta directo y luego proxy
async function get7html() {
  const direct = buildDirectUrl();
  const proxy = buildProxyUrl(direct);

  // 1) directo
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500); // 2.5s
    const txt = await fetch7htmlOnce(direct, ctrl.signal);
    clearTimeout(t);
    return { text: txt, source: 'direct' };
  } catch (e) {
    // continúa al proxy
  }

  // 2) proxy
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000); // un poco más laxo
    const txt = await fetch7htmlOnce(proxy, ctrl.signal);
    clearTimeout(t);
    return { text: txt, source: 'proxy' };
  } catch (e) {
    throw new Error('fetch failed');
  }
}

// ---------------- HTTP server ----------------
const server = http.createServer(async (req, res) => {
  try {
    // Habilita CORS simple
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.url === '/health') {
      return respondJSON(res, { ok: true, ts: Date.now() });
    }

    if (req.url === '/env') {
      const debug = {
        upstreamSet: !!FULL_URL || !!HOST,
        valid: !!buildDirectUrl(),
        host: HOST || (FULL_URL ? new URL(FULL_URL).host : null),
        parseError: null
      };
      return respondJSON(res, debug);
    }

    if (req.url === '/diag') {
      try {
        const { text, source } = await get7html();
        return respondJSON(res, { ok: true, source, sample: String(text).slice(0, 200) });
      } catch (e) {
        return respondJSON(res, { ok: false, name: e.name, message: e.message }, 502);
      }
    }

    if (req.url === '/now') {
      try {
        const { text, source } = await get7html();
        const now = parse7html(text);
        // bitrate: muchas veces en 7.html viene en alguno de los campos previos (320),
        // pero no es confiable; si lo quieres, parsea parts[parts.length-2] si es número.
        return respondJSON(res, {
          artist: now.artist || '',
          title: now.title || '',
          bitrate: '',
          source: source === 'direct' ? '7.html' : 'proxy-7.html'
        });
      } catch (e) {
        return respondJSON(res, {
          artist: '',
          title: '',
          bitrate: '',
          source: '7.html',
          error: e.message || 'fetch failed'
        }, 502);
      }
    }

    // 404
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'server error', message: e.message }));
  }
});

function respondJSON(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(body);
}

server.listen(PORT, () => {
  console.log('radio backend listening on', PORT);
});
