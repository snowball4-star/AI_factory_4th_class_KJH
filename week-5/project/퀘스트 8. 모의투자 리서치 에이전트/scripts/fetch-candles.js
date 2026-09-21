#!/usr/bin/env node
'use strict';
// ============================================================
// 업비트 캔들 + 이동평균 스냅샷 수집기
//
//   node scripts/fetch-candles.js                       # KRW-BTC 1시간봉 200봉, MA 4/20/120
//   node scripts/fetch-candles.js --count 400
//   node scripts/fetch-candles.js --unit day --ma 4,20,120
//   node scripts/fetch-candles.js --market KRW-ETH --quiet
//
// data/ 에 스냅샷 JSON 을 남기고, 사람이 읽을 요약을 stdout 에 찍는다.
// 에이전트는 이 요약만 읽어도 판단에 필요한 값이 다 들어 있다.
// ============================================================

const fs = require('fs');
const path = require('path');
const { buildSeries, analyze } = require('../lib/upbit');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { market: 'KRW-BTC', unit: '60', count: 200, ma: [4, 20, 120], outDir: 'data', quiet: false, save: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--market') out.market = next().toUpperCase();
    else if (a === '--unit') out.unit = String(next());
    else if (a === '--count') out.count = Math.max(30, Math.min(2000, Number(next()) || 200));
    else if (a === '--ma') out.ma = next().split(',').map((v) => Number(v.trim())).filter((v) => v > 0);
    else if (a === '--out') out.outDir = next();
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--no-save') out.save = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  if (out.ma.length < 2) throw new Error('--ma 는 최소 두 기간이 필요합니다 (예: --ma 4,20,120)');
  return out;
}

const fmtKRW = (n) => (n == null ? '-' : Math.round(n).toLocaleString('ko-KR') + '원');
const fmtPct = (n) => (n == null ? '-' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%');

const crossLine = (c, prefix) =>
  `${prefix} MA${c.pair[0]}×MA${c.pair[1]} ${c.label}: ${c.at.replace('T', ' ')} (${c.barsAgo}봉 전, ${fmtKRW(c.price)})`;

function summarize(series, sig) {
  const L = [];
  L.push(`[${sig.market}] ${series.unitLabel} ${series.candles.length}봉 · 기준시각 ${sig.at.replace('T', ' ')} KST`);
  L.push(`현재가 ${fmtKRW(sig.price)}`);
  for (const m of sig.lines) {
    L.push(`MA${m.period} (${m.span}) ${fmtKRW(m.value)} · 이격 ${fmtPct(m.gapPct)} · 기울기 ${fmtPct(m.slopePct)}`);
  }
  L.push(`배열 ${sig.alignment} (MA${sig.fast.period}이 MA${sig.slow.period}보다 ${fmtPct(sig.spreadPct)}) · 현재가는 ${sig.position}`);
  L.push(
    sig.cross
      ? crossLine(sig.cross, '추세')
      : `추세 구간 안에 MA${sig.fast.period}×MA${sig.slow.period} 교차 없음 (${sig.window.from.slice(0, 10)} ~ ${sig.window.to.slice(0, 10)})`,
  );
  if (sig.shortCross) L.push(crossLine(sig.shortCross, '단기'));
  return L.join('\n');
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 14).join('\n').replace(/^\/\/ ?/gm, ''));
    return;
  }

  const series = await buildSeries({ market: opt.market, unit: opt.unit, periods: opt.ma, count: opt.count });
  const signals = analyze(series);

  if (opt.save) {
    const dir = path.isAbsolute(opt.outDir) ? opt.outDir : path.join(ROOT, opt.outDir);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = signals.at.replace(/[-:T]/g, '').slice(0, 12);   // YYYYMMDDHHmm (KST 봉 기준)
    const name = `${opt.market}_${series.unitLabel}_${stamp}.json`;
    const payload = { ...series, signals };
    fs.writeFileSync(path.join(dir, name), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
    if (!opt.quiet) console.log(`저장: ${path.relative(ROOT, path.join(dir, name)).replace(/\\/g, '/')}`);
  }

  if (series.incomplete) {
    console.log(`주의: 과거 봉이 모자라 앞쪽 MA${Math.max(...opt.ma)} 가 비어 있습니다.`);
  }
  console.log(summarize(series, signals));
}

main().catch((err) => {
  console.error(`실패: ${err.message}`);
  process.exit(1);
});
