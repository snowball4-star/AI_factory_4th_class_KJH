// ============================================================
// 포켓몬 도감 API 서버 (week-4)
//   - PokeAPI 를 쓰지 않고, 이 파일 안의 인메모리 데이터로 도감을 서비스한다.
//   - 로컬:   node server.js  → http://localhost:3000
//   - Vercel: module.exports = app (서버리스 함수로 동작)
// ============================================================

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── In-memory store ─────────────────────────────────────────
// 우선 1~10번 10마리. 포켓몬을 더 넣고 싶으면 이 배열에 객체를 하나 더 추가하면 된다.
// 도감 화면이 쓰는 필드를 여기 한곳에 모아 두고, 목록 응답에서는 가벼운 필드만 골라 보낸다.

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';

const POKEDEX = [
  {
    id: 1, name: '이상해씨', enName: 'bulbasaur', genus: '씨앗포켓몬', generation: 1,
    types: [{ en: 'grass', ko: '풀' }, { en: 'poison', ko: '독' }],
    height: 0.7, weight: 6.9,
    stats: { hp: 45, attack: 49, defense: 49, 'special-attack': 65, 'special-defense': 65, speed: 45 },
    abilities: [{ ko: '심록', isHidden: false }, { ko: '엽록소', isHidden: true }],
    description: '태어났을 때부터 등에 이상한 씨앗이 심어져 있으며 몸과 함께 자란다고 한다.',
    evolution: [{ id: 1, ko: '이상해씨' }, { id: 2, ko: '이상해풀' }, { id: 3, ko: '이상해꽃' }],
  },
  {
    id: 2, name: '이상해풀', enName: 'ivysaur', genus: '씨앗포켓몬', generation: 1,
    types: [{ en: 'grass', ko: '풀' }, { en: 'poison', ko: '독' }],
    height: 1.0, weight: 13.0,
    stats: { hp: 60, attack: 62, defense: 63, 'special-attack': 80, 'special-defense': 80, speed: 60 },
    abilities: [{ ko: '심록', isHidden: false }, { ko: '엽록소', isHidden: true }],
    description: '등의 봉오리가 커지면 두 다리로 서 있는 일이 많아진다. 꽃이 필 때가 가까워졌다는 증거다.',
    evolution: [{ id: 1, ko: '이상해씨' }, { id: 2, ko: '이상해풀' }, { id: 3, ko: '이상해꽃' }],
  },
  {
    id: 3, name: '이상해꽃', enName: 'venusaur', genus: '씨앗포켓몬', generation: 1,
    types: [{ en: 'grass', ko: '풀' }, { en: 'poison', ko: '독' }],
    height: 2.0, weight: 100.0,
    stats: { hp: 80, attack: 82, defense: 83, 'special-attack': 100, 'special-defense': 100, speed: 80 },
    abilities: [{ ko: '심록', isHidden: false }, { ko: '엽록소', isHidden: true }],
    description: '꽃에서 감미로운 향기가 난다. 싸움 중에도 향기를 퍼뜨려 상대의 기분을 누그러뜨린다.',
    evolution: [{ id: 1, ko: '이상해씨' }, { id: 2, ko: '이상해풀' }, { id: 3, ko: '이상해꽃' }],
  },
  {
    id: 4, name: '파이리', enName: 'charmander', genus: '도마뱀포켓몬', generation: 1,
    types: [{ en: 'fire', ko: '불꽃' }],
    height: 0.6, weight: 8.5,
    stats: { hp: 39, attack: 52, defense: 43, 'special-attack': 60, 'special-defense': 50, speed: 65 },
    abilities: [{ ko: '맹화', isHidden: false }, { ko: '태양의힘', isHidden: true }],
    description: '태어날 때부터 꼬리에 불꽃이 타오른다. 불꽃이 꺼지면 목숨을 잃는다고 전해진다.',
    evolution: [{ id: 4, ko: '파이리' }, { id: 5, ko: '리자드' }, { id: 6, ko: '리자몽' }],
  },
  {
    id: 5, name: '리자드', enName: 'charmeleon', genus: '화염포켓몬', generation: 1,
    types: [{ en: 'fire', ko: '불꽃' }],
    height: 1.1, weight: 19.0,
    stats: { hp: 58, attack: 64, defense: 58, 'special-attack': 80, 'special-defense': 65, speed: 80 },
    abilities: [{ ko: '맹화', isHidden: false }, { ko: '태양의힘', isHidden: true }],
    description: '강한 상대와 싸울 때는 꼬리의 푸른 불꽃을 격렬하게 태워 올린다.',
    evolution: [{ id: 4, ko: '파이리' }, { id: 5, ko: '리자드' }, { id: 6, ko: '리자몽' }],
  },
  {
    id: 6, name: '리자몽', enName: 'charizard', genus: '화염포켓몬', generation: 1,
    types: [{ en: 'fire', ko: '불꽃' }, { en: 'flying', ko: '비행' }],
    height: 1.7, weight: 90.5,
    stats: { hp: 78, attack: 84, defense: 78, 'special-attack': 109, 'special-defense': 85, speed: 100 },
    abilities: [{ ko: '맹화', isHidden: false }, { ko: '태양의힘', isHidden: true }],
    description: '거대한 불꽃을 뿜으며 하늘을 난다. 강한 상대를 찾아 세계 곳곳을 떠돈다.',
    evolution: [{ id: 4, ko: '파이리' }, { id: 5, ko: '리자드' }, { id: 6, ko: '리자몽' }],
  },
  {
    id: 7, name: '꼬부기', enName: 'squirtle', genus: '꼬마거북포켓몬', generation: 1,
    types: [{ en: 'water', ko: '물' }],
    height: 0.5, weight: 9.0,
    stats: { hp: 44, attack: 48, defense: 65, 'special-attack': 50, 'special-defense': 64, speed: 43 },
    abilities: [{ ko: '급류', isHidden: false }, { ko: '젖은접시', isHidden: true }],
    description: '등껍질에 숨어 몸을 지킨다. 반격할 때는 입에서 세찬 거품을 뿜어낸다.',
    evolution: [{ id: 7, ko: '꼬부기' }, { id: 8, ko: '어니부기' }, { id: 9, ko: '거북왕' }],
  },
  {
    id: 8, name: '어니부기', enName: 'wartortle', genus: '거북포켓몬', generation: 1,
    types: [{ en: 'water', ko: '물' }],
    height: 1.0, weight: 22.5,
    stats: { hp: 59, attack: 63, defense: 80, 'special-attack': 65, 'special-defense': 80, speed: 58 },
    abilities: [{ ko: '급류', isHidden: false }, { ko: '젖은접시', isHidden: true }],
    description: '긴 꼬리의 털은 나이를 먹을수록 짙어진다. 오래 산 개체일수록 상처가 많다.',
    evolution: [{ id: 7, ko: '꼬부기' }, { id: 8, ko: '어니부기' }, { id: 9, ko: '거북왕' }],
  },
  {
    id: 9, name: '거북왕', enName: 'blastoise', genus: '껍질포켓몬', generation: 1,
    types: [{ en: 'water', ko: '물' }],
    height: 1.6, weight: 85.5,
    stats: { hp: 79, attack: 83, defense: 100, 'special-attack': 85, 'special-defense': 105, speed: 78 },
    abilities: [{ ko: '급류', isHidden: false }, { ko: '젖은접시', isHidden: true }],
    description: '등껍질의 물대포에서 물을 세차게 발사한다. 두꺼운 강철판도 꿰뚫는 위력이다.',
    evolution: [{ id: 7, ko: '꼬부기' }, { id: 8, ko: '어니부기' }, { id: 9, ko: '거북왕' }],
  },
  {
    id: 10, name: '캐터피', enName: 'caterpie', genus: '애벌레포켓몬', generation: 1,
    types: [{ en: 'bug', ko: '벌레' }],
    height: 0.3, weight: 2.9,
    stats: { hp: 45, attack: 30, defense: 35, 'special-attack': 20, 'special-defense': 20, speed: 45 },
    abilities: [{ ko: '인분', isHidden: false }, { ko: '도주', isHidden: true }],
    description: '머리의 더듬이에서 지독한 냄새를 뿜어 적을 쫓아낸다. 나뭇잎을 아주 좋아한다.',
    evolution: [{ id: 10, ko: '캐터피' }, { id: 11, ko: '단데기' }, { id: 12, ko: '버터플' }],
  },
];

// 목록 카드에 필요한 필드만 추린다 (종족값·설명 같은 무거운 값은 상세에서만 내려준다).
const toIndexRow = (p) => ({
  id: p.id,
  name: p.name,
  enName: p.enName,
  genus: p.genus,
  generation: p.generation,
  types: p.types,
  sprite: `${SPRITE_BASE}/${p.id}.png`,
  artwork: `${SPRITE_BASE}/other/official-artwork/${p.id}.png`,
});

// ── Middleware ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── API routes ──────────────────────────────────────────────

// 도감 목록. ?q=파이 &type=fire &generation=1 로 서버에서 걸러 받을 수도 있다.
app.get('/api/pokemon', (req, res) => {
  const { q = '', type = '', generation = '' } = req.query;
  const keyword = String(q).trim().toLowerCase();

  const rows = POKEDEX.filter((p) => {
    const matchKeyword =
      !keyword ||
      p.name.toLowerCase().includes(keyword) ||
      p.enName.toLowerCase().includes(keyword) ||
      String(p.id).includes(keyword);
    const matchType = !type || p.types.some((t) => t.en === type);
    const matchGen = !generation || String(p.generation) === String(generation);
    return matchKeyword && matchType && matchGen;
  }).map(toIndexRow);

  res.json({ success: true, count: rows.length, data: rows });
});

// 도감 상세. 목록 필드 + 키 / 몸무게 / 종족값 / 특성 / 설명 / 진화 단계.
app.get('/api/pokemon/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ success: false, message: '도감 번호는 1 이상의 정수여야 합니다.' });
  }

  const found = POKEDEX.find((p) => p.id === id);
  if (!found) {
    return res.status(404).json({ success: false, message: `도감 번호 ${id}번 포켓몬이 없습니다.` });
  }

  res.json({
    success: true,
    data: {
      ...toIndexRow(found),
      height: found.height,
      weight: found.weight,
      stats: found.stats,
      abilities: found.abilities,
      description: found.description,
      evolution: found.evolution,
    },
  });
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
    console.log(`포켓몬 도감 서버 실행 중 → http://localhost:${PORT}`);
  });
}

module.exports = app;
