// ============================================================
// 📝 메모장 앱 - Single File Backend (server.js)
// 데이터는 PostgreSQL(Supabase)의 memos 테이블에 저장한다.
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
// 요구 사양: id / title / content / created_at 네 컬럼으로 시작한다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memos (
      id         BIGSERIAL PRIMARY KEY,
      title      TEXT        NOT NULL,
      content    TEXT        NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  dbInitialized = true;
}

// DB row → 클라이언트 형식
function toMemo(row) {
  return {
    id: Number(row.id),
    title: row.title,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// 제목 정규화 (앞뒤 공백 제거, 줄바꿈은 공백으로)
function sanitizeTitle(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

// 본문은 줄바꿈을 살려야 하므로 앞뒤 공백만 정리한다
function sanitizeContent(text) {
  return String(text).replace(/\r\n/g, '\n').trim();
}

const MAX_TITLE = 120;
const MAX_CONTENT = 20000;
const MAX_KEYWORDS = 5;

// 검색어를 공백 기준 키워드 배열로 자른다 (너무 많은 조건은 앞에서 자른다)
function parseKeywords(raw) {
  return String(raw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_KEYWORDS);
}

// LIKE 패턴에서 특수문자로 동작하는 %, _, \ 를 리터럴로 바꾼다.
// (이걸 안 하면 "%" 한 글자만 검색해도 전체 메모가 걸린다)
function escapeLike(word) {
  return word.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '1mb' }));
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
    const { rows } = await pool.query('SELECT NOW() AS now, COUNT(*)::int AS count FROM memos');
    res.json({ success: true, data: { connected: true, serverTime: rows[0].now, count: rows[0].count } });
  } catch (err) {
    next(err);
  }
});

// 목록 조회 (?q=검색어, ?sort=newest|oldest)
// 검색어는 공백으로 나눠 여러 키워드로 쓰고, 모든 키워드를 포함한 메모만 남긴다(AND).
// 키워드 하나는 제목 또는 본문 어느 쪽에 있어도 일치로 본다.
app.get('/api/memos', async (req, res, next) => {
  try {
    const keywords = parseKeywords(req.query.q);
    const order = req.query.sort === 'oldest' ? 'ASC' : 'DESC';

    const params = [];
    const clauses = keywords.map((word) => {
      params.push(`%${escapeLike(word)}%`);
      const i = params.length;
      // ILIKE 로 대소문자 무시. %, _ 는 위에서 이스케이프했으므로 리터럴로 취급된다.
      return `(title ILIKE $${i} ESCAPE '\\' OR content ILIKE $${i} ESCAPE '\\')`;
    });
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT * FROM memos ${where} ORDER BY created_at ${order}, id ${order}`,
      params
    );
    res.json({ success: true, data: rows.map(toMemo), meta: { keywords } });
  } catch (err) {
    next(err);
  }
});

// 단건 조회
app.get('/api/memos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 입니다.' });
    }
    const { rows } = await pool.query('SELECT * FROM memos WHERE id = $1', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 작성
app.post('/api/memos', async (req, res, next) => {
  try {
    const title = sanitizeTitle((req.body && req.body.title) || '');
    const content = sanitizeContent((req.body && req.body.content) || '');

    if (!title) {
      return res.status(400).json({ success: false, message: '제목을 입력해 주세요.' });
    }
    if (title.length > MAX_TITLE) {
      return res.status(400).json({ success: false, message: `제목은 ${MAX_TITLE}자 이내로 입력해 주세요.` });
    }
    if (content.length > MAX_CONTENT) {
      return res.status(400).json({ success: false, message: `내용은 ${MAX_CONTENT}자 이내로 입력해 주세요.` });
    }

    const { rows } = await pool.query(
      'INSERT INTO memos (title, content) VALUES ($1, $2) RETURNING *',
      [title, content]
    );
    res.status(201).json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 수정 (제목 / 내용)
app.patch('/api/memos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 입니다.' });
    }

    const { title, content } = req.body || {};
    let cleanTitle = null;
    let cleanContent = null;

    if (typeof title === 'string') {
      cleanTitle = sanitizeTitle(title);
      if (!cleanTitle) {
        return res.status(400).json({ success: false, message: '제목은 비울 수 없습니다.' });
      }
      if (cleanTitle.length > MAX_TITLE) {
        return res.status(400).json({ success: false, message: `제목은 ${MAX_TITLE}자 이내로 입력해 주세요.` });
      }
    }
    if (typeof content === 'string') {
      cleanContent = sanitizeContent(content);
      if (cleanContent.length > MAX_CONTENT) {
        return res.status(400).json({ success: false, message: `내용은 ${MAX_CONTENT}자 이내로 입력해 주세요.` });
      }
    }
    if (cleanTitle === null && cleanContent === null) {
      return res.status(400).json({ success: false, message: '변경할 내용이 없습니다.' });
    }

    // COALESCE 로 전달된 필드만 갱신 (내용은 빈 문자열도 유효하므로 따로 처리)
    const { rows } = await pool.query(
      `UPDATE memos
          SET title   = COALESCE($2, title),
              content = CASE WHEN $3::boolean THEN $4 ELSE content END
        WHERE id = $1
      RETURNING *`,
      [id, cleanTitle, cleanContent !== null, cleanContent]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toMemo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 삭제
app.delete('/api/memos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 입니다.' });
    }
    const { rows } = await pool.query('DELETE FROM memos WHERE id = $1 RETURNING *', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 메모를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toMemo(rows[0]) });
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
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ── Startup & export ─────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`메모장 앱 서버 실행 중 → http://localhost:${PORT}`);
    console.log(DATABASE_URL ? 'DB: DATABASE_URL 연결 설정됨' : 'DB: DATABASE_URL 없음 (.env 확인 필요)');
  });
}

module.exports = app;
