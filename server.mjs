import express from "express";
import cors from "cors";
import { Innertube } from "youtubei.js";

const app = express();
app.use(cors());

async function yt(gl = "US") { return await Innertube.create({ gl }); }

// 보수적 Shorts 판정
function isShortLike(v) {
  const type = (v?.type || "").toLowerCase();
  const sec  = Number(v?.duration?.seconds ?? v?.duration_seconds ?? 0);
  return type.includes("short") || (sec > 0 && sec <= 62);
}

function mapVideo(v, region) {
  const id = v?.id;
  const publishedText = v?.published?.text ?? '';
  return {
    videoId: id,
    title: v?.title?.text ?? v?.title ?? null,
    views: pickViews(v),                 // ← 숫자
    channel: v?.author?.name ?? v?.author_text ?? v?.channel?.name ?? null,
    publishedText,                       // "2 weeks ago" 원문
    ageHours: publishedTextToHours(publishedText),
    durationSec: v?.duration?.seconds ?? v?.duration_seconds ?? null,
    url: id ? `https://www.youtube.com/shorts/${id}` : null,
    thumb: id ? thumb(id) : null,        // ← 썸네일 URL
    region
  };
}


app.get("/health", (_, res) => res.json({ ok: true }));

app.get("/shorts/search", async (req, res) => {
  try {
    const gl = (req.query.region || "US").toString().toUpperCase();
    const q  = (req.query.q || "").toString();
    if (!q) return res.status(400).json({ error: "q required" });

    const y = await yt(gl);
    const search = await y.search(q);

    let shortsResults = search;
    if (search?.applyFilter) { try { shortsResults = await search.applyFilter("Shorts"); } catch {} }

    const list = (shortsResults?.results ?? shortsResults ?? [])
      .filter(isShortLike).map(v => mapVideo(v, gl)).filter(v => v.videoId);

    res.json(list);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 2) 트렌딩 → Shorts (탭 전환 시도 + 선반 스캔 fallback)
// 2) 트렌딩(강화판): Shorts 탭 시도 → 선반 스캔 → 안 되면 검색 기반 대체
// 2) 트렌딩(강화): Shorts 탭 시도 → 선반 스캔 → 검색백업 + 필터(hours/minViews)
app.get("/shorts/trending", async (req, res) => {
  try {
    const gl = (req.query.region || "US").toString().toUpperCase();
    const hours = Number(req.query.hours || 48);       // ← 기본 48시간
    const minViews = Number(req.query.minViews || 0);  // ← 기본 제한 없음

    const y = await yt(gl);
    const trending = await y.getTrending();

    let itemsRaw = [];

    // A. Shorts 탭/필터
    if (typeof trending?.applyContentTypeFilter === "function") {
      try {
        const tShorts = await trending.applyContentTypeFilter("Shorts");
        itemsRaw = tShorts?.items ?? tShorts?.videos ?? [];
      } catch {}
    }

    // B. 선반(shelf) 전체에서 쇼츠만 추림
    if (!itemsRaw?.length) {
      const shelves = trending?.contents ?? trending?.sections ?? trending?.items ?? [];
      const pool = [];
      for (const s of shelves) {
        const arr = s?.contents ?? s?.items ?? [];
        pool.push(...arr);
      }
      itemsRaw = pool.filter(isShortLike);
    }

    // C. 그래도 비면: 검색 기반 백업
    if (!itemsRaw?.length) {
      const search = await y.search("#shorts");
      let r = search;
      if (search?.applyFilter) { try { r = await search.applyFilter("Shorts"); } catch {} }
      itemsRaw = (r?.results ?? r ?? []).filter(isShortLike).slice(0, 120);
    }

    // 매핑 + 필터 + 정렬
    const items = (itemsRaw || [])
      .filter(isShortLike)
      .map(v => mapVideo(v, gl))
      .filter(v => v.videoId)
      .filter(v => (v.views || 0) >= minViews)
      .filter(v => v.ageHours !== Infinity && v.ageHours <= hours)
      .sort((a,b) => (b.views||0) - (a.views||0))
      .slice(0, 120);

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


app.get("/shorts/by-channel", async (req, res) => {
  try {
    const gl = (req.query.region || "US").toString().toUpperCase();
    const input = (req.query.input || "").toString();
    if (!input) return res.status(400).json({ error: "input required" });

    const y = await yt(gl);
    const ch = await y.getChannel(input);

    let raw = ch?.items ?? ch?.videos ?? [];
    if (ch?.applyContentTypeFilter) { try {
      const filtered = await ch.applyContentTypeFilter("Shorts");
      raw = filtered?.items ?? raw;
    } catch {} }

    const items = raw.filter(isShortLike).map(v => mapVideo(v, gl)).filter(v => v.videoId);
    res.json(items);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("YT Shorts API listening")
);

function pickViews(v) {
  const n = v?.view_count ?? v?.viewCount ?? v?.short_view_count ?? v?.shortViewCount;
  if (typeof n === 'number') return n;
  const t = v?.views?.text || v?.view_count_text || v?.short_view_count_text;
  if (t) {
    const num = Number(String(t).replace(/[^\d]/g, '')); // "123,456 views" → 123456
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

function publishedTextToHours(txt) {
  if (!txt) return Infinity;
  const s = String(txt).toLowerCase();
  const m = s.match(/(\d+)\s*(second|minute|hour|day|week|month|year)s?/);
  if (!m) return Infinity;
  const n = parseInt(m[1], 10) || 0;
  const u = m[2];
  const H = { second: 1/3600, minute: 1/60, hour: 1, day: 24, week: 24*7, month: 24*30, year: 24*365 }[u] || Infinity;
  return n * H;
}

const thumb = id => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
