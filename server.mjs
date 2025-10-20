// server.mjs (minimal, stable)
import http from 'node:http';
import { URL } from 'node:url';

const {
  PORT = process.env.PORT || 10000,
  UPSTREAM_STATUS_URL = process.env.UPSTREAM_STATUS_URL,
  STREAM_URL = process.env.STREAM_URL,
  CACHE_TTL_MS = process.env.CACHE_TTL_MS || 4500,
  USER_AGENT = process.env.USER_AGENT || 'radio-ok/1.0 (+render)',
} = process.env;

const HAS_CONF = Boolean(UPSTREAM_STATUS_URL && STREAM_URL);
let cache = { at: 0, payload: null };

function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(obj));
}
const ok = (res, obj={ok:true}) => json(res, 200, obj);
const bad = (res, code, msg, extra={}) => json(res, code, { error: msg, ...extra });

function decodeEntities(str='') {
  return str.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function fixEncoding(s=''){ try { return Buffer.from(s,'latin1').toString('utf8'); } catch { return s; } }
function stripNumericPrefix(s=''){ return s.replace(/^(\d+,){2,}\s*/, ''); }
function splitArtistTitle(s=''){
  const c=s.replace(/\s{2,}/g,' ').trim();
  let a='',t=''; const i=c.indexOf(' - ');
  if(i>-1){ a=c.slice(0,i).trim(); t=c.slice(i+3).trim(); }
  else if(c.includes(',')){ const p=c.split(','); a=p.shift().trim(); t=p.join(',').trim(); }
  else { t=c; }
  return { artist:a, title:t };
}
async function getText(url, timeoutMs=6000){
  const ctl=new AbortController(); const id=setTimeout(()=>ctl.abort(), timeoutMs);
  try{
    const r=await fetch(url,{redirect:'follow',signal:ctl.signal,headers:{'user-agent':USER_AGENT}});
    if(!r.ok) throw new Error(`upstream ${r.status}`);
    const buf=await r.arrayBuffer(); const raw=Buffer.from(buf).toString('latin1'); return fixEncoding(raw);
  } finally { clearTimeout(id); }
}
function parse7html(text){
  const lines=text.replace(/\r/g,'').split('\n').filter(Boolean);
  const last=lines.at(-1)||'';
  const decoded=decodeEntities(fixEncoding(last)).trim();
  const parts=decoded.split(',');
  let bitrate=''; if(parts.length>2){ const m=parts.at(-2); if(/^\d+$/.test(m)) bitrate=`${m} kbps`; }
  const without=stripNumericPrefix(decoded);
  const {artist,title}=splitArtistTitle(without);
  return { artist, title, bitrate, source:'7.html' };
}

const server = http.createServer(async (req,res)=>{
  try{
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if(path==='/health') return ok(res);
    if(path==='/env') return ok(res, { upstreamSet:Boolean(UPSTREAM_STATUS_URL), valid:HAS_CONF });

    if(path==='/now'){
      if(!HAS_CONF) return bad(res,500,'misconfig',{source:'7.html'});
      const now=Date.now();
      if(cache.payload && (now-cache.at)<CACHE_TTL_MS) return ok(res, cache.payload);
      try{
        const txt=await getText(UPSTREAM_STATUS_URL,6000);
        const parsed=parse7html(txt);
        cache={ at: now, payload: parsed };
        return ok(res, parsed);
      }catch(e){
        return bad(res,502,'fetch failed',{source:'7.html'});
      }
    }

    if(path==='/stream'){
      if(!STREAM_URL) return bad(res,500,'Missing STREAM_URL');
      res.writeHead(302, { 'location': STREAM_URL, 'cache-control':'no-store', 'access-control-allow-origin':'*' });
      return res.end();
    }

    res.writeHead(404, { 'content-type':'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error:'not_found' }));
  }catch(err){
    bad(res,500,'server_error',{ detail:String(err?.message||err) });
  }
});

server.listen(PORT, ()=>console.log('radio backend listening on', PORT));
