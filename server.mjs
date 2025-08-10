// server.mjs (part 1/2)
// 최종 업그레이드 버전 — Express + youtubei.js
// Render 무료플랜 친화: CORS, compression, 간단 로깅, 에러핸들

import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { Innertube } from 'youtubei.js';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(compression());

// ────────────────────────────────────────────────────────────
// 유틸
// ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseCount(textOrNum) {
  if (textOrNum == null) return 0;
  if (typeof textOrNum === 'number') return textOrNum;
  let s = String(textOrNum).trim().toLowerCase();
  if (!s) return 0;
  // "1.2M views" / "123,456 views" / "1.2억회" 등
  s = s.replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*([kmb억천만]?)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1] || '0');
  const unit = m[2] || '';
  switch (unit) {
    case 'k': case 'K': n *= 1e3; break;
    case 'm': case 'M': n *= 1e6; break;
    case 'b': case 'B': n *= 1e9; break;
    // 한글 약어 대략치
    case '천': n *= 1e3; break;
    case '만': n *= 1e4; break;
    case '억': n *= 1e8; break;
  }
  return Math.floor(n);
}

function isoToSec(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  const h = (m && +m[1]) || 0;
  const mi = (m && +m[2]) || 0;
  const s = (m && +m[3]) || 0;
  return h * 3600 + mi * 60 + s;
}

function hmsToSec(hms) {
  // "0:23" "1:02:03"
  if (!hms || typeof hms !== 'string') return 0;
  const parts = hms.split(':').map(x => parseInt(x, 10) || 0);
  if (parts.length === 3) return parts[0]*3600 + parts[1]*60 + parts[2];
  if (parts.length === 2) return parts[0]*60 + parts[1];
  return 0;
}

function relativeToHours(text) {
  // "3 days ago", "1 day ago", "4 hours ago", "2 weeks ago", "11 months ago", "3 years ago"
  if (!text || typeof text !== 'string') return Infinity;
  const t = text.toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(year|month|week|day|hour|minute|yr|min|sec)s?\s*ago/);
  if (!m) return Infinity;
  const num = parseFloat(m[1] || '0');
  const unit = m[2];
  switch (unit) {
    case 'sec': return num / 3600;
    case 'minute': case 'min': return num / 60;
    case 'hour': return num;
    case 'day': return num * 24;
    case 'week': return num * 24 * 7;
    case 'month': return num * 24 * 30;
    case 'year': case 'yr': return num * 24 * 365;
    default: return Infinity;
  }
}

function pick(obj, paths) {
  for (const p of paths) {
    const val = p.split('.').reduce((o,k)=> (o && o[k] != null ? o[k] : undefined), obj);
    if (val != null) return val;
  }
  return undefined;
}

function pickVideoId(v) {
  return (
    v?.videoId ||
    v?.id ||
    v?.video_id ||
    v?.endpoint?.payload?.videoId ||
    v?.navigationEndpoint?.watchEndpoint?.videoId
  );
}

function isShortLike(v) {
  // youtubei.js 구조가 다양해서 여러 힌트로 판별
  const sec =
    v?.short_byline_text != null ?  // shorts tile에 흔함
      ((v?.length_seconds) || v?.length || v?.duration?.seconds || 0) :
      (v?.length_seconds || v?.duration?.seconds || v?.duration || 0);
  const d =
    (typeof sec === 'number' ? sec : 0) ||
    isoToSec(v?.duration) ||
    hmsToSec(v?.duration?.text);
  if (d > 0 && d <= 75) return true;
  const badges = JSON.stringify(v?.badges || v?.video_badges || '').toLowerCase();
  if (badges.includes('short')) return true;
  // 썸네일 세로형 체크를 서버에서 하긴 까다로움 → 길이 우선
  return false;
}

function mapVideo(v, region = 'US') {
  const id = pickVideoId(v);
  if (!id) return null;

  const title = pick(v, ['title.text','title','headline','snippet.title']) || '';
  const url = `https://youtu.be/${id}`;

  // views
  let views =
    pick(v, ['view_count','stats.view_count','view_count_text','short_view_count_text','viewCount','viewCountText']) || '';
  views = parseCount(views);

  // duration seconds
  let sec =
    v?.length_seconds ||
    v?.duration?.seconds ||
    isoToSec(v?.duration) ||
    hmsToSec(v?.duration?.text) ||
    0;

  // published & ageHours
  const publishedText =
    pick(v, ['published.time_text','published.text','snippet.publishedAt','publishedAt']) || '';
  let ageHours = Infinity;
  if (publishedText) {
    if (/^\d{4}-\d{2}-\d{2}/.test(publishedText)) {
      const d = new Date(publishedText).getTime();
      if (!Number.isNaN(d)) ageHours = (Date.now() - d) / 36e5;
    } else {
      ageHours = relativeToHours(publishedText);
    }
  }

  const channel =
    pick(v, ['author.name','channel','owner.text','short_byline_text.runs.0.text','long_byline_text.runs.0.text']) || '';

  const thumb =
    pick(v, ['thumbnail.thumbnails.0.url','thumbnail.thumbnails.1.url','thumbnail.url']) ||
    `https://i.ytimg.com/vi/${id}/hq720.jpg`;

  return {
    videoId: id,
    title,
    url,
    views,
    duration: v?.duration || '',
    sec,
    publishedAt: publishedText || '',
    ageHours,
    channel,
    region,
    thumb
  };
}

// youtubei.js 클라이언트
async function yt(gl = 'US') {
  const y = await Innertube.create({
    lang: 'en',
    location: gl
  });
  return y;
}

// 공통 응답: 배열만 유지
function keepArray(a) {
  if (Array.isArray(a)) return a;
  if (Array.isArray(a?.items)) return a.items;
  if (Array.isArray(a?.contents)) return a.contents;
  if (Array.isArray(a?.videos)) return a.videos;
  return [];
}

// 간단 라우트
app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  res.type('text/plain').send(
`YT Shorts API (Render)
GET /health
GET /shorts/trending?region=KR&hours=168&minViews=0&max=300
GET /shorts/search?q=cat&region=US&max=200
`
  );
});

// server.mjs (part 2/2)

// ────────────────────────────────────────────────────────────
// 1) 검색 라우트
// ────────────────────────────────────────────────────────────
app.get('/shorts/search', async (req, res) => {
  const q = (req.query.q || '').toString();
  const gl = (req.query.region || 'US').toString().toUpperCase();
  const max = Math.min(parseInt(req.query.max || '200', 10) || 200, 800);

  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const y = await yt(gl);
    let r = await y.search(q);

    // Shorts 필터 시도
    if (typeof r?.applyFilter === 'function') {
      try { r = await r.applyFilter('Shorts'); } catch {}
    }

    let pool = keepArray(r?.results || r);
    if (!pool.length) pool = keepArray(r);

    // 쇼츠 유사 판별 + 매핑
    const out = [];
    for (const it of pool) {
      if (!isShortLike(it)) continue;
      const m = mapVideo(it, gl);
      if (m) out.push(m);
      if (out.length >= max) break;
    }

    res.json(out);
  } catch (e) {
    console.error('[SEARCH] error', e);
    res.status(500).json({ error: String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// 2) 트렌딩 라우트 (강화판)
// ────────────────────────────────────────────────────────────
app.get('/shorts/trending', async (req, res) => {
  const gl = (req.query.region || 'US').toString().toUpperCase();
  const hours = Number(req.query.hours || 168);      // 서버 1차 필터(널널)
  const minViews = Number(req.query.minViews || 0);  // 서버 1차 필터(널널)
  const max = Math.min(parseInt(req.query.max || '400', 10) || 400, 1200);

  try {
    const y = await yt(gl);
    const trending = await y.getTrending();

    let itemsRaw = [];

    // A. Shorts 탭/필터 시도
    if (typeof trending?.applyContentTypeFilter === 'function') {
      try {
        const tShorts = await trending.applyContentTypeFilter('Shorts');
        itemsRaw = keepArray(tShorts?.items || tShorts?.videos || tShorts);
      } catch {}
    }

    // B. 선반(shelf) 전체 긁어서 쇼츠만
    if (!itemsRaw.length) {
      const shelves = keepArray(trending?.contents || trending?.sections || trending?.items || []);
      const pool = [];
      for (const s of shelves) {
        const arr = keepArray(s?.contents || s?.items || []);
        pool.push(...arr);
      }
      itemsRaw = pool.filter(isShortLike);
    }

    // C. 그래도 비면: 검색 기반 백업
    if (!itemsRaw.length) {
      let r = await y.search('#shorts');
      if (typeof r?.applyFilter === 'function') {
        try { r = await r.applyFilter('Shorts'); } catch {}
      }
      itemsRaw = keepArray(r?.results || r).filter(isShortLike);
    }

    // 매핑 + 서버 1차 필터 + 정렬 (널널하게만)
    const out = [];
    const seen = new Set();

    for (const v of itemsRaw) {
      const m = mapVideo(v, gl);
      if (!m || seen.has(m.videoId)) continue;
      seen.add(m.videoId);

      if ((m.views || 0) < minViews) continue;
      if (m.ageHours !== Infinity && m.ageHours > hours) continue;

      out.push(m);
      if (out.length >= max) break;
    }

    // 조회수 내림차순
    out.sort((a,b) => (b.views || 0) - (a.views || 0));

    res.json(out);
  } catch (e) {
    console.error('[TREND] error', e);
    res.status(500).json({ error: String(e) });
  }
});

// ────────────────────────────────────────────────────────────
// 서버 기동
// ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`YT Shorts API listening on ${PORT}`);
});
