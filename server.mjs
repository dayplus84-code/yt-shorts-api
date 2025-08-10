// server.mjs (final)
// YouTube Shorts API (Express + youtubei.js)
// - /health
// - /shorts/trending?region=KR&hours=48&minViews=50000
// - /shorts/search?q=cat&region=US&hours=48&minViews=0

import express from "express";
import cors from "cors";
import { Innertube } from "youtubei.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* ────────────────────────────────────────────────────────────────────────── */
/*                            YT client (per region)                          */
/* ────────────────────────────────────────────────────────────────────────── */
const ytClientCache = new Map();
async function yt(gl = "US") {
  gl = (gl || "US").toUpperCase();
  if (ytClientCache.has(gl)) return ytClientCache.get(gl);
  const client = await Innertube.create({ gl }); // region
  ytClientCache.set(gl, client);
  return client;
}

/* ────────────────────────────────────────────────────────────────────────── */
/*                               Small helpers                                */
/* ────────────────────────────────────────────────────────────────────────── */

// ISO8601 duration like PT1M2S → seconds
function isoToSeconds(iso = "") {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const h = parseInt(m?.[1] || "0", 10);
  const mi = parseInt(m?.[2] || "0", 10);
  const s = parseInt(m?.[3] || "0", 10);
  return h * 3600 + mi * 60 + s;
}

// number parser for views (en/ko/ja abbreviations)
function _numFromAbbrev(s = "") {
  s = String(s).replace(/\s/g, "").toLowerCase();

  // en: 1.2k / 3.4m / 2.1b
  let m = s.match(/([\d.,]+)\s*([kmb])/i);
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, "")) || 0;
    const mul = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()];
    return Math.round(n * mul);
  }

  // ko: 52만, 1.2억
  m = s.match(/([\d.,]+)\s*만/);
  if (m) return Math.round((parseFloat(m[1].replace(/,/g, "")) || 0) * 1e4);
  m = s.match(/([\d.,]+)\s*억/);
  if (m) return Math.round((parseFloat(m[1].replace(/,/g, "")) || 0) * 1e8);

  // ja: 12万
  m = s.match(/([\d.,]+)\s*万/);
  if (m) return Math.round((parseFloat(m[1].replace(/,/g, "")) || 0) * 1e4);

  // plain number "140,456,499"
  m = s.match(/([\d.,]+)/);
  if (m) return parseInt(m[1].replace(/[.,]/g, ""), 10) || 0;

  return 0;
}

function viewsFromAny(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;

  if (typeof v === "object") {
    if (v.viewCount) return Number(v.viewCount) || 0;
    if (v.stats?.viewCount) return Number(v.stats.viewCount) || 0;
    if (v.shortViewCountText?.simpleText)
      return _numFromAbbrev(v.shortViewCountText.simpleText);
    if (v.viewCountText?.simpleText)
      return _numFromAbbrev(v.viewCountText.simpleText);
    if (v.simpleText) return _numFromAbbrev(v.simpleText);
    if (v.text) return _numFromAbbrev(v.text);
  }

  if (typeof v === "string") return _numFromAbbrev(v);

  return 0;
}

// "3 hours ago", "2일 전", "4 days ago", "3週間前" → hours
function ageToHours(s = "") {
  const t = String(s).toLowerCase();

  // en
  if (/(\d+)\s*minute/.test(t)) return parseInt(RegExp.$1, 10) / 60;
  if (/(\d+)\s*hour/.test(t)) return parseInt(RegExp.$1, 10);
  if (/(\d+)\s*day/.test(t)) return parseInt(RegExp.$1, 10) * 24;
  if (/(\d+)\s*week/.test(t)) return parseInt(RegExp.$1, 10) * 24 * 7;
  if (/(\d+)\s*month/.test(t)) return parseInt(RegExp.$1, 10) * 24 * 30;
  if (/(\d+)\s*year/.test(t)) return parseInt(RegExp.$1, 10) * 24 * 365;

  // ko
  const tk = s;
  if (/(\d+)\s*분\s*전/.test(tk)) return parseInt(RegExp.$1, 10) / 60;
  if (/(\d+)\s*시간\s*전/.test(tk)) return parseInt(RegExp.$1, 10);
  if (/(\d+)\s*일\s*전/.test(tk)) return parseInt(RegExp.$1, 10) * 24;
  if (/(\d+)\s*주\s*전/.test(tk)) return parseInt(RegExp.$1, 10) * 24 * 7;
  if (/(\d+)\s*개월\s*전/.test(tk)) return parseInt(RegExp.$1, 10) * 24 * 30;
  if (/(\d+)\s*년\s*전/.test(tk)) return parseInt(RegExp.$1, 10) * 24 * 365;

  // ja (간단)
  if (/(\d+)\s*分前/.test(s)) return parseInt(RegExp.$1, 10) / 60;
  if (/(\d+)\s*時間前/.test(s)) return parseInt(RegExp.$1, 10);
  if (/(\d+)\s*日前/.test(s)) return parseInt(RegExp.$1, 10) * 24;
  if (/(\d+)\s*週間前/.test(s)) return parseInt(RegExp.$1, 10) * 24 * 7;
  if (/(\d+)\s*か月前/.test(s)) return parseInt(RegExp.$1, 10) * 24 * 30;
  if (/(\d+)\s*年前/.test(s)) return parseInt(RegExp.$1, 10) * 24 * 365;

  return Infinity;
}

// shorts-like 판단 (길이/경로/태그 등 널널하게)
function isShortLike(x) {
  const dur =
    x.length_seconds ||
    x.lengthSeconds ||
    (typeof x.duration === "string" ? isoToSeconds(x.duration) : 0);

  if (dur && dur > 0 && dur <= 62) return true;

  const url =
    x.url ||
    x.watch_url ||
    x.on_tap?.endpoint?.url ||
    x.navigationEndpoint?.watchEndpoint?.videoId ||
    "";

  if (String(url).includes("/shorts/")) return true;

  const badges =
    x.badges ||
    x.ownerBadges ||
    x.thumbnailOverlays ||
    x.icon?.iconType ||
    "";

  if (JSON.stringify(badges).toLowerCase().includes("short")) return true;

  return false;
}

// 결과 표준화
function mapVideo(x, regionCode) {
  const id =
    x.videoId ||
    x.id?.videoId ||
    x.id ||
    x.shortVideoId ||
    x?.navigationEndpoint?.watchEndpoint?.videoId;

  const title =
    x.title?.text ||
    x.title?.simpleText ||
    x.title ||
    x.headline ||
    x.accessibility?.label ||
    "";

  const publishedText =
    x.published ||
    x.publishedText ||
    x.publishedTimeText?.simpleText ||
    x.snippet?.publishedAt ||
    x.snippet?.publishedTimeText ||
    "";

  const durationSec =
    x.durationSec ||
    x.lengthSeconds ||
    (typeof x.duration === "string" ? isoToSeconds(x.duration) : 0);

  const views =
    viewsFromAny(
      x.stats?.viewCount ??
        x.viewCount ??
        x.shortViewCountText ??
        x.viewCountText ??
        x.accessibility?.accessibilityData?.label ??
        x.views
    ) || 0;

  const thumb =
    x.thumbnails?.[0]?.url ||
    x.thumbnail?.url ||
    x.thumbnail?.thumbnails?.[0]?.url ||
    (id ? `https://i.ytimg.com/vi/${id}/hq720.jpg` : "");

  return {
    videoId: id,
    title,
    views,
    url: id ? `https://www.youtube.com/shorts/${id}` : "",
    published: publishedText,
    ageHours: ageToHours(publishedText),
    channel:
      x.channel || x.channelTitle || x.ownerText?.simpleText || x.owner?.name || "",
    duration: durationSec ? `PT${Math.round(durationSec)}S` : "",
    sec: durationSec || 0,
    region: regionCode,
    thumb,
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/*                                   Routes                                   */
/* ────────────────────────────────────────────────────────────────────────── */

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (_, res) => res.send("YT Shorts API is live 🚀"));

/**
 * 1) 트렌딩(강화): Shorts 탭 시도 → 선반 스캔 → 검색백업 + 필터(hours/minViews)
 */
app.get("/shorts/trending", async (req, res) => {
  const gl = (req.query.region || "US").toString().toUpperCase();
  const hours = Number(req.query.hours || 48);
  const minViews = Number(req.query.minViews || 0);

  console.log(
    `[TREND] region=${gl} hours=${hours} minViews=${minViews}`
  );

  try {
    const y = await yt(gl);
    const trending = await y.getTrending();
    console.log(`[TREND] getTrending ok`);

    let itemsRaw = [];

    // A. Shorts 탭/필터 시도
    if (typeof trending?.applyContentTypeFilter === "function") {
      try {
        const tShorts = await trending.applyContentTypeFilter("Shorts");
        itemsRaw = tShorts?.items ?? tShorts?.videos ?? [];
      } catch (e) {
        console.log(`[TREND] applyContentTypeFilter err: ${e?.message || e}`);
      }
    }

    // B. 선반(shelf)에서 쇼츠만 추림
    if (!itemsRaw?.length) {
      const shelves =
        trending?.contents ?? trending?.sections ?? trending?.items ?? [];
      let pool = [];
      for (const s of shelves) {
        const arr = s?.contents ?? s?.items ?? [];
        pool.push(...arr);
      }
      const onlyShort = pool.filter(isShortLike);
      itemsRaw = onlyShort;
      console.log(
        `[TREND] shelves short-like len: ${onlyShort.length}`
      );
    }

    // C. 그래도 비면: 검색 기반 백업
    if (!itemsRaw?.length) {
      const search = await y.search("#shorts");
      let r = search;
      if (search?.applyFilter) {
        try {
          r = await search.applyFilter("Shorts");
        } catch {}
      }
      itemsRaw = (r?.results ?? r ?? []).filter(isShortLike).slice(0, 120);
      console.log(`[TREND] search backup len: ${itemsRaw.length}`);
    }

    // 매핑 + 필터
    let dropV = 0,
      dropH = 0;

    const items = (itemsRaw || [])
      .filter(isShortLike)
      .map((v) => mapVideo(v, gl))
      .filter((v) => v.videoId)
      .filter((v) => {
        if ((v.views || 0) < minViews) {
          dropV++;
          return false;
        }
        return true;
      })
      .filter((v) => {
        const ok = v.ageHours !== Infinity && v.ageHours <= hours;
        if (!ok) dropH++;
        return ok;
      })
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 120);

    console.log(
      `[TREND] final len=${items.length} (dropViews=${dropV}, dropHours=${dropH})`
    );
    res.json(items);
  } catch (e) {
    console.error(`[TREND] error:`, e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * 2) 검색: q=... → Shorts 필터 → 동일한 hour/minViews 필터
 */
app.get("/shorts/search", async (req, res) => {
  const gl = (req.query.region || "US").toString().toUpperCase();
  const q = (req.query.q || "").toString();
  const hours = Number(req.query.hours || 48);
  const minViews = Number(req.query.minViews || 0);

  if (!q) return res.status(400).json({ error: "q required" });

  console.log(
    `[SEARCH] q="${q}" region=${gl} hours=${hours} minViews=${minViews}`
  );

  try {
    const y = await yt(gl);
    let r = await y.search(q);
    if (r?.applyFilter) {
      try {
        r = await r.applyFilter("Shorts");
      } catch {}
    }
    let arr = (r?.results ?? r ?? []).filter(isShortLike);

    let dropV = 0,
      dropH = 0;

    const items = arr
      .map((v) => mapVideo(v, gl))
      .filter((v) => v.videoId)
      .filter((v) => {
        if ((v.views || 0) < minViews) {
          dropV++;
          return false;
        }
        return true;
      })
      .filter((v) => {
        const ok = v.ageHours !== Infinity && v.ageHours <= hours;
        if (!ok) dropH++;
        return ok;
      })
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 120);

    console.log(
      `[SEARCH] final len=${items.length} (dropViews=${dropV}, dropHours=${dropH})`
    );
    res.json(items);
  } catch (e) {
    console.error(`[SEARCH] error:`, e);
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/* ────────────────────────────────────────────────────────────────────────── */
/*                                  Startup                                   */
/* ────────────────────────────────────────────────────────────────────────── */

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("YT Shorts API listening on", PORT);
});
