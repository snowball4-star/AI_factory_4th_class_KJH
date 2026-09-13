// ============================================================
// 📝 Todo App - Single File Backend (server.js)
// 투두를 todos.txt 파일에 한 줄씩 저장한다.
// 로컬(node server.js) / Vercel 서버리스 듀얼 모드.
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const app = express();
const PORT = process.env.PORT || 3000;

// ── 저장 파일 경로 ────────────────────────────
// 서버리스(읽기 전용 FS)에서는 /tmp 로 폴백한다.
const DATA_FILE = process.env.TODO_FILE
  ? path.resolve(process.env.TODO_FILE)
  : process.env.VERCEL
    ? path.join('/tmp', 'todos.txt')
    : path.join(__dirname, 'todos.txt');

const FILE_HEADER = [
  '# 투두 목록 저장 파일 (todos.txt)',
  '# 형식: id | 상태 | 등록시각 | 내용',
  '# 상태: [ ] 진행중 / [x] 완료',
].join('\n');

// ── txt 직렬화 / 파싱 ─────────────────────────
// 한 줄 = "1 | [ ] | 2026-09-08 21:10:00 | 우유 사기"
// 내용에 '|' 가 들어가도 되도록, 파싱할 때 앞 3개만 잘라내고 나머지는 전부 내용으로 본다.
function serialize(todos) {
  const lines = todos.map(
    (t) => `${t.id} | ${t.done ? '[x]' : '[ ]'} | ${t.createdAt} | ${t.text}`
  );
  return `${FILE_HEADER}\n${lines.join('\n')}\n`;
}

function parse(raw) {
  const todos = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('|');
    if (parts.length < 4) continue;

    const id = Number(parts[0].trim());
    if (!Number.isFinite(id)) continue;

    todos.push({
      id,
      done: parts[1].trim().toLowerCase() === '[x]',
      createdAt: parts[2].trim(),
      text: parts.slice(3).join('|').trim(),
    });
  }
  return todos;
}

// ── 파일 읽기 / 쓰기 ──────────────────────────
async function readTodos() {
  try {
    return parse(await fsp.readFile(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return []; // 아직 파일이 없으면 빈 목록
    throw err;
  }
}

async function writeTodos(todos) {
  await fsp.writeFile(DATA_FILE, serialize(todos), 'utf8');
}

function nextId(todos) {
  return todos.reduce((max, t) => Math.max(max, t.id), 0) + 1;
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 내용에 줄바꿈/파이프가 섞이면 파일 포맷이 깨지므로 한 줄로 정규화한다.
function sanitize(text) {
  return String(text).replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim();
}

// ── Middleware ───────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── API routes ───────────────────────────────

// 목록 조회
app.get('/api/todos', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await readTodos(), file: path.basename(DATA_FILE) });
  } catch (err) {
    next(err);
  }
});

// 저장된 txt 원본 보기
app.get('/api/todos/raw', async (_req, res, next) => {
  try {
    let raw;
    try {
      raw = await fsp.readFile(DATA_FILE, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      raw = `${FILE_HEADER}\n`;
    }
    res.json({ success: true, data: { path: DATA_FILE, name: path.basename(DATA_FILE), raw } });
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

    const todos = await readTodos();
    const todo = { id: nextId(todos), done: false, createdAt: nowStamp(), text };
    todos.push(todo);
    await writeTodos(todos);

    res.status(201).json({ success: true, data: todo });
  } catch (err) {
    next(err);
  }
});

// 수정 (완료 토글 / 내용 변경)
app.patch('/api/todos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const todos = await readTodos();
    const todo = todos.find((t) => t.id === id);
    if (!todo) {
      return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
    }

    const { done, text } = req.body || {};
    if (typeof done === 'boolean') todo.done = done;
    if (typeof text === 'string') {
      const clean = sanitize(text);
      if (!clean) {
        return res.status(400).json({ success: false, message: '할 일 내용은 비울 수 없습니다.' });
      }
      todo.text = clean;
    }

    await writeTodos(todos);
    res.json({ success: true, data: todo });
  } catch (err) {
    next(err);
  }
});

// 삭제
app.delete('/api/todos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const todos = await readTodos();
    const idx = todos.findIndex((t) => t.id === id);
    if (idx === -1) {
      return res.status(404).json({ success: false, message: '해당 할 일을 찾을 수 없습니다.' });
    }

    const [removed] = todos.splice(idx, 1);
    await writeTodos(todos);
    res.json({ success: true, data: removed });
  } catch (err) {
    next(err);
  }
});

// 완료된 항목 일괄 삭제
app.delete('/api/todos', async (_req, res, next) => {
  try {
    const todos = await readTodos();
    const remaining = todos.filter((t) => !t.done);
    const removedCount = todos.length - remaining.length;
    await writeTodos(remaining);
    res.json({ success: true, data: { removedCount } });
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
    console.log(`✅ Todo server running on http://localhost:${PORT}`);
    console.log(`📄 저장 파일: ${DATA_FILE}${fs.existsSync(DATA_FILE) ? '' : ' (첫 저장 시 생성됩니다)'}`);
  });
}
module.exports = app;
