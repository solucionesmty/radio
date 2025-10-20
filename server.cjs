// server.cjs
const http = require('http');

// ===== Helpers =====
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJSON(res, obj, status = 200) {
  setCORS(res);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  // dec: &#225;
  str = str.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  // hex: &#xE1;
  str = str.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  // nombradas básicas
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  str = str.replace(/&([a-zA-Z]+);/g, (_, n) => (map[n] ?? `&${n};`));
  return str;
}

function normalizeFancyChars(str) {
  if (!str) return '';
  return str
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

function splitArtistTitle(raw) {
  const s = normalizeFancyChars(raw);
  // separadores habituales " - " / " – " / " — "
  const parts = s.split(/\s[-–—]\s/);
  if (parts.length >= 2) {
    return { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
  }
  // fallback por coma: "Título, Artista"
  const p2 = s.split(/\s*,\s*/);
  if (p2.length >= 2) {
    return { artist: p2[p2.length - 1].trim(), title: p2.slice(0, -1).join(', ').trim() };
  }
  return { artist: '', title: s };
}

// ===== 7.html parser (latin-1) =====
async function fetchFromSevenHtml(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('seven.html status ' + res.status);

  // leer como latin-1
  const buf = await res.arrayBuffer();
  let txt = new TextDecoder('latin1').decode(buf);

  // si trae <body>…</body>, nos quedamos con el contenido
  const body = (txt.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? txt)
    .replace(/<[^>]+>/g, '')
    .trim();

  // Formato Shoutcast v1 7.html:
  // listeners,streamstatus,peak,max,reported,bitrate,songtitle
  // OJO: songtitle puede contener comas => tomamos de índice 6 en adelante
  const fields = body.split(',');
  if (fields.length < 7) {
    return { artist: '', title: '', bitrate: '', source: '7.html-raw', raw: body };
  }

  const bitrate = fields[5]?.trim() || '';
  const songRaw = fields.slice(6).join(',').trim(); // preserva comas en título
  const decoded = normalizeFancyChars(decodeHtmlEntities(songRaw));
  const { artist, title } = splitArtistTitle(decoded);

  return {
    artist,
    title,
    bitrate: bitrate ? `${bitrate} kbps` : '',
    source: '7.html'
  };
}

// ===== HTTP server =====
const PORT = process.env.PORT || 10000;
const STATUS_URL = process.env.UPSTREAM_STATUS_URL; // p.ej. http://uk5freenew.listen2myradio.com:6345/7.html

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      setCORS(res);
      res.statusCode = 204;
      return res.end();
    }

    if (req.url === '/health') {
      return sendJSON(res, { ok: true });
    }

    if (req.url === '/now') {
      if (!STATUS_URL) {
        return sendJSON(res, { artist: '', title: '', bitrate: '', source: 'misconfig', error: 'Missing UPSTREAM_STATUS_URL' }, 500);
      }
      try {
        const data = await fetchFromSevenHtml(STATUS_URL);
        return sendJSON(res, data);
      } catch (e) {
        return sendJSON(res, { artist: '', title: '', bitrate: '', source: '7.html', error: String(e.message || e) }, 502);
      }
    }

    // 404 por defecto
    setCORS(res);
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    return sendJSON(res, { error: String(err && err.message || err) }, 500);
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log('radio backend listening on', PORT);
});
