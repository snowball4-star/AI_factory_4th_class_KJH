// ============================================================
// 💸 익명 월급/지출 비교 - Single File Backend (server.js)
//
// - 제출 데이터는 PostgreSQL(Supabase)의 pay_entries 테이블에 저장한다.
//   (같은 DB를 다른 과제 앱도 쓰므로 테이블 이름에 pay_ 접두사를 붙였다)
// - 접속 문자열은 코드에 넣지 않고 환경변수 DATABASE_URL 에서만 읽는다.
//   브라우저는 /api/... 만 호출하며 DB 정보는 절대 내려가지 않는다.
// - 로그인이 없는 익명 앱이다. 브라우저가 만든 무작위 익명 ID(X-Client-Id 헤더)는
//   SHA-256 해시로만 저장하고, "한 브라우저 = 한 건"으로 덮어써 중복 집계를 막는다.
// - 개별 행은 절대 응답하지 않는다. 집계도 표본이 MIN_GROUP_SIZE 명 미만인 그룹은
//   숨겨서, 소수 인원의 값이 역산되지 않게 한다.
// - 로컬(node server.js) / Vercel 서버리스 듀얼 모드.
// ============================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

// 로컬 개발용: 같은 폴더의 .env 를 읽는다 (.env 는 gitignore 대상).
// Vercel 등 배포 환경에서는 플랫폼 환경변수를 그대로 쓴다.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (_) {
  /* .env 가 없으면 무시 */
}

const app = express();
const PORT = process.env.PORT || 3000;

// 환경변수에 trailing newline 이 붙는 경우가 있어 항상 .trim()
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

// ── 입력 항목 정의 (프런트는 /api/meta 로 받아 쓴다) ──
const JOBS = [
  '개발', '데이터·AI', '디자인', '기획·PM', '마케팅', '영업', '경영지원',
  '금융', '의료·보건', '교육', '연구·R&D', '생산·제조', '서비스·유통', '공공·공무원', '기타',
];
const COMPANIES = ['대기업', '중견기업', '중소기업', '스타트업', '공공기관', '외국계', '프리랜서·자영업'];

// 연차 구간: SQL width_bucket(years, ARRAY[1,3,6,10,15]) 결과(0~5)와 1:1 대응
const CAREER_EDGES = [1, 3, 6, 10, 15];
const CAREERS = ['1년 미만', '1~2년', '3~5년', '6~9년', '10~14년', '15년 이상']
  .map((label, id) => ({ id, label }));

// 지출 카테고리: key 는 컬럼명(exp_<key>)으로도 쓰이므로 반드시 영문 소문자 상수만
const CATEGORIES = [
  { key: 'food',         label: '식비',      emoji: '🍚', hint: '장보기·외식·배달·카페' },
  { key: 'housing',      label: '주거',      emoji: '🏠', hint: '월세·관리비·대출이자·공과금' },
  { key: 'transport',    label: '교통',      emoji: '🚌', hint: '대중교통·주유·주차·택시' },
  { key: 'subscription', label: '구독료',    emoji: '📺', hint: 'OTT·음악·클라우드·멤버십' },
  { key: 'telecom',      label: '통신',      emoji: '📱', hint: '휴대폰·인터넷' },
  { key: 'shopping',     label: '쇼핑·생활', emoji: '🛍️', hint: '의류·생필품·미용' },
  { key: 'leisure',      label: '여가·문화', emoji: '🎬', hint: '여행·취미·운동·모임' },
  { key: 'etc',          label: '기타',      emoji: '🧾', hint: '보험·의료·경조사·교육 등' },
];
const EXP_COLS = CATEGORIES.map((c) => `exp_${c.key}`);

// ── 검증 규칙 / 집계 규칙 (금액 단위: 원) ──────
const SALARY_MIN   = 500_000;       // 50만원
const SALARY_MAX   = 100_000_000;   // 1억원
const CATEGORY_MAX = 50_000_000;    // 카테고리당 5,000만원
const YEARS_MAX    = 50;
const MIN_GROUP_SIZE = 3;           // 이 인원 미만 그룹은 통계를 숨긴다
const CLIENT_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

// 분포 히스토그램 구간 경계 (width_bucket 용, 원)
const SALARY_EDGES  = [2_000_000, 2_500_000, 3_000_000, 3_500_000, 4_000_000, 5_000_000, 6_000_000, 8_000_000];
const EXPENSE_EDGES = [500_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000, 4_000_000];

// ── DB 풀 ────────────────────────────────────
// Supabase pooler(6543)는 TLS 필수. 자체 서명 체인이라 rejectUnauthorized: false.
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

pool && pool.on('error', (err) => console.error('[pg pool error]', err.message));

// ── Lazy init (cold start 대비 1회만) ─────────
// pay_entries : 익명 ID 해시(유니크) / 직군 / 기업 규모 / 연차 / 월 실수령액 /
//               카테고리별 월지출 + 총지출(생성 컬럼, 집계 편의용)
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  const expDefs = EXP_COLS
    .map((col) => `${col} INT NOT NULL DEFAULT 0 CHECK (${col} BETWEEN 0 AND ${CATEGORY_MAX})`)
    .join(',\n      ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pay_entries (
      id          BIGSERIAL   PRIMARY KEY,
      client_hash TEXT        NOT NULL UNIQUE,
      job         TEXT        NOT NULL,
      company     TEXT        NOT NULL,
      years       INT         NOT NULL CHECK (years BETWEEN 0 AND ${YEARS_MAX}),
      salary      INT         NOT NULL CHECK (salary BETWEEN ${SALARY_MIN} AND ${SALARY_MAX}),
      ${expDefs},
      expense     BIGINT      GENERATED ALWAYS AS (${EXP_COLS.join(' + ')}) STORED,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS pay_entries_job_idx ON pay_entries (job)');
  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────
// 원본 익명 ID는 저장하지 않고 해시만 비교한다
const getClientHash = (req) => {
  const id = String(req.get('X-Client-Id') || '').trim();
  return CLIENT_ID_RE.test(id) ? crypto.createHash('sha256').update(`pay:${id}`).digest('hex') : null;
};

const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));

// SQL 조각: 저축률(0~1, 지출이 월급보다 크면 음수)과 연차 구간
const SAVINGS_SQL = '((salary - expense)::float8 / salary)';
const CAREER_SQL  = `width_bucket(years, ARRAY[${CAREER_EDGES.join(',')}])`;

// 필터(?job=&company=&career=)를 파라미터 바인딩 WHERE 절로 만든다
function parseFilters(query) {
  const job = JOBS.includes(query.job) ? query.job : null;
  const company = COMPANIES.includes(query.company) ? query.company : null;
  const careerNum = parseInt(query.career, 10);
  const career = CAREERS.some((c) => c.id === careerNum) ? careerNum : null;
  return { job, company, career };
}

const FILTER_SQL = `($1::text IS NULL OR job = $1)
         AND ($2::text IS NULL OR company = $2)
         AND ($3::int  IS NULL OR ${CAREER_SQL} = $3)`;

const filterParams = (f) => [f.job, f.company, f.career];

// width_bucket 결과 → 모든 구간이 채워진 히스토그램 배열
function toHistogram(rows, edges) {
  const counts = Object.fromEntries(rows.map((r) => [r.b, r.count]));
  return Array.from({ length: edges.length + 1 }, (_, i) => ({
    from: i === 0 ? 0 : edges[i - 1],
    to: i === edges.length ? null : edges[i],
    count: counts[i] || 0,
  }));
}

// 상위 %: 나보다 값이 큰 사람 수 + 1 을 등수로 보고 전체 인원으로 나눈다.
// 내가 그 그룹에 속하지 않으면 "나를 그 그룹에 넣었다고 가정"해 인원을 +1 한다.
const topPercent = (greater, n, inGroup) => {
  const total = inGroup ? n : n + 1;
  return Math.round(((greater + 1) / total) * 1000) / 10;
};

function toEntry(row) {
  const expenses = Object.fromEntries(CATEGORIES.map((c) => [c.key, Number(row[`exp_${c.key}`])]));
  return {
    job: row.job,
    company: row.company,
    years: Number(row.years),
    career: Number(row.career),
    salary: Number(row.salary),
    expense: Number(row.expense),
    expenses,
    updatedAt: row.updated_at,
  };
}

// 요청 body 검증 → 정상이면 { value }, 아니면 { error }
function validateEntry(body) {
  const { job, company, years, salary, expenses } = body || {};
  if (!JOBS.includes(job)) return { error: '직군을 선택해 주세요.' };
  if (!COMPANIES.includes(company)) return { error: '기업 규모를 선택해 주세요.' };

  const y = Number(years);
  if (!Number.isInteger(y) || y < 0 || y > YEARS_MAX) {
    return { error: `연차는 0~${YEARS_MAX} 사이의 정수로 입력해 주세요.` };
  }

  const s = Math.round(Number(salary));
  if (!Number.isFinite(s) || s < SALARY_MIN || s > SALARY_MAX) {
    return { error: '월 실수령액은 50만원 ~ 1억원 사이로 입력해 주세요.' };
  }

  if (!expenses || typeof expenses !== 'object') return { error: '월지출을 입력해 주세요.' };
  const exp = {};
  for (const c of CATEGORIES) {
    const raw = expenses[c.key] ?? 0;
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v) || v < 0 || v > CATEGORY_MAX) {
      return { error: `${c.label} 지출은 0 ~ 5,000만원 사이로 입력해 주세요.` };
    }
    exp[c.key] = v;
  }
  if (Object.values(exp).every((v) => v === 0)) {
    return { error: '카테고리 중 하나 이상의 지출을 입력해 주세요.' };
  }

  return { value: { job, company, years: y, salary: s, expenses: exp } };
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '16kb' }));
// 정적 파일은 index.html 하나뿐이라 express.static 대신 SPA fallback 으로만 내려준다.
// (폴더 전체를 static 으로 열면 server.js·package.json·.env 까지 브라우저에서 받아볼 수 있다)

// /api/meta 는 DB 없이도 응답 가능하므로 DB 게이트보다 먼저 등록한다
app.get('/api/meta', (_req, res) => {
  res.json({
    success: true,
    data: {
      jobs: JOBS,
      companies: COMPANIES,
      careers: CAREERS,
      categories: CATEGORIES,
      minGroupSize: MIN_GROUP_SIZE,
      limits: { salaryMin: SALARY_MIN, salaryMax: SALARY_MAX, categoryMax: CATEGORY_MAX, yearsMax: YEARS_MAX },
    },
  });
});

app.use('/api', async (_req, res, next) => {
  if (!pool) {
    return res.status(503).json({ success: false, message: '서버에 DATABASE_URL 환경변수가 설정되지 않았습니다.' });
  }
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err.message);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했습니다.' });
  }
});

// ── GET ──────────────────────────────────────
// 통계: ?job=개발 &company=대기업 &career=2  (모두 선택, 없으면 전체)
app.get('/api/stats', async (req, res, next) => {
  try {
    const filters = parseFilters(req.query);
    const fp = filterParams(filters);
    const clientHash = getClientHash(req);

    const catAvgSql = CATEGORIES.map((c) => `AVG(exp_${c.key}) AS avg_${c.key}`).join(', ');

    const [totalQ, groupQ, salaryHistQ, expenseHistQ, meQ, byJobQ, byCareerQ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM pay_entries'),
      pool.query(
        `SELECT COUNT(*)::int AS n,
                AVG(salary) AS avg_salary,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY salary)  AS med_salary,
                percentile_cont(0.25) WITHIN GROUP (ORDER BY salary) AS p25_salary,
                percentile_cont(0.75) WITHIN GROUP (ORDER BY salary) AS p75_salary,
                AVG(expense) AS avg_expense,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY expense) AS med_expense,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY ${SAVINGS_SQL}) AS med_savings,
                ${catAvgSql}
           FROM pay_entries
          WHERE ${FILTER_SQL}`,
        fp
      ),
      pool.query(
        `SELECT width_bucket(salary, $4::int[]) AS b, COUNT(*)::int AS count
           FROM pay_entries WHERE ${FILTER_SQL} GROUP BY b`,
        [...fp, SALARY_EDGES]
      ),
      pool.query(
        `SELECT width_bucket(expense, $4::bigint[]) AS b, COUNT(*)::int AS count
           FROM pay_entries WHERE ${FILTER_SQL} GROUP BY b`,
        [...fp, EXPENSE_EDGES]
      ),
      clientHash
        ? pool.query(`SELECT *, ${CAREER_SQL} AS career FROM pay_entries WHERE client_hash = $1`, [clientHash])
        : Promise.resolve({ rows: [] }),
      pool.query(
        `SELECT job AS key, COUNT(*)::int AS n, AVG(salary) AS avg_salary, AVG(expense) AS avg_expense
           FROM pay_entries GROUP BY job`
      ),
      pool.query(
        `SELECT ${CAREER_SQL} AS key, COUNT(*)::int AS n, AVG(salary) AS avg_salary, AVG(expense) AS avg_expense
           FROM pay_entries GROUP BY key`
      ),
    ]);

    const g = groupQ.rows[0];
    const enough = g.n >= MIN_GROUP_SIZE;

    const group = {
      count: g.n,
      enough,
      ...(enough && {
        salary: { avg: num(g.avg_salary), median: num(g.med_salary), p25: num(g.p25_salary), p75: num(g.p75_salary) },
        expense: { avg: num(g.avg_expense), median: num(g.med_expense) },
        savingsRate: Math.round(Number(g.med_savings) * 1000) / 10,
        categories: Object.fromEntries(CATEGORIES.map((c) => [c.key, num(g[`avg_${c.key}`])])),
        salaryHistogram: toHistogram(salaryHistQ.rows, SALARY_EDGES),
        expenseHistogram: toHistogram(expenseHistQ.rows, EXPENSE_EDGES),
      }),
    };

    // 내 위치 (선택한 그룹 기준)
    let me = null;
    if (meQ.rows[0]) {
      const entry = toEntry(meQ.rows[0]);
      me = { entry, position: null };
      if (enough) {
        const { rows } = await pool.query(
          `SELECT COUNT(*) FILTER (WHERE salary  > $4)::int AS salary_gt,
                  COUNT(*) FILTER (WHERE expense > $5)::int AS expense_gt,
                  COUNT(*) FILTER (WHERE ${SAVINGS_SQL} > $6::float8)::int AS savings_gt,
                  COUNT(*) FILTER (WHERE client_hash = $7)::int AS me_in
             FROM pay_entries WHERE ${FILTER_SQL}`,
          [...fp, entry.salary, entry.expense, (entry.salary - entry.expense) / entry.salary, clientHash]
        );
        const r = rows[0];
        const inGroup = r.me_in > 0;
        me.position = {
          inGroup,
          salaryTop: topPercent(r.salary_gt, g.n, inGroup),
          expenseTop: topPercent(r.expense_gt, g.n, inGroup),
          savingsTop: topPercent(r.savings_gt, g.n, inGroup),
        };
      }
    }

    // 직군별 / 연차별 요약 (표본 부족 그룹은 인원수만 숨긴 채 개수로 알린다)
    const summarize = (rows, order) => {
      const byKey = new Map(rows.map((r) => [String(r.key), r]));
      const visible = [];
      let hidden = 0;
      for (const { key, label } of order) {
        const r = byKey.get(String(key));
        if (!r) continue;
        if (r.n < MIN_GROUP_SIZE) { hidden += 1; continue; }
        visible.push({ key, label, count: r.n, avgSalary: num(r.avg_salary), avgExpense: num(r.avg_expense) });
      }
      return { rows: visible, hiddenGroups: hidden };
    };

    res.json({
      success: true,
      data: {
        total: totalQ.rows[0].n,
        filters,
        group,
        me,
        byJob: summarize(byJobQ.rows, JOBS.map((j) => ({ key: j, label: j }))),
        byCareer: summarize(byCareerQ.rows, CAREERS.map((c) => ({ key: c.id, label: c.label }))),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST ─────────────────────────────────────
// 제출(한 브라우저당 1건, 다시 제출하면 덮어쓴다)
app.post('/api/entries', async (req, res, next) => {
  try {
    const clientHash = getClientHash(req);
    if (!clientHash) {
      return res.status(400).json({ success: false, message: '익명 ID가 없습니다. 페이지를 새로고침해 주세요.' });
    }
    const { value, error } = validateEntry(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const cols = ['client_hash', 'job', 'company', 'years', 'salary', ...EXP_COLS];
    const vals = [clientHash, value.job, value.company, value.years, value.salary, ...CATEGORIES.map((c) => value.expenses[c.key])];
    const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
    const updates = cols.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ');

    const { rows } = await pool.query(
      `INSERT INTO pay_entries (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT (client_hash) DO UPDATE SET ${updates}, updated_at = NOW()
       RETURNING *, ${CAREER_SQL} AS career, (xmax::text <> '0') AS updated`,
      vals
    );
    const updated = rows[0].updated;
    res.status(updated ? 200 : 201).json({ success: true, data: { entry: toEntry(rows[0]), updated } });
  } catch (err) {
    next(err);
  }
});

// ── DELETE ───────────────────────────────────
// 내 데이터 삭제
app.delete('/api/entries/me', async (req, res, next) => {
  try {
    const clientHash = getClientHash(req);
    if (!clientHash) {
      return res.status(400).json({ success: false, message: '익명 ID가 없습니다.' });
    }
    const { rowCount } = await pool.query('DELETE FROM pay_entries WHERE client_hash = $1', [clientHash]);
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '삭제할 제출 기록이 없습니다.' });
    }
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
});

// ── API 404 ──────────────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API endpoint not found' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 형식이 올바르지 않습니다.' });
  }
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => console.log(`익명 월급·지출 비교 서버: http://localhost:${PORT}`));
}
module.exports = app;
