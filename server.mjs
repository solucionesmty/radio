
import { createServer } from 'node:http';
import { request } from 'undici';
import { URL } from 'node:url';

const PORT  = process.env.PORT || 10000;
const UPSTREAM_STATUS_URL = process.env.UPSTREAM_STATUS_URL;
const STREAM_URL = process.env.STREAM_URL;

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function okJSON(res, obj) {
  setCORS(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(200);
  res.end(JSON.stringify(obj));
}
function errJSON(res, code, message, extra = {}) {
  setCORS(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(code);
  res.end(JSON.stringify({ ok:false, error: message, ...extra }));
}
function latin1ToUtf8(uint8) {
  const dec = new TextDecoder('latin1');
  return dec.decode(uint8);
}
function parse7html(text) {
  const line = String(text).trim().replace(/^\ufeff/, '');
  const sepIndex = line.indexOf(' - ');
  if (sepIndex === -1) return { artist:'', title:'' };
  const left  = line.slice(0, sepIndex).trim();
  const right = line.slice(sepIndex + 3).trim();
  const lastComma = left.lastIndexOf(',');
  const artist = (lastComma >= 0 ? left.slice(lastComma + 1) : left).trim();
  const fix = (s) => s.replace(/\s+/g,' ').replace(/�/g,'ñ').replace(/\\uFFFD/g,'');
  return { artist: fix(artist), title: fix(right) };
}
async function fetchNow() {
  if (!UPSTREAM_STATUS_URL) return { artist:'', title:'', bitrate:'', source:'misconfig', error:'Missing UPSTREAM_STATUS_URL' };
  try {
    const r = await request(UPSTREAM_STATUS_URL, { method:'GET', headers:{ 'Accept':'text/html, text/plain, */*' }, maxRedirections:3 });
    if (r.statusCode !== 200) return { artist:'', title:'', bitrate:'', source:'7.html', error:`upstream ${r.statusCode}` };
    const buf = new Uint8Array(await r.body.arrayBuffer());
    const textLatin = latin1ToUtf8(buf);
    const { artist, title } = parse7html(textLatin);
    let bitrate = '';
    const csv = textLatin.split(',');
    if (csv.length >= 7) {
      const maybe = csv[csv.length - 2]?.trim();
      if (/^\\d+$/.test(maybe)) bitrate = `${maybe} kbps`;
    }
    return { artist, title, bitrate, source:'7.html' };
  } catch {
    return { artist:'', title:'', bitrate:'', source:'7.html', error:'fetch failed' };
  }
}
async function proxyStream(req, res) {
  if (!STREAM_URL) { errJSON(res, 500, 'Missing STREAM_URL'); return; }
  try {
    const upstream = await request(STREAM_URL, { method:'GET', headers:{ 'Icy-MetaData':'0', 'Accept':'audio/mpeg, */*' }, maxRedirections:3 });
    if (upstream.statusCode !== 200) { errJSON(res, 502, `Upstream status ${upstream.statusCode}`); return; }
    setCORS(res);
    res.writeHead(200, { 'Content-Type':'audio/mpeg', 'Cache-Control':'no-store', 'Accept-Ranges':'bytes', 'Connection':'keep-alive' });
    upstream.body.on('error', () => { try { res.destroy(); } catch {} });
    upstream.body.pipe(res);
  } catch (e) {
    errJSON(res, 502, 'proxy failed', { detail: e?.message });
  }
}
const server = createServer(async (req, res) => {
  const { method, url } = req;
  if (method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }
  if (url === '/' || url.startsWith('/health')) { okJSON(res, { ok:true }); return; }
  if (url.startsWith('/env')) {
    okJSON(res, { upstreamSet: Boolean(UPSTREAM_STATUS_URL), valid: Boolean(STREAM_URL), host: (new URL(UPSTREAM_STATUS_URL || 'http://x.invalid')).hostname, parseError: null });
    return;
  }
  if (url.startsWith('/diag')) {
    try {
      const test = await request(UPSTREAM_STATUS_URL, { method:'GET', maxRedirections:3 });
      okJSON(res, { ok:true, status: test.statusCode });
    } catch (e) { okJSON(res, { ok:false, name:e?.name, message:e?.message || 'fetch failed' }); }
    return;
  }
  if (url.startsWith('/now')) { const data = await fetchNow(); okJSON(res, data); return; }
  if (url.startsWith('/stream')) { await proxyStream(req, res); return; }
  res.writeHead(404, { 'Content-Type':'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok:false, error:'not found' }));
});
server.listen(PORT, () => console.log('radio backend listening on', PORT));
