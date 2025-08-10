// server.mjs  (ESM)
// ─────────────────────────────────────────────────────────────────────────────
// 안정판: 트렌딩(Shorts) 강력 폴백 + 타임아웃 + 로깅 + CORS
// Endpoints:
//   GET /health
//   GET /shorts/trending?region=KR&hours=48&minViews=0
//   GET /shorts/search?q=cat&region=KR&hours=48&minViews=0
//   GET /shorts/by-channel?input=@handle|URL|UC...&region=KR&limit=30
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import { Innertube } from 'youtubei.js';

const app = express();
app.use(cors());
app.use(express.json());

// 요청 로깅 (디버그에 좋아요)
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()}  ${req.method} ${req.url}`);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 유틸
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Promise 타임아웃: 특정 ms 내에 끝나지 않으면 에러로 전환
const withTimeout = (p, ms = 7000) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout after ${ms}ms`)), ms))
  ]);

const yt = async (gl = 'US') => {
  // region(gl)은 KR/US/JP/ES 등
  return await Innertube.create({ gl: gl.toUpperCase() });
};

// 'PT1M8S' 같은 ISO8601 → 초
function isoToSeconds(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  const h = parseInt(m?.[1] || '0', 10);
  const mi = parseInt(m?.[2] || '0', 10);
  const s = parseInt(m?.[3] || '0', 10);
  return h * 3600 + mi * 60 + s;
}

// “3 months ago”, “2 days ago” → 대략 시간
function publishedTextToHours(text) {
  if (!text) return Infinity;
  const s = text.toString().toLowerCase();

  const pick = (re, mul) => {
    const m = s.match(re);
    if (m) return Number(m[1]) * mul;
    return null;
  };
  // 대충 근사치: 년/월/주/일/시간 → 시간
  return (
    pick(/(\d+)\s*year/, 24 * 365) ??
    pick(/(\d+)\s*month/, 24 * 30) ??
    pick(/(\d+)\s*week/, 24 * 7) ??
    pick(/(\d+)\s*day/, 24) ??
    pick(/(\d+)\s*hour/, 1) ??
    Infinity
  );
}

// "1,234,567 views" / "1.2M" / "13,219,150" 등 → 숫자
function parseHumanNumber(s) {
  if (typeof s !== 'string') return 0;

  const cleaned = s
    .toLowerCase()
    .replace(/views?/g, '')
    .replace(/[^0-9.,kmb]/g, '')
    .trim();

  if (!cleaned) return 0;

  // 1.2k / 3.4m / 1.1b
  const kmbr = cleaned.match(/^([\d,.]+)\s*([kmb])$/i);
  if (kmbr) {
    const n = parseFloat(kmbr[1].replace(/,/g, ''));
    const unit = kmbr[2].toLowerCase();
    const mul = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : 1e9;
    return Math.round(n * mul);
  }

  // 그냥 숫자
  const number = cleaned.replace(/[^\d]/g, '');
  return number ? parseInt(number, 10) : 0;
}

// 여러 형태의 뷰 문자열에서 최선의 값을 고르기
function pickViews(it) {
  const candidates = [
    it?.view_count?.text,
    it?.short_view_count?.text,
    it?.short_view_count_text,
    it?.views?.text,
    it?.metadata?.view_count,
    it?.stats?.views,
    it?.shorts?.view_count?.text,
    it?.shorts_view_count?.text
  ].filter(Boolean);

  for (const c of candidates) {
    const n = typeof c === 'number' ? c : parseHumanNumber(String(c));
    if (n > 0) return n;
  }
  // 그래도 못 찾으면, 객체 속 문자열 전체를 훑어서 'M/k/b' 또는 숫자 덩어리 추출 시도
  const deep = JSON.stringify(it);
  const deepM = deep.match(/"text"\s*:\s*"([^"]*views?[^"]*)"/i)?.[1];
  if (deepM) {
    const n = parseHumanNumber(deepM);
    if (n > 0) return n;
  }
  return 0;
}

// durationSec 추출 (가능하면 초)
function pickDurationSec(it) {
  // youtubei.js가 seconds 제공하는 경우
  if (typeof it?.duration?.seconds === 'number') return it.duration.seconds;
  if (typeof it?.duration === 'number') return it.duration;

  // ISO
  if (typeof it?.duration?.text === 'string' && it.duration.text.startsWith('PT')) {
    return isoToSeconds(it.duration.text);
  }
  if (typeof it?.duration?.toString === 'function') {
    const s = it.duration.toString();
    if (s.startsWith('PT')) return isoToSeconds(s);
  }

  // length_text 형태 “1:03”, “12:34”
  const t = it?.length_text?.text || it?.length?.text || it?.length_text || '';
  if (t && typeof t === 'string') {
    const parts = t.split(':').map(x => parseInt(x, 10));
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }

  return 0;
}

// 썸네일 URL
function pickThumb(it) {
  const arr =
    it?.thumbnails ||
    it?.thumbnail?.thumbnails ||
    it?.thumbnail ||
    it?.thumbnails_all ||
    [];
  if (Array.isArray(arr) && arr.length) {
    // 가장 큰 이미지
    const best = arr.reduce((a, b) => (a?.width || 0) * (a?.height || 0) > (b?.width || 0) * (b?.height || 0) ? a : b);
    return best?.url || arr[0]?.url || null;
  }
  return null;
}

// 쇼츠처럼 보이면 true
function isShortLike(it) {
  const secs = pickDurationSec(it);
  if (secs > 0 && secs <= 62) return true;

  const url = it?.url || `https://youtu.be/${it?.id || it?.video_id}`;
  if (url.includes('/shorts/')) return true;

  // youtubei.js 일부 항목은 is_short 1비트 제공
  if (it?.is_short === true) return true;

  // 제목/설명 태그
  const title = it?.title?.text || it?.title || '';
  if (/#shorts/i.test(title)) return true;

  return false;
}

// 비디오 → 우리 포맷
function mapVideo(it, region = 'US') {
  const videoId = it?.id || it?.video_id || it?.id?.videoId || it?.compact_video_renderer?.video_id || '';
  const title = it?.title?.text || it?.title || '';
  const channel =
    it?.author?.name || it?.channel?.name || it?.owner?.name || it?.author || it?.channel || '';
  const publishedAt =
    it?.published?.text || it?.published_text || it?.published || it?.published_time_text || '';
  const durationSec = pickDurationSec(it);
  const views = pickViews(it);
  const thumb = pickThumb(it);
  const url = it?.url || (videoId ? `https://www.youtube.com/shorts/${videoId}` : '');

  return {
    videoId,
    title,
    views,
    url,
    publishedAt,
    channel,
    duration: `PT${Math.floor(durationSec / 60)}M${durationSec % 60}S`,
    sec: durationSec,
    region,
    thumb,
    ageHours: publishedTextToHours(publishedAt)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// 헬스 체크
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// 트렌딩(강화): Shorts 탭 시도 → 선반 스캔 → 검색 백업 + 필터(hours/minViews) + 타임아웃
app.get('/shorts/trending', async (req, res) => {
  const started = Date.now();
  try {
    const gl = (req.query.region || 'US').toString().toUpperCase();
    const hours = Number(req.query.hours || 48);
    const minViews = Number(req.query.minViews || 0);

    console.log(`[TREND] region=${gl} hours=${hours} minViews=${minViews}`);

    const y = await yt(gl);

    // 1) getTrending with timeout
    let trending = null;
    try {
      trending = await withTimeout(y.getTrending(), 7000);
      console.log('[TREND] getTrending ok');
    } catch (e) {
      console.warn('[TREND] getTrending failed:', e.message);
    }

    let itemsRaw = [];

    // 2) Shorts 탭 필터
    if (trending && typeof trending.applyContentTypeFilter === 'function') {
      try {
        const tShorts = await withTimeout(trending.applyContentTypeFilter('Shorts'), 5000);
        itemsRaw = tShorts?.items ?? tShorts?.videos ?? [];
        console.log('[TREND] filter(Shorts) len:', itemsRaw?.length || 0);
      } catch (e) {
        console.warn('[TREND] applyContentTypeFilter failed:', e.message);
      }
    }

    // 3) 선반(shelf) 스캔
    if (!itemsRaw?.length && trending) {
      const shelves = trending?.contents ?? trending?.sections ?? trending?.items ?? [];
      const pool = [];
      for (const s of shelves) pool.push(...(s?.contents ?? s?.items ?? []));
      itemsRaw = pool.filter(isShortLike);
      console.log('[TREND] shelves short-like len:', itemsRaw?.length || 0);
    }

    // 4) 검색 백업
    if (!itemsRaw?.length) {
      try {
        const search = await withTimeout(y.search('#shorts'), 7000);
        let r = search;
        if (search?.applyFilter) {
          try { r = await withTimeout(search.applyFilter('Shorts'), 5000); } catch {}
        }
        itemsRaw = (r?.results ?? r ?? []).filter(isShortLike).slice(0, 150);
        console.log('[TREND] search backup len:', itemsRaw?.length || 0);
      } catch (e) {
        console.warn('[TREND] search backup failed:', e.message);
      }
    }

    const items = (itemsRaw || [])
      .filter(isShortLike)
      .map(v => mapVideo(v, gl))
      .filter(v => v.videoId)
      .filter(v => (v.views || 0) >= minViews)
      .filter(v => v.ageHours !== Infinity && v.ageHours <= hours)
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 120);

    console.log(`[TREND] final len=${items.length} (${Date.now() - started}ms)`);
    res.json(items);
  } catch (e) {
    console.error('[TREND] ERROR:', e);
    res.status(500).json({ error: String(e) });
  }
});

// 검색(Shorts 전용 필터 + 시간/조회 필터)
app.get('/shorts/search', async (req, res) => {
  try {
    const gl = (req.query.region || 'US').toString().toUpperCase();
    const q = (req.query.q || '').toString().trim();
    const hours = Number(req.query.hours || 168);    // 검색은 기본 일주일
    const minViews = Number(req.query.minViews || 0);

    if (!q) return res.json([]);

    const y = await yt(gl);
    const search = await withTimeout(y.search(q), 7000);
    let r = search;

    if (search?.applyFilter) {
      try { r = await withTimeout(search.applyFilter('Shorts'), 5000); } catch {}
    }

    const items = ((r?.results ?? r ?? []) || [])
      .filter(isShortLike)
      .map(v => mapVideo(v, gl))
      .filter(v => v.videoId)
      .filter(v => (v.views || 0) >= minViews)
      .filter(v => v.ageHours !== Infinity && v.ageHours <= hours)
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, 120);

    res.json(items);
  } catch (e) {
    console.error('[SEARCH] ERROR:', e);
    res.status(500).json({ error: String(e) });
  }
});

// 채널 최신(간단 버전): @handle / 채널 URL / UCID를 입력으로 받아 최신 Shorts 느낌으로 필터
app.get('/shorts/by-channel', async (req, res) => {
  try {
    const gl = (req.query.region || 'US').toString().toUpperCase();
    const input = (req.query.input || '').toString().trim();
    const limit = Math.min(Number(req.query.limit || 30), 50);

    if (!input) return res.json([]);

    const y = await yt(gl);

    // 1) UCID 직접
    let ucid = null;
    const ucMatch = input.match(/(UC[0-9A-Za-z_-]{22,})/);
    if (ucMatch) ucid = ucMatch[1];

    // 2) URL에 @handle 또는 /channel/UC...
    if (!ucid && /^https?:\/\//i.test(input)) {
      const m1 = input.match(/\/channel\/(UC[0-9A-Za-z_-]{22,})/);
      if (m1) ucid = m1[1];
    }

    // 3) 핸들이나 키워드로 검색해서 채널 찾기
    let channelTitle = '';
    if (!ucid) {
      const sr = await withTimeout(y.search(input), 7000);
      const ch = (sr?.results ?? sr ?? []).find(r => (r?.type || '').toLowerCase() === 'channel');
      if (ch?.id) {
        ucid = ch.id;
        channelTitle = ch?.author?.name || ch?.title || '';
      }
    }

    if (!ucid) return res.json([]);

    // 최신 업로드 가져오기 (검색 기반)
    const search = await withTimeout(y.search(`@${ucid}`), 7000);
    let items = (search?.results ?? search ?? [])
      .filter(it => it?.author?.id === ucid || it?.channel?.id === ucid);

    // Shorts 느낌으로 제한
    items = items
      .filter(isShortLike)
      .map(v => mapVideo(v, gl))
      .slice(0, limit);

    // 채널명 보강
    if (channelTitle) items = items.map(o => ({ ...o, channel: channelTitle }));

    res.json(items);
  } catch (e) {
    console.error('[BY-CHANNEL] ERROR:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Listen
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`YT Shorts API listening on ${PORT}`);
});
