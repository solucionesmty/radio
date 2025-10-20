// server.cjs
const http = require('http');
const https = require('https');
const dns = require('dns');

const PORT = parseInt(process.env.PORT || '10000', 10);
const UPSTREAM = process.env.UPSTREAM_STATUS_URL || ''; // p.ej. http://uk5freenew.listen2myradio.com:6345/7.html

function httpGetBuffer(url, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        Accept: 'text/html,*/*;q=0.8',
        Connection: 'close',
      },
      // Fuerza IPv4 (algunos proveedores fallan con AAAA)
      lookup: (hostname, options, cb) => dns.lookup(hostname, { family: 4 }, cb),
    }, (res) => {
      // Sigue redirecciones simples
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        return resolve(httpGetBuffer(next, timeoutMs));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('http ' + res.statusCode));
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// ---- helpers de texto / parsing ----
function decodeLatin1(buf) {
  // Node soporta TextDecoder('latin1')
  const dec = new TextDecoder('latin1');
  return dec.decode(buf);
}

function stripTags(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '')
    .trim();
}

function looksLikeNoise(line) {
  // líneas como "1,1,8,10000,1,320" o vacías
  const s = line.trim();
  if (!s) return true;
  // >= 80% dígitos/comas
  const digits = (s.match(/[0-9,]/g) || []).length;
  return digits / s.length > 0.8;
}

function pickNowLine(text) {
  // Busca primero un "ARTISTA - TÍTULO"
  const m = text.match(/([^\n<>]{2,}?)\s-\s([^\n<>]{2,})/);
  if (m) return { raw: m[0], a: m[1].trim(), t: m[2].trim() };

  // Si no, parte por líneas y elige la más "legible" que no sea ruido
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !looksLikeNoise(l));

  if (!lines.length) return null;

  // La más larga suele ser el "now playing"
  const best = lines.sort((x, y) => y.length - x.length)[0];

  // Intenta dividir por ' - '
  const parts = best.split(' - ');
  if (parts.length >= 2) {
    return { raw: best, a: parts[0].trim(), t: parts.slice(1).join(' - ').trim() };
  }
  // fallback: sin separador claro -> todo como título
  return { raw: best, a: '', t: best };
}

function makeJSON(artist, title, source) {
  return JSON.stringify(
    { artist: artist || '', title: title || '', bitrate: '', source: source || '7.html' },
    null,
    0
  );
}

const server = http.createServer(async (req, res) => {
  // CORS y cache
  const setCORS = () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };

  if (req.method === 'OPTIONS') {
    setCORS();
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('ok');
  }

  if (req.url === '/now') {
    setCORS();
    res.setHeader('cache-control', 'no-store');
    if (!UPSTREAM) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ artist: '', title: '', bitrate: '', source: 'misconfig', error: 'Missing UPSTREAM_STATUS_URL' }));
    }
    try {
      const buf = await httpGetBuffer(UPSTREAM, 6000);
      const html = decodeLatin1(buf);
      const text = stripTags(html);
      const picked = pickNowLine(text);

      let artist = '', title = '';
      if (picked) {
        artist = picked.a;
        title  = picked.t;

        // sanea casos raros: si artist parece números/comas, elimínalo
        if (looksLikeNoise(artist) && !looksLikeNoise(title)) {
          artist = '';
        }

        // si título viene vacío y raw tenía ' - ', intercambia
        if (!title && artist.includes(' - ')) {
          const p = artist.split(' - ');
          artist = p[0].trim(); title = p.slice(1).join(' - ').trim();
        }
      }

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(makeJSON(artist, title, '7.html'));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ artist: '', title: '', bitrate: '', source: '7.html', error: 'fetch failed' }));
    }
  }

  // raíz
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('radio-ok backend. Try /now');
});

server.listen(PORT, () => {
  console.log('radio backend listening on', PORT);
});
