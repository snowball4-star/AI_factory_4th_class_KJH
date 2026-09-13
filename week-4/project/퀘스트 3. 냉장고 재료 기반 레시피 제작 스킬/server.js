// ============================================================
// 🧊 냉장고 재료 기입기 - Single File Backend (server.js)
// 재료 하나를 fridge/ingredients/<재료명>.json 파일 하나로 저장한다.
// 브라우저는 /api 만 호출하고, 파일 쓰기는 전부 이 서버가 한다.
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 저장 폴더 ─────────────────────────────────
// SKILL.md 가 읽는 폴더와 같은 곳이어야 한다.
const INGREDIENTS_DIR = process.env.FRIDGE_DIR
  ? path.resolve(process.env.FRIDGE_DIR)
  : path.join(__dirname, 'fridge', 'ingredients');

fs.mkdirSync(INGREDIENTS_DIR, { recursive: true });

// ── 파일명 규칙 ───────────────────────────────
// SKILL.md 와 동일: 금지문자 제거, 공백은 _.
// 여기서 걸러낸 이름만 파일 경로에 쓴다 (../ 로 폴더를 벗어나는 요청 차단).
function toFileStem(name) {
  return String(name || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_');
}

function resolveIngredientPath(name) {
  const stem = toFileStem(name);
  if (!stem || stem === '.' || stem === '..' || stem.startsWith('.')) return null;

  const full = path.join(INGREDIENTS_DIR, `${stem}.json`);
  // path.join 뒤에도 폴더 밖을 가리키면 거부한다
  if (path.dirname(full) !== INGREDIENTS_DIR) return null;
  return { stem, full };
}

// ── 스키마 정규화 ─────────────────────────────
// 클라이언트가 뭘 보내든 SKILL.md 의 필드만 남긴다.
const CATEGORIES = ['채소', '과일', '육류', '해산물', '유제품', '달걀', '곡물·면', '양념', '가공식품', '음료', '기타'];
const STORAGES = ['냉장', '냉동', '실온'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalize(body, stem) {
  const quantity = Number(body.quantity);
  return {
    id: stem,
    name: String(body.name || '').trim(),
    category: CATEGORIES.includes(body.category) ? body.category : '기타',
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    unit: String(body.unit || '개').trim(),
    storage: STORAGES.includes(body.storage) ? body.storage : '냉장',
    purchasedOn: DATE_RE.test(body.purchasedOn) ? body.purchasedOn : todayISO(),
    expiresOn: DATE_RE.test(body.expiresOn) ? body.expiresOn : null,
    note: String(body.note || '').trim(),
    updatedAt: new Date().toISOString(),
  };
}

// ── 읽기 ──────────────────────────────────────
async function readAll() {
  const names = await fsp.readdir(INGREDIENTS_DIR);
  const items = [];

  for (const file of names) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(INGREDIENTS_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      if (data && data.name) items.push(data);
    } catch (err) {
      // 손으로 고치다 깨진 파일은 목록에서만 빼고 서버는 계속 돈다
      console.warn(`건너뜀 (JSON 파싱 실패): ${file} — ${err.message}`);
    }
  }
  return items;
}

// ============================================================
// 🛣  Routes
// ============================================================

app.use(express.json());
app.use(express.static(__dirname));

// 프런트가 저장 위치를 화면에 보여줄 수 있게 알려준다
app.get('/api/config', (req, res) => {
  res.json({ dir: path.relative(process.cwd(), INGREDIENTS_DIR) || INGREDIENTS_DIR });
});

app.get('/api/ingredients', async (req, res) => {
  try {
    res.json({ items: await readAll() });
  } catch (err) {
    res.status(500).json({ error: `재료를 읽지 못했다: ${err.message}` });
  }
});

// 같은 이름이면 새 파일을 만들지 않고 그 파일을 덮어쓴다 (재료당 파일 1개)
app.post('/api/ingredients', async (req, res) => {
  const target = resolveIngredientPath(req.body && req.body.name);
  if (!target) return res.status(400).json({ error: '쓸 수 없는 재료 이름이다.' });

  const item = normalize(req.body, target.stem);
  try {
    await fsp.writeFile(target.full, `${JSON.stringify(item, null, 2)}\n`, 'utf8');
    res.json({ item, file: `${target.stem}.json` });
  } catch (err) {
    res.status(500).json({ error: `저장하지 못했다: ${err.message}` });
  }
});

app.delete('/api/ingredients/:id', async (req, res) => {
  const target = resolveIngredientPath(req.params.id);
  if (!target) return res.status(400).json({ error: '쓸 수 없는 재료 이름이다.' });

  try {
    await fsp.unlink(target.full);
    res.json({ deleted: `${target.stem}.json` });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: '그런 재료가 없다.' });
    res.status(500).json({ error: `삭제하지 못했다: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`🧊 냉장고 재료 기입기 → http://localhost:${PORT}`);
  console.log(`   저장 폴더: ${INGREDIENTS_DIR}`);
});
