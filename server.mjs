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
  return {
    videoId: v?.id,
    title: v?.title?.text ?? v?.title ?? null,
    views: v?.view_count ?? v?.viewCount ?? null,
    channel: v?.author?.name ?? v?.author_text ?? v?.channel?.name ?? null,
    publishedAt: v?.published?.text ?? null,
    durationSec: v?.duration?.seconds ?? v?.duration_seconds ?? null,
    url: v?.id ? `https://www.youtube.com/shorts/${v.id}` : null,
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
app.get("/shorts/trending", async (req, res) => {
  try {
    const gl = (req.query.region || "US").toString().toUpperCase();
    const y  = await yt(gl);
    const trending = await y.getTrending();

    let itemsRaw = [];

    // (A) 트렌딩 화면에서 Shorts 탭/필터 강제 적용
    if (typeof trending?.applyContentTypeFilter === "function") {
      try {
        const tShorts = await trending.applyContentTypeFilter("Shorts");
        itemsRaw = tShorts?.items ?? tShorts?.videos ?? [];
      } catch {}
    }

    // (B) 아직도 없으면: 선반(shelf) 전부 긁고 쇼츠만 추림
    if (!itemsRaw?.length) {
      const shelves = trending?.contents ?? trending?.sections ?? trending?.items ?? [];
      const pool = [];
      for (const s of shelves) {
        const arr = s?.contents ?? s?.items ?? [];
        pool.push(...arr);
      }
      itemsRaw = pool.filter(isShortLike);
    }

    // (C) 그래도 비면: 검색 기반 대체(지역은 gl 적용됨)
    if (!itemsRaw?.length) {
      const search = await y.search("#shorts");
      let r = search;
      if (search?.applyFilter) { try { r = await search.applyFilter("Shorts"); } catch {} }
      itemsRaw = (r?.results ?? r ?? []).filter(isShortLike).slice(0, 60);
    }

    const items = (itemsRaw || [])
      .filter(isShortLike)
      .map(v => mapVideo(v, gl))
      .filter(v => v.videoId);

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
