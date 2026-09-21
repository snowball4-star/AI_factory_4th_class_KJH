const express = require('express');
const path = require('path');
const fs = require('fs');
const { Pool, types } = require('pg');

// ── Env (.env 직접 파싱, dotenv 의존성 없음) ────
// 로컬 개발용. Vercel 등에서는 대시보드에 설정한 환경변수를 그대로 쓴다
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  });
} catch { /* .env 없음 → 시스템 환경변수 사용 */ }

// ── App init & config ────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

// DATE·TIMESTAMP는 문자열 그대로(KST 벽시계 시각 유지), BIGINT·NUMERIC(SUM 결과)은 숫자로 받는다
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1114, (v) => v);
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

// DB에 아직 기록이 없을 때 쓰는 기본 분류 (편한가계부 분류 체계)
const DEFAULT_CATEGORIES = {
  expense: ['식사', '교통비', '사회생활', '생활품', '문화', '건강', '경조사', '교육', '미용', '의복', '자기계발', '투자', '빚이자세금', '기타'],
  income: ['월급', '보너스', '수당', '기타소득'],
};

// API는 income/expense, DB는 편한가계부 원본 값(수입/지출)을 그대로 저장한다
const TYPE_TO_DB = { income: '수입', expense: '지출' };

const pad = (n) => String(n).padStart(2, '0');
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toMonthStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// 월의 [시작일, 다음 달 시작일) 범위 — occurred_at 인덱스를 그대로 탄다
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  return [`${month}-01`, toDateStr(new Date(y, m, 1))];
}

const TX_COLUMNS = `id,
  CASE type WHEN '수입' THEN 'income' ELSE 'expense' END AS type,
  amount, category, subcategory, asset, content, memo, currency,
  to_char(occurred_at, 'YYYY-MM-DD') AS date,
  to_char(occurred_at, 'HH24:MI') AS time,
  created_at AS "createdAt"`;

// ── DB init (lazy, 서버리스 cold start 대응) ───
// 컬럼은 편한가계부 내보내기(xlsx) 항목과 1:1로 대응한다. 원본의 '금액'·두 번째 '자산' 열은 KRW와 값이 같아 저장하지 않는다
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ledger_transactions (
    id           SERIAL PRIMARY KEY,
    occurred_at  TIMESTAMP NOT NULL,
    asset        TEXT      NOT NULL DEFAULT '',
    category     TEXT      NOT NULL,
    subcategory  TEXT      NOT NULL DEFAULT '',
    content      TEXT      NOT NULL DEFAULT '',
    amount       BIGINT    NOT NULL,
    type         TEXT      NOT NULL CHECK (type IN ('수입', '지출')),
    memo         TEXT      NOT NULL DEFAULT '',
    currency     CHAR(3)   NOT NULL DEFAULT 'KRW',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS ledger_transactions_occurred_idx ON ledger_transactions (occurred_at);
  CREATE INDEX IF NOT EXISTS ledger_transactions_type_cat_idx ON ledger_transactions (type, category);
  COMMENT ON TABLE  ledger_transactions IS '개인 가계부 거래 내역 (편한가계부 xlsx 항목 기준)';
  COMMENT ON COLUMN ledger_transactions.occurred_at IS '날짜: 거래 일시 (KST, 편한가계부 원본의 밀리초까지 보존)';
  COMMENT ON COLUMN ledger_transactions.asset       IS '자산: 결제 수단 (카드·은행·현금 등)';
  COMMENT ON COLUMN ledger_transactions.category    IS '분류';
  COMMENT ON COLUMN ledger_transactions.subcategory IS '소분류';
  COMMENT ON COLUMN ledger_transactions.content     IS '내용: 가맹점·거래 설명';
  COMMENT ON COLUMN ledger_transactions.amount      IS 'KRW: 원 단위 금액. 취소·환불은 음수';
  COMMENT ON COLUMN ledger_transactions.type        IS '수입/지출';
  COMMENT ON COLUMN ledger_transactions.memo        IS '메모: 카드 승인 문자 원문 등';
  COMMENT ON COLUMN ledger_transactions.currency    IS '화폐';

  CREATE TABLE IF NOT EXISTS ledger_budgets (
    month   CHAR(7) PRIMARY KEY,
    amount  BIGINT NOT NULL CHECK (amount >= 0)
  );
  COMMENT ON TABLE ledger_budgets IS '월별 지출 예산 (YYYY-MM → 원)';
`;

let dbInitPromise = null;

function ensureDB() {
  if (!pool) return Promise.reject(new Error('DATABASE_URL 환경변수가 설정되지 않았습니다'));
  if (!dbInitPromise) {
    dbInitPromise = pool.query(SCHEMA_SQL).catch((err) => { dbInitPromise = null; throw err; });
  }
  return dbInitPromise;
}

// ── Helpers ──────────────────────────────────
function validateTransaction(body, partial = false) {
  const errors = [];
  const { type, amount, category, asset, content, memo, date, time } = body || {};
  const has = (v) => !partial || v !== undefined;
  if (has(type) && !TYPE_TO_DB[type]) errors.push('type은 income 또는 expense여야 합니다');
  if (has(amount)) {
    const n = Number(amount);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > 10_000_000_000) errors.push('amount는 0이 아닌 정수(원)여야 합니다 (취소·환불은 음수)');
  }
  if (has(category) && (typeof category !== 'string' || !category.trim() || category.length > 30)) errors.push('category(분류)는 30자 이하로 필수입니다');
  if (has(date) && (typeof date !== 'string' || !DATE_RE.test(date) || isNaN(new Date(date)))) errors.push('date는 YYYY-MM-DD 형식이어야 합니다');
  if (time !== undefined && time !== '' && (typeof time !== 'string' || !TIME_RE.test(time))) errors.push('time은 HH:MM 형식이어야 합니다');
  if (asset !== undefined && (typeof asset !== 'string' || asset.length > 50)) errors.push('asset(자산)은 50자 이하여야 합니다');
  if (content !== undefined && (typeof content !== 'string' || content.length > 200)) errors.push('content(내용)는 200자 이하여야 합니다');
  if (memo !== undefined && (typeof memo !== 'string' || memo.length > 2000)) errors.push('memo는 2000자 이하여야 합니다');
  return errors;
}

const badMonth = (res) => res.status(400).json({ success: false, message: 'month는 YYYY-MM 형식이어야 합니다' });
const notFound = (res) => res.status(404).json({ success: false, message: '거래를 찾을 수 없습니다' });
const trimOrNull = (v) => (v === undefined ? null : String(v).trim());

// ── Middleware ───────────────────────────────
app.use(express.json());
// .env·server.js·node_modules가 정적 파일로 새어 나가지 않도록 index.html만 서빙한다
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use('/api', async (_req, res, next) => {
  try {
    await ensureDB();
    next();
  } catch (err) {
    console.error('DB init failed:', err.message);
    res.status(500).json({
      success: false,
      message: pool ? '데이터베이스 초기화에 실패했습니다' : 'DATABASE_URL 환경변수가 설정되지 않았습니다',
    });
  }
});

// ── API routes: GET ──────────────────────────
// 입력 폼 선택지: 실제 기록에서 많이 쓴 분류 순, 최근에 쓴 자산 순
app.get('/api/meta', async (_req, res) => {
  try {
    const [cats, assets, range] = await Promise.all([
      pool.query(`SELECT type, category, COUNT(*)::int AS n FROM ledger_transactions
                  WHERE category NOT IN ('미분류', '잔액수정') GROUP BY type, category ORDER BY n DESC`),
      pool.query(`SELECT asset, MAX(occurred_at) AS last FROM ledger_transactions
                  WHERE asset <> '' GROUP BY asset ORDER BY last DESC`),
      pool.query(`SELECT to_char(MIN(occurred_at), 'YYYY-MM') AS first, to_char(MAX(occurred_at), 'YYYY-MM') AS last,
                         COUNT(*)::int AS total FROM ledger_transactions`),
    ]);
    const pick = (t, fallback) => {
      const list = cats.rows.filter((r) => r.type === t).map((r) => r.category);
      return list.length ? list : fallback;
    };
    res.json({
      success: true,
      data: {
        categories: { expense: pick('지출', DEFAULT_CATEGORIES.expense), income: pick('수입', DEFAULT_CATEGORIES.income) },
        assets: assets.rows.map((r) => r.asset),
        ...range.rows[0],
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '분류·자산 목록을 불러오지 못했습니다' });
  }
});

// 거래 목록: ?month=YYYY-MM&type=&category=&asset=&q=
app.get('/api/transactions', async (req, res) => {
  try {
    const { month, type, category, asset, q } = req.query;
    if (month && !MONTH_RE.test(month)) return badMonth(res);
    const where = [];
    const params = [];
    const add = (sql, ...values) => {
      params.push(...values);
      where.push(sql.replace(/\$(\d)/g, (_, i) => `$${params.length - values.length + Number(i)}`));
    };
    if (month) add('occurred_at >= $1 AND occurred_at < $2', ...monthRange(month));
    if (type && TYPE_TO_DB[type]) add('type = $1', TYPE_TO_DB[type]);
    if (category) add('category = $1', category);
    if (asset) add('asset = $1', asset);
    if (q) {
      add('(content ILIKE $1 OR memo ILIKE $1 OR category ILIKE $1 OR asset ILIKE $1)',
        `%${String(q).replace(/[\\%_]/g, '\\$&')}%`);
    }
    const { rows } = await pool.query(
      `SELECT ${TX_COLUMNS} FROM ledger_transactions
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY occurred_at DESC, id DESC
       LIMIT 2000`,
      params,
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '거래 목록을 불러오지 못했습니다' });
  }
});

// 월간 요약: 수입·지출·잔액·분류별·일별·예산
app.get('/api/summary', async (req, res) => {
  try {
    const month = req.query.month || toMonthStr(new Date());
    if (!MONTH_RE.test(month)) return badMonth(res);
    const range = monthRange(month);

    const [totals, byCategory, daily, budget] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE type = '수입'), 0) AS income,
                COALESCE(SUM(amount) FILTER (WHERE type = '지출'), 0) AS expense,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (WHERE type = '지출')::int AS "expenseCount"
         FROM ledger_transactions WHERE occurred_at >= $1 AND occurred_at < $2`, range),
      pool.query(
        `SELECT category, SUM(amount) AS amount FROM ledger_transactions
         WHERE type = '지출' AND occurred_at >= $1 AND occurred_at < $2
         GROUP BY category HAVING SUM(amount) > 0 ORDER BY amount DESC`, range),
      pool.query(
        `SELECT d::date AS date,
                COALESCE(SUM(t.amount) FILTER (WHERE t.type = '수입'), 0) AS income,
                COALESCE(SUM(t.amount) FILTER (WHERE t.type = '지출'), 0) AS expense
         FROM generate_series($1::date, $2::date - 1, interval '1 day') AS d
         LEFT JOIN ledger_transactions t ON t.occurred_at >= d AND t.occurred_at < d + interval '1 day'
         GROUP BY d ORDER BY d`, range),
      pool.query('SELECT amount FROM ledger_budgets WHERE month = $1', [month]),
    ]);

    const { income, expense, count, expenseCount } = totals.rows[0];
    res.json({
      success: true,
      data: {
        month,
        income,
        expense,
        balance: income - expense,
        count,
        expenseCount,
        budget: budget.rows[0]?.amount || 0,
        byCategory: byCategory.rows,
        daily: daily.rows,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '요약을 계산하지 못했습니다' });
  }
});

// 최근 N개월 추이: ?months=6&end=YYYY-MM
app.get('/api/trend', async (req, res) => {
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
    const end = req.query.end && MONTH_RE.test(req.query.end) ? req.query.end : toMonthStr(new Date());
    const { rows } = await pool.query(
      `SELECT to_char(m, 'YYYY-MM') AS month,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = '수입'), 0) AS income,
              COALESCE(SUM(t.amount) FILTER (WHERE t.type = '지출'), 0) AS expense
       FROM generate_series($1::date - make_interval(months => $2 - 1), $1::date, interval '1 month') AS m
       LEFT JOIN ledger_transactions t ON t.occurred_at >= m AND t.occurred_at < m + interval '1 month'
       GROUP BY m ORDER BY m`,
      [`${end}-01`, months],
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '추이를 계산하지 못했습니다' });
  }
});

// ── API routes: POST ─────────────────────────
app.post('/api/transactions', async (req, res) => {
  try {
    const errors = validateTransaction(req.body);
    if (errors.length) return res.status(400).json({ success: false, message: errors.join(', ') });
    const { type, amount, category, asset = '', content = '', memo = '', date, time } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO ledger_transactions (occurred_at, asset, category, content, amount, type, memo)
       VALUES ($1::date + $2::time, $3, $4, $5, $6, $7, $8) RETURNING ${TX_COLUMNS}`,
      [date, time || '12:00', asset.trim(), category.trim(), content.trim(), Number(amount), TYPE_TO_DB[type], memo.trim()],
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '거래를 저장하지 못했습니다' });
  }
});

// ── API routes: PUT ──────────────────────────
app.put('/api/transactions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return notFound(res);
    const errors = validateTransaction(req.body, true);
    if (errors.length) return res.status(400).json({ success: false, message: errors.join(', ') });
    const { type, amount, category, asset, content, memo, date, time } = req.body;
    // 보내지 않은 필드(null)는 기존 값을 유지한다. 날짜·시각은 각각 따로 바꿀 수 있다
    const { rows } = await pool.query(
      `UPDATE ledger_transactions SET
         type        = COALESCE($2, type),
         amount      = COALESCE($3, amount),
         category    = COALESCE($4, category),
         asset       = COALESCE($5, asset),
         content     = COALESCE($6, content),
         memo        = COALESCE($7, memo),
         occurred_at = COALESCE($8::date, occurred_at::date) + COALESCE($9::time, occurred_at::time)
       WHERE id = $1 RETURNING ${TX_COLUMNS}`,
      [id, type ? TYPE_TO_DB[type] : null, amount !== undefined ? Number(amount) : null,
        trimOrNull(category), trimOrNull(asset), trimOrNull(content), trimOrNull(memo),
        date ?? null, time || null],
    );
    if (!rows.length) return notFound(res);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '거래를 수정하지 못했습니다' });
  }
});

app.put('/api/budgets/:month', async (req, res) => {
  try {
    const { month } = req.params;
    if (!MONTH_RE.test(month)) return badMonth(res);
    const amount = Number((req.body || {}).amount);
    if (!Number.isInteger(amount) || amount < 0) {
      return res.status(400).json({ success: false, message: '예산은 0 이상의 정수(원)여야 합니다' });
    }
    await pool.query(
      `INSERT INTO ledger_budgets (month, amount) VALUES ($1, $2)
       ON CONFLICT (month) DO UPDATE SET amount = EXCLUDED.amount`,
      [month, amount],
    );
    res.json({ success: true, data: { month, amount } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '예산을 저장하지 못했습니다' });
  }
});

// ── API routes: DELETE ───────────────────────
app.delete('/api/transactions/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return notFound(res);
    const { rows } = await pool.query(`DELETE FROM ledger_transactions WHERE id = $1 RETURNING ${TX_COLUMNS}`, [id]);
    if (!rows.length) return notFound(res);
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '거래를 삭제하지 못했습니다' });
  }
});

// 정의되지 않은 API 경로는 SPA fallback으로 넘기지 않고 JSON 404
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API입니다' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '잘못된 JSON 형식입니다' });
  }
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Startup & export ─────────────────────────
if (require.main === module) {
  app.listen(PORT, () => console.log(`가계부 서버 실행 중: http://localhost:${PORT}`));
}
module.exports = app;
// import-xlsx.js가 같은 연결·스키마를 재사용한다
module.exports.pool = pool;
module.exports.SCHEMA_SQL = SCHEMA_SQL;
