// ============================================================
// 📝 Todo App 02 - Single File Backend (server.js)
// 데이터는 PostgreSQL(Supabase)에 저장한다.
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
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS todos (
      id         BIGSERIAL PRIMARY KEY,
      text       TEXT        NOT NULL,
      done       BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  dbInitialized = true;
}

// DB row → 클라이언트 형식
function toTodo(row) {
  return {
    id: Number(row.id),
    text: row.text,
    done: row.done,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

// 내용 정규화 (앞뒤 공백 제거, 줄바꿈은 공백으로)
function sanitize(text) {
  return String(text).replace(/\s+/g, ' ').trim();
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
    const { rows } = await pool.query('SELECT NOW() AS now, COUNT(*)::int AS count FROM todos');
    res.json({ success: true, data: { connected: true, serverTime: rows[0].now, count: rows[0].count } });
  } catch (err) {
    next(err);
  }
});

// 목록 조회 (?filter=all|active|done)
app.get('/api/todos', async (req, res, next) => {
  try {
    const filter = req.query.filter;
    const where = filter === 'active' ? 'WHERE done = FALSE' : filter === 'done' ? 'WHERE done = TRUE' : '';
    const { rows } = await pool.query(`SELECT * FROM todos ${where} ORDER BY id ASC`);
    res.json({ success: true, data: rows.map(toTodo) });
  } catch (err) {
    next(err);
  }
});

// 추가
app.post('/api/todos', async (req, res, next) => {
  try {
    const text = sanitize((req.body && req.body.text) || '');
    if (!text) {
      return res.status(400).json({ success: false, message: '할 일 내용을 입력해 주세요.' });
    }
    if (text.length > 200) {
      return res.status(400).json({ success: false, message: '할 일은 200자 이내로 입력해 주세요.' });
    }

    const { rows } = await pool.query('INSERT INTO todos (text) VALUES ($1) RETURNING *', [text]);
    res.status(201).json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 수정 (완료 토글 / 내용 변경)
app.patch('/api/todos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 입니다.' });
    }

    const { done, text } = req.body || {};
    let cleanText = null;
    if (typeof text === 'string') {
      cleanText = sanitize(text);
      if (!cleanText) {
        return res.status(400).json({ success: false, message: '할 일 내용은 비울 수 없습니다.' });
      }
    }
    if (typeof done !== 'boolean' && cleanText === null) {
      return res.status(400).json({ success: false, message: '변경할 내용이 없습니다.' });
    }

    // COALESCE 로 전달된 필드만 갱신
    const { rows } = await pool.query(
      `UPDATE todos
          SET done = COALESCE($2, done),
              text = COALESCE($3, text)
        WHERE id = $1
      RETURNING *`,
      [id, typeof done === 'boolean' ? done : null, cleanText]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 삭제
app.delete('/api/todos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '올바르지 않은 id 입니다.' });
    }
    const { rows } = await pool.query('DELETE FROM todos WHERE id = $1 RETURNING *', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toTodo(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 완료된 항목 일괄 삭제
app.delete('/api/todos', async (_req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM todos WHERE done = TRUE');
    res.json({ success: true, data: { removedCount: rowCount } });
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
    console.log(`✅ Todo(DB) server running on http://localhost:${PORT}`);
    console.log(
      DATABASE_URL
        ? '🗄️  DATABASE_URL 환경변수 감지됨 (PostgreSQL 사용)'
        : '⚠️  DATABASE_URL 이 없습니다. .env 파일을 만들어 주세요.'
    );
  });
}
module.exports = app;
