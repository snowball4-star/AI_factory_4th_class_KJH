// ============================================================
// Mini Journey — 이미지 생성 API 서버 (week-4)
//   - 브라우저는 fal.ai 를 직접 부르지 않는다. 이 서버가 대신 부른다.
//     (API 키가 브라우저로 내려가면 소스 보기만으로 유출되기 때문)
//   - 키는 같은 폴더의 .env 파일 또는 환경변수 FAL_KEY 에서만 읽는다.
//   - 로컬:   npm install && npm start  → http://localhost:3000
//   - Vercel: module.exports = app (서버리스 함수), FAL_KEY 는 프로젝트 환경변수로 등록
// ============================================================

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── .env 로더 ───────────────────────────────────────────────
// dotenv 의존성을 추가하지 않고 KEY=VALUE 형식만 아주 단순하게 읽는다.
(function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
})();

const FAL_KEY = process.env.FAL_KEY || '';

// ── 모델 / 파라미터 매핑 ────────────────────────────────────
// 품질 슬라이더 → 모델. schnell 은 1~2초, dev 는 더 느리지만 결과가 좋다.
const MODELS = {
  fast: { id: 'fal-ai/flux/schnell', label: 'FLUX schnell', steps: 4 },
  quality: { id: 'fal-ai/flux/dev', label: 'FLUX dev', steps: 28 },
};

// fal 이 받는 image_size 프리셋으로 변환
const IMAGE_SIZE = {
  '1:1': 'square_hd',
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
};

// 스타일 프리셋 → 프롬프트에 덧붙일 영어 수식어 (프롬프트 엔지니어링은 서버가 담당)
const STYLE_SUFFIX = {
  cinematic: 'cinematic film still, dramatic lighting, shallow depth of field, 35mm, color graded',
  anime: 'anime illustration, cel shading, vibrant colors, clean linework, studio quality',
  oil: 'oil painting, thick impasto brush strokes, canvas texture, classical palette',
  cyberpunk: 'cyberpunk, neon signage, rain-soaked streets, volumetric fog, high contrast',
  watercolor: 'watercolor painting, soft washes, paper texture, delicate pigment bleed',
  render3d: '3d render, octane render, soft studio lighting, subsurface scattering, clean materials',
  pixel: 'pixel art, 16-bit sprite, limited palette, crisp pixels',
  photo: 'photorealistic photograph, natural lighting, 50mm lens, fine detail',
};

const MAX_PROMPT_LENGTH = 1200;

// ── 한국어 프롬프트 번역 ────────────────────────────────────
// FLUX 의 텍스트 인코더는 영어 위주라 한국어를 그대로 넣으면 내용이 거의 반영되지 않는다.
// (실제로 "비 내리는 밤의 네온 골목"을 그대로 보내면 네온도 우산도 사라진 밋밋한 야경이 나온다)
// 그래서 한글이 섞여 있으면 같은 FAL_KEY 로 fal 의 LLM 엔드포인트를 한 번 거쳐 영어로 바꾼다.
const TRANSLATE_MODEL = 'google/gemini-flash-1.5';
const HANGUL = /[ㄱ-ㆎ가-힣]/;
const translationCache = new Map();   // 같은 문장을 반복 호출하지 않도록 메모리에 캐시

async function translateToEnglish(text) {
  if (!HANGUL.test(text)) return { text, translated: false };
  if (translationCache.has(text)) return { text: translationCache.get(text), translated: true };

  try {
    const res = await fetch('https://fal.run/fal-ai/any-llm', {
      method: 'POST',
      headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TRANSLATE_MODEL,
        system_prompt:
          'You translate Korean image prompts into English prompts for a text-to-image model. ' +
          'Keep every subject, action and detail from the original. Do not add new subjects, ' +
          'do not add style or camera words. Output only the translated prompt, no quotes.',
        prompt: text,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const out = (body.output || '').trim().replace(/^["']|["']$/g, '');
    if (!out) throw new Error('빈 응답');
    translationCache.set(text, out);
    return { text: out, translated: true };
  } catch (err) {
    // 번역이 실패해도 생성 자체는 진행한다 (원문 그대로 전달)
    console.warn('[translate] 실패 — 원문으로 진행합니다:', err.message);
    return { text, translated: false };
  }
}

app.use(express.json({ limit: '256kb' }));
app.use(express.static(__dirname, { extensions: ['html'] }));

// ── 클라이언트가 부팅할 때 모드를 물어보는 엔드포인트 ───────
// 키가 없으면 프런트가 "데모 모드"(로컬 생성 아트)로 알아서 동작한다.
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      mode: FAL_KEY ? 'live' : 'demo',
      provider: 'fal.ai',
      models: { fast: MODELS.fast.label, quality: MODELS.quality.label },
      maxImages: 4,
    },
  });
});

// ── 실제 이미지 생성 ────────────────────────────────────────
app.post('/api/generate', async (req, res, next) => {
  try {
    if (!FAL_KEY) {
      return res.status(503).json({
        success: false,
        code: 'NO_KEY',
        message: 'FAL_KEY 가 설정되지 않았습니다. .env 파일에 키를 넣고 서버를 다시 시작하세요.',
      });
    }

    const {
      prompt,
      negative = '',
      style = 'cinematic',
      ratio = '1:1',
      count = 4,
      quality = 60,
      seed = null,
    } = req.body || {};

    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ success: false, code: 'EMPTY_PROMPT', message: '프롬프트를 입력해주세요.' });
    }

    const tier = Number(quality) >= 70 ? 'quality' : 'fast';
    const model = MODELS[tier];

    // 프롬프트 조립: (한국어면 영어로 번역한) 사용자 문장 + 스타일 수식어 + 피할 요소
    const translatedPrompt = await translateToEnglish(prompt.trim());
    const parts = [translatedPrompt.text];
    if (STYLE_SUFFIX[style]) parts.push(STYLE_SUFFIX[style]);
    if (typeof negative === 'string' && negative.trim()) {
      const translatedNegative = await translateToEnglish(negative.trim());
      parts.push(`avoid: ${translatedNegative.text}`);
    }
    const finalPrompt = parts.join(', ').slice(0, MAX_PROMPT_LENGTH);

    const payload = {
      prompt: finalPrompt,
      image_size: IMAGE_SIZE[ratio] || 'square_hd',
      num_images: Math.min(4, Math.max(1, Number(count) || 1)),
      num_inference_steps: model.steps,
      enable_safety_checker: true,
    };
    // 시드를 주면 같은 프롬프트에서 같은 그림이 재현된다 (fal 은 32bit 정수를 받는다)
    if (seed !== null && seed !== undefined && Number.isFinite(Number(seed))) {
      payload.seed = Math.abs(Math.trunc(Number(seed))) % 2147483647;
    }

    const startedAt = Date.now();
    const falRes = await fetch(`https://fal.run/${model.id}`, {
      method: 'POST',
      headers: {
        Authorization: `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000),
    });

    const text = await falRes.text();
    let body;
    try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }

    if (!falRes.ok) {
      // fal 의 에러 형식이 몇 가지라 최대한 읽을 수 있는 문장으로 정리한다
      const detail = body && body.detail;
      const message = typeof detail === 'string'
        ? detail
        : Array.isArray(detail) && detail.length
          ? detail.map(d => d.msg || JSON.stringify(d)).join(' / ')
          : body.message || `fal.ai 응답 오류 (HTTP ${falRes.status})`;
      console.error('[fal error]', falRes.status, text.slice(0, 500));
      return res.status(falRes.status === 401 || falRes.status === 403 ? 401 : 502).json({
        success: false,
        code: falRes.status === 401 || falRes.status === 403 ? 'BAD_KEY' : 'UPSTREAM',
        message,
      });
    }

    const images = (body.images || []).map(img => ({
      url: img.url,
      width: img.width,
      height: img.height,
    }));

    if (!images.length) {
      return res.status(502).json({ success: false, code: 'NO_IMAGE', message: '이미지가 생성되지 않았습니다.' });
    }

    res.json({
      success: true,
      data: {
        images,
        seed: body.seed ?? payload.seed ?? null,
        model: model.label,
        prompt: finalPrompt,
        translated: translatedPrompt.translated,
        elapsedMs: Date.now() - startedAt,
        nsfw: body.has_nsfw_concepts || null,
      },
    });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return res.status(504).json({
        success: false,
        code: 'TIMEOUT',
        message: '생성이 너무 오래 걸려 중단했습니다. 다시 시도해주세요.',
      });
    }
    next(err);
  }
});

// ── SPA fallback (Express 5 문법) ───────────────────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ───────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ success: false, message: '서버 내부 오류가 발생했습니다.' });
});

// ── Startup & export ────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Mini Journey 서버 실행 중 → http://localhost:${PORT}`);
    console.log(FAL_KEY
      ? '모드: live (fal.ai 실제 호출)'
      : '모드: demo (FAL_KEY 없음 → 브라우저에서 로컬 생성 아트로 대체)');
  });
}

module.exports = app;
