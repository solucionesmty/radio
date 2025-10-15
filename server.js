import express from "express";

// ----------- Utils -----------
const ORIGIN  = "https://hombresg.radio12345.com";
const INDEX   = `${ORIGIN}/index.php`;
const AJAX    = `${ORIGIN}/getRecentSong.ajax.php`;
const HOST    = "uk5freenew.listen2myradio.com";
const PORT    = "6345";
const HTTP    = `http://${HOST}:${PORT}`;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function json(res, data, status = 200) {
  res.status(status)
     .set("cache-control", "no-store")
     .set("access-control-allow-origin", "*")
     .json(data);
}

function splitSong(s) {
  const str = String(s || "").trim();
  for (const sep of [" - ", " — ", " ~ ", " | "]) {
    const i = str.indexOf(sep);
    if (i > -1) return { artist: str.slice(0, i).trim(), title: str.slice(i + sep.length).trim() };
  }
  return { artist: "", title: str };
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseItemsFromHtml(html) {
  const lis = [...String(html).matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map(m => m[1]);
  const out = [];
  for (const li of lis) {
    const mTitle  = li.match(/<div[^>]*class=["'][^"']*list_title[^"']*["'][^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const mArtist = li.match(/<div[^>]*class=["'][^"']*list_title[^"']*["'][^>]*>[\s\S]*?<label[^>]*>([\s\S]*?)<\/label>/i);
    let title  = stripTags(mTitle  ? mTitle[1]  : "");
    let artist = stripTags(mArtist ? mArtist[1] : "");
    if (!title || !artist) {
      const plain = stripTags(li);
      const sp = splitSong(plain);
      title = title || sp.title;
      artist = artist || sp.artist;
    }
    if (title || artist) out.push({ title, artist });
  }
  return out;
}

function parse7html(text) {
  const t = String(text || "").replace(/<[^>]+>/g, " ").trim();
  const parts = t.split(",").map(s => s.trim()).filter(Boolean);
  const song = parts[parts.length - 1] || "";
  const br   = parts.find(p => /^\d{2,4}$/.test(p));
  const { artist, title } = splitSong(song);
  return { artist, title, bitrate: br ? `${br} kbps` : "" };
}

function pickIceStats(j) {
  const s = Array.isArray(j?.icestats?.source) ? j.icestats.source[0] : (j?.icestats?.source || {});
  const song = s.title || s.song || "";
  const { artist, title } = splitSong(song);
  const br = s.bitrate ? `${s.bitrate} kbps` : "";
  return { artist, title, bitrate: br };
}

// ----------- Scrapers -----------
async function fetchAjaxWithSession() {
  // 1) abre index para obtener cookies
  const pre = await fetch(INDEX, {
    headers: { "user-agent": UA, "accept": "text/html,*/*" },
    redirect: "follow"
  });
  const set = pre.headers.get("set-cookie") || "";
  const cookie = set
    .split(/,(?=\s*\w+=)/)
    .map(s => s.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  // 2) POST ajax (urlencoded)
  const r = await fetch(AJAX, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      "origin": ORIGIN,
      "referer": INDEX,
      "user-agent": UA,
      "cookie": cookie
    },
    body: new URLSearchParams({ _ts: Date.now().toString() }),
    redirect: "follow"
  });

  const txt = await r.text();
  let j;
  try { j = JSON.parse(txt); } catch { j = {}; }
  const html = j?.html || "";
  const items = parseItemsFromHtml(html);
  if (items.length) {
    const now = items[0];
    return { artist: now.artist, title: now.title, source: "ajax" };
  }
  throw new Error("ajax-empty");
}

async function fetchIndexHtml() {
  const r = await fetch(`${HTTP}/index.html`, { headers: { "user-agent": UA } });
  const html = await r.text();
  const m = html.match(/Current Song:\s*([^<]+)/i);
  if (m && m[1]) {
    const { artist, title } = splitSong(m[1].trim());
    return { artist, title, source: "index.html" };
  }
  throw new Error("no-current-song");
}

async function fetch7Html() {
  const r = await fetch(`${HTTP}/7.html`, { headers: { "user-agent": UA } });
  const txt = await r.text();
  const { artist, title, bitrate } = parse7html(txt);
  if (artist || title) return { artist, title, bitrate, source: "7.html" };
  throw new Error("7html-empty");
}

async function fetchStatusJson() {
  const r = await fetch(`${HTTP}/status-json.xsl`, { headers: { "user-agent": UA } });
  const j = await r.json();
  const out = pickIceStats(j);
  if (out.artist || out.title) return { ...out, source: "status-json" };
  throw new Error("status-empty");
}

// ----------- Express app -----------
const app = express();

app.get("/now", async (req, res) => {
  try {
    // 1) AJAX con sesión (HTTPS del proveedor)
    try {
      const x = await fetchAjaxWithSession();
      return json(res, x);
    } catch {}

    // 2) SHOUTcast en claro (si no lo bloquea la red del host)
    try {
      const x = await fetchIndexHtml();
      return json(res, x);
    } catch {}
    try {
      const x = await fetch7Html();
      return json(res, x);
    } catch {}
    try {
      const x = await fetchStatusJson();
      return json(res, x);
    } catch {}

    return json(res, { artist: "", title: "", source: "none" }, 502);
  } catch (e) {
    return json(res, { artist: "", title: "", source: "error" }, 502);
  }
});

app.get("/health", (req, res) => res.send("ok"));

const PORT_ENV = process.env.PORT || 3000;
app.listen(PORT_ENV, () => console.log("nowplaying running on :" + PORT_ENV));

// === PROXY DE STREAM CON CORS ===
app.get("/stream", async (req, res) => {
  const upstream = "https://uk5freenew.listen2myradio.com/live.mp3?typeportmount=s1_6345_stream_898887520";
  try {
    const controller = new AbortController();
    req.on("close", () => controller.abort());

    const r = await fetch(upstream, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!r.ok || !r.body) {
      res.status(502).set("access-control-allow-origin", "*").json({ error: "upstream" });
      return;
    }
    // CORS + tipo de audio
    res.writeHead(200, {
      "Content-Type": "audio/mpeg",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      // estas dos ayudan a algunos players
      "Accept-Ranges": "bytes",
      "Connection": "keep-alive"
    });

    // pipe del cuerpo (streaming)
    r.body.on("error", () => { try { res.end(); } catch {} });
    r.body.pipe(res);
  } catch (e) {
    try {
      res.status(500).set("access-control-allow-origin", "*").json({ error: "proxy" });
    } catch {}
  }
});

