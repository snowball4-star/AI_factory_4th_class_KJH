'use strict';
// ============================================================
// 업비트 공개 시세 + 이동평균 계산 (의존성 없음, Node 18+ 내장 fetch)
//
// - 업비트 공개 캔들/시세 API 는 인증이 필요 없다. 그래도 브라우저가 외부
//   도메인을 직접 부르지 않도록 항상 이 모듈(서버 쪽)을 거친다.
// - 한 번에 최대 200봉만 주므로 `to` 파라미터로 과거 쪽으로 이어 받는다.
// ============================================================

const BASE = 'https://api.upbit.com/v1';
const MINUTE_UNITS = [1, 3, 5, 10, 15, 30, 60, 240];
const MAX_PER_CALL = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 'day' | 'week' | 'month' | 분 단위 숫자
function endpointOf(unit) {
  const u = String(unit).toLowerCase();
  if (u === 'day' || u === 'days' || u === 'd') return `${BASE}/candles/days`;
  if (u === 'week' || u === 'weeks' || u === 'w') return `${BASE}/candles/weeks`;
  if (u === 'month' || u === 'months') return `${BASE}/candles/months`;
  const n = Number(u);
  if (!MINUTE_UNITS.includes(n)) {
    throw new Error(`지원하지 않는 봉 단위: ${unit} (분봉은 ${MINUTE_UNITS.join('/')} 또는 day)`);
  }
  return `${BASE}/candles/minutes/${n}`;
}

function unitLabel(unit) {
  const u = String(unit).toLowerCase();
  if (u === 'day' || u === 'days' || u === 'd') return '일봉';
  if (u === 'week' || u === 'weeks' || u === 'w') return '주봉';
  if (u === 'month' || u === 'months') return '월봉';
  const n = Number(u);
  return n >= 60 ? `${n / 60}시간봉` : `${n}분봉`;
}

// 한 봉이 몇 분인지 (MA 기간을 "며칠치"로 환산해 보여줄 때 쓴다)
function unitMinutes(unit) {
  const u = String(unit).toLowerCase();
  if (u === 'day' || u === 'days' || u === 'd') return 1440;
  if (u === 'week' || u === 'weeks' || u === 'w') return 1440 * 7;
  if (u === 'month' || u === 'months') return 1440 * 30;
  return Number(u);
}

function toCandle(r) {
  return {
    utc: r.candle_date_time_utc,
    kst: r.candle_date_time_kst,
    // ts: 실제 UTC 초. tsKst: KST 벽시계를 그대로 초로 바꾼 값(차트 축 표시용).
    ts: Math.floor(Date.parse(`${r.candle_date_time_utc}Z`) / 1000),
    tsKst: Math.floor(Date.parse(`${r.candle_date_time_kst}Z`) / 1000),
    open: r.opening_price,
    high: r.high_price,
    low: r.low_price,
    close: r.trade_price,
    volume: r.candle_acc_trade_volume,
  };
}

// 필요한 봉 수를 채울 때까지 과거로 페이징하며 받는다.
async function fetchCandles({ market = 'KRW-BTC', unit = 60, need = 320 } = {}) {
  const url = endpointOf(unit);
  const acc = new Map();          // candle_date_time_utc -> row (경계 봉 중복 제거)
  let to = null;
  let guard = 0;
  let lastErr = null;

  while (acc.size < need && guard++ < 25) {
    const u = new URL(url);
    u.searchParams.set('market', market);
    u.searchParams.set('count', String(Math.min(MAX_PER_CALL, need - acc.size + 1)));
    if (to) u.searchParams.set('to', to);

    let res;
    try {
      res = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(7000) });
    } catch (err) {
      lastErr = err;
      await sleep(500);
      continue;
    }
    if (res.status === 429) { await sleep(700); continue; }   // 초당 호출 제한
    if (!res.ok) throw new Error(`업비트 응답 오류 HTTP ${res.status}`);

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;      // 더 과거가 없음
    for (const r of rows) acc.set(r.candle_date_time_utc, r);
    to = `${rows[rows.length - 1].candle_date_time_utc}Z`;
    await sleep(150);
  }

  if (acc.size === 0) {
    throw new Error(`업비트에서 캔들을 받지 못했습니다${lastErr ? `: ${lastErr.message}` : ''}`);
  }
  return [...acc.values()].map(toCandle).sort((a, b) => a.ts - b.ts);
}

async function fetchTicker(market = 'KRW-BTC') {
  const res = await fetch(`${BASE}/ticker?markets=${market}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`업비트 응답 오류 HTTP ${res.status}`);
  const [d] = await res.json();
  return {
    market,
    price: d.trade_price,
    changeRate: d.signed_change_rate * 100,
    high: d.high_price,
    low: d.low_price,
    prevClose: d.prev_closing_price,
    volume24h: d.acc_trade_volume_24h,
    updatedAt: d.timestamp,
  };
}

// 단순이동평균. 앞쪽 (period-1)개는 null.
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// 캔들 + 각 기간의 이동평균을 붙여 화면/분석에 바로 쓸 형태로 만든다.
// count 는 "보여줄 봉 수"이고, MA 를 채우려면 (최장기간-1)봉을 더 받아야 한다.
async function buildSeries({ market = 'KRW-BTC', unit = 60, periods = [4, 20, 120], count = 200 } = {}) {
  const ps = [...new Set(periods.map(Number))].filter((p) => p > 0).sort((a, b) => a - b);
  const longest = ps[ps.length - 1] || 1;
  const raw = await fetchCandles({ market, unit, need: count + longest - 1 });

  const closes = raw.map((c) => c.close);
  const mas = Object.fromEntries(ps.map((p) => [p, sma(closes, p)]));

  const full = raw.map((c, i) => ({
    ...c,
    ma: Object.fromEntries(ps.map((p) => [p, mas[p][i]])),
  }));

  const candles = full.slice(-count);

  return {
    market,
    unit: String(unit),
    unitLabel: unitLabel(unit),
    unitMinutes: unitMinutes(unit),
    periods: ps,
    fetchedAt: new Date().toISOString(),
    candles,
    // 상장 초기 등으로 과거 봉이 모자라면 앞쪽 MA 가 비어 있다는 표시
    incomplete: candles.length > 0 && candles[0].ma[longest] == null,
  };
}

// 한 봉이 몇 분인지 알 때, 기간을 "며칠/몇시간치"인지로 바꿔 준다 (1시간봉 120봉 = 5일)
function spanText(period, unitMinutes) {
  const min = period * unitMinutes;
  if (min % 1440 === 0) return `${min / 1440}일`;
  if (min >= 1440) return `${(min / 1440).toFixed(1)}일`;
  if (min % 60 === 0) return `${min / 60}시간`;
  return `${min}분`;
}

// 두 이동평균이 마지막으로 교차한 지점 (표시 구간 안에서만 찾는다)
function findCross(candles, fastP, slowP) {
  for (let i = candles.length - 1; i > 0; i--) {
    const a = candles[i], b = candles[i - 1];
    if (a.ma[fastP] == null || a.ma[slowP] == null || b.ma[fastP] == null || b.ma[slowP] == null) break;
    const now = a.ma[fastP] - a.ma[slowP];
    const before = b.ma[fastP] - b.ma[slowP];
    if (now === 0 || before === 0) continue;
    if (Math.sign(now) !== Math.sign(before)) {
      return {
        pair: [fastP, slowP],
        type: now > 0 ? 'golden' : 'dead',
        label: now > 0 ? '골든크로스' : '데드크로스',
        at: a.kst,
        price: a.close,
        barsAgo: candles.length - 1 - i,
      };
    }
  }
  return null;
}

// 이동평균들의 관계를 신호로 요약한다.
// 선이 셋 이상이면 추세 신호는 가장 긴 두 선(예: 20/120), 타이밍 신호는
// 가장 짧은 두 선(예: 4/20)으로 본다.
function analyze(series) {
  const ps = series.periods;                 // 오름차순
  const cs = series.candles;
  const last = cs[cs.length - 1];
  const um = series.unitMinutes;
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);

  // 기울기: 기간의 1/4봉 전과 비교한 변화율(%) — 최소 2봉, 최대 30봉
  const slopeOf = (period) => {
    const back = Math.max(2, Math.min(Math.round(period / 4), 30));
    const prev = cs[cs.length - 1 - back];
    if (!prev || prev.ma[period] == null || last.ma[period] == null) return null;
    return { slopePct: pct(last.ma[period], prev.ma[period]), slopeBars: back };
  };

  const lines = ps.map((p) => ({
    period: p,
    span: spanText(p, um),
    value: last.ma[p],
    gapPct: pct(last.close, last.ma[p]),
    ...(slopeOf(p) || { slopePct: null, slopeBars: null }),
  }));

  const fastP = ps[ps.length - 2];           // 추세 판정용 빠른선 (선 2개면 짧은 쪽)
  const slowP = ps[ps.length - 1];
  const fast = lines.find((l) => l.period === fastP);
  const slow = lines.find((l) => l.period === slowP);

  // 배열: 짧은 선부터 순서대로 위에 있으면 정배열, 완전히 뒤집혀 있으면 역배열
  const vals = ps.map((p) => last.ma[p]);
  const known = vals.every((v) => v != null);
  const ordered = (cmp) => vals.every((v, i) => i === 0 || cmp(vals[i - 1], v));
  const alignment = !known ? '판정불가'
    : ordered((a, b) => a > b) ? '정배열'
    : ordered((a, b) => a < b) ? '역배열'
    : '혼조';

  // 현재가가 어느 선 위에 있는지
  const above = ps.filter((p) => last.ma[p] != null && last.close > last.ma[p]);
  const position = above.length === ps.length ? '모든 선 위'
    : above.length === 0 ? '모든 선 아래'
    : `${above.map((p) => `MA${p}`).join('·')} 위`;

  return {
    market: series.market,
    unitLabel: series.unitLabel,
    at: last.kst,
    price: last.close,
    lines,
    fast,                                     // 추세 신호의 빠른선
    slow,                                     // 추세 신호의 느린선
    spreadPct: fast && slow && fast.value != null && slow.value != null ? pct(fast.value, slow.value) : null,
    alignment,
    position,
    cross: findCross(cs, fastP, slowP),                              // 추세 전환 (예: MA20 × MA120)
    shortCross: ps.length >= 3 ? findCross(cs, ps[0], ps[1]) : null,  // 단기 타이밍 (예: MA4 × MA20)
    window: { count: cs.length, from: cs[0].kst, to: last.kst },
  };
}

module.exports = { fetchCandles, fetchTicker, buildSeries, analyze, sma, unitLabel, unitMinutes, spanText };
