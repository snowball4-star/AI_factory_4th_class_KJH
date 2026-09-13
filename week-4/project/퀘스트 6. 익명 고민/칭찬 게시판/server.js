// ============================================================
// 💌 익명 고민/칭찬 게시판 - Single File Backend (server.js)
//
// - 글과 공감은 PostgreSQL(Supabase)의 anon_posts / anon_empathies 테이블에 저장한다.
//   (같은 DB를 다른 과제 앱도 쓰므로 테이블 이름에 anon_ 접두사를 붙였다)
// - 접속 문자열은 코드에 넣지 않고 환경변수 DATABASE_URL 에서만 읽는다.
//   브라우저는 /api/... 만 호출하며 DB 정보는 절대 내려가지 않는다.
// - 로그인 없는 익명 앱이라, 브라우저가 만든 무작위 익명 ID(X-Client-Id 헤더)로
//   "한 사람당 글 하나에 공감 한 번"만 허용한다. 이 ID는 응답에 노출하지 않는다.
// - 로컬(node server.js) / Vercel 서버리스 듀얼 모드.
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

// ── 게시판 규칙 ──────────────────────────────
const CATEGORIES   = ['고민', '칭찬', '응원', '감사'];
const SORTS        = { latest: 'latest', empathy: 'empathy' };
const MAX_CONTENT  = 500;
const PAGE_SIZE    = 20;
const CLIENT_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

// 글마다 붙는 익명 닉네임 재료 ("포근한 고양이" 같은 조합)
const ADJECTIVES = ['포근한', '용감한', '다정한', '졸린', '반짝이는', '느긋한', '씩씩한', '수줍은', '따뜻한', '엉뚱한'];
const ANIMALS    = ['고양이', '강아지', '펭귄', '수달', '다람쥐', '토끼', '판다', '고래', '부엉이', '햄스터'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

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
// anon_posts     : 카테고리 / 본문 / 익명 닉네임 / 공감 수(정렬용 비정규화 컬럼)
// anon_empathies : (글, 익명 ID) 쌍을 기본키로 두어 중복 공감을 DB 차원에서 막는다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anon_posts (
      id            BIGSERIAL   PRIMARY KEY,
      category      TEXT        NOT NULL,
      content       TEXT        NOT NULL CHECK (char_length(content) BETWEEN 1 AND ${MAX_CONTENT}),
      nickname      TEXT        NOT NULL,
      empathy_count INT         NOT NULL DEFAULT 0 CHECK (empathy_count >= 0),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS anon_empathies (
      post_id    BIGINT      NOT NULL REFERENCES anon_posts(id) ON DELETE CASCADE,
      client_id  TEXT        NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, client_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS anon_posts_created_idx ON anon_posts (created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS anon_posts_empathy_idx ON anon_posts (empathy_count DESC, created_at DESC, id DESC)');
  dbInitialized = true;
}

// ── Helpers ──────────────────────────────────
const getClientId = (req) => {
  const id = String(req.get('X-Client-Id') || '').trim();
  return CLIENT_ID_RE.test(id) ? id : null;
};

const toPost = (row) => ({
  id: Number(row.id),
  category: row.category,
  content: row.content,
  nickname: row.nickname,
  empathyCount: Number(row.empathy_count),
  empathized: Boolean(row.empathized),
  createdAt: row.created_at,
});

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '16kb' }));
// 정적 파일은 index.html 하나뿐이라 express.static 대신 SPA fallback 으로만 내려준다.
// (폴더 전체를 static 으로 열면 server.js·package.json 까지 브라우저에서 받아볼 수 있다)

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
// 카테고리 목록 + 카테고리별 글 수 (필터 탭 표시용)
app.get('/api/categories', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT category, COUNT(*)::int AS count FROM anon_posts GROUP BY category');
    const counts = Object.fromEntries(rows.map((r) => [r.category, r.count]));
    const data = CATEGORIES.map((name) => ({ name, count: counts[name] || 0 }));
    res.json({ success: true, data: { categories: data, total: data.reduce((s, c) => s + c.count, 0) } });
  } catch (err) {
    next(err);
  }
});

// 글 목록: ?sort=latest|empathy &category=고민 &offset=0
app.get('/api/posts', async (req, res, next) => {
  try {
    const sort = SORTS[req.query.sort] || SORTS.latest;
    const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
    const offset = Math.max(0, Math.min(10_000, parseInt(req.query.offset, 10) || 0));
    const clientId = getClientId(req);

    const orderBy = sort === SORTS.empathy
      ? 'p.empathy_count DESC, p.created_at DESC, p.id DESC'
      : 'p.created_at DESC, p.id DESC';

    // 한 개 더 가져와서 다음 페이지 존재 여부를 판단한다
    const { rows } = await pool.query(
      `SELECT p.*,
              EXISTS (SELECT 1 FROM anon_empathies e WHERE e.post_id = p.id AND e.client_id = $1) AS empathized
         FROM anon_posts p
        WHERE ($2::text IS NULL OR p.category = $2)
        ORDER BY ${orderBy}
        LIMIT $3 OFFSET $4`,
      [clientId, category, PAGE_SIZE + 1, offset]
    );

    res.json({
      success: true,
      data: {
        posts: rows.slice(0, PAGE_SIZE).map(toPost),
        hasMore: rows.length > PAGE_SIZE,
        nextOffset: offset + Math.min(rows.length, PAGE_SIZE),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── POST ─────────────────────────────────────
// 익명 글 작성
app.post('/api/posts', async (req, res, next) => {
  try {
    const { category, content } = req.body || {};
    const text = typeof content === 'string' ? content.trim() : '';

    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: `카테고리는 ${CATEGORIES.join(', ')} 중 하나여야 합니다.` });
    }
    if (!text) {
      return res.status(400).json({ success: false, message: '내용을 입력해 주세요.' });
    }
    if (text.length > MAX_CONTENT) {
      return res.status(400).json({ success: false, message: `내용은 ${MAX_CONTENT}자 이하로 작성해 주세요.` });
    }

    const { rows } = await pool.query(
      `INSERT INTO anon_posts (category, content, nickname)
       VALUES ($1, $2, $3)
       RETURNING *, FALSE AS empathized`,
      [category, text, `${pick(ADJECTIVES)} ${pick(ANIMALS)}`]
    );
    res.status(201).json({ success: true, data: toPost(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 공감 토글: 안 눌렀으면 공감, 이미 눌렀으면 공감 취소
app.post('/api/posts/:id/empathy', async (req, res, next) => {
  const postId = parseInt(req.params.id, 10);
  const clientId = getClientId(req);

  if (!Number.isSafeInteger(postId) || postId <= 0) {
    return res.status(400).json({ success: false, message: '잘못된 글 번호입니다.' });
  }
  if (!clientId) {
    return res.status(400).json({ success: false, message: '익명 ID가 없습니다. 페이지를 새로고침해 주세요.' });
  }

  const client = await pool.connect().catch(next);
  if (!client) return;
  try {
    await client.query('BEGIN');

    // 글 행을 잠가 동시 클릭에도 공감 수가 어긋나지 않게 한다
    const found = await client.query('SELECT id FROM anon_posts WHERE id = $1 FOR UPDATE', [postId]);
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: '글을 찾을 수 없습니다.' });
    }

    const inserted = await client.query(
      'INSERT INTO anon_empathies (post_id, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [postId, clientId]
    );
    const empathized = inserted.rowCount === 1;
    if (!empathized) {
      await client.query('DELETE FROM anon_empathies WHERE post_id = $1 AND client_id = $2', [postId, clientId]);
    }

    const { rows } = await client.query(
      `UPDATE anon_posts SET empathy_count = GREATEST(empathy_count + $2, 0)
        WHERE id = $1 RETURNING empathy_count`,
      [postId, empathized ? 1 : -1]
    );
    await client.query('COMMIT');

    res.json({ success: true, data: { id: postId, empathized, empathyCount: Number(rows[0].empathy_count) } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client.release();
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
  app.listen(PORT, () => console.log(`익명 게시판 서버: http://localhost:${PORT}`));
}
module.exports = app;
