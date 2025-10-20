// server.cjs
const http = require('http');
const https = require('https');
const dns = require('dns');
const { URL } = require('url');

const PORT = process.env.PORT || 10000;
const UPSTREAM = process.env.UPSTREAM_STATUS_URL || ''; // ej: http://uk5freenew.listen2myradio.com:6345/7.html
const ALLOW_ORIGIN = process.env.CORS_ORIGIN || '*';     // o tu dominio https://hombresgradio.com

// -------- util ----------
function sendJSON(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': ALLOW_ORIGIN,
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-allow-headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}
function isValidUrl(s) {
  try { new URL(s); return true; } catch { return false; }
}

// lookup v4 “seguro”
function v4Lookup(hostname, options, cb) {
  try {
    if (!hostname) return cb(new Error('INVALID_HOSTNAME'));
    // IP v4 literal
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return cb(null, hostname, 4);
    dns.lookup(hostname, { family: 4 }, (err, addr, fam) => {
      if (err) return cb(err);
      if (!addr) return cb(new Error('LOOKUP_EMPTY_ADDRESS'));
      cb(null, addr, fam || 4);
    });
  } catch (e) { cb(e); }
}

// GET binario con timeout + forzar IPv4
function httpGetBuffer(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;

    const req = lib.request(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (RadioOK/1.0)',
        'Accept': 'text/*,*/*;q=0.8',
        'Connection': 'close'
      },
      lookup: v4Lookup
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow 1 redirect
        try {
          const next = new URL(res.headers.location, url).toString();
          res.resume();
          resolve(httpGetBuffer(next, timeoutMs));
        } catch (e) { reject(e); }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP_' + res.statusCode));
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('TIMEOUT')); });
    req.end();
  });
}

// decodifica el buffer intentando latin1 (muy típico en 7.html)
function bufferToText(buf, contentType = '') {
  // si no hay charset, 7.html suele venir en ISO-8859-1
  const isLatin1 = /charset *= *(iso-8859-1|latin1)/i.test(contentType) || !/charset *=/i.test(contentType);
  try {
    return isLatin1 ? buf.toString('latin1') : buf.toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}

// parser sencillo para 7.html
// Ejemplos de línea:
//   "Hombres G - Rita"
//   "1,1,8,10000,1,320,Hombres G - Rita"
//   "Hombres G|Rita"
function parse7html(text) {
  const line = text.replace(/<[^>]*>/g, '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  // quita prefijo numérico 1,1,8,10000,1,320,
  let s = line;
  if (/^\d+(,\d+){2,},/.test(s)) {
    s = s.substring(s.lastIndexOf(',') + 1).trim();
  }
  // separadores comunes: " - " o "|"
  let artist = '', title = s;
  const m = s.match(/^([^|\-]+)[|\-](.+)$/);
  if (m) {
    artist = m[1].trim();
    title  = m[2].trim();
  }
  return { artist, title, bitrate: '' };
}

// ----------------- HTTP server -----------------
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': ALLOW_ORIGIN,
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'Content-Type',
      'cache-control': 'no-store'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, {'content-type':'text/plain; charset=utf-8'});
    return res.end('ok');
  }

  if (url.pathname === '/env') {
    const host = (() => { try { return new URL(UPSTREAM).hostname; } catch { return null; } })();
    return sendJSON(res, 200, { hasUpstream: Boolean(host), upstream: host || null });
  }

  if (url.pathname === '/diag') {
    if (!isValidUrl(UPSTREAM)) {
      return sendJSON(res, 200, { ok:false, error:'Missing/invalid UPSTREAM_STATUS_URL' });
    }
    try {
      const buf = await httpGetBuffer(UPSTREAM);
      const text = bufferToText(buf);
      return sendJSON(res, 200, { ok:true, sample: text.slice(0,200) });
    } catch (e) {
      return sendJSON(res, 200, { ok:false, name: e.name, message: e.message, code: e.code || null, statusCode: null });
    }
  }

  if (url.pathname === '/now') {
    if (!isValidUrl(UPSTREAM)) {
      return sendJSON(res, 200, { artist:'', title:'', bitrate:'', source:'misconfig', error:'Missing/invalid UPSTREAM_STATUS_URL' });
    }
    try {
      const buf = await httpGetBuffer(UPSTREAM);
      const text = bufferToText(buf);
      const parsed = parse7html(text);
      return sendJSON(res, 200, { ...parsed, source: '7.html' });
    } catch (e) {
      return sendJSON(res, 200, { artist:'', title:'', bitrate:'', source:'7.html', error: e.message || 'fetch failed' });
    }
  }

  // 404
  res.writeHead(404, {'content-type':'text/plain; charset=utf-8', 'access-control-allow-origin': ALLOW_ORIGIN});
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`radio-ok listening on ${PORT}`);
  console.log(`UPSTREAM_STATUS_URL: ${UPSTREAM || '(unset)'}`);
});
