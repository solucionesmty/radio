// server.cjs
/* eslint-disable no-console */
const http = require('http');

const PORT = process.env.PORT || 10000;
const UPSTREAM = process.env.UPSTREAM_STATUS_URL || ''; // ej: http://uk5freenew.listen2myradio.com:6345/7.html
const ALLOW_ORIGIN = process.env.CORS_ORIGIN || '*';     // o https://hombresgradio.com

// ---------- util ----------
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
function bufferToText(buf, contentType = '') {
  // 7.html suele venir en latin1 (iso-8859-1). Si no hay charset, asumimos latin1.
  const isLatin1 = /charset *= *(iso-8859-1|latin1)/i.test(contentType) || !/charset *=/i.test(contentType);
  try {
    return isLatin1 ? buf.toString('latin1') : buf.toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}
// limpia prefijo tipo "1,1,8,10000,1,320," → deja solo "Artista - Título"
function stripNumericPrefix(s) {
  return /^\d+(,\d+){2,},/.test(s) ? s.substring(s.lastIndexOf(',') + 1).trim() : s;
}
// parsea primera línea en formato "Artista - Título" o "Artista|Título"
function parse7html(text) {
  const line = text.replace(/<[^>]*>/g, '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  const cleaned = stripNumericPrefix(line);
  let artist = '', title = cleaned;
  const m = cleaned.match(/^([^|\-]+)[|\-](.+)$/);
  if (m) {
    artist = m[1].trim();
    title  = m[2].trim();
  }
  return { artist, title, bitrate: '' };
}

// ---------- server ----------
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
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }

  if (url.pathname === '/env') {
    let host = null, valid = false, parseError = null;
    try { valid = isValidUrl(UPSTREAM); if (valid) host = new URL(UPSTREAM).hostname; }
    catch (e) { parseError = e.message; }
    return sendJSON(res, 200, { upstreamSet: !!UPSTREAM, valid, host, parseError });
  }

  if (url.pathname === '/diag') {
    if (!isValidUrl(UPSTREAM)) {
      return sendJSON(res, 200, { ok:false, error:'Missing/invalid UPSTREAM_STATUS_URL' });
    }
    try {
      const r = await fetch(UPSTREAM, { redirect: 'follow' }); // fetch nativo Node 20/22
      if (!r.ok) throw new Error('HTTP_' + r.status);
      const ct = r.headers.get('content-type') || '';
      const ab = await r.arrayBuffer();
      const txt = bufferToText(Buffer.from(ab), ct);
      return sendJSON(res, 200, { ok:true, sample: txt.slice(0, 200), contentType: ct });
    } catch (e) {
      return sendJSON(res, 200, { ok:false, name: e.name, message: e.message });
    }
  }

  if (url.pathname === '/now') {
    if (!isValidUrl(UPSTREAM)) {
      return sendJSON(res, 200, { artist:'', title:'', bitrate:'', source:'misconfig', error:'Missing/invalid UPSTREAM_STATUS_URL' });
    }
    try {
      const r = await fetch(UPSTREAM, { redirect: 'follow' });
      if (!r.ok) throw new Error('HTTP_' + r.status);
      const ct = r.headers.get('content-type') || '';
      const ab = await r.arrayBuffer();
      const txt = bufferToText(Buffer.from(ab), ct);
      const parsed = parse7html(txt);
      return sendJSON(res, 200, { ...parsed, source: '7.html' });
    } catch (e) {
      return sendJSON(res, 200, { artist:'', title:'', bitrate:'', source:'7.html', error: e.message || 'fetch failed' });
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': ALLOW_ORIGIN });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`radio-ok listening on ${PORT}`);
  console.log(`UPSTREAM_STATUS_URL: ${UPSTREAM || '(unset)'}`);
});
