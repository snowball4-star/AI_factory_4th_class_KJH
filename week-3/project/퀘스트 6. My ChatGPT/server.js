// ─────────────────────────────────────────────
// 마음노트 · 간단 AI 상담 — 백엔드 (단일 파일)
// 클라이언트는 API 키를 절대 볼 수 없다. 키는 서버의 .env 에만 존재하며
// 브라우저는 /api/chat 프록시만 호출한다.
// ─────────────────────────────────────────────

const express = require('express');
const path = require('path');
const fs = require('fs');

// ── .env 로더 (dotenv 의존성 없이 처리) ───────
// Vercel 등 배포 환경에서는 대시보드 환경변수가 이미 들어와 있으므로 파일이 없어도 무시한다.
function loadEnvFile() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    raw.split(/\r?\n/).forEach((line) => {
      const matched = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!matched) return;
      const key = matched[1];
      const value = matched[2].trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    });
  } catch (_err) {
    /* .env 없음 — 환경변수만 사용 */
  }
}
loadEnvFile();

const app = express();
const PORT = process.env.PORT || 3000;

// 환경변수에 trailing newline 이 붙는 경우가 있어 항상 trim 한다.
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_MODEL = (process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

// ── 상담 정책 (서버가 소유한다) ───────────────
const SYSTEM_PROMPT = [
  '너는 한국어로 대화하는 심리상담 도우미 "마음노트"다.',
  '역할은 진단이나 처방이 아니라, 판단하지 않고 끝까지 듣는 공감적 경청이다.',
  '',
  '응답 규칙:',
  '1. 먼저 사용자의 감정을 구체적으로 되비춰 준다(반영적 경청). 섣부른 조언이나 훈계는 하지 않는다.',
  '2. 전체 3~5문장, 300자 이내로 짧게 답한다. 목록이나 마크다운 기호는 쓰지 않는다.',
  '3. 마지막은 반드시 열린 질문 하나로 끝맺어 대화를 이어 간다.',
  '4. "괜찮아질 거예요" 같은 값싼 위로나 성급한 해결책 제시는 피한다.',
  '5. 의학적 진단명, 약물, 치료법을 단정적으로 말하지 않는다.',
  '6. 존댓말을 쓰고 따뜻하지만 담백한 어조를 유지한다.',
].join('\n');

// 위기 신호 — 서버에서도 한 번 더 막는다. 감지되면 모델을 호출하지 않고 즉시 기관을 안내한다.
const CRISIS_KEYWORDS = [
  '자살', '죽고싶', '죽고 싶', '죽을까', '자해', '살기싫', '살기 싫',
  '사라지고싶', '사라지고 싶', '끝내고싶', '끝내고 싶', '없어지고 싶',
];

const CRISIS_REPLY = [
  '지금 정말 많이 힘드신 것 같아 마음이 쓰입니다. 그 이야기를 꺼내 주신 것만으로도 큰 용기예요.',
  '이건 혼자 견딜 일이 아니고, 지금 바로 도움을 받을 수 있는 곳이 있습니다.',
  '',
  '· 자살예방 상담전화 109 (24시간)',
  '· 정신건강 위기상담전화 1577-0199',
  '· 생명의전화 1588-9191',
  '',
  '당장 위험하다고 느껴진다면 119에 연락하거나 곁에 있는 사람에게 지금 상태를 알려 주세요. 저와의 대화는 계속할 수 있지만, 전문가의 도움을 함께 받으시면 좋겠습니다.',
].join('\n');

// ── 입력 제한값 ───────────────────────────────
const MAX_MESSAGES = 16;        // 모델에 넘길 최근 대화 수
const MAX_CONTENT_LENGTH = 1000; // 메시지 1개 최대 길이(자)
const UPSTREAM_TIMEOUT_MS = 20000;

// ── 인메모리 레이트리밋 (IP 기준) ─────────────
// API 키 남용을 막기 위한 최소한의 방어. 서버 재시작 시 초기화된다.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 20;
const rateBuckets = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfter: 0 };
  }
  if (bucket.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  bucket.count += 1;
  return { allowed: true, retryAfter: 0 };
}

// 버킷이 무한정 쌓이지 않도록 주기적으로 만료분을 비운다.
setInterval(() => {
  const now = Date.now();
  rateBuckets.forEach((bucket, ip) => {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  });
}, RATE_LIMIT_WINDOW_MS).unref?.();

// ── Middleware ────────────────────────────────
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname)));

// ── Helpers ───────────────────────────────────
const isCrisis = (text) => CRISIS_KEYWORDS.some((k) => text.includes(k));

// 클라이언트가 보낸 대화 기록을 검증하고 OpenAI 형식으로 정규화한다.
function sanitizeMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'messages 배열이 필요합니다.' };
  }

  const cleaned = [];
  for (const item of raw.slice(-MAX_MESSAGES)) {
    if (!item || typeof item.content !== 'string') {
      return { error: '각 메시지는 content 문자열을 가져야 합니다.' };
    }
    const content = item.content.trim();
    if (!content) continue;
    if (content.length > MAX_CONTENT_LENGTH) {
      return { error: `메시지는 ${MAX_CONTENT_LENGTH}자를 넘을 수 없습니다.` };
    }
    // 클라이언트가 임의의 role(system 등)을 주입하지 못하게 두 가지로만 좁힌다.
    const role = item.role === 'assistant' || item.role === 'bot' ? 'assistant' : 'user';
    cleaned.push({ role, content });
  }

  if (!cleaned.length) return { error: '보낼 메시지가 비어 있습니다.' };
  if (cleaned[cleaned.length - 1].role !== 'user') {
    return { error: '마지막 메시지는 사용자의 발화여야 합니다.' };
  }
  return { messages: cleaned };
}

async function callOpenAI(messages, topic) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  const system = topic
    ? `${SYSTEM_PROMPT}\n\n현재 사용자가 고른 주제: ${topic}`
    : SYSTEM_PROMPT;

  try {
    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: 0.8,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await response.text();
      // 업스트림 에러 본문에는 조직/키 정보가 섞일 수 있으므로 원문은 서버 로그에만 남긴다.
      console.error(`[openai] ${response.status} ${detail.slice(0, 500)}`);

      let code = '';
      try { code = JSON.parse(detail)?.error?.code || ''; } catch (_e) { /* 무시 */ }

      // 운영자가 원인을 바로 알 수 있도록 유형별로만 안내한다(키·조직 정보는 노출하지 않는다).
      let message = 'AI 응답을 받지 못했습니다.';
      if (code === 'insufficient_quota' || code === 'credit_balance_exhausted') {
        message = 'OpenAI 계정의 크레딧이 소진되어 AI 응답을 사용할 수 없습니다. 결제 설정을 확인해 주세요.';
      } else if (response.status === 401) {
        message = 'OpenAI API 키가 유효하지 않습니다. 서버의 .env 를 확인해 주세요.';
      } else if (response.status === 429) {
        message = 'AI 요청이 잠시 몰리고 있습니다. 잠시 후 다시 시도해 주세요.';
      }

      const error = new Error(message);
      error.status = response.status === 429 || response.status === 401 ? response.status : 502;
      throw error;
    }

    const json = await response.json();
    const reply = json?.choices?.[0]?.message?.content?.trim();
    if (!reply) {
      const error = new Error('AI 응답이 비어 있습니다.');
      error.status = 502;
      throw error;
    }
    return reply;
  } catch (err) {
    if (err.name === 'AbortError') {
      const error = new Error('AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
      error.status = 504;
      throw error;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── API routes ────────────────────────────────

// 키 보유 여부만 알려 준다. 키 자체는 어떤 응답에도 포함되지 않는다.
app.get('/api/health', (_req, res) => {
  res.json({
    success: true,
    data: { aiReady: Boolean(OPENAI_API_KEY), model: OPENAI_MODEL },
  });
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const limit = checkRateLimit(ip);
    if (!limit.allowed) {
      return res.status(429).json({
        success: false,
        message: `요청이 너무 잦습니다. ${limit.retryAfter}초 후 다시 시도해 주세요.`,
      });
    }

    const { messages, error } = sanitizeMessages(req.body?.messages);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    const lastUserText = messages[messages.length - 1].content;

    // 위기 표현은 모델을 거치지 않고 고정 안내문으로 응답한다.
    if (isCrisis(lastUserText)) {
      return res.json({
        success: true,
        data: { reply: CRISIS_REPLY, kind: 'crisis', source: 'policy' },
      });
    }

    if (!OPENAI_API_KEY) {
      return res.status(503).json({
        success: false,
        message: '서버에 OPENAI_API_KEY 가 설정되지 않았습니다.',
      });
    }

    const topic = typeof req.body?.topic === 'string' ? req.body.topic.slice(0, 40) : '';
    const reply = await callOpenAI(messages, topic);

    res.json({
      success: true,
      data: { reply, kind: 'normal', source: 'ai', model: OPENAI_MODEL },
    });
  } catch (err) {
    next(err);
  }
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ─────────────────────────────
// 스택 트레이스나 업스트림 원문은 클라이언트로 내보내지 않는다.
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({
    success: false,
    message: status === 500 ? '서버 오류가 발생했습니다.' : err.message,
  });
});

// ── Startup & export ──────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`마음노트 서버: http://localhost:${PORT}`);
    console.log(`AI 연동: ${OPENAI_API_KEY ? `사용 가능 (${OPENAI_MODEL})` : '비활성 — .env 의 OPENAI_API_KEY 확인 필요'}`);
  });
}
module.exports = app;
