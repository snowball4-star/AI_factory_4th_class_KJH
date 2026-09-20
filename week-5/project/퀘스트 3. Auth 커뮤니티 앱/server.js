// ========================================
// 👨‍👩‍👧 우리가족 커뮤니티 — 단일 파일 백엔드 (Express 5 + Supabase PostgreSQL)
// 로컬: node server.js  /  Vercel: module.exports = app
//
// 비밀정보는 전부 .env(gitignore됨)에서만 읽는다.
//   DATABASE_URL : Supabase PostgreSQL 연결 문자열
//   SEED_USERS   : 최초 실행 시 만들 가족 계정 "아이디:표시이름:비밀번호" 쉼표 구분
// 세션은 HttpOnly 쿠키로만 오가며, 브라우저 저장소에는 아무것도 남기지 않는다.
// ========================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool, types } = require('pg');

// ── Env (.env 직접 파싱, dotenv 의존성 없음) ────
// 로컬 개발 전용. 배포 환경에서는 플랫폼에 설정한 환경변수만 쓴다.
// Vercel은 .vercelignore에 .env를 적어도 배포 번들에 포함시키므로, 여기서 읽지 않도록
// 막아야 번들에 딸려 들어간 .env가 조용히 사용되는 일을 막을 수 있다
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

const CATEGORIES = ['맛집정보', '여행정보', '생활정보', '포트폴리오'];
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7일
const COOKIE_NAME = 'sid';

// TIMESTAMPTZ는 ISO 문자열 그대로 받는다 (프런트에서 Date로 파싱)
types.setTypeParser(20, (v) => Number(v)); // BIGINT(COUNT) → 숫자

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  : null;

// ── DB 스키마 (lazy init, 서버리스 cold start 대응) ──
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS community_users (
    id            SERIAL PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  COMMENT ON TABLE  community_users IS '가족 커뮤니티 사용자';
  COMMENT ON COLUMN community_users.password_hash IS 'scrypt(비밀번호, salt) 해시 — 평문은 저장하지 않는다';

  CREATE TABLE IF NOT EXISTS community_posts (
    id         SERIAL PRIMARY KEY,
    title      TEXT NOT NULL,
    category   TEXT NOT NULL CHECK (category IN ('맛집정보', '여행정보', '생활정보', '포트폴리오')),
    content    TEXT NOT NULL,
    author_id  INTEGER NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS community_posts_created_idx  ON community_posts (created_at DESC);
  CREATE INDEX IF NOT EXISTS community_posts_category_idx ON community_posts (category);
  COMMENT ON TABLE community_posts IS '가족 게시글 (맛집정보·여행정보·생활정보·포트폴리오)';

  CREATE TABLE IF NOT EXISTS community_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS community_sessions_expires_idx ON community_sessions (expires_at);
  COMMENT ON TABLE community_sessions IS '로그인 세션. 쿠키의 토큰 원문이 아니라 SHA-256 해시를 저장한다';
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

// ── 시드 (DB가 비어 있을 때만) ────────────────
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

const SEED_POSTS = [
  {
    seedIndex: 1, // SEED_USERS의 두 번째 사람(엄마)
    category: '맛집정보',
    title: '대치동 손칼국수 명가 다녀왔어요',
    content:
      '면이 쫄깃하고 국물이 진해요. 점심시간엔 줄이 길어서 11시 30분 전에 가는 걸 추천합니다.\n\n- 위치: 대치역 3번 출구 도보 5분\n- 가격: 손칼국수 9,000원 / 만두 6,000원\n- 주차: 건물 뒤편 2시간 무료',
  },
  {
    seedIndex: 0,
    category: '여행정보',
    title: '가을 강릉 1박 2일 코스 정리',
    content:
      '이번 연휴에 다녀온 강릉 코스를 정리해 둡니다.\n\n1일차: 주문진 수산시장 → 경포호 산책 → 숙소 체크인\n2일차: 안목해변 커피거리 → 오죽헌 → 귀가\n\n토요일 오전에 출발하니 영동고속도로가 덜 막혔습니다.',
  },
  {
    seedIndex: 2,
    category: '포트폴리오',
    title: '학교 과제로 만든 날씨 웹앱',
    content:
      'React로 만든 간단한 날씨 조회 앱입니다. 도시를 검색하면 현재 기온과 3일 예보를 보여줘요.\n\n배운 점: 비동기 요청 상태(로딩/에러/성공)를 나눠서 관리하니 화면이 훨씬 안정적으로 동작했습니다.',
  },
  {
    seedIndex: 0,
    category: '생활정보',
    title: '아파트 재활용 배출 요일 변경 안내',
    content:
      '관리사무소 공지에 따라 이번 달부터 재활용 배출 요일이 수요일에서 목요일로 바뀌었습니다.\n\n- 플라스틱/캔: 목요일 저녁 6시 이후\n- 대형 폐기물: 사전 신고 후 주말 배출',
  },
];

async function seedIfEmpty() {
  const seedUsers = parseSeedUsers();
  if (seedUsers.length === 0) return;

  // 이미 있는 아이디는 건드리지 않는다 (비밀번호를 덮어쓰지 않기 위해)
  const created = [];
  for (const u of seedUsers) {
    const salt = crypto.randomBytes(16).toString('hex');
    const { rows } = await pool.query(
      `INSERT INTO community_users (username, display_name, password_salt, password_hash)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (username) DO NOTHING
       RETURNING id`,
      [u.username, u.displayName || u.username, salt, hashPassword(u.password, salt)]
    );
    created.push(rows[0] ? rows[0].id : null);
  }

  const { rows: countRows } = await pool.query('SELECT COUNT(*)::bigint AS n FROM community_posts');
  if (countRows[0].n > 0) return;

  // 시드 글은 시드 사용자가 실제로 만들어졌을 때만 넣는다
  const { rows: userRows } = await pool.query(
    'SELECT id, username FROM community_users WHERE username = ANY($1::text[])',
    [seedUsers.map((u) => u.username)]
  );
  const idByUsername = new Map(userRows.map((r) => [r.username, r.id]));

  const base = Date.now() - SEED_POSTS.length * 1000 * 60 * 90;
  for (let i = 0; i < SEED_POSTS.length; i += 1) {
    const sample = SEED_POSTS[i];
    const seedUser = seedUsers[sample.seedIndex] || seedUsers[0];
    const authorId = idByUsername.get(seedUser.username);
    if (!authorId) continue;
    const at = new Date(base + i * 1000 * 60 * 90).toISOString();
    await pool.query(
      `INSERT INTO community_posts (title, category, content, author_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [sample.title, sample.category, sample.content, authorId, at]
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
    'INSERT INTO community_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), userId, new Date(Date.now() + SESSION_TTL_MS).toISOString()]
  );
  setSessionCookie(req, res, token);
}

async function requireAuth(req, res, next) {
  try {
    const token = readCookie(req, COOKIE_NAME);
    if (!token) {
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.display_name, s.token_hash, s.expires_at
         FROM community_sessions s
         JOIN community_users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    );

    if (rows.length === 0) {
      clearSessionCookie(req, res);
      return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    req.user = rows[0];
    req.tokenHash = rows[0].token_hash;
    next();
  } catch (err) {
    next(err);
  }
}

// 게시글 조회용 공통 SELECT (작성자 이름 조인 + camelCase 별칭)
const POST_COLUMNS = `p.id, p.title, p.category, p.content,
  p.author_id AS "authorId", u.display_name AS "authorName",
  p.created_at AS "createdAt", p.updated_at AS "updatedAt"`;

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

// ── 인증 라우트 ──────────────────────────────
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
      `INSERT INTO community_users (username, display_name, password_salt, password_hash)
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
      'SELECT id, username, display_name, password_salt, password_hash FROM community_users WHERE username = $1',
      [String(username).trim().toLowerCase()]
    );
    const user = rows[0];

    if (!user || !verifyPassword(user, String(password))) {
      return res.status(401).json({ success: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    await pool.query('DELETE FROM community_sessions WHERE expires_at < now()'); // 만료 세션 정리
    await createSession(req, res, user.id);
    res.json({ success: true, data: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, data: publicUser(req.user) });
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM community_sessions WHERE token_hash = $1', [req.tokenHash]);
    clearSessionCookie(req, res);
    res.json({ success: true, message: '로그아웃되었습니다.' });
  } catch (err) {
    next(err);
  }
});

// ── 카테고리 ─────────────────────────────────
app.get('/api/categories', (_req, res) => {
  res.json({ success: true, data: CATEGORIES });
});

// ── 게시글 라우트 ────────────────────────────
// 목록: 최신순 + 카테고리/검색어 필터. 본문 전체 대신 미리보기만 내려보낸다
app.get('/api/posts', async (req, res, next) => {
  try {
    const { category, q } = req.query;
    const conditions = [];
    const params = [];

    if (category && CATEGORIES.includes(category)) {
      params.push(category);
      conditions.push(`p.category = $${params.length}`);
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim()}%`);
      conditions.push(`(p.title ILIKE $${params.length} OR p.content ILIKE $${params.length} OR u.display_name ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT p.id, p.title, p.category, p.author_id AS "authorId", u.display_name AS "authorName",
              p.created_at AS "createdAt", p.updated_at AS "updatedAt",
              left(regexp_replace(p.content, '\\s+', ' ', 'g'), 80) AS excerpt
         FROM community_posts p
         JOIN community_users u ON u.id = p.author_id
         ${where}
        ORDER BY p.created_at DESC`,
      params
    );

    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch (err) {
    next(err);
  }
});

// 상세
app.get('/api/posts/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ success: false, message: '잘못된 게시글 번호입니다.' });
    }

    const { rows } = await pool.query(
      `SELECT ${POST_COLUMNS} FROM community_posts p JOIN community_users u ON u.id = p.author_id WHERE p.id = $1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

function validatePost(body) {
  const { title, category, content } = body || {};
  if (!title || !String(title).trim()) return '제목을 입력해 주세요.';
  if (!content || !String(content).trim()) return '내용을 입력해 주세요.';
  if (!CATEGORIES.includes(category)) return '카테고리는 ' + CATEGORIES.join(', ') + ' 중 하나여야 합니다.';
  if (String(title).trim().length > 100) return '제목은 100자 이하여야 합니다.';
  return null;
}

// 작성
app.post('/api/posts', requireAuth, async (req, res, next) => {
  try {
    const invalid = validatePost(req.body);
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    const { title, category, content } = req.body;
    const { rows } = await pool.query(
      `WITH inserted AS (
         INSERT INTO community_posts (title, category, content, author_id)
         VALUES ($1, $2, $3, $4)
         RETURNING *
       )
       SELECT ${POST_COLUMNS} FROM inserted p JOIN community_users u ON u.id = p.author_id`,
      [String(title).trim(), category, String(content).trim(), req.user.id]
    );

    res.status(201).json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// 수정 (작성자 본인만)
app.put('/api/posts/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const invalid = validatePost(req.body);
    if (invalid) return res.status(400).json({ success: false, message: invalid });

    const { rows: owner } = await pool.query('SELECT author_id FROM community_posts WHERE id = $1', [id]);
    if (owner.length === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    if (owner[0].author_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '본인이 작성한 글만 수정할 수 있습니다.' });
    }

    const { title, category, content } = req.body;
    const { rows } = await pool.query(
      `WITH updated AS (
         UPDATE community_posts
            SET title = $1, category = $2, content = $3, updated_at = now()
          WHERE id = $4
          RETURNING *
       )
       SELECT ${POST_COLUMNS} FROM updated p JOIN community_users u ON u.id = p.author_id`,
      [String(title).trim(), category, String(content).trim(), id]
    );

    res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// 삭제 (작성자 본인만)
app.delete('/api/posts/:id', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);

    const { rows: owner } = await pool.query('SELECT author_id FROM community_posts WHERE id = $1', [id]);
    if (owner.length === 0) {
      return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
    }
    if (owner[0].author_id !== req.user.id) {
      return res.status(403).json({ success: false, message: '본인이 작성한 글만 삭제할 수 있습니다.' });
    }

    await pool.query('DELETE FROM community_posts WHERE id = $1', [id]);
    res.json({ success: true, data: { id }, message: '삭제되었습니다.' });
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
    console.log('👨‍👩‍👧 우리가족 커뮤니티 서버: http://localhost:' + PORT);
    console.log(DATABASE_URL ? '   DB: Supabase PostgreSQL 연결됨' : '   ⚠️ DATABASE_URL 환경변수가 없습니다 (.env 확인)');
  });
}

module.exports = app;
