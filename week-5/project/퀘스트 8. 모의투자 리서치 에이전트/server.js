'use strict';
// ============================================================
// 📈 모의투자 리서치 차트 서버 (의존성 없음 — node server.js 만으로 실행)
//
// - 브라우저는 자기 서버(/api)만 호출한다. 업비트 호출은 전부 서버가 대신 한다.
// - 정적 폴더를 통째로 노출하지 않고 필요한 파일만 명시적으로 서빙한다.
//   (폴더를 통째로 서빙하면 같은 폴더의 .env 같은 파일까지 /- 경로로 새어나간다)
// - week-4「퀘스트 1. 나만의 모의투자 앱」이 떠 있으면 그 지갑을 읽어
//   평균 매수가를 차트에 같이 그린다. 꺼져 있어도 차트는 그대로 동작한다.
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildSeries, analyze, fetchTicker } = require('./lib/upbit');
const { runRuleTrade } = require('./lib/rule-trade');

const PORT = Number(process.env.PORT) || 3100;
// 모의투자 앱(week-4 퀘스트 1)의 주소. 다른 포트로 띄웠으면 환경변수로 바꾼다.
const TRADER_API = (process.env.TRADER_API || 'http://localhost:3000').replace(/\/+$/, '');

const CANDLE_TTL_MS = 10_000;   // 같은 조건의 캔들 요청은 10초간 재사용
const cache = new Map();

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const sendJSON = (res, code, obj) => send(res, code, JSON.stringify(obj));

async function getSeries({ market, unit, periods, count }) {
  const key = `${market}|${unit}|${periods.join(',')}|${count}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CANDLE_TTL_MS) return hit.data;

  const series = await buildSeries({ market, unit, periods, count });
  const data = { ...series, signals: analyze(series) };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// week-4 모의투자 앱의 지갑. 앱이 꺼져 있으면 connected:false 로만 알린다.
async function getPortfolio() {
  try {
    const res = await fetch(`${TRADER_API}/api/portfolio`, { signal: AbortSignal.timeout(8000) });   // Supabase 첫 연결(cold start)이 느릴 수 있다
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.success) throw new Error(body.message || 'unknown error');
    return { connected: true, api: TRADER_API, ...body.data };
  } catch (err) {
    return { connected: false, api: TRADER_API, reason: err.message };
  }
}

const routes = {
  '/api/candles': async (url, res) => {
    const market = (url.searchParams.get('market') || 'KRW-BTC').toUpperCase();
    const unit = url.searchParams.get('unit') || '60';
    const count = Math.max(30, Math.min(1000, Number(url.searchParams.get('count')) || 200));
    const periods = (url.searchParams.get('ma') || '4,20,120')
      .split(',').map((v) => Number(v.trim())).filter((v) => v > 0 && v <= 600);
    if (periods.length < 2) return sendJSON(res, 400, { success: false, message: 'ma 는 두 기간 이상이어야 합니다.' });
    sendJSON(res, 200, { success: true, data: await getSeries({ market, unit, periods, count }) });
  },

  '/api/ticker': async (url, res) => {
    const market = (url.searchParams.get('market') || 'KRW-BTC').toUpperCase();
    sendJSON(res, 200, { success: true, data: await fetchTicker(market) });
  },

  '/api/portfolio': async (_url, res) => {
    sendJSON(res, 200, { success: true, data: await getPortfolio() });
  },

  // BTC_trade_1wk 규칙 모의매매 (시작 현금 1,000만 원, 매수 현금의 3%). 봉이 바뀔 때만 결과가 달라지므로 30초 캐시.
  '/api/rule-trade': async (url, res) => {
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 7));
    const key = `rule|${days}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 30_000) return sendJSON(res, 200, { success: true, data: hit.data });
    const data = await runRuleTrade({ days });
    cache.set(key, { at: Date.now(), data });
    sendJSON(res, 200, { success: true, data });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method !== 'GET') return sendJSON(res, 405, { success: false, message: 'GET 만 지원합니다.' });

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, buf) =>
      err ? send(res, 500, 'index.html 을 읽을 수 없습니다.', 'text/plain; charset=utf-8')
          : send(res, 200, buf, 'text/html; charset=utf-8'));
  }

  const handler = routes[url.pathname];
  if (!handler) return sendJSON(res, 404, { success: false, message: 'Not found' });

  try {
    await handler(url, res);
  } catch (err) {
    console.error('[error]', url.pathname, err.message);
    sendJSON(res, 502, { success: false, message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`📈 차트 서버: http://localhost:${PORT}`);
  console.log(`   모의투자 앱 연동 대상: ${TRADER_API} (꺼져 있어도 차트는 동작합니다)`);
});
