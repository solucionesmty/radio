// server.js — Backend Radio (Render)
// Node 18+, "type": "module" en package.json

import express from "express";
import { fetch, Agent } from "undici";
import { Readable } from "node:stream";
import iconv from "iconv-lite";

const app = express();

/* =================== Config =================== */
const STATION_PAGE = "https://hombresg.radio12345.com/index.php";
const RADIO_AJAX   = "https://hombresg.radio12345.com/getRecentSong.ajax.php";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

const agent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  headersTimeout: 30_000,
  bodyTimeout: 0,
});

/* =================== Utils =================== */
function clean(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}
function stripTags(html) {
  return clean(String(html).replace(/<[^>]+>/g, " "));
}

/** Decodifica texto respetando charset (cabecera o meta) */
async function fetchTextSmart(url, options = {}) {
  const r = await fetch(url, { dispatcher: agent, ...options });
  const buf = Buffer.from(await r.arrayBuffer());
  let ct = String(r.headers.get("content-type") || "").toLowerCase();

  // 1) charset desde cabecera
  let enc = (ct.match(/charset=([\w-]+)/)?.[1] || "").toLowerCase();

  // 2) si no hay, intenta meta charset en el HTML
  if (!enc) {
    const head = buf.slice(0, 4096).toString("latin1"); // no asumimos utf8 aún
    enc = (head.match(/<meta[^>]*charset=["']?([\w-]+)["']?/i)?.[1] || "").toLowerCase();
  }

  // 3) normaliza alias comunes
  if (!enc) enc = "utf-8";
  if (enc === "utf8") enc = "utf-8";
  if (enc === "iso-8859-1" || enc === "latin-1") enc = "latin1";

  const text = iconv.decode(buf, enc).normalize("NFC");
  return { ok: r.ok, status: r.status, headers: r.headers, contentType: ct, text };
}

function parseFromHtml(html) {
  const out = [];
  const txt = clean(html);
  const li = Array.from(txt.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)).map((m) => m[1]);

  for (const block of li) {
    const title = (block.match(/class=["']?list_title[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1];
    const artist = (block.match(/<label[^>]*>([\s\S]*?)<\/label>/i) || [])[1];
    const t = clean(stripTags(title));
    const a = clean(stripTags(artist));
    if (t || a) out.push({ title: t, artist: a });
  }

  if (!out.length) {
    const plain = stripTags(txt);
    const first = plain.split(/\s{2,}|\n/).find(Boolean) || plain;
    const seps = [" - ", " — ", " – ", " | ", ": "];
    for (const sep of seps) {
      const i = first.indexOf(sep);
      if (i > 0) {
        out.push({ artist: first.slice(0, i).trim(), title: first.slice(i + sep.length).trim() });
        break;
      }
    }
  }
  return out;
}

/* =================== Resolver URL del stream =================== */
let cachedUrl = null;
let cachedAt = 0;
const CACHE_MS = 90_000;

async function resolveUpstreamURL() {
  const now = Date.now();
  if (cachedUrl && now - cachedAt < CACHE_MS) return cachedUrl;

  const { text: html } = await fetchTextSmart(STATION_PAGE, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,*/*",
      "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
      Connection: "keep-alive",
    },
  });

  let m = html.match(/id=["']urladdress["'][^>]*>\s*([^<\s][^<]*?)\s*<\/div>/i);
  if (m && m[1]) {
    const url = m[1].trim();
    if (url.startsWith("http")) {
      cachedUrl = url;
      cachedAt = now;
      return url;
    }
  }
  m = html.match(/https?:\/\/[^\s"'<>]+live\.mp3\?typeportmount=[^"'<>\s]+/i);
  if (m) {
    cachedUrl = m[0];
    cachedAt = now;
    return cachedUrl;
  }

  cachedUrl = "http://uk5freenew.listen2myradio.com:6345/;stream.mp3";
  cachedAt = now;
  return cachedUrl;
}

/* =================== Endpoints =================== */
app.get("/", (_req, res) => res.type("text/plain").send("OK"));

// ---- /now con decodificación segura (adiós mojibake) ----
app.get("/now", async (_req, res) => {
  try {
    const { text, contentType } = await fetchTextSmart(RADIO_AJAX, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        Accept: "application/json,text/html,*/*",
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://hombresg.radio12345.com",
        Referer: "https://hombresg.radio12345.com/",
      },
      body: "x=1",
    });

    let items = [];
    if ((contentType || "").includes("application/json")) {
      try {
        const j = JSON.parse(text);
        if (j && j.html) items = parseFromHtml(j.html);
        if (!items.length && Array.isArray(j.history)) {
          for (const h of j.history) {
            const t = clean(h.title || h.song || "");
            const a = clean(h.artist || "");
            if (t || a) items.push({ title: t, artist: a });
          }
        }
        // bitrate si viene en json (a veces no aplica):
        const bitrate = clean(j?.bitrate || "");
        const now = items[0] || { artist: "", title: "" };
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.type("application/json; charset=utf-8").send(
          JSON.stringify({ artist: now.artist, title: now.title, bitrate, source: "ajax-json" })
        );
        return;
      } catch {
        // caemos a parseo HTML/texto
      }
    }

    // respuesta text/html: parsea HTML
    items = parseFromHtml(text);
    const now = items[0] || { artist: "", title: "" };
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.type("application/json; charset=utf-8").send(
      JSON.stringify({ artist: now.artist, title: now.title, bitrate: "", source: "v7.html" })
    );
  } catch (err) {
    res
      .status(502)
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ artist: "", title: "", source: "error", msg: String(err) }));
  }
});

// ---- /diag ----
app.get("/diag", async (_req, res) => {
  try {
    const url = await resolveUpstreamURL();
    const r = await fetch(url, {
      dispatcher: agent,
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        "Icy-MetaData": "0",
        Connection: "keep-alive",
        Referer: "https://hombresgradio.com/",
        Origin: "https://hombresgradio.com",
      },
    });
    const reader = r.body?.getReader?.();
    let bytes = 0;
    if (reader) {
      while (bytes < 65536) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (chunk.value) bytes += chunk.value.byteLength;
      }
    }
    res.json({
      ok: r.ok,
      status: r.status,
      ct: r.headers.get("content-type"),
      bytes,
      urlUsed: url,
      cachedAgeMs: Date.now() - cachedAt,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e) });
  }
});

// ---- /stream ----
app.get("/stream", async (req, res) => {
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Disposition", 'inline; filename="live.mp3"');
  res.setHeader("Cache-Control", "no-store, no-transform, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const ac = new AbortController();
  const onClose = () => ac.abort();
  req.on("close", onClose);
  req.on("aborted", onClose);

  try {
    const upstreamURL = await resolveUpstreamURL();
    const upstream = await fetch(upstreamURL, {
      dispatcher: agent,
      method: "GET",
      headers: {
        "User-Agent": UA,
        Accept: "*/*",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.8",
        "Icy-MetaData": "0",
        Connection: "keep-alive",
        Referer: "https://hombresgradio.com/",
        Origin: "https://hombresgradio.com",
      },
      signal: ac.signal,
    });

    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: "upstream", code: upstream.status });
      return;
    }

    res.flushHeaders?.();
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on("error", () => {
      if (!res.headersSent) res.status(502);
      res.end();
    });
    res.on("error", () => ac.abort());

    nodeStream.pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: "proxy", msg: String(err) });
    } else {
      res.end();
    }
  }
});

/* Puerto */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("radio backend listening on", PORT));
