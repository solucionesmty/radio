// server.cjs
const http = require('http');
const https = require('https');
const dns = require('dns');

const PORT = parseInt(process.env.PORT || '10000', 10);
const UPSTREAM = process.env.UPSTREAM_STATUS_URL || ''; // p.ej. http://uk5freenew.listen2myradio.com:6345/7.html

// ---------- util red ----------
function httpGetBuffer(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
          Accept: 'text/html,*/*;q=0.8',
          Connection: 'close',
        },
        // fuerza IPv4 (algunos upstreams fallan con AAAA)
        lookup: (hostname, options, cb) => dns.lookup(hostname, { family: 4 }, cb),
      },
      (res) => {
        // redirecciones simples
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(httpGetBuffer(next, timeoutMs));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const sc = res.statusCode;
          const hs = res.headers;
          res.resume();
          return reject(Object.assign(new Error('http ' + sc), { code: 'HTTP_STATUS', statusCode: sc, headers: hs }));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );

    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchWithRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await httpGetBuffer(url);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1))); // backoff 0.5s,1s,1.5s
    }
  }
  throw lastErr;
}

// ---------- helpers texto ----------
function decodeLatin1(buf) {
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
  const s = (line || '').trim();
  if (!s) return true;
  const digits = (s.match(/[0-9,]/g) || []).length;
  return digits / s.length > 0.8;
}
function pickNowLine(text) {
  const m = text.match(/([^\n<>]{2,}?)\s-\s([^\n<>]{2,})/);
  if (m) return { raw: m[0], a: m[1].trim(), t: m[2].trim() };
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !looksLikeNoise(l));
  if (!lines.length) return null;
  const best = lines.sort((x, y) => y.length - x.length)[0];
  const parts = best.split(' - ');
  if (parts.length >= 2) return { raw: best, a: parts[0].trim(), t: parts.slice(1).join(' - ').trim() };
  return { raw: best, a: '', t: best };
}
function jsonNow(artist, title, source, extra = {}) {
  return JSON.stringify(
    Object.assign({ artist: artist || '', title: title || '', bitrate: '', source: source || '7.html' }, extra),
    null,
    0
  );
}

// ---------- cache 5s ----------
let cacheVal = null;
let cacheTs = 0;
const CACHE_MS = 5000;

const server = http.createServer(async (req, res) => {
  const cors = () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };

  if (req.method === 'OPTIONS') {
    cors();
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('ok');
  }

  if (req.url === '/diag') {
    cors();
    res.setHeader('cache-control', 'no-store');
    if (!UPSTREAM) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, why: 'Missing UPSTREAM_STATUS_URL' }));
    }
    try {
      const buf = await fetchWithRetry(UPSTREAM, 2);
      const html = decodeLatin1(buf);
      const text = stripTags(html);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, bytes: buf.length, sample: text.slice(0, 200) }));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, name: e.name, message: e.message, code: e.code || null, statusCode: e.statusCode || null }));
    }
  }

  if (req.url === '/now') {
    cors();
    res.setHeader('cache-control', 'no-store');
    if (!UPSTREAM) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(jsonNow('', '', 'misconfig', { error: 'Missing UPSTREAM_STATUS_URL' }));
    }

    // cache corto
    const now = Date.now();
    if (cacheVal && now - cacheTs < CACHE_MS) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(cacheVal);
    }

    try {
      const buf = await fetchWithRetry(UPSTREAM, 2);
      const html = decodeLatin1(buf);
      const text = stripTags(html);
      const picked = pickNowLine(text);
      let artist = '', title = '';
      if (picked) {
        artist = picked.a;
        title = picked.t;
        if (looksLikeNoise(artist) && !looksLikeNoise(title)) artist = '';
        if (!title && artist.includes(' - ')) {
          const p = artist.split(' - ');
          artist = p[0].trim();
          title = p.slice(1).join(' - ').trim();
        }
      }
      const out = jsonNow(artist, title, '7.html');
      cacheVal = out;
      cacheTs = now;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(out);
    } catch (e) {
      // LOG al panel de Render para diagnóstico
      console.error('[NOW] upstream fetch error:', e && (e.stack || e.message || e));
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(jsonNow('', '', '7.html', { error: 'fetch failed' }));
    }
  }

  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('radio-ok backend. Try /now or /diag');
});

server.listen(PORT, () => {
  console.log('radio backend listening on', PORT);
});
