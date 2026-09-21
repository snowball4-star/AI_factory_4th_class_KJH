// ========================================
// 🛍️ 오늘의 마켓 — 단일 파일 백엔드 (Express 5 + Supabase PostgreSQL)
// 로컬: node server.js  /  Vercel: module.exports = app
//
// 공개(로그인 불필요): 상품 목록·상세(상품명·가격·이미지·설명), 카테고리
// 보호(로그인 필요): 장바구니, 주문
//
// 비밀정보는 전부 .env(gitignore됨)에서만 읽는다.
//   DATABASE_URL : Supabase PostgreSQL 연결 문자열
//   SEED_USERS   : 최초 실행 시 만들 데모 계정 "아이디:표시이름:비밀번호" 쉼표 구분
// 세션은 HttpOnly 쿠키로만 오가며, 브라우저 저장소에는 아무것도 남기지 않는다.
// ========================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool, types } = require('pg');

// ── Env (.env 직접 파싱, dotenv 의존성 없음) ────
// 로컬 개발 전용. 배포 환경에서는 플랫폼에 설정한 환경변수만 쓴다.
// Vercel은 .vercelignore에 .env를 적어도 배포 번들에 포함시킬 수 있으므로,
// 여기서 읽지 않도록 막아야 번들에 딸려 들어간 .env가 조용히 사용되는 일을 막는다
if (!process.env.VERCEL) {
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach((line) => {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
      }
    });
  } catch { /* .env 없음 → 시스템 환경변수 사용 */ }
}

// ── App init & config ────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = (process.env.DATABASE_URL || '').trim(); // 환경변수 끝 개행 방어

const CATEGORIES = ['전자기기', '패션', '홈·리빙', '뷰티'];
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7일
const COOKIE_NAME = 'shop_sid';
const MAX_QTY = 20; // 한 상품당 장바구니 최대 수량

// COUNT(BIGINT)·NUMERIC를 문자열이 아니라 숫자로 받는다
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

// ── DB 스키마 (lazy init, 서버리스 cold start 대응) ──
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS shop_users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  COMMENT ON TABLE  shop_users IS '쇼핑몰 회원';
  COMMENT ON COLUMN shop_users.password_hash IS 'scrypt(비밀번호, salt) 해시 — 평문은 저장하지 않는다';

  CREATE TABLE IF NOT EXISTS shop_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS shop_sessions_expires_idx ON shop_sessions (expires_at);
  COMMENT ON TABLE shop_sessions IS '로그인 세션. 쿠키의 토큰 원문이 아니라 SHA-256 해시를 저장한다';

  CREATE TABLE IF NOT EXISTS shop_products (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    price       INTEGER NOT NULL CHECK (price >= 0),
    image_url   TEXT NOT NULL,
    summary     TEXT NOT NULL,
    description TEXT NOT NULL,
    stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    rating      NUMERIC(2,1) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS shop_products_category_idx ON shop_products (category);
  COMMENT ON TABLE shop_products IS '판매 상품. 로그인 없이 누구나 조회할 수 있는 공개 데이터';

  CREATE TABLE IF NOT EXISTS shop_cart_items (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES shop_products(id) ON DELETE CASCADE,
    quantity   INTEGER NOT NULL CHECK (quantity > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, product_id)
  );
  COMMENT ON TABLE shop_cart_items IS '회원별 장바구니. 로그인한 본인 것만 읽고 쓸 수 있다';

  CREATE TABLE IF NOT EXISTS shop_orders (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES shop_users(id) ON DELETE CASCADE,
    receiver     TEXT NOT NULL,
    address      TEXT NOT NULL,
    memo         TEXT NOT NULL DEFAULT '',
    total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
    status       TEXT NOT NULL DEFAULT '결제완료',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS shop_orders_user_idx ON shop_orders (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS shop_order_items (
    id         SERIAL PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES shop_orders(id) ON DELETE CASCADE,
    product_id INTEGER REFERENCES shop_products(id) ON DELETE SET NULL,
    name       TEXT NOT NULL,
    price      INTEGER NOT NULL,
    image_url  TEXT NOT NULL DEFAULT '',
    quantity   INTEGER NOT NULL CHECK (quantity > 0)
  );
  CREATE INDEX IF NOT EXISTS shop_order_items_order_idx ON shop_order_items (order_id);
  COMMENT ON TABLE shop_order_items IS '주문 시점의 상품명·가격을 복사해 둔다 (나중에 가격이 바뀌어도 영수증은 그대로)';
`;

// ── 비밀번호·토큰 헬퍼 ────────────────────────
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(user, password) {
  const attempt = Buffer.from(hashPassword(password, user.password_salt), 'hex');
  const stored = Buffer.from(user.password_hash, 'hex');
  return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ── 시드 데이터 ──────────────────────────────
// 계정 정보는 코드에 하드코딩하지 않고 SEED_USERS 환경변수에서만 읽는다
function parseSeedUsers() {
  return (process.env.SEED_USERS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [username, displayName, password] = entry.split(':');
      return {
        username: (username || '').trim().toLowerCase(),
        displayName: (displayName || '').trim(),
        password: (password || '').trim(),
      };
    })
    .filter((u) => u.username && u.password);
}

const img = (id) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=80`;

// 상품은 공개 데이터라 코드에 그대로 둬도 된다 (비밀정보가 아님)
const SEED_PRODUCTS = [
  {
    name: '노이즈 캔슬링 무선 헤드폰',
    category: '전자기기',
    price: 189000,
    stock: 24,
    rating: 4.8,
    image: img('1505740420928-5e560c06d30e'),
    summary: '주변 소음을 지우는 40mm 드라이버, 30시간 재생',
    description:
      '카페에서도 지하철에서도 음악만 남습니다. 40mm 대구경 드라이버와 하이브리드 노이즈 캔슬링으로 저음은 단단하게, 중고음은 선명하게 잡아 줍니다.\n\n- 재생 시간: 노이즈 캔슬링 켠 상태로 최대 30시간\n- 충전: USB-C 10분 충전으로 3시간 재생\n- 무게: 250g, 90도 회전 이어컵으로 목에 걸기 편함\n- 멀티포인트: 노트북과 휴대폰에 동시에 연결',
  },
  {
    name: '데일리 러닝화 (레드)',
    category: '패션',
    price: 99000,
    stock: 31,
    rating: 4.6,
    image: img('1542291026-7eec264c27ff'),
    summary: '니트 갑피 + 반발 쿠션, 한 켤레 245g',
    description:
      '매일 5km를 가볍게 달리기 위한 신발입니다. 통기성 좋은 니트 갑피가 발등을 부드럽게 감싸고, 중창의 반발 쿠션이 착지 충격을 되돌려 줍니다.\n\n- 무게: 245g (270mm 기준)\n- 드롭: 8mm, 데일리 조깅과 출퇴근 겸용\n- 사이즈: 230~290mm (5mm 단위)\n- 관리: 미온수 손세탁 권장',
  },
  {
    name: '블랙 스마트워치 44mm',
    category: '전자기기',
    price: 259000,
    stock: 18,
    rating: 4.7,
    image: img('1546868871-7041f2a55e12'),
    summary: '심박·수면 측정, 5일 배터리, 50m 방수',
    description:
      '손목에서 하루를 기록합니다. 심박·산소포화도·수면 단계를 자동으로 재고, 운동 모드 120종을 지원합니다.\n\n- 화면: 1.4인치 AMOLED, 상시 표시 지원\n- 배터리: 일반 사용 5일, 절전 모드 12일\n- 방수: 5ATM (수영 가능)\n- 알림: 전화·메시지·일정 미러링',
  },
  {
    name: '클래식 선글라스',
    category: '패션',
    price: 139000,
    stock: 12,
    rating: 4.5,
    image: img('1572635196237-14b3f281503f'),
    summary: '편광 렌즈 + 아세테이트 프레임, 전용 케이스 포함',
    description:
      '어느 얼굴형에도 무난하게 얹히는 웰링턴 셰이프입니다. 편광 렌즈가 바다·설원의 난반사를 걸러 주고, 아세테이트 프레임은 가볍고 잘 휘지 않습니다.\n\n- 렌즈: UV400 편광, 가시광선 투과율 15%\n- 프레임: 이탈리아산 아세테이트\n- 구성: 하드 케이스, 극세사 클로스, 보증서',
  },
  {
    name: '미니멀 15인치 백팩',
    category: '패션',
    price: 79000,
    stock: 40,
    rating: 4.4,
    image: img('1553062407-98eeb64c6a62'),
    summary: '발수 원단, 노트북 전용 포켓, 20L',
    description:
      '출퇴근과 1박 여행을 한 가방으로 해결합니다. 등판 쪽에 15인치 노트북 전용 포켓이 따로 있어 짐과 섞이지 않습니다.\n\n- 용량: 20L\n- 원단: 발수 코팅 폴리에스터 900D\n- 포켓: 노트북 15인치, 태블릿, 숨은 뒷주머니\n- 무게: 780g',
  },
  {
    name: '인스턴트 카메라',
    category: '전자기기',
    price: 149000,
    stock: 9,
    rating: 4.3,
    image: img('1526170375885-4d8ecf77b99f'),
    summary: '찍는 즉시 인화, 자동 노출·플래시',
    description:
      '찍자마자 손에 남는 사진. 자동 노출과 플래시가 알아서 맞춰 주기 때문에 셔터만 누르면 됩니다.\n\n- 필름: 정사각 인스턴트 필름 8장 팩\n- 초점: 0.3m ~ 무한대 2모드\n- 배터리: 내장 충전식, 한 번 충전에 15팩\n- 구성: 본체, 스트랩, USB-C 케이블 (필름 별매)',
  },
  {
    name: '14인치 경량 노트북',
    category: '전자기기',
    price: 1290000,
    stock: 7,
    rating: 4.9,
    image: img('1517336714731-489689fd1ca8'),
    summary: '16GB 메모리 · 512GB SSD · 1.1kg',
    description:
      '가방에 넣은 걸 잊어버릴 만큼 가볍지만, 영상 편집까지 버티는 성능을 냅니다.\n\n- CPU: 8코어, 팬리스 설계로 무소음\n- 메모리/저장: 16GB / 512GB NVMe SSD\n- 화면: 14인치 2.8K, 400nit\n- 배터리: 실사용 14시간, 65W USB-C 충전',
  },
  {
    name: '북유럽 디자인 체어',
    category: '홈·리빙',
    price: 119000,
    stock: 15,
    rating: 4.2,
    image: img('1592078615290-033ee584e267'),
    summary: '원목 다리 + 쿠션 시트, 조립 10분',
    description:
      '식탁에도, 책상에도 어울리는 기본형 의자입니다. 시트 안쪽에 쿠션이 들어가 오래 앉아도 배기지 않습니다.\n\n- 크기: 가로 46 x 세로 52 x 높이 82cm (좌석 높이 45cm)\n- 소재: PP 시트 + 비치 원목 다리\n- 하중: 120kg\n- 구성: 조립용 렌치 포함, 10분 조립',
  },
  {
    name: '에어 쿠션 스니커즈',
    category: '패션',
    price: 129000,
    stock: 22,
    rating: 4.6,
    image: img('1600185365483-26d7a4cc7519'),
    summary: '에어 쿠션 미드솔, 데일리 화이트',
    description:
      '오래 걷는 날을 위한 스니커즈입니다. 뒤꿈치의 에어 쿠션이 체중을 분산해 발바닥 피로를 줄여 줍니다.\n\n- 갑피: 소가죽 + 메쉬 혼합\n- 중창: 에어 쿠션 + EVA 폼\n- 사이즈: 230~290mm\n- 색상: 화이트 / 오렌지 포인트',
  },
  {
    name: '블랙 에디션 오 드 퍼퓸 50ml',
    category: '뷰티',
    price: 98000,
    stock: 26,
    rating: 4.5,
    image: img('1585386959984-a4155224a1ad'),
    summary: '머스크 베이스의 잔향 6시간, 남녀 공용',
    description:
      '첫 향은 가벼운 시트러스, 끝은 포근한 머스크로 내려앉습니다. 계절을 타지 않아 사계절 데일리로 쓰기 좋습니다.\n\n- 용량: 50ml (오 드 퍼퓸)\n- 노트: 베르가못 / 자스민 / 화이트 머스크\n- 지속력: 약 6시간\n- 선물 포장 무료',
  },
  {
    name: '11인치 태블릿 + 스타일러스',
    category: '전자기기',
    price: 749000,
    stock: 11,
    rating: 4.7,
    image: img('1544244015-0df4b3ffc6b0'),
    summary: '120Hz 화면, 필기 지연 없는 펜 포함',
    description:
      '필기와 스케치를 종이처럼 받아 냅니다. 120Hz 주사율 덕분에 펜이 손을 따라오지 못하는 느낌이 없습니다.\n\n- 화면: 11인치 2.4K, 120Hz\n- 저장: 128GB, microSD 확장 지원\n- 펜: 4096 필압, 자석 부착 충전\n- 배터리: 동영상 재생 12시간',
  },
  {
    name: '스웨이드 더비 슈즈 (민트)',
    category: '패션',
    price: 158000,
    stock: 8,
    rating: 4.1,
    image: img('1560343090-f0409e92791a'),
    summary: '이탈리아 스웨이드, 3cm 우드 힐',
    description:
      '한 켤레로 분위기를 바꾸는 컬러 더비입니다. 스웨이드 특유의 결이 빛에 따라 톤을 달리합니다.\n\n- 소재: 이탈리아산 스웨이드\n- 굽: 3cm 우드 힐\n- 사이즈: 225~265mm\n- 관리: 전용 브러시로 결 정리, 방수 스프레이 권장',
  },
  {
    name: '화이트 스마트워치 (실리콘 밴드)',
    category: '전자기기',
    price: 179000,
    stock: 19,
    rating: 4.4,
    image: img('1523275335684-37898b6baf30'),
    summary: '가벼운 32g, 밴드 2종 구성',
    description:
      '손목이 얇아도 부담 없는 32g 경량 스마트워치입니다. 실리콘 밴드 2종이 함께 들어 있어 운동용·외출용으로 바꿔 낄 수 있습니다.\n\n- 화면: 1.2인치 원형 AMOLED\n- 배터리: 7일\n- 측정: 심박, 수면, 걸음 수, 스트레스\n- 방수: IP68',
  },
  {
    name: '원목 하이 스툴',
    category: '홈·리빙',
    price: 89000,
    stock: 14,
    rating: 4.0,
    image: img('1503602642458-232111445657'),
    summary: '아일랜드 식탁용 높이 65cm, 화이트 오크',
    description:
      '주방 아일랜드나 홈바에 두기 좋은 높이의 원목 스툴입니다. 발받침이 있어 오래 앉아도 다리가 편합니다.\n\n- 크기: 가로 36 x 세로 36 x 높이 65cm\n- 소재: 화이트 오크 원목, 수성 도장\n- 하중: 110kg\n- 구성: 완제품 배송 (조립 불필요)',
  },
];

async function seedIfEmpty() {
  // 1) 데모 계정 — 이미 있는 아이디는 건드리지 않는다 (비밀번호를 덮어쓰지 않기 위해)
  for (const u of parseSeedUsers()) {
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query(
      `INSERT INTO shop_users (username, display_name, password_salt, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING`,
      [u.username, u.displayName || u.username, salt, hashPassword(u.password, salt)]
    );
  }

  // 2) 상품 — 테이블이 비어 있을 때만 한 번 채운다
  const { rows } = await pool.query('SELECT COUNT(*)::bigint AS n FROM shop_products');
  if (rows[0].n > 0) return;

  for (const p of SEED_PRODUCTS) {
    await pool.query(
      `INSERT INTO shop_products (name, category, price, image_url, summary, description, stock, rating)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [p.name, p.category, p.price, p.image, p.summary, p.description, p.stock, p.rating]
    );
  }
}

let dbInitPromise = null;

function ensureDB() {
  if (!pool) return Promise.reject(new Error('DATABASE_URL 환경변수가 설정되지 않았습니다'));
  if (!dbInitPromise) {
    dbInitPromise = pool
      .query(SCHEMA_SQL)
      .then(() => seedIfEmpty())
      .catch((err) => { dbInitPromise = null; throw err; });
  }
  return dbInitPromise;
}

// ── 쿠키 헬퍼 (cookie-parser 없이 직접 처리) ───
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return '';
}

function isHttps(req) {
  return req.secure || (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// HttpOnly → 페이지 스크립트가 읽을 수 없다. 브라우저 저장소에는 아무것도 남지 않는다
function setSessionCookie(req, res, token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req, res) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isHttps(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ── 사용자 직렬화 (해시·salt는 절대 응답에 담지 않는다) ──
const publicUser = (row) => ({ id: row.id, username: row.username, displayName: row.display_name });

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO shop_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), userId, new Date(Date.now() + SESSION_TTL_MS).toISOString()]
  );
  setSessionCookie(req, res, token);
}

// 쿠키의 세션을 확인해 사용자를 찾는다. 세션이 없으면 null (에러 아님)
async function loadUser(req) {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return null;

  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, s.token_hash
       FROM shop_sessions s
       JOIN shop_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await loadUser(req);
    if (!user) {
      clearSessionCookie(req, res);
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }
    req.user = user;
    req.tokenHash = user.token_hash;
    next();
  } catch (err) {
    next(err);
  }
}

// 상품 조회용 공통 SELECT (camelCase 별칭)
const PRODUCT_COLUMNS = `id, name, category, price, image_url AS "imageUrl",
  summary, description, stock, rating`;

// ── Middleware ───────────────────────────────
app.use(express.json());

// .env·server.js·node_modules가 정적 파일로 새어 나가지 않도록 index.html만 서빙한다
app.get(['/', '/index.html'], (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// 모든 /api 요청 전에 DB 준비 (cold start 대응, 중복 실행은 promise 캐시로 막는다)
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

// ========================================
// 🌐 공개 API — 로그인 없이 누구나 호출할 수 있다
// ========================================

app.get('/api/categories', (_req, res) => {
  res.json({ success: true, data: CATEGORIES });
});

// 상품 목록: 카테고리·검색어·정렬. 긴 설명(description)은 빼고 요약만 내려보낸다
app.get('/api/products', async (req, res, next) => {
  try {
    const { category, q } = req.query;
    const sortMap = {
      recommended: 'rating DESC, id ASC',
      price_asc: 'price ASC, id ASC',
      price_desc: 'price DESC, id ASC',
      name: 'name ASC',
    };
    const orderBy = sortMap[String(req.query.sort || '')] || sortMap.recommended;

    const conditions = [];
    const params = [];

    if (category && CATEGORIES.includes(category)) {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim()}%`);
      conditions.push(`(name ILIKE $${params.length} OR summary ILIKE $${params.length} OR category ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT id, name, category, price, image_url AS "imageUrl", summary, stock, rating
         FROM shop_products ${where} ORDER BY ${orderBy}`,
      params
    );

    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (err) {
    next(err);
  }
});

// 상품 상세: 상품명·가격·이미지·설명 모두 공개
app.get('/api/products/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 상품 번호입니다.' });
    }

    const { rows } = await pool.query(`SELECT ${PRODUCT_COLUMNS} FROM shop_products WHERE id = $1`, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '상품을 찾을 수 없습니다.' });
    }

    // 같은 카테고리의 다른 상품 3개를 함께 추천
    const { rows: related } = await pool.query(
      `SELECT id, name, price, image_url AS "imageUrl"
         FROM shop_products WHERE category = $1 AND id <> $2 ORDER BY rating DESC LIMIT 3`,
      [rows[0].category, id]
    );

    res.json({ success: true, data: { ...rows[0], related } });
  } catch (err) {
    next(err);
  }
});

// ========================================
// 🔐 인증 API
// ========================================

app.post('/api/auth/signup', async (req, res, next) => {
  try {
    const { username, password, displayName } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해 주세요.' });
    }
    if (String(username).trim().length < 3) {
      return res.status(400).json({ success: false, message: '아이디는 3자 이상이어야 합니다.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ success: false, message: '비밀번호는 6자 이상이어야 합니다.' });
    }

    const id = String(username).trim().toLowerCase();
    const salt = crypto.randomBytes(16).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO shop_users (username, display_name, password_salt, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, display_name`,
      [id, (displayName || '').trim() || id, salt, hashPassword(String(password), salt)]
    );

    if (rows.length === 0) {
      return res.status(409).json({ success: false, message: '이미 사용 중인 아이디입니다.' });
    }

    await createSession(req, res, rows[0].id);
    res.status(201).json({ success: true, data: publicUser(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: '아이디와 비밀번호를 입력해 주세요.' });
    }

    const { rows } = await pool.query(
      'SELECT id, username, display_name, password_salt, password_hash FROM shop_users WHERE username = $1',
      [String(username).trim().toLowerCase()]
    );
    const user = rows[0];

    if (!user || !verifyPassword(user, String(password))) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    await pool.query('DELETE FROM shop_sessions WHERE expires_at < now()'); // 만료 세션 정리
    await createSession(req, res, user.id);
    res.json({ success: true, data: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

// 로그인 여부 확인용. 비로그인도 정상 응답(data: null)이라 첫 화면에서 에러가 나지 않는다
app.get('/api/auth/me', async (req, res, next) => {
  try {
    const user = await loadUser(req);
    res.json({ success: true, data: user ? publicUser(user) : null });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM shop_sessions WHERE token_hash = $1', [req.tokenHash]);
    clearSessionCookie(req, res);
    res.json({ success: true, message: '로그아웃되었습니다.' });
  } catch (err) {
    next(err);
  }
});

// ========================================
// 🛒 장바구니 API — 로그인 필요 (본인 것만)
// ========================================

async function readCart(userId) {
  const { rows } = await pool.query(
    `SELECT c.product_id AS "productId", c.quantity,
            p.name, p.price, p.image_url AS "imageUrl", p.stock, p.category
       FROM shop_cart_items c
       JOIN shop_products p ON p.id = c.product_id
      WHERE c.user_id = $1
      ORDER BY c.created_at`,
    [userId]
  );
  const items = rows.map((r) => ({ ...r, subtotal: r.price * r.quantity }));
  return {
    items,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    totalAmount: items.reduce((sum, i) => sum + i.subtotal, 0),
  };
}

app.get('/api/cart', requireAuth, async (req, res, next) => {
  try {
    res.json({ success: true, data: await readCart(req.user.id) });
  } catch (err) {
    next(err);
  }
});

// 담기: 이미 있으면 수량을 더한다 (재고·최대 수량 범위로 잘라 냄)
app.post('/api/cart', requireAuth, async (req, res, next) => {
  try {
    const productId = Number((req.body || {}).productId);
    const quantity = Number((req.body || {}).quantity || 1);

    if (!Number.isInteger(productId)) {
      return res.status(400).json({ success: false, message: '잘못된 상품 번호입니다.' });
    }
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      return res.status(400).json({ success: false, message: `수량은 1~${MAX_QTY}개 사이여야 합니다.` });
    }

    const { rows: products } = await pool.query('SELECT id, stock FROM shop_products WHERE id = $1', [productId]);
    if (products.length === 0) {
      return res.status(404).json({ success: false, message: '상품을 찾을 수 없습니다.' });
    }
    if (products[0].stock < 1) {
      return res.status(409).json({ success: false, message: '품절된 상품입니다.' });
    }

    const limit = Math.min(products[0].stock, MAX_QTY);
    await pool.query(
      `INSERT INTO shop_cart_items (user_id, product_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, product_id)
       DO UPDATE SET quantity = LEAST(shop_cart_items.quantity + EXCLUDED.quantity, $4)`,
      [req.user.id, productId, Math.min(quantity, limit), limit]
    );

    res.status(201).json({ success: true, data: await readCart(req.user.id), message: '장바구니에 담았습니다.' });
  } catch (err) {
    next(err);
  }
});

// 수량 변경
app.patch('/api/cart/:productId', requireAuth, async (req, res, next) => {
  try {
    const productId = Number(req.params.productId);
    const quantity = Number((req.body || {}).quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      return res.status(400).json({ success: false, message: `수량은 1~${MAX_QTY}개 사이여야 합니다.` });
    }

    const { rows: products } = await pool.query('SELECT stock FROM shop_products WHERE id = $1', [productId]);
    if (products.length === 0) {
      return res.status(404).json({ success: false, message: '상품을 찾을 수 없습니다.' });
    }
    if (quantity > products[0].stock) {
      return res.status(409).json({ success: false, message: `재고가 ${products[0].stock}개 남았습니다.` });
    }

    const { rowCount } = await pool.query(
      'UPDATE shop_cart_items SET quantity = $1 WHERE user_id = $2 AND product_id = $3',
      [quantity, req.user.id, productId]
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '장바구니에 없는 상품입니다.' });
    }

    res.json({ success: true, data: await readCart(req.user.id) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/cart/:productId', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1 AND product_id = $2', [
      req.user.id,
      Number(req.params.productId),
    ]);
    res.json({ success: true, data: await readCart(req.user.id), message: '장바구니에서 뺐습니다.' });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/cart', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM shop_cart_items WHERE user_id = $1', [req.user.id]);
    res.json({ success: true, data: await readCart(req.user.id), message: '장바구니를 비웠습니다.' });
  } catch (err) {
    next(err);
  }
});

// ========================================
// 📦 주문 API — 로그인 필요
// ========================================

// 결제: 장바구니 → 주문. 재고 차감까지 한 트랜잭션이라 중간에 끊겨도 반쯤 된 주문이 남지 않는다
app.post('/api/orders', requireAuth, async (req, res, next) => {
  const { receiver, address, memo } = req.body || {};

  if (!receiver || !String(receiver).trim()) {
    return res.status(400).json({ success: false, message: '받는 분 이름을 입력해 주세요.' });
  }
  if (!address || String(address).trim().length < 5) {
    return res.status(400).json({ success: false, message: '배송지 주소를 정확히 입력해 주세요.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR UPDATE OF p: 결제하는 동안 같은 상품의 재고가 다른 주문에 먼저 빠져나가지 못하게 잠근다
    const { rows: items } = await client.query(
      `SELECT c.product_id, c.quantity, p.name, p.price, p.image_url, p.stock
         FROM shop_cart_items c
         JOIN shop_products p ON p.id = c.product_id
        WHERE c.user_id = $1
        ORDER BY c.product_id
          FOR UPDATE OF p`,
      [req.user.id]
    );

    if (items.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: '장바구니가 비어 있습니다.' });
    }

    const soldOut = items.find((i) => i.quantity > i.stock);
    if (soldOut) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: `'${soldOut.name}'의 재고가 ${soldOut.stock}개뿐입니다. 수량을 조정해 주세요.`,
      });
    }

    const totalAmount = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const { rows: orderRows } = await client.query(
      `INSERT INTO shop_orders (user_id, receiver, address, memo, total_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [req.user.id, String(receiver).trim(), String(address).trim(), String(memo || '').trim(), totalAmount]
    );
    const orderId = orderRows[0].id;

    for (const item of items) {
      await client.query(
        `INSERT INTO shop_order_items (order_id, product_id, name, price, image_url, quantity)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, item.product_id, item.name, item.price, item.image_url, item.quantity]
      );
      await client.query('UPDATE shop_products SET stock = stock - $1 WHERE id = $2', [
        item.quantity,
        item.product_id,
      ]);
    }

    await client.query('DELETE FROM shop_cart_items WHERE user_id = $1', [req.user.id]);
    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: { id: orderId, totalAmount, createdAt: orderRows[0].created_at, itemCount: items.length },
      message: '주문이 완료되었습니다.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
  }
});

// 내 주문 내역 (주문 + 주문 상품을 한 번에 묶어서)
app.get('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT o.id, o.receiver, o.address, o.memo, o.total_amount AS "totalAmount",
              o.status, o.created_at AS "createdAt",
              COALESCE(json_agg(
                json_build_object('productId', i.product_id, 'name', i.name,
                                  'price', i.price, 'imageUrl', i.image_url, 'quantity', i.quantity)
                ORDER BY i.id
              ) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
         FROM shop_orders o
         LEFT JOIN shop_order_items i ON i.order_id = o.id
        WHERE o.user_id = $1
        GROUP BY o.id
        ORDER BY o.created_at DESC`,
      [req.user.id]
    );

    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (err) {
    next(err);
  }
});

// ── API 404 ─────────────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: '존재하지 않는 API 경로입니다.' });
});

// ── SPA fallback (Express 5 문법) ────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── 에러 핸들러 (스택 트레이스는 노출하지 않는다) ──
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ── 기동 & export (로컬 / 서버리스 듀얼 모드) ──
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('🛍️ 오늘의 마켓 서버: http://localhost:' + PORT);
    console.log(DATABASE_URL ? '   DB: Supabase PostgreSQL 연결됨' : '   ⚠️ DATABASE_URL 환경변수가 없습니다 (.env 확인)');
  });
}

module.exports = app;
