// ============================================================
// ⚖️ 실시간 밸런스 게임 - Single File Backend (server.js)
//
// - 질문/투표는 PostgreSQL(Supabase)의 balance_questions / balance_votes 테이블에 저장한다.
// - 접속 문자열은 코드에 넣지 않고 환경변수 DATABASE_URL 에서만 읽는다.
//   (브라우저로는 절대 내려보내지 않는다. 프런트는 /api/... 만 호출한다)
// - 로그인이 없는 익명 앱이다. 브라우저가 만든 무작위 익명 ID(X-Client-Id 헤더)는
//   SHA-256 해시로만 저장하고, "한 브라우저 = 질문당 한 표"(선택 변경 가능)로 집계한다.
// - 실시간: SSE(/api/stream)로 집계 스냅샷을 푸시한다.
//   · 이 인스턴스에서 일어난 쓰기 → 즉시 브로드캐스트
//   · 다른 인스턴스(서버리스)에서 일어난 쓰기 → DB 변경 시그니처를 주기적으로 비교해 브로드캐스트
//   · SSE 가 끊기면 프런트가 /api/snapshot 폴링으로 자동 전환한다.
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

// ── 규칙 ─────────────────────────────────────
const TITLE_MAX        = 60;     // 질문 제목(선택) 최대 글자수
const OPTION_MAX       = 60;     // 선택지 최대 글자수
const LIST_LIMIT       = 100;    // 목록 최대 개수
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const CREATE_MAX       = 5;      // 한 브라우저가 10분 동안 등록할 수 있는 질문 수
const WATCH_MS         = 2000;   // 다른 인스턴스의 변경 감지 주기
const HEARTBEAT_MS     = 25000;  // SSE 연결 유지 핑
const CLIENT_ID_RE     = /^[A-Za-z0-9-]{16,64}$/;

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
let dbInitPromise = null;
function initDB() {
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS balance_questions (
          id           BIGSERIAL   PRIMARY KEY,
          title        TEXT        NOT NULL DEFAULT '',
          option_a     TEXT        NOT NULL,
          option_b     TEXT        NOT NULL,
          creator_hash TEXT        NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS balance_votes (
          question_id BIGINT      NOT NULL REFERENCES balance_questions(id) ON DELETE CASCADE,
          voter_hash  TEXT        NOT NULL,
          choice      CHAR(1)     NOT NULL CHECK (choice IN ('A', 'B')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (question_id, voter_hash)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS balance_votes_voter_idx ON balance_votes (voter_hash)');
    })().catch((err) => {
      dbInitPromise = null; // 실패하면 다음 요청에서 다시 시도
      throw err;
    });
  }
  return dbInitPromise;
}

// ── Helpers ──────────────────────────────────
const getClientHash = (req) => {
  const id = String(req.get('X-Client-Id') || req.query.cid || '').trim();
  return CLIENT_ID_RE.test(id) ? crypto.createHash('sha256').update(`balance:${id}`).digest('hex') : null;
};

const cleanText = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

const toQuestion = (r) => ({
  id: Number(r.id),
  title: r.title,
  optionA: r.option_a,
  optionB: r.option_b,
  createdAt: r.created_at,
  a: r.a,
  b: r.b,
  total: r.a + r.b,
  myChoice: r.my_choice || null,
  isMine: r.is_mine,
});

// 모든 클라이언트에게 똑같이 보낼 수 있는 집계 (개인 정보 없음)
async function getSnapshot() {
  const [counts, participants] = await Promise.all([
    pool.query(`
      SELECT q.id,
             COUNT(v.voter_hash) FILTER (WHERE v.choice = 'A')::int AS a,
             COUNT(v.voter_hash) FILTER (WHERE v.choice = 'B')::int AS b
        FROM balance_questions q
        LEFT JOIN balance_votes v ON v.question_id = q.id
       GROUP BY q.id
    `),
    pool.query('SELECT COUNT(DISTINCT voter_hash)::int AS n, COUNT(*)::int AS votes FROM balance_votes'),
  ]);
  const stats = {};
  for (const r of counts.rows) stats[Number(r.id)] = { a: r.a, b: r.b, total: r.a + r.b };
  return {
    stats,
    questionCount: counts.rowCount,
    participants: participants.rows[0].n,
    totalVotes: participants.rows[0].votes,
    at: Date.now(),
  };
}

// ── 실시간(SSE) 허브 ──────────────────────────
const sseClients = new Set();
let lastSignature = '';
let watchTimer = null;
let broadcastQueued = false;

async function readSignature() {
  const { rows } = await pool.query(`
    SELECT (SELECT COUNT(*) FROM balance_votes)                 AS vc,
           (SELECT COALESCE(MAX(updated_at), 'epoch') FROM balance_votes) AS vu,
           (SELECT COUNT(*) FROM balance_questions)             AS qc,
           (SELECT COALESCE(MAX(id), 0) FROM balance_questions) AS qm
  `);
  const r = rows[0];
  return `${r.vc}|${new Date(r.vu).getTime()}|${r.qc}|${r.qm}`;
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// 짧은 시간에 여러 표가 몰려도 스냅샷 쿼리는 한 번만 돌린다
function broadcast() {
  if (broadcastQueued || sseClients.size === 0) return;
  broadcastQueued = true;
  setTimeout(async () => {
    broadcastQueued = false;
    try {
      const [snapshot, signature] = await Promise.all([getSnapshot(), readSignature()]);
      lastSignature = signature;
      for (const res of sseClients) sendEvent(res, 'snapshot', snapshot);
    } catch (err) {
      console.error('[broadcast]', err.message);
    }
  }, 80);
}

function startWatcher() {
  if (watchTimer) return;
  watchTimer = setInterval(async () => {
    if (sseClients.size === 0) return stopWatcher();
    try {
      const signature = await readSignature();
      if (signature !== lastSignature) {
        lastSignature = signature;
        broadcast();
      }
    } catch (err) {
      console.error('[watcher]', err.message);
    }
  }, WATCH_MS);
  watchTimer.unref?.();
}

function stopWatcher() {
  clearInterval(watchTimer);
  watchTimer = null;
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '16kb' }));
// 정적 파일은 index.html 하나뿐이라 express.static 대신 SPA fallback 으로만 내려준다.
// (폴더 전체를 static 으로 열면 server.js·package.json·.env 까지 브라우저에서 받아볼 수 있다)

// DB 설정 여부만 알려준다 (접속 문자열 자체는 절대 응답하지 않는다)
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    data: { dbConfigured: Boolean(pool), limits: { titleMax: TITLE_MAX, optionMax: OPTION_MAX } },
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
// 질문 목록: ?sort=latest|popular  (X-Client-Id 가 있으면 내 선택도 함께)
app.get('/api/questions', async (req, res, next) => {
  try {
    const sort = req.query.sort === 'popular' ? 'popular' : 'latest';
    const clientHash = getClientHash(req) || '';
    const orderBy = sort === 'popular' ? 'total DESC, q.id DESC' : 'q.id DESC';

    const { rows } = await pool.query(
      `SELECT q.id, q.title, q.option_a, q.option_b, q.created_at,
              (q.creator_hash = $1) AS is_mine,
              COUNT(v.voter_hash) FILTER (WHERE v.choice = 'A')::int AS a,
              COUNT(v.voter_hash) FILTER (WHERE v.choice = 'B')::int AS b,
              COUNT(v.voter_hash)::int AS total,
              MAX(v.choice) FILTER (WHERE v.voter_hash = $1) AS my_choice
         FROM balance_questions q
         LEFT JOIN balance_votes v ON v.question_id = q.id
        GROUP BY q.id
        ORDER BY ${orderBy}
        LIMIT ${LIST_LIMIT}`,
      [clientHash]
    );

    const snapshot = await getSnapshot();
    res.json({
      success: true,
      data: {
        questions: rows.map(toQuestion),
        participants: snapshot.participants,
        totalVotes: snapshot.totalVotes,
        questionCount: snapshot.questionCount,
      },
    });
  } catch (err) {
    next(err);
  }
});

// 집계 스냅샷 (SSE 가 안 될 때 폴링용)
app.get('/api/snapshot', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getSnapshot() });
  } catch (err) {
    next(err);
  }
});

// 실시간 스트림 (Server-Sent Events)
app.get('/api/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  sseClients.add(res);
  startWatcher();

  try {
    sendEvent(res, 'snapshot', await getSnapshot());
    if (!lastSignature) lastSignature = await readSignature();
  } catch (err) {
    console.error('[stream init]', err.message);
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
    if (sseClients.size === 0) stopWatcher();
  });
});

// ── POST ─────────────────────────────────────
// 질문 등록: { title?, optionA, optionB }
app.post('/api/questions', async (req, res, next) => {
  try {
    const clientHash = getClientHash(req);
    if (!clientHash) {
      return res.status(400).json({ success: false, message: '익명 ID가 없습니다. 페이지를 새로고침해 주세요.' });
    }

    const body = req.body || {};
    const title = cleanText(body.title);
    const optionA = cleanText(body.optionA);
    const optionB = cleanText(body.optionB);

    if (!optionA || !optionB) {
      return res.status(400).json({ success: false, message: 'A와 B 선택지를 모두 입력해 주세요.' });
    }
    if (optionA.length > OPTION_MAX || optionB.length > OPTION_MAX) {
      return res.status(400).json({ success: false, message: `선택지는 ${OPTION_MAX}자 이내로 입력해 주세요.` });
    }
    if (title.length > TITLE_MAX) {
      return res.status(400).json({ success: false, message: `질문 제목은 ${TITLE_MAX}자 이내로 입력해 주세요.` });
    }
    if (optionA.toLowerCase() === optionB.toLowerCase()) {
      return res.status(400).json({ success: false, message: 'A와 B는 서로 다른 선택지여야 합니다.' });
    }

    const recent = await pool.query(
      `SELECT COUNT(*)::int AS n FROM balance_questions
        WHERE creator_hash = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 millisecond')`,
      [clientHash, CREATE_WINDOW_MS]
    );
    if (recent.rows[0].n >= CREATE_MAX) {
      return res.status(429).json({ success: false, message: '질문을 너무 자주 등록했어요. 잠시 후 다시 시도해 주세요.' });
    }

    const { rows } = await pool.query(
      `INSERT INTO balance_questions (title, option_a, option_b, creator_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, option_a, option_b, created_at, TRUE AS is_mine, 0 AS a, 0 AS b`,
      [title, optionA, optionB, clientHash]
    );

    broadcast();
    res.status(201).json({ success: true, data: toQuestion(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// 투표 / 선택 변경: { choice: 'A' | 'B' }
app.post('/api/questions/:id/vote', async (req, res, next) => {
  try {
    const clientHash = getClientHash(req);
    if (!clientHash) {
      return res.status(400).json({ success: false, message: '익명 ID가 없습니다. 페이지를 새로고침해 주세요.' });
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '잘못된 질문 번호입니다.' });
    }
    const choice = String((req.body || {}).choice || '').toUpperCase();
    if (choice !== 'A' && choice !== 'B') {
      return res.status(400).json({ success: false, message: "choice 는 'A' 또는 'B' 여야 합니다." });
    }

    try {
      await pool.query(
        `INSERT INTO balance_votes (question_id, voter_hash, choice)
         VALUES ($1, $2, $3)
         ON CONFLICT (question_id, voter_hash)
         DO UPDATE SET choice = EXCLUDED.choice, updated_at = NOW()
         WHERE balance_votes.choice <> EXCLUDED.choice`,
        [id, clientHash, choice]
      );
    } catch (err) {
      if (err.code === '23503') {
        return res.status(404).json({ success: false, message: '질문을 찾을 수 없습니다. 삭제되었을 수 있어요.' });
      }
      throw err;
    }

    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE choice = 'A')::int AS a,
              COUNT(*) FILTER (WHERE choice = 'B')::int AS b
         FROM balance_votes WHERE question_id = $1`,
      [id]
    );

    broadcast();
    const { a, b } = rows[0];
    res.json({ success: true, data: { id, a, b, total: a + b, myChoice: choice } });
  } catch (err) {
    next(err);
  }
});

// ── DELETE ───────────────────────────────────
// 내가 등록한 질문 삭제 (투표도 함께 삭제됨)
app.delete('/api/questions/:id', async (req, res, next) => {
  try {
    const clientHash = getClientHash(req);
    const id = Number(req.params.id);
    if (!clientHash || !Number.isSafeInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, message: '잘못된 요청입니다.' });
    }
    const { rowCount } = await pool.query(
      'DELETE FROM balance_questions WHERE id = $1 AND creator_hash = $2',
      [id, clientHash]
    );
    if (rowCount === 0) {
      return res.status(404).json({ success: false, message: '삭제할 수 있는 질문이 없습니다. (내가 등록한 질문만 삭제 가능)' });
    }
    broadcast();
    res.json({ success: true, data: { id, deleted: true } });
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
  app.listen(PORT, () => console.log(`⚖️ 실시간 밸런스 게임 서버: http://localhost:${PORT}`));
}
module.exports = app;
