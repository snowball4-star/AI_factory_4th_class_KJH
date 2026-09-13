// ============================================================
// 🤖 냉장고 재료 기반 AI 레시피 제작앱 - Single File Backend (server.js)
//
// 퀘스트 4 「냉장고 재료 & 레시피 관리앱」을 그대로 가져와 다음을 더했다.
// - POST /api/recipe : DB 에 저장된 냉장고 재료로 레시피를 자동 생성한다.
//   규칙은 Claude Code 의 /recipe 스킬(퀘스트 3)과 같다.
//     · 요리명 없이 부르면 → 후보 3개 추천
//     · 요리명을 붙이면   → 분 단위 타임라인 레시피 생성
// - 생성한 레시피는 퀘스트 4 와 같은 DB·같은 fridge_recipes 테이블에 저장한다
//   (source / meta / markdown 컬럼만 추가 — 퀘스트 4 앱도 계속 그대로 동작한다).
//
// - DB 접속 문자열(DATABASE_URL)과 OpenAI 키(OPENAI_API_KEY)는 환경변수에서만 읽는다.
//   브라우저로는 절대 내려보내지 않는다. 프런트는 /api/... 만 호출한다.
// - OPENAI_API_KEY 가 없으면 규칙 기반 데모 생성으로 동작한다.
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
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const UPSTREAM_TIMEOUT_MS = 60_000;

// ── 입력 제한 ────────────────────────────────
const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품·계란', '양념·소스', '가공식품', '기타'];
const DIFFICULTIES = ['아주 쉬움', '쉬움', '보통'];
const SERVINGS = ['1인분', '2인분'];
const MAX_NAME = 50;
const MAX_QUANTITY = 30;
const MAX_TITLE = 80;
const MAX_INGREDIENTS = 40;
const MAX_INSTRUCTIONS = 5000;
const MAX_DISH = 40;

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
  // 퀘스트 5 추가 컬럼. 기본값이 있어 퀘스트 4 앱의 INSERT/SELECT 는 영향받지 않는다.
  //   source   : 'manual'(직접 작성) | 'ai'(OpenAI 생성) | 'demo'(키 없이 규칙 기반 생성)
  //   meta     : 소요 시간·재료표·단계별 경과 분·성공 포인트 등 구조화된 레시피
  //   markdown : /recipe 스킬과 같은 형식으로 렌더링한 레시피 문서
  await pool.query(`
    ALTER TABLE fridge_recipes
      ADD COLUMN IF NOT EXISTS source   TEXT  NOT NULL DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS meta     JSONB,
      ADD COLUMN IF NOT EXISTS markdown TEXT
  `);
  dbInitialized = true;
}

// ── 유틸 ─────────────────────────────────────
const asText = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (v, max) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '').slice(0, max);
const arr = (v) => (Array.isArray(v) ? v : []);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

function toInt(v, min, max, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function parseId(raw) {
  return /^\d+$/.test(String(raw)) ? String(raw) : null;
}

// 한국 시간 기준 오늘 (YYYY-MM-DD)
function todayKST() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
}

function daysLeft(expiresOn, today) {
  if (!expiresOn) return null;
  return Math.round((Date.parse(expiresOn) - Date.parse(today)) / 86_400_000);
}

// /recipe 스킬 규칙: 2일 이내 ⚠️, 지났으면 ❌
function expiryStatus(expiresOn, today) {
  const d = daysLeft(expiresOn, today);
  if (d === null) return '✅';
  if (d < 0) return '❌ 기한 경과';
  if (d === 0) return '⚠️ 오늘까지';
  if (d <= 2) return `⚠️ D-${d}`;
  return `✅ D-${d}`;
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
    source: row.source || 'manual',
    meta: row.meta || null,
    markdown: row.markdown || null,
    createdAt: row.created_at,
  };
}

const INGREDIENT_COLUMNS = `id, name, quantity, category, TO_CHAR(expires_on, 'YYYY-MM-DD') AS expires_on_text, created_at`;
const RECIPE_COLUMNS = `id, title, ingredients, instructions, source, meta, markdown, created_at`;

async function loadFridge() {
  const { rows } = await pool.query(
    `SELECT ${INGREDIENT_COLUMNS} FROM fridge_ingredients
      ORDER BY expires_on ASC NULLS LAST, created_at DESC`
  );
  return rows.map(toIngredient);
}

// 레시피가 말한 재료 이름 → 실제 냉장고 재료 ("대파 흰 부분" → 대파, "치즈" → 모짜렐라치즈)
function findFridgeItem(name, fridge) {
  const n = norm(name);
  if (!n) return null;
  return (
    fridge.find((i) => norm(i.name) === n) ||
    fridge.find((i) => {
      const f = norm(i.name);
      return f && (n.includes(f) || f.includes(n));
    }) ||
    null
  );
}

// ============================================================
// 🍳 /recipe — 레시피 자동 생성
// ============================================================

// 퀘스트 3 /recipe 스킬(SKILL.md)의 "3. 레시피 추천"·"4. 레시피 생성" 규칙을 옮긴 프롬프트
const SKILL_STYLE = `
[문체 — /recipe 스킬 공통]
- 평서형 "~한다" 로 끝낸다.
- "적당히", "약간", "조금" 을 쓰지 않는다. 모든 분량은 숫자+단위다 (예: 1큰술, 200ml, 1/2모).
- 모든 지시에 이유를 붙인다.
- 소금·간장·설탕·식용유·후추·물 같은 기본 양념은 냉장고에 있다고 가정한다 (부족 재료로 세지 않는다).
- 냉장고 목록에 없는 재료를 있다고 쓰지 않는다. 목록에 없으면 부족한 재료다.
- 모든 텍스트는 한국어로 쓴다.`;

const SUGGEST_PROMPT = `너는 Claude Code 의 /recipe 스킬 중 "레시피 추천" 모드다.
사용자의 냉장고 재고를 보고 지금 만들 수 있는 요리 후보를 정확히 3개 제안한다.

[후보 구성 규칙]
- 최소 1개는 부족한 재료가 없다 (missing 이 빈 배열) — 지금 당장 만들 수 있어야 한다.
- 최소 1개는 유통기한이 가장 임박한 재료를 주재료로 쓴다.
- 나머지 1개는 재료 1~2개만 더 사면 되는 요리로 폭을 넓힌다. 부족한 재료는 반드시 missing 에 적는다.
- uses 의 name 은 냉장고 목록의 재료 이름을 그대로 쓴다.
- why 는 한 문장. 어떤 재료(특히 유통기한 임박 재료)를 쓰려고 고른 요리인지 구체적으로 쓴다.
${SKILL_STYLE}

[출력] JSON 객체 하나만 출력한다.
{"candidates":[{"title":"대파 계란 볶음밥","minutes":12,"difficulty":"쉬움","uses":[{"name":"대파","need":"1대"}],"missing":[{"name":"찬밥","need":"1공기"}],"why":"..."}]}
difficulty 는 "아주 쉬움" | "쉬움" | "보통" 중 하나.`;

const GENERATE_PROMPT = `너는 Claude Code 의 /recipe 스킬 중 "레시피 생성" 모드다.
사용자가 고른 요리의 레시피를 냉장고 재고에 맞춰 작성한다.

[작성 규칙]
- summary: 냉장고에 있던 무엇을 쓰려고 고른 요리인지 2~3문장.
- fromFridge: 냉장고 목록에 실제로 있는 재료만. name 은 목록의 이름을 그대로 쓴다. need 는 필요량.
  필요량이 보유량보다 많으면 fromFridge 가 아니라 missing 으로 옮긴다.
- missing: 더 사야 하는 재료. memo 에 대체재나 생략 가능 여부를 한 줄로 쓴다. 없으면 빈 배열.
- basics: 레시피에 쓰는 기본 양념(소금·간장·설탕·식용유·후추·물 등)과 분량.
- steps: 5~7단계. minute 은 그 단계를 시작하는 누적 경과 분(첫 단계 0, 오름차순).
  마지막 단계의 minute 이 전체 소요 시간(minutes)과 같아야 한다. name 은 짧은 단계명, text 는 행동과 그 이유.
- fromFridge·missing·basics 의 모든 재료가 steps 에 한 번 이상 등장해야 한다 (그 반대도).
- prepMinutes + cookMinutes = minutes.
- tips: 성공 포인트 3~5개. point 는 명령형 단언, why 는 어기면 어떻게 되는지.
- leftovers: 이 요리를 하고도 남는 냉장고 재료로 더 해먹을 수 있는 것 2~3줄.
${SKILL_STYLE}

[출력] JSON 객체 하나만 출력한다.
{"title":"","summary":"","minutes":15,"prepMinutes":5,"cookMinutes":10,"servings":"1인분","difficulty":"쉬움",
 "fromFridge":[{"name":"","need":""}],"missing":[{"name":"","need":"","memo":""}],"basics":[{"name":"","need":""}],
 "steps":[{"name":"","minute":0,"text":""}],"tips":[{"point":"","why":""}],"leftovers":[""]}`;

function fridgeForPrompt(fridge, today) {
  const lines = fridge.map((i) => {
    const d = daysLeft(i.expiresOn, today);
    const exp = i.expiresOn ? `${i.expiresOn} (${d < 0 ? `${-d}일 지남` : `D-${d}`})` : '미기재';
    return `- ${i.name} | 수량: ${i.quantity || '미기재'} | 분류: ${i.category} | 유통기한: ${exp}`;
  });
  return `오늘 날짜: ${today}\n냉장고 재고 (유통기한 임박 순):\n${lines.join('\n')}`;
}

async function callOpenAI(system, user) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      // 업스트림 에러 본문에는 조직/키 정보가 섞일 수 있으므로 원문은 서버 로그에만 남긴다.
      console.error(`[openai] ${response.status} ${detail.slice(0, 500)}`);
      let code = '';
      try { code = JSON.parse(detail)?.error?.code || ''; } catch (_) { /* 무시 */ }

      let message = 'AI 레시피 생성에 실패했습니다.';
      // 키 문제·크레딧 소진은 재시도해도 풀리지 않으므로 unusable 로 표시해 데모 생성으로 대체한다
      let unusable = false;
      if (code === 'insufficient_quota' || code === 'credit_balance_exhausted') {
        message = 'OpenAI 계정의 크레딧이 소진되어 AI 생성을 사용할 수 없습니다.';
        unusable = true;
      } else if (response.status === 401) {
        message = 'OpenAI API 키가 유효하지 않습니다.';
        unusable = true;
      } else if (response.status === 429) {
        message = 'AI 요청이 잠시 몰리고 있습니다. 잠시 후 다시 시도해주세요.';
      }
      const error = new Error(message);
      error.status = response.status === 429 || response.status === 401 ? response.status : 502;
      error.unusable = unusable;
      throw error;
    }

    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content;
    try {
      return JSON.parse(content);
    } catch (_) {
      const error = new Error('AI 응답을 해석하지 못했습니다. 다시 시도해주세요.');
      error.status = 502;
      throw error;
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해주세요.');
      error.status = 504;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── AI 응답 정리: 스킬 체크리스트를 서버에서 한 번 더 강제한다 ──
function pickDifficulty(v) {
  return DIFFICULTIES.includes(v) ? v : '쉬움';
}

function pushUnique(list, item) {
  if (item.name && !list.some((x) => norm(x.name) === norm(item.name))) list.push(item);
}

function sanitizeSuggestions(raw, fridge) {
  return arr(raw && raw.candidates)
    .slice(0, 3)
    .map((c) => {
      const uses = [];
      const missing = [];
      for (const u of arr(c && c.uses)) {
        const name = clip(u && u.name, 30);
        const need = clip(u && u.need, 20);
        const item = findFridgeItem(name, fridge);
        // 냉장고에 없는 재료를 "쓰는 재료"로 적었으면 부족한 재료로 옮긴다
        if (item) pushUnique(uses, { name: item.name, need });
        else pushUnique(missing, { name, need });
      }
      for (const m of arr(c && c.missing)) {
        pushUnique(missing, { name: clip(m && m.name, 30), need: clip(m && m.need, 20) });
      }
      return {
        title: clip(c && c.title, MAX_DISH),
        minutes: toInt(c && c.minutes, 1, 600, 20),
        difficulty: pickDifficulty(c && c.difficulty),
        uses,
        missing,
        why: clip(c && c.why, 200),
      };
    })
    .filter((c) => c.title);
}

// fridge 를 넘기면(생성 직후) 재료를 실제 재고와 대조해 보유량·유통기한 상태를 서버가 채운다.
// fridge 없이 부르면(저장 시) 형식과 길이만 정리한다.
function sanitizeRecipe(raw, { fridge = null, today = todayKST(), source = 'ai', model = '' } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};

  const fromFridge = [];
  const missing = [];
  for (const it of arr(r.fromFridge)) {
    const name = clip(it && it.name, 30);
    const need = clip(it && it.need, 20);
    if (!name) continue;
    if (!fridge) {
      pushUnique(fromFridge, { name, need, have: clip(it.have, 30), status: clip(it.status, 20) });
      continue;
    }
    const item = findFridgeItem(name, fridge);
    if (!item) {
      pushUnique(missing, { name, need, memo: '냉장고에 없는 재료라 사야 한다.' });
      continue;
    }
    pushUnique(fromFridge, {
      name: item.name,
      need,
      have: item.quantity || '보유',
      status: expiryStatus(item.expiresOn, today),
    });
  }
  for (const it of arr(r.missing)) {
    pushUnique(missing, { name: clip(it && it.name, 30), need: clip(it && it.need, 20), memo: clip(it && it.memo, 100) });
  }
  const basics = [];
  for (const it of arr(r.basics).slice(0, 12)) {
    pushUnique(basics, { name: clip(it && it.name, 20), need: clip(it && it.need, 20) });
  }

  // 단계는 누적 경과 분 오름차순. 마지막 단계의 분 = 전체 소요 시간
  const steps = arr(r.steps)
    .map((s) => ({ name: clip(s && s.name, 30), minute: toInt(s && s.minute, 0, 600, 0), text: clip(s && s.text, 400) }))
    .filter((s) => s.text)
    .slice(0, 10)
    .sort((a, b) => a.minute - b.minute);
  const lastMinute = steps.length ? steps[steps.length - 1].minute : 0;
  const minutes = lastMinute > 0 ? lastMinute : toInt(r.minutes, 1, 600, 20);
  const prepMinutes = Math.min(minutes, toInt(r.prepMinutes, 0, 600, 0));

  return {
    title: clip(r.title, MAX_TITLE),
    summary: clip(r.summary, 400),
    minutes,
    prepMinutes,
    cookMinutes: minutes - prepMinutes,
    servings: SERVINGS.includes(r.servings) ? r.servings : '1인분',
    difficulty: pickDifficulty(r.difficulty),
    fromFridge: fromFridge.slice(0, 20),
    missing: missing.slice(0, 20),
    basics,
    steps,
    tips: arr(r.tips)
      .map((t) => ({ point: clip(t && t.point, 120), why: clip(t && t.why, 200) }))
      .filter((t) => t.point)
      .slice(0, 5),
    leftovers: arr(r.leftovers).map((l) => clip(l, 200)).filter(Boolean).slice(0, 3),
    generatedOn: /^\d{4}-\d{2}-\d{2}$/.test(r.generatedOn || '') ? r.generatedOn : today,
    source: ['ai', 'demo'].includes(r.source) ? r.source : source,
    model: clip(r.model || model, 40),
  };
}

// /recipe 스킬 「4. 레시피 생성 · markdown 저장」 형식
function recipeToMarkdown(r) {
  const cell = (v) => String(v || '').replace(/\|/g, '/');
  const out = [
    `# ${r.title} (${r.minutes}분)`,
    '',
    r.summary,
    '',
    `- **소요 시간**: ${r.minutes}분 (준비 ${r.prepMinutes}분 + 조리 ${r.cookMinutes}분)`,
    `- **분량**: ${r.servings}`,
    `- **난이도**: ${r.difficulty}`,
    `- **생성일**: ${r.generatedOn}`,
    '',
    '## 냉장고에서 쓰는 재료',
    '',
    '| 재료 | 필요량 | 보유량 | 상태 |',
    '| --- | --- | --- | --- |',
    ...r.fromFridge.map((i) => `| ${cell(i.name)} | ${cell(i.need)} | ${cell(i.have)} | ${cell(i.status)} |`),
    '',
    '## 더 필요한 재료',
    '',
  ];
  if (r.missing.length) {
    out.push('| 재료 | 필요량 | 메모 |', '| --- | --- | --- |');
    r.missing.forEach((i) => out.push(`| ${cell(i.name)} | ${cell(i.need)} | ${cell(i.memo)} |`));
  } else {
    out.push('모든 재료가 냉장고에 있다.');
  }
  if (r.basics.length) {
    out.push('', `> 기본 양념: ${r.basics.map((b) => `${b.name} ${b.need}`.trim()).join(', ')}`);
  }
  out.push('', '## 만드는 법', '');
  r.steps.forEach((s, i) => out.push(`${i + 1}. **${s.name || `단계 ${i + 1}`} (${s.minute}분)** — ${s.text}`));
  if (r.tips.length) {
    out.push('', '## 성공 포인트', '');
    r.tips.forEach((t) => out.push(`- **${t.point}** ${t.why}`));
  }
  if (r.leftovers.length) {
    out.push('', '## 남은 재료 활용', '');
    r.leftovers.forEach((l) => out.push(`- ${l}`));
  }
  return out.join('\n') + '\n';
}

// ── 데모 생성 (OPENAI_API_KEY 가 없거나 키·크레딧 문제로 AI 를 쓸 수 없을 때) ──
// 보유량의 절반을 필요량으로 잡는다: "6개" → "3개", "1모" → "1/2모", 미기재 → "100g"
function halfOf(quantity) {
  const m = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(String(quantity || '').trim());
  if (!m) return '100g';
  const n = Number(m[1]);
  return n > 1 ? `${Math.ceil(n / 2)}${m[2]}` : `1/2${m[2]}`;
}

function demoSuggestions(fridge) {
  const [a, b, c] = fridge; // 이미 유통기한 임박 순
  const pick = (...items) => items.filter(Boolean).map((i) => ({ name: i.name, need: halfOf(i.quantity) }));
  return [
    { title: `${a.name} 볶음`, minutes: 12, difficulty: '쉬움', uses: pick(a, b), missing: [], why: `유통기한이 가장 임박한 ${a.name}을(를) 기본 양념만으로 바로 소진한다.` },
    { title: `${(b || a).name}국`, minutes: 15, difficulty: '아주 쉬움', uses: pick(b || a, c), missing: [], why: `국물 요리로 ${(b || a).name}을(를) 넉넉히 쓴다.` },
    { title: `${a.name} 덮밥`, minutes: 20, difficulty: '보통', uses: pick(a, c), missing: [{ name: '밥', need: '1공기' }], why: `밥 1공기만 있으면 ${a.name}(으)로 한 끼가 된다.` },
  ];
}

function demoRecipe(dish, fridge) {
  const used = fridge.slice(0, 3);
  const names = used.map((i) => i.name).join('·');
  return {
    title: dish,
    summary: `(데모) AI 없이 규칙 기반으로 만든 예시다. 유통기한이 임박한 ${names}을(를) 먼저 쓰도록 구성했다.`,
    prepMinutes: 5,
    servings: '1인분',
    difficulty: '쉬움',
    fromFridge: used.map((i) => ({ name: i.name, need: halfOf(i.quantity) })),
    missing: [],
    basics: [{ name: '식용유', need: '1큰술' }, { name: '소금', need: '2꼬집' }],
    steps: [
      { name: '재료 손질', minute: 0, text: `${names}을(를) 한입 크기로 손질한다. 크기가 같아야 동시에 익는다.` },
      { name: '팬 예열', minute: 5, text: '팬에 식용유 1큰술을 두르고 중불로 1분 달군다. 차가운 팬에 넣으면 재료가 기름을 먹는다.' },
      { name: '볶기', minute: 6, text: '단단한 재료부터 넣고 4분 볶는다. 익는 시간이 긴 재료를 먼저 넣어야 식감이 고르다.' },
      { name: '간 맞추기', minute: 10, text: '소금 2꼬집으로 간하고 1분 더 볶는다. 마지막에 간해야 수분이 덜 빠진다.' },
      { name: '담기', minute: 12, text: '불을 끄고 접시에 담는다. 잔열로 더 익기 전에 옮겨야 한다.' },
    ],
    tips: [{ point: '팬을 먼저 달군다.', why: '온도가 낮으면 볶음이 아니라 찜이 된다.' }],
    leftovers: fridge.slice(3, 5).map((i) => `${i.name}은(는) 다음 요리에 쓴다.`),
  };
}

// ── Middleware ───────────────────────────────
app.use(express.json({ limit: '200kb' }));

// 정적 파일은 index.html 하나만 내보낸다.
// (폴더 전체를 static 으로 열면 server.js·package.json·.env 까지 노출되므로)
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 설정 여부만 알려준다 (접속 문자열·API 키 자체는 절대 내려보내지 않음)
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      app: 'fridge-ai-recipe',
      dbConfigured: Boolean(pool),
      aiReady: Boolean(OPENAI_API_KEY),
      model: OPENAI_API_KEY ? OPENAI_MODEL : null,
    },
  });
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
    res.json({ success: true, data: await loadFridge() });
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

// ── API: /recipe 자동 생성 ───────────────────
// body: { dish?: string, servings?: '1인분' | '2인분' }
//   dish 없음 → { type: 'suggestions', candidates: [...] }  (스킬 모드 3. 레시피 추천)
//   dish 있음 → { type: 'recipe', recipe, markdown }        (스킬 모드 4. 레시피 생성)
// 생성만 하고 DB 에는 저장하지 않는다 — 저장은 사용자가 POST /api/recipes 로 고른다.
app.post('/api/recipe', async (req, res, next) => {
  const body = req.body || {};
  const dish = asText(body.dish);
  const servings = SERVINGS.includes(body.servings) ? body.servings : '1인분';

  if (dish.length > MAX_DISH) {
    return res.status(400).json({ success: false, message: `요리명은 ${MAX_DISH}자 이하로 입력해주세요.` });
  }

  try {
    const fridge = await loadFridge();
    if (!fridge.length) {
      return res.status(400).json({
        success: false,
        message: '냉장고가 비어 있어요. 냉장고 탭에서 재료를 먼저 등록해주세요.',
      });
    }
    const today = todayKST();
    let source = OPENAI_API_KEY ? 'ai' : 'demo';
    let model = OPENAI_API_KEY ? OPENAI_MODEL : '';
    let notice = OPENAI_API_KEY ? '' : 'OPENAI_API_KEY 가 없어 데모(규칙 기반)로 생성했습니다.';

    // AI 를 부르고, 키·크레딧 문제면 이유를 notice 로 남기고 데모 생성으로 대체한다
    const generate = async (prompt, user, demo) => {
      if (!OPENAI_API_KEY) return demo();
      try {
        return await callOpenAI(prompt, user);
      } catch (err) {
        if (!err.unusable) throw err;
        source = 'demo';
        model = '';
        notice = `${err.message} 서버의 .env 를 확인하기 전까지 데모(규칙 기반)로 생성합니다.`;
        return demo();
      }
    };

    if (!dish) {
      const raw = await generate(
        SUGGEST_PROMPT,
        `${fridgeForPrompt(fridge, today)}\n\n/recipe — 후보 3개를 추천해줘.`,
        () => ({ candidates: demoSuggestions(fridge) })
      );
      const candidates = sanitizeSuggestions(raw, fridge);
      if (!candidates.length) {
        return res.status(502).json({ success: false, message: 'AI가 후보를 만들지 못했습니다. 다시 시도해주세요.' });
      }
      return res.json({ success: true, data: { type: 'suggestions', candidates, source, model, notice } });
    }

    const raw = await generate(
      GENERATE_PROMPT,
      `${fridgeForPrompt(fridge, today)}\n\n/recipe ${dish}\n요리명: ${dish}\n분량: ${servings}`,
      () => demoRecipe(dish, fridge)
    );
    const recipe = sanitizeRecipe({ ...raw, servings }, { fridge, today, source, model });
    if (!recipe.title) recipe.title = dish;
    if (!recipe.steps.length) {
      return res.status(502).json({ success: false, message: 'AI가 조리 단계를 만들지 못했습니다. 다시 시도해주세요.' });
    }
    res.json({ success: true, data: { type: 'recipe', recipe, markdown: recipeToMarkdown(recipe), source, model, notice } });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ success: false, message: err.message });
    next(err);
  }
});

// ── API: 레시피 ──────────────────────────────
app.get('/api/recipes', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${RECIPE_COLUMNS} FROM fridge_recipes ORDER BY created_at DESC`);
    res.json({ success: true, data: rows.map(toRecipe) });
  } catch (err) {
    next(err);
  }
});

// 두 가지 형태를 받는다.
//   직접 작성 : { title, ingredients: string[], instructions }         (퀘스트 4 와 동일)
//   자동 생성 : { recipe: { title, summary, fromFridge, steps, ... } }  (/api/recipe 결과 그대로)
app.post('/api/recipes', async (req, res, next) => {
  const body = req.body || {};

  let title;
  let instructions;
  let rawIngredients;
  let source = 'manual';
  let meta = null;
  let markdown = null;

  if (body.recipe && typeof body.recipe === 'object') {
    meta = sanitizeRecipe(body.recipe);
    if (!meta.steps.length) {
      return res.status(400).json({ success: false, message: '조리 단계가 없는 레시피는 저장할 수 없습니다.' });
    }
    source = meta.source;
    title = meta.title;
    markdown = recipeToMarkdown(meta);
    // 퀘스트 4 화면(보유 재료 비교·조리법 목록)과도 호환되게 기본 컬럼을 채운다.
    // 기본 양념은 "보유 여부" 계산을 흐리므로 ingredients 에서는 뺀다 (meta.basics 에만 둔다).
    rawIngredients = [...meta.fromFridge, ...meta.missing].map((i) => `${i.name} ${i.need}`.trim());
    instructions = meta.steps.map((s) => `${s.name ? `${s.name} ` : ''}(${s.minute}분) — ${s.text}`).join('\n');
  } else {
    title = asText(body.title);
    instructions = asText(body.instructions);
    rawIngredients = Array.isArray(body.ingredients) ? body.ingredients : [];
  }

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
      `INSERT INTO fridge_recipes (title, ingredients, instructions, source, meta, markdown)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${RECIPE_COLUMNS}`,
      [title, ingredients, instructions, source, meta ? JSON.stringify(meta) : null, markdown]
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
    const { rows } = await pool.query(`DELETE FROM fridge_recipes WHERE id = $1 RETURNING ${RECIPE_COLUMNS}`, [id]);
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
    console.log(`🤖 AI 레시피 제작앱: http://localhost:${port}`);
    if (port !== Number(PORT)) {
      console.log(`   (포트 ${PORT} 는 다른 프로그램이 사용 중이라 ${port} 번으로 실행했습니다)`);
    }
    if (!pool) console.warn('⚠️  DATABASE_URL 이 설정되지 않았습니다. .env 를 만들어주세요.');
    console.log(OPENAI_API_KEY ? `   AI 모델: ${OPENAI_MODEL}` : '⚠️  OPENAI_API_KEY 가 없어 데모(규칙 기반) 생성으로 동작합니다.');
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
