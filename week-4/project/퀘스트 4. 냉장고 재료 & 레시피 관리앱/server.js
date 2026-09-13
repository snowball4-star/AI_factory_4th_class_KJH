// ============================================================
// 🧊 냉장고 재료 & 레시피 관리앱 - Single File Backend (server.js)
//
// - 재료/레시피는 PostgreSQL(Supabase)의 fridge_ingredients / fridge_recipes 테이블에 저장한다.
// - 접속 문자열은 코드에 넣지 않고 환경변수 DATABASE_URL 에서만 읽는다.
//   (브라우저로는 절대 내려보내지 않는다. 프런트는 /api/... 만 호출한다)
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

// ── 입력 제한 ────────────────────────────────
const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품·계란', '양념·소스', '가공식품', '기타'];
const MAX_NAME = 50;
const MAX_QUANTITY = 30;
const MAX_TITLE = 80;
const MAX_INGREDIENTS = 40;
const MAX_INSTRUCTIONS = 5000;

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
// 같은 DB 를 다른 수업 앱(memos, todos, wallet ...)과 공유하므로 fridge_ 접두어를 붙인다.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fridge_ingredients (
      id         BIGSERIAL   PRIMARY KEY,
      name       TEXT        NOT NULL,
      quantity   TEXT        NOT NULL DEFAULT '',
      category   TEXT        NOT NULL DEFAULT '기타',
      expires_on DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  // 같은 재료를 두 번 등록하지 않도록 이름(대소문자·공백 무시) 유니크
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS fridge_ingredients_name_uq
      ON fridge_ingredients (LOWER(name))
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fridge_recipes (
      id           BIGSERIAL   PRIMARY KEY,
      title        TEXT        NOT NULL,
      ingredients  TEXT[]      NOT NULL DEFAULT '{}',
      instructions TEXT        NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  dbInitialized = true;
}

// ── 유틸 ─────────────────────────────────────
const asText = (v) => (typeof v === 'string' ? v.trim() : '');

function parseId(raw) {
  return /^\d+$/.test(String(raw)) ? String(raw) : null;
}

function toIngredient(row) {
  return {
    id: Number(row.id),
    name: row.name,
    quantity: row.quantity,
    category: row.category,
    // DATE 는 pg 가 로컬 자정 Date 로 파싱하므로 문자열로 직접 뽑는다
    expiresOn: row.expires_on_text || null,
    createdAt: row.created_at,
  };
}

function toRecipe(row) {
  return {
    id: Number(row.id),
    title: row.title,
    ingredients: row.ingredients,
    instructions: row.instructions,
    createdAt: row.created_at,
  };
}

const INGREDIENT_COLUMNS = `id, name, quantity, category, TO_CHAR(expires_on, 'YYYY-MM-DD') AS expires_on_text, created_at`;

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '100kb' }));

// 정적 파일은 index.html 하나만 내보낸다.
// (폴더 전체를 static 으로 열면 server.js·package.json 까지 노출되므로)
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// DB 설정 여부만 알려준다 (접속 문자열 자체는 절대 내려보내지 않음)
app.get('/api/config', (_req, res) => {
  res.json({ success: true, data: { app: 'fridge-recipe', dbConfigured: Boolean(pool) } });
});

app.use('/api', async (_req, res, next) => {
  if (!pool) {
    return res.status(503).json({
      success: false,
      message: '서버에 DATABASE_URL 환경변수가 설정되지 않았습니다. .env 를 확인해주세요.',
    });
  }
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err.message);
    res.status(500).json({ success: false, message: '데이터베이스에 연결하지 못했습니다.' });
  }
});

// ── API: 재료 ────────────────────────────────
app.get('/api/ingredients', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${INGREDIENT_COLUMNS} FROM fridge_ingredients
        ORDER BY expires_on ASC NULLS LAST, created_at DESC`
    );
    res.json({ success: true, data: rows.map(toIngredient) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/ingredients', async (req, res, next) => {
  const body = req.body || {};
  const name = asText(body.name);
  const quantity = asText(body.quantity);
  const category = CATEGORIES.includes(body.category) ? body.category : '기타';
  const expiresOn = asText(body.expiresOn);

  if (!name) {
    return res.status(400).json({ success: false, message: '재료 이름을 입력해주세요.' });
  }
  if (name.length > MAX_NAME) {
    return res.status(400).json({ success: false, message: `재료 이름은 ${MAX_NAME}자 이하로 입력해주세요.` });
  }
  if (quantity.length > MAX_QUANTITY) {
    return res.status(400).json({ success: false, message: `수량은 ${MAX_QUANTITY}자 이하로 입력해주세요.` });
  }
  if (expiresOn && (!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn) || Number.isNaN(Date.parse(expiresOn)))) {
    return res.status(400).json({ success: false, message: '유통기한 날짜 형식이 올바르지 않습니다.' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO fridge_ingredients (name, quantity, category, expires_on)
       VALUES ($1, $2, $3, $4)
       RETURNING ${INGREDIENT_COLUMNS}`,
      [name, quantity, category, expiresOn || null]
    );
    res.status(201).json({ success: true, data: toIngredient(rows[0]) });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ success: false, message: `'${name}'은(는) 이미 냉장고에 있습니다.` });
    }
    next(err);
  }
});

app.delete('/api/ingredients/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: '잘못된 재료 ID 입니다.' });
  try {
    const { rows } = await pool.query(
      `DELETE FROM fridge_ingredients WHERE id = $1 RETURNING ${INGREDIENT_COLUMNS}`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '재료를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toIngredient(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── API: 레시피 ──────────────────────────────
app.get('/api/recipes', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, title, ingredients, instructions, created_at
         FROM fridge_recipes ORDER BY created_at DESC`
    );
    res.json({ success: true, data: rows.map(toRecipe) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/recipes', async (req, res, next) => {
  const body = req.body || {};
  const title = asText(body.title);
  const instructions = asText(body.instructions);
  const rawIngredients = Array.isArray(body.ingredients) ? body.ingredients : [];

  // 공백 제거 + 대소문자 무시 중복 제거
  const seen = new Set();
  const ingredients = [];
  for (const item of rawIngredients) {
    const v = asText(item);
    if (!v || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    ingredients.push(v);
  }

  if (!title) {
    return res.status(400).json({ success: false, message: '요리명을 입력해주세요.' });
  }
  if (title.length > MAX_TITLE) {
    return res.status(400).json({ success: false, message: `요리명은 ${MAX_TITLE}자 이하로 입력해주세요.` });
  }
  if (!ingredients.length) {
    return res.status(400).json({ success: false, message: '재료를 한 개 이상 추가해주세요.' });
  }
  if (ingredients.length > MAX_INGREDIENTS || ingredients.some((v) => v.length > MAX_NAME)) {
    return res.status(400).json({
      success: false,
      message: `재료는 최대 ${MAX_INGREDIENTS}개, 각 ${MAX_NAME}자 이하로 입력해주세요.`,
    });
  }
  if (!instructions) {
    return res.status(400).json({ success: false, message: '조리법을 입력해주세요.' });
  }
  if (instructions.length > MAX_INSTRUCTIONS) {
    return res.status(400).json({ success: false, message: `조리법은 ${MAX_INSTRUCTIONS}자 이하로 입력해주세요.` });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO fridge_recipes (title, ingredients, instructions)
       VALUES ($1, $2, $3)
       RETURNING id, title, ingredients, instructions, created_at`,
      [title, ingredients, instructions]
    );
    res.status(201).json({ success: true, data: toRecipe(rows[0]) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/recipes/:id', async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: '잘못된 레시피 ID 입니다.' });
  try {
    const { rows } = await pool.query(
      `DELETE FROM fridge_recipes WHERE id = $1
       RETURNING id, title, ingredients, instructions, created_at`,
      [id]
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: '레시피를 찾을 수 없습니다.' });
    }
    res.json({ success: true, data: toRecipe(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── 알 수 없는 API ───────────────────────────
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'API 경로를 찾을 수 없습니다.' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, message: '요청 형식(JSON)이 올바르지 않습니다.' });
  }
  res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
});

// Local: 서버 시작 / Vercel: app export
// ⚠️ Express 5 는 포트 충돌(EADDRINUSE) 같은 에러도 app.listen 콜백으로 넘긴다.
//    콜백에서 에러를 무시하면 "실행 중" 로그만 찍히고 프로세스는 조용히 종료되므로,
//    listening / error 이벤트를 직접 받아 처리한다.
//    PORT 를 따로 지정하지 않았으면 다른 앱이 쓰는 포트를 피해 다음 포트로 넘어간다.
const PORT_EXPLICIT = Boolean(process.env.PORT);
const MAX_PORT_TRIES = 10;

function startServer(port, triesLeft) {
  const server = app.listen(port);

  server.once('listening', () => {
    console.log(`🧊 냉장고 & 레시피 앱: http://localhost:${port}`);
    if (port !== Number(PORT)) {
      console.log(`   (포트 ${PORT} 는 다른 프로그램이 사용 중이라 ${port} 번으로 실행했습니다)`);
    }
    if (!pool) console.warn('⚠️  DATABASE_URL 이 설정되지 않았습니다. .env 를 만들어주세요.');
  });

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && !PORT_EXPLICIT && triesLeft > 1) {
      console.warn(`⚠️  포트 ${port} 사용 중 → ${port + 1} 번으로 다시 시도합니다.`);
      return startServer(port + 1, triesLeft - 1);
    }
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ 포트 ${port} 를 이미 다른 프로그램이 사용 중입니다.`);
      console.error('   실행 중인 다른 node server.js 를 종료하거나, PORT=3100 node server.js 처럼 다른 포트를 지정하세요.');
    } else {
      console.error('❌ 서버를 시작하지 못했습니다:', err.message);
    }
    process.exit(1);
  });
}

if (require.main === module) {
  startServer(Number(PORT), MAX_PORT_TRIES);
}
module.exports = app;
