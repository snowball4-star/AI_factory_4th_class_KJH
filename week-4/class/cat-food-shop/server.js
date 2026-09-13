// ============================================================
// 🐱 냐옹밥상 - 고양이 사료 상품 페이지 백엔드 (server.js)
// 상품 정보는 서버 인메모리, 문의 내역은 PostgreSQL(Supabase)에 저장한다.
// 접속 정보는 코드에 넣지 않고 환경변수 DATABASE_URL 에서만 읽는다.
// 로컬(node server.js) / Vercel 서버리스 듀얼 모드.
// ============================================================

const express = require('express');
const path = require('path');
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

// ── 상품 데이터 (인메모리) ───────────────────
const PRODUCT = {
  id: 'nyaong-salmon-01',
  name: '냐옹밥상 그레인프리 연어&닭가슴살',
  subtitle: '전연령 고양이용 · 헤어볼 케어 · 무곡물',
  brand: '냐옹밥상',
  rating: 4.8,
  reviewCount: 1287,
  listPrice: 39000,
  price: 29900,
  badges: ['무곡물', '휴먼그레이드', '무항생제', '국내생산'],
  summary:
    '노르웨이산 생연어와 국내산 닭가슴살을 62% 함유한 무곡물 사료입니다. ' +
    '작은 입에도 부담 없는 8mm 도넛형 키블에 타우린과 크랜베리 추출물을 더해 ' +
    '눈·심장 건강과 요로 건강까지 함께 챙깁니다.',
  options: [
    { id: 'kg1', label: '1kg (체험용)', price: 12900, stock: 42 },
    { id: 'kg2', label: '2kg (인기)', price: 29900, stock: 18 },
    { id: 'kg5', label: '5kg (대용량)', price: 62900, stock: 0 },
  ],
  features: [
    { icon: '🐟', title: '동물성 단백 62%', desc: '생연어와 닭가슴살을 주원료로 사용했습니다.' },
    { icon: '🌾', title: '그레인프리', desc: '밀·옥수수·대두 무첨가로 알러지 부담을 낮췄습니다.' },
    { icon: '🧶', title: '헤어볼 케어', desc: '식이섬유 4.5%로 털뭉치 배출을 도와줍니다.' },
    { icon: '💧', title: '요로 건강', desc: '크랜베리 추출물과 마그네슘 저감 설계.' },
  ],
  nutrition: [
    { key: '조단백질', value: '38% 이상' },
    { key: '조지방', value: '16% 이상' },
    { key: '조섬유', value: '4.5% 이하' },
    { key: '조회분', value: '8% 이하' },
    { key: '수분', value: '10% 이하' },
    { key: '타우린', value: '0.2% 이상' },
    { key: '칼슘 : 인', value: '1.2 : 1' },
    { key: '대사에너지', value: '3,850 kcal/kg' },
  ],
  feedingGuide: [
    { weight: '2kg 미만 / 자묘', amount: '30~45g' },
    { weight: '3kg 내외', amount: '45~55g' },
    { weight: '4~5kg', amount: '55~70g' },
    { weight: '6kg 이상 / 활동량 많음', amount: '70~90g' },
  ],
  reviews: [
    { id: 1, author: '치즈집사', rating: 5, date: '2026-08-24', body: '입 짧은 아이가 그릇을 싹 비웠어요. 알갱이가 작아서 노묘도 잘 먹습니다.' },
    { id: 2, author: '삼색이맘', rating: 5, date: '2026-08-19', body: '두 달째 급여 중인데 털뭉치 토하는 횟수가 눈에 띄게 줄었어요.' },
    { id: 3, author: '고등어2호', rating: 4, date: '2026-08-11', body: '품질은 만족. 다만 2kg는 금방 없어져서 다음엔 5kg 재입고를 기다립니다.' },
  ],
};

const INQUIRY_CATEGORIES = ['상품 문의', '배송 문의', '교환/반품', '대량 구매', '기타'];

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
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inquiries (
      id         BIGSERIAL PRIMARY KEY,
      product_id TEXT        NOT NULL,
      name       TEXT        NOT NULL,
      email      TEXT        NOT NULL,
      phone      TEXT,
      category   TEXT        NOT NULL,
      message    TEXT        NOT NULL,
      answered   BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  dbInitialized = true;
}

// ── 헬퍼 ─────────────────────────────────────
function sanitize(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// 여러 줄 문의 본문은 줄바꿈을 살리되 앞뒤 공백만 정리한다.
function sanitizeMultiline(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 목록 노출용 마스킹 (이름 가운데, 이메일 아이디 뒷부분)
function maskName(name) {
  if (name.length <= 1) return name;
  if (name.length === 2) return name[0] + '*';
  return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
}

function maskEmail(email) {
  const [id, domain] = email.split('@');
  const head = id.slice(0, 2);
  return head + '*'.repeat(Math.max(id.length - 2, 1)) + '@' + domain;
}

function toPublicInquiry(row) {
  return {
    id: Number(row.id),
    name: maskName(row.name),
    email: maskEmail(row.email),
    category: row.category,
    message: row.message,
    answered: row.answered,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// 모든 /api 요청 전에 DB 준비 확인
app.use('/api', async (_req, res, next) => {
  if (!pool) {
    return res.status(500).json({
      success: false,
      message: 'DATABASE_URL 환경변수가 설정되지 않았습니다. .env 파일을 확인해 주세요.',
    });
  }
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err);
    res.status(500).json({ success: false, message: '데이터베이스 초기화에 실패했습니다.' });
  }
});

// ── API routes ───────────────────────────────

// 연결 상태 확인
app.get('/api/health', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now, COUNT(*)::int AS count FROM inquiries');
    res.json({
      success: true,
      data: { connected: true, serverTime: rows[0].now, inquiryCount: rows[0].count },
    });
  } catch (err) {
    next(err);
  }
});

// 상품 정보
app.get('/api/product', (_req, res) => {
  res.json({ success: true, data: { ...PRODUCT, inquiryCategories: INQUIRY_CATEGORIES } });
});

// 문의 목록 (개인정보는 마스킹해서 내려준다)
app.get('/api/inquiries', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const { rows } = await pool.query('SELECT * FROM inquiries ORDER BY id DESC LIMIT $1', [limit]);
    res.json({ success: true, data: rows.map(toPublicInquiry) });
  } catch (err) {
    next(err);
  }
});

// 문의 등록
app.post('/api/inquiries', async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = sanitize(body.name);
    const email = sanitize(body.email);
    const phone = sanitize(body.phone);
    const category = sanitize(body.category);
    const message = sanitizeMultiline(body.message);

    if (!name) {
      return res.status(400).json({ success: false, message: '이름을 입력해 주세요.' });
    }
    if (name.length > 30) {
      return res.status(400).json({ success: false, message: '이름은 30자 이내로 입력해 주세요.' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ success: false, message: '올바른 이메일 주소를 입력해 주세요.' });
    }
    if (phone && !/^[0-9-+() ]{7,20}$/.test(phone)) {
      return res.status(400).json({ success: false, message: '연락처 형식을 확인해 주세요.' });
    }
    if (!INQUIRY_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: '문의 유형을 선택해 주세요.' });
    }
    if (message.length < 5) {
      return res.status(400).json({ success: false, message: '문의 내용을 5자 이상 입력해 주세요.' });
    }
    if (message.length > 1000) {
      return res.status(400).json({ success: false, message: '문의 내용은 1000자 이내로 입력해 주세요.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO inquiries (product_id, name, email, phone, category, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [PRODUCT.id, name, email, phone || null, category, message]
    );
    res.status(201).json({ success: true, data: toPublicInquiry(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버에서 오류가 발생했습니다.' });
});

// ── Startup & export ─────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('🐱 Cat food shop running on http://localhost:' + PORT);
    console.log(
      DATABASE_URL
        ? '🗄️  DATABASE_URL 환경변수 감지됨 (PostgreSQL 사용)'
        : '⚠️  DATABASE_URL 이 없습니다. .env 파일을 만들어 주세요.'
    );
  });
}
module.exports = app;
