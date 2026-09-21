#!/usr/bin/env node
'use strict';
// ============================================================
// BTC_trade_1wk — 규칙 기반 1주일 모의매매 CLI (KRW-BTC 1시간봉 종가 기준)
// 규칙과 계산은 lib/rule-trade.js, 규칙 원문은 BTC_trade_1wk.md
//
// 사용법
//   node scripts/trade-1wk.js                 # 최근 168봉(7일), 시작 현금 10,000,000원, 매수 현금의 3%
//   node scripts/trade-1wk.js --cash 5000000  # 시작 현금 바꾸기
//   node scripts/trade-1wk.js --days 3        # 기간 바꾸기
//   node scripts/trade-1wk.js --no-save       # 일지 파일을 만들지 않음
// ============================================================

const fs = require('fs');
const path = require('path');
const { runRuleTrade, START_CASH } = require('../lib/rule-trade');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const CASH = Number(arg('cash', START_CASH));
const DAYS = Number(arg('days', 7));
const SAVE = !process.argv.includes('--no-save');

const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
const btc = (n) => `${n.toFixed(8)} BTC`;
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const hm = (kst) => kst.replace('T', ' ').slice(0, 16);

(async () => {
  const r = await runRuleTrade({ days: DAYS, cash: CASH });
  const a = r.account, n = r.now;
  const ratioPct = `${+(r.params.buyRatio * 100).toFixed(2)}%`;

  // ── 콘솔 요약 ──
  console.log(`[BTC_trade_1wk] KRW-BTC 1시간봉 ${r.window.bars}봉 · ${hm(r.window.from)} ~ ${hm(r.window.to)} KST · 매수 현금의 ${ratioPct}`);
  console.log(`시작 현금 ${won(CASH)} → 평가자산 ${won(a.equity)} (${pct(a.returnPct)}) · 같은 기간 단순보유 ${pct(r.holdReturnPct)}`);
  console.log(`체결 매수 ${r.counts.buy}회 · 매도① ${r.counts.sell1}회 · 매도② ${r.counts.sell2}회 · 수수료 ${won(a.fees)}`);
  console.log(`보유 ${btc(a.qty)}${a.avgPrice ? ` (평단 ${won(a.avgPrice)})` : ''} · 현금 ${won(a.cash)} · 실현손익 ${won(a.realized)}`);
  console.log(`마지막 완성 봉 종가 ${won(n.close)} · MA4 ${won(n.ma4)} · MA20 ${won(n.ma20)} · MA120 ${won(n.ma120)}`);
  console.log(`이 봉의 규칙 판정: ${n.signal ? `${n.signal.rule} (${n.signal.why})` : '해당 없음'} · 진행 중인 봉 ${won(r.live.close)}`);

  if (!SAVE) return;

  // ── 일지 저장 ──
  const rows = r.trades.map((t) => t.skipped
    ? `| ${hm(t.at)} | ${t.rule} | ${t.why} | - | - | - | 건너뜀: ${t.skipped} |`
    : `| ${hm(t.at)} | ${t.rule} | ${t.why} | ${won(t.price)} | ${t.qty.toFixed(8)} | ${won(t.krw)} | ${t.pnl != null ? `실현 ${won(t.pnl)}` : ''} |`);
  const flags = `${CASH !== START_CASH ? ` --cash ${CASH}` : ''}${DAYS !== 7 ? ` --days ${DAYS}` : ''}`;

  const md = `# BTC_trade_1wk 규칙 모의매매 (${r.window.from.slice(0, 10)} ~ ${r.window.to.slice(0, 10)})

- 대상: 업비트 KRW-BTC 1시간봉 ${r.window.bars}봉 (${hm(r.window.from)} ~ ${hm(r.window.to)} KST, 완성된 봉만)
- 규칙: [BTC_trade_1wk.md](../BTC_trade_1wk.md) · 매수는 보유 현금의 ${ratioPct} · 체결가는 신호가 난 봉의 종가, 수수료 편도 0.05%
- 생성: \`node scripts/trade-1wk.js${flags}\` (${new Date().toISOString().slice(0, 10)})

> 요약: 시작 현금 ${won(CASH)} → 평가자산 **${won(a.equity)} (${pct(a.returnPct)})**.
> 같은 기간 BTC를 처음부터 들고 있었다면 **${pct(r.holdReturnPct)}** 이었다.

## 1. 결과

| 항목 | 값 |
|---|---|
| 시작 현금 | ${won(CASH)} |
| 기말 현금 | ${won(a.cash)} |
| 보유 수량 | ${btc(a.qty)}${a.avgPrice ? ` (평단 ${won(a.avgPrice)})` : ''} |
| 보유분 평가 | ${won(a.evalAmt)}${a.unrealizedPct != null ? ` (평가손익 ${won(a.unrealized)}, ${pct(a.unrealizedPct)})` : ''} |
| 평가자산 | ${won(a.equity)} (${pct(a.returnPct)}) |
| 실현손익 | ${won(a.realized)} |
| 수수료 합계 | ${won(a.fees)} |
| 체결 횟수 | 매수 ${r.counts.buy} · 매도① ${r.counts.sell1} · 매도② ${r.counts.sell2} |
| 단순보유 비교 | ${won(r.firstClose)} → ${won(n.close)} (${pct(r.holdReturnPct)}) |

## 2. 체결 내역

${r.trades.length ? `| 시각 (KST) | 규칙 | 조건 | 체결가 | 수량 (BTC) | 금액 | 비고 |
|---|---|---|---:|---:|---:|---|
${rows.join('\n')}` : '기간 중 규칙에 맞는 봉이 없었다.'}

## 3. 지금 상태 (마지막 완성 봉 ${hm(n.at)})

| 값 | |
|---|---:|
| 종가 | ${won(n.close)} |
| MA4 | ${won(n.ma4)} |
| MA20 | ${won(n.ma20)} |
| MA120 | ${won(n.ma120)} |

| 조건 | 지금 |
|---|---|
${n.checks.map(([k, v]) => `| ${k} | ${v ? '예' : '아니오'} |`).join('\n')}

이 봉의 규칙 판정: **${n.signal ? `${n.signal.rule} — ${n.signal.why}` : '해당 없음 (대기)'}**

모의투자 연습용 기록이며 투자 판단의 근거가 아니다.
`;

  const dir = path.join(__dirname, '..', 'journal');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `BTC_trade_1wk_${r.window.to.slice(0, 10)}.md`);
  fs.writeFileSync(file, md);
  console.log(`저장: ${path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/')}`);
})().catch((e) => { console.error(`오류: ${e.message}`); process.exit(1); });
