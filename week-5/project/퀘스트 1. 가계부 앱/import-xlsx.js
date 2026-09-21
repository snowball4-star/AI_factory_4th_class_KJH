// 편한가계부 내보내기(xlsx)를 ledger_transactions 테이블로 가져오는 1회성 스크립트
//
//   node import-xlsx.js [파일.xlsx] [--replace]
//
// - 접속 정보는 server.js와 같이 .env(DATABASE_URL)에서 읽는다
// - 테이블에 이미 기록이 있으면 중단한다. --replace를 주면 테이블을 지우고 다시 만든 뒤 가져온다
// - 전 과정이 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않는다
const path = require('path');
const XLSX = require('xlsx');
const { pool, SCHEMA_SQL } = require('./server.js');

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const file = path.resolve(__dirname, args.find((a) => !a.startsWith('--')) || '편한가계부_26-9-18.xlsx');

const pad = (n) => String(n).padStart(2, '0');

// 엑셀 날짜 일련번호 → 'YYYY-MM-DD HH:MM:SS.mmm' (시간대 변환 없이 파일에 적힌 시각 그대로)
// 편한가계부는 밀리초까지 기록한다. 초로 자르거나 반올림하면 원본과 1초씩 어긋나므로 밀리초까지 보존한다
function excelToTimestamp(v) {
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v * 86_400_000)); // 1899-12-30 기준 일수
    return d.toISOString().slice(0, 23).replace('T', ' ');
  }
  const m = String(v || '').match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return `${m[1]}-${pad(m[2])}-${pad(m[3])} ${pad(m[4] || 0)}:${m[5] || '00'}:${m[6] || '00'}`;
}

function readRows() {
  const wb = XLSX.readFile(file);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const [header, ...rows] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  // 열 순서가 바뀌어도 되도록 헤더 이름으로 찾는다 ('자산'은 두 번 나오므로 첫 번째)
  const col = (name) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`'${name}' 열을 찾을 수 없습니다. 헤더: ${header.join(', ')}`);
    return i;
  };
  const c = {
    date: col('날짜'), asset: col('자산'), category: col('분류'), subcategory: col('소분류'), content: col('내용'),
    krw: col('KRW'), type: col('수입/지출'), memo: col('메모'), currency: col('화폐'),
  };

  const records = [];
  const skipped = [];
  rows.forEach((r, i) => {
    if (r.every((v) => v === null || v === '')) return;
    const occurredAt = excelToTimestamp(r[c.date]);
    const amount = Number(r[c.krw]);
    const type = String(r[c.type] || '').trim();
    const problem = !occurredAt ? '날짜 형식 오류'
      : !Number.isInteger(amount) ? 'KRW 금액 오류'
        : !['수입', '지출'].includes(type) ? `수입/지출 값 오류(${type})` : null;
    if (problem) return skipped.push({ row: i + 2, problem });
    records.push([
      occurredAt,
      String(r[c.asset] ?? '').trim(),
      String(r[c.category] ?? '').trim() || '미분류',
      String(r[c.subcategory] ?? '').trim(),
      String(r[c.content] ?? '').trim(),
      amount,
      type,
      String(r[c.memo] ?? '').trim(),
      String(r[c.currency] ?? 'KRW').trim() || 'KRW',
    ]);
  });
  return { records, skipped };
}

async function main() {
  const { records, skipped } = readRows();
  console.log(`파일: ${path.basename(file)} → 가져올 행 ${records.length}건, 건너뜀 ${skipped.length}건`);
  skipped.slice(0, 20).forEach((s) => console.log(`  - ${s.row}행: ${s.problem}`));

  if (!pool) throw new Error('DATABASE_URL 환경변수가 설정되지 않았습니다');
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    // 스키마가 바뀌었을 수 있으므로 --replace면 지우고 새로 만든다 (ledger_budgets는 유지)
    if (replace) await tx.query('DROP TABLE IF EXISTS ledger_transactions');
    await tx.query(SCHEMA_SQL);
    const { rows: [{ n }] } = await tx.query('SELECT COUNT(*)::int AS n FROM ledger_transactions');
    if (n > 0) {
      throw new Error(`ledger_transactions에 이미 ${n}건이 있습니다. 덮어쓰려면 --replace 옵션을 붙이세요`);
    }

    const BATCH = 500;
    for (let i = 0; i < records.length; i += BATCH) {
      const chunk = records.slice(i, i + BATCH);
      const values = chunk.map((_, j) => `(${Array.from({ length: 9 }, (_, k) => `$${j * 9 + k + 1}`).join(', ')})`);
      await tx.query(
        `INSERT INTO ledger_transactions (occurred_at, asset, category, subcategory, content, amount, type, memo, currency)
         VALUES ${values.join(', ')}`,
        chunk.flat(),
      );
      process.stdout.write(`\r  입력 중… ${Math.min(i + BATCH, records.length)}/${records.length}`);
    }
    await tx.query('COMMIT');
    console.log('\n완료');

    const { rows } = await tx.query(`
      SELECT type, COUNT(*)::int AS n, SUM(amount) AS total,
             to_char(MIN(occurred_at), 'YYYY-MM-DD') AS first, to_char(MAX(occurred_at), 'YYYY-MM-DD') AS last
      FROM ledger_transactions GROUP BY type ORDER BY type`);
    console.table(rows);
  } catch (err) {
    await tx.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}

main()
  .catch((err) => { console.error('\n가져오기 실패:', err.message); process.exitCode = 1; })
  .finally(() => pool && pool.end());
