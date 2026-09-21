'use strict';
// ============================================================
// BTC_trade_1wk 규칙 모의매매 (KRW-BTC 1시간봉 종가 기준)
//
// 규칙 원문: BTC_trade_1wk.md
//   매수   MA20 > MA120 이고 MA4 < 종가 < MA20          → 보유 현금의 3% 매수
//   매도①  MA4×MA20 데드크로스 후 종가 > MA4            → 보유 수량의 50% 매도 (데드크로스 1회당 1번)
//   매도②  MA20×MA120 데드크로스 후 종가 > MA20         → 보유 수량 전량 매도
//
// CLI(scripts/trade-1wk.js)와 차트 서버(server.js)가 같은 계산을 쓰도록 여기 모아 둔다.
// ============================================================

const { buildSeries } = require('./upbit');

const START_CASH = 10_000_000;               // 모의매매 시작 현금
const BUY_RATIO = 0.03;                      // 매수: 보유 현금의 3%
const FEE = 0.0005;                          // 업비트 KRW 마켓 편도 수수료 0.05%
const MIN_ORDER = 5000;                      // 업비트 최소 주문 금액

// 한 봉의 규칙 판정. 매도가 매수보다 우선한다.
function decide(c, st, buyRatio) {
  const { 4: m4, 20: m20, 120: m120 } = c.ma;
  if (st.qty > 0 && m20 < m120 && c.close > m20) return { rule: '매도②', why: 'MA20<MA120(데드크로스 후) · 종가>MA20', sellRatio: 1 };
  if (st.qty > 0 && st.shortArmed && m4 < m20 && c.close > m4) return { rule: '매도①', why: 'MA4<MA20(데드크로스 후) · 종가>MA4', sellRatio: 0.5 };
  if (m20 > m120 && c.close < m20 && c.close > m4) return { rule: '매수', why: 'MA20>MA120 · MA4<종가<MA20', buyRatio };
  return null;
}

// 완성된 봉 배열(MA4/20/120 포함)에 규칙을 차례로 적용한다.
function simulate(cs, { cash = START_CASH, buyRatio = BUY_RATIO } = {}) {
  if (!cs.length || cs[0].ma[120] == null) throw new Error('MA120을 채울 과거 봉이 부족합니다');

  const st = {
    cash, qty: 0, cost: 0, fees: 0, realized: 0,
    // 시작 시점에 이미 MA4<MA20 이면 직전 교차가 데드크로스였으므로 매도①이 대기 상태다
    shortArmed: cs[0].ma[4] < cs[0].ma[20],
  };
  const trades = [];

  for (let i = 0; i < cs.length; i++) {
    const c = cs[i], p = cs[i - 1];
    if (p) {
      if (p.ma[4] >= p.ma[20] && c.ma[4] < c.ma[20]) st.shortArmed = true;    // 새 데드크로스
      if (p.ma[4] <= p.ma[20] && c.ma[4] > c.ma[20]) st.shortArmed = false;   // 골든크로스로 해제
    }
    const d = decide(c, st, buyRatio);
    if (!d) continue;
    const base = { at: c.kst, tsKst: c.tsKst, rule: d.rule, why: d.why, price: c.close };

    if (d.buyRatio) {
      const krw = Math.floor(st.cash * d.buyRatio);
      if (krw < MIN_ORDER) { trades.push({ ...base, skipped: `주문금액 ${krw}원 < 최소 ${MIN_ORDER}원` }); continue; }
      const fee = krw * FEE;
      const qty = (krw - fee) / c.close;
      st.cash -= krw; st.qty += qty; st.cost += krw; st.fees += fee;
      trades.push({ ...base, side: 'buy', qty, krw, fee });
    } else {
      const qty = st.qty * d.sellRatio;
      const gross = qty * c.close;
      const fee = gross * FEE;
      const costPart = st.cost * d.sellRatio;
      const pnl = gross - fee - costPart;
      st.cash += gross - fee; st.qty -= qty; st.cost -= costPart; st.fees += fee; st.realized += pnl;
      if (d.rule === '매도①') st.shortArmed = false;                            // 데드크로스 1회당 1번
      trades.push({ ...base, side: 'sell', qty, krw: gross, fee, pnl });
    }
  }

  const last = cs[cs.length - 1];
  const { 4: m4, 20: m20, 120: m120 } = last.ma;
  const count = (r) => trades.filter((t) => t.rule === r && !t.skipped).length;
  const evalAmt = st.qty * last.close;
  const equity = st.cash + evalAmt;
  const avgPrice = st.qty > 0 ? st.cost / st.qty : null;
  const next = decide(last, st, buyRatio);

  return {
    params: { startCash: cash, buyRatio, fee: FEE },
    window: { bars: cs.length, from: cs[0].kst, to: last.kst },
    trades,
    account: {
      cash: st.cash,
      qty: st.qty,
      avgPrice,
      invested: st.cost,                                   // 보유 수량의 매수원가 (수수료 포함)
      evalAmt,
      unrealized: evalAmt - st.cost,
      unrealizedPct: st.cost > 0 ? (evalAmt / st.cost - 1) * 100 : null,
      realized: st.realized,
      fees: st.fees,
      equity,
      returnPct: (equity / cash - 1) * 100,
    },
    holdReturnPct: (last.close / cs[0].close - 1) * 100,
    firstClose: cs[0].close,
    counts: { buy: count('매수'), sell1: count('매도①'), sell2: count('매도②') },
    now: {
      at: last.kst, close: last.close, ma4: m4, ma20: m20, ma120: m120,
      checks: [
        ['MA20 > MA120', m20 > m120],
        ['종가 < MA20', last.close < m20],
        ['종가 > MA4', last.close > m4],
        ['MA4 < MA20 (단기 데드크로스 상태)', m4 < m20],
        ['매도① 대기 중', st.shortArmed],
      ],
      signal: next ? { rule: next.rule, why: next.why } : null,
    },
  };
}

// 업비트에서 최근 N일(1시간봉 N×24개)을 받아 모의매매한다. 진행 중인 마지막 봉은 뺀다.
async function runRuleTrade({ days = 7, cash = START_CASH, buyRatio = BUY_RATIO } = {}) {
  const series = await buildSeries({ unit: 60, periods: [4, 20, 120], count: days * 24 + 1 });
  const live = series.candles[series.candles.length - 1];
  const result = simulate(series.candles.slice(0, -1), { cash, buyRatio });
  return { ...result, days, live: { at: live.kst, close: live.close } };
}

module.exports = { runRuleTrade, simulate, decide, START_CASH, BUY_RATIO, FEE, MIN_ORDER };
