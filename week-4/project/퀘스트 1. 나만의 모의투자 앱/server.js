// ============================================================
// ₿ 비트코인 모의투자 - Single File Backend (server.js)
//
// - 지갑/주문은 PostgreSQL(Supabase)의 wallet / orders 테이블에 저장한다.
// - 접속 문자열은 코드에 넣지 않고 환경변수 DATABASE_URL 에서만 읽는다.
//   (브라우저로는 절대 내려보내지 않는다. 프런트는 /api/... 만 호출한다)
// - 체결가는 클라이언트가 보내는 값을 믿지 않고 서버가 업비트에서 직접 조회한다.
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

// ── 거래 규칙 ────────────────────────────────
const MARKET       = 'KRW-BTC';
const INITIAL_CASH = 10000000;   // 시작 현금 1,000만원
const FEE_RATE     = 0.0005;     // 거래 수수료 0.05%
const QTY_EPS      = 1e-8;       // 수량 비교 허용 오차 (소수점 8자리)
const PRICE_TTL_MS = 2000;       // 시세 캐시 수명

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
// wallet : 단일 계좌(id=1). 현금 + 보유 코인수량이 핵심 컬럼이고,
//          화면의 평균 매수가·실현손익 표시를 위해 두 컬럼을 덧붙였다.
// orders : 시간 / 마켓 / 매수·매도 / 수량 / 체결가 / 메모 + 수수료·실현손익.
let dbInitialized = false;
async function initDB() {
  if (dbInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet (
      id           INT           PRIMARY KEY DEFAULT 1,
      cash         NUMERIC(20,2) NOT NULL DEFAULT ${INITIAL_CASH},
      qty          NUMERIC(24,8) NOT NULL DEFAULT 0,
      avg_price    NUMERIC(20,2) NOT NULL DEFAULT 0,
      realized_pnl NUMERIC(20,2) NOT NULL DEFAULT 0,
      updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      CONSTRAINT wallet_single_row CHECK (id = 1)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id         BIGSERIAL     PRIMARY KEY,
      created_at TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
      market     TEXT          NOT NULL,
      side       TEXT          NOT NULL CHECK (side IN ('buy', 'sell')),
      qty        NUMERIC(24,8) NOT NULL CHECK (qty > 0),
      price      NUMERIC(20,2) NOT NULL CHECK (price > 0),
      fee        NUMERIC(20,2) NOT NULL DEFAULT 0,
      pnl        NUMERIC(20,2),
      memo       TEXT          NOT NULL DEFAULT ''
    )
  `);
  await pool.query(`
    INSERT INTO wallet (id, cash) VALUES (1, ${INITIAL_CASH}) ON CONFLICT (id) DO NOTHING
  `);
  dbInitialized = true;
}

// ── 변환 헬퍼 ────────────────────────────────
// pg 는 NUMERIC 을 문자열로 돌려주므로 숫자로 바꿔서 내려준다.
const num = (v) => (v === null || v === undefined ? null : Number(v));

function toWallet(row) {
  return {
    cash: num(row.cash),
    qty: num(row.qty),
    avgPrice: num(row.avg_price),
    realized: num(row.realized_pnl),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toOrder(row) {
  return {
    id: Number(row.id),
    at: new Date(row.created_at).toISOString(),
    market: row.market,
    side: row.side,
    qty: num(row.qty),
    price: num(row.price),
    amount: num(row.qty) * num(row.price),
    fee: num(row.fee),
    pnl: num(row.pnl),
    memo: row.memo || '',
  };
}

// 소수점 8자리에서 버림 (반올림으로 보유량을 넘기지 않게)
const floorQty = (v) => Math.floor(v * 1e8) / 1e8;
// 원 단위 반올림
const roundKRW = (v) => Math.round(v * 100) / 100;

// ── 시세 조회 (서버에서만 외부 API 호출) ──────
// 업비트 공개 시세는 키가 필요 없지만, 브라우저가 외부 도메인을 직접 부르지 않도록
// 서버가 대신 호출하고 짧게 캐시한다. 실패하면 마지막 시세를 그대로 쓰고,
// 한 번도 못 받았으면 시뮬레이션 시세(demo)로 화면을 띄울 수 있게 한다.
let priceCache = null;   // { data, fetchedAt }
let simPrice = 158000000;

async function fetchTicker() {
  const res = await fetch(`https://api.upbit.com/v1/ticker?markets=${MARKET}`, {
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`upbit HTTP ${res.status}`);
  const [d] = await res.json();
  if (!d || typeof d.trade_price !== 'number') throw new Error('unexpected upbit payload');
  return {
    market: MARKET,
    price: d.trade_price,
    changeRate: d.signed_change_rate * 100,
    high: d.high_price,
    low: d.low_price,
    prevClose: d.prev_closing_price,
    updatedAt: d.timestamp || Date.now(),
    source: 'upbit',
  };
}

async function getPrice({ force = false } = {}) {
  const fresh = priceCache && Date.now() - priceCache.fetchedAt < PRICE_TTL_MS;
  if (fresh && !force) return priceCache.data;

  try {
    const data = await fetchTicker();
    priceCache = { data, fetchedAt: Date.now() };
    return data;
  } catch (err) {
    if (priceCache) return priceCache.data;   // 일시적 실패: 마지막 시세 유지
    simPrice = Math.max(1000000, simPrice * (1 + (Math.random() - 0.5) * 0.003));
    return {
      market: MARKET,
      price: Math.round(simPrice),
      changeRate: ((simPrice - 158000000) / 158000000) * 100,
      high: Math.round(simPrice * 1.012),
      low: Math.round(simPrice * 0.988),
      prevClose: 158000000,
      updatedAt: Date.now(),
      source: 'demo',
    };
  }
}

// ── 미들웨어 ─────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// /api/* 는 DB 가 준비된 뒤에만 처리한다
app.use('/api', async (_req, res, next) => {
  if (!pool) {
    return res.status(500).json({
      success: false,
      message: 'DATABASE_URL 환경변수가 없습니다. .env 를 확인하세요.',
    });
  }
  try {
    await initDB();
    next();
  } catch (err) {
    console.error('[initDB]', err.message);
    res.status(500).json({ success: false, message: 'Database initialization failed' });
  }
});

// ── API: 시세 ────────────────────────────────
app.get('/api/price', async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getPrice() });
  } catch (err) {
    next(err);
  }
});

// ── API: 지갑 ────────────────────────────────
app.get('/api/wallet', async (_req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM wallet WHERE id = 1');
    res.json({ success: true, data: toWallet(rows[0]) });
  } catch (err) {
    next(err);
  }
});

// ── API: 주문 내역 ───────────────────────────
app.get('/api/orders', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const { rows } = await pool.query(
      'SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT $1',
      [limit],
    );
    res.json({ success: true, data: rows.map(toOrder) });
  } catch (err) {
    next(err);
  }
});

// ── API: 지갑 + 주문 + 시세 한 번에 (화면 초기 로드용) ──
app.get('/api/portfolio', async (_req, res, next) => {
  try {
    const [price, wallet, orders] = await Promise.all([
      getPrice(),
      pool.query('SELECT * FROM wallet WHERE id = 1'),
      pool.query('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 200'),
    ]);
    res.json({
      success: true,
      data: {
        price,
        wallet: toWallet(wallet.rows[0]),
        orders: orders.rows.map(toOrder),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── API: 주문 체결 (매수/매도) ────────────────
// body: { side: 'buy' | 'sell', qty?: number, amount?: number, memo?: string }
//   - 매수는 amount(주문금액, 원) 또는 qty 중 하나
//   - 매도는 qty
// 체결가는 서버가 조회한 현재가를 쓴다. 현금/수량이 모자라면 409로 거절한다.
app.post('/api/orders', async (req, res, next) => {
  const { side, memo } = req.body || {};

  if (side !== 'buy' && side !== 'sell') {
    return res.status(400).json({ success: false, message: "side 는 'buy' 또는 'sell' 이어야 합니다." });
  }

  const reqQty    = Number(req.body?.qty);
  const reqAmount = Number(req.body?.amount);
  const hasQty    = Number.isFinite(reqQty) && reqQty > 0;
  const hasAmount = Number.isFinite(reqAmount) && reqAmount > 0;

  if (!hasQty && !hasAmount) {
    return res.status(400).json({ success: false, message: '주문 수량(qty) 또는 주문 금액(amount)이 필요합니다.' });
  }
  if (side === 'sell' && !hasQty) {
    return res.status(400).json({ success: false, message: '매도는 주문 수량(qty)이 필요합니다.' });
  }

  const client = await pool.connect();
  try {
    const ticker = await getPrice();
    const price = ticker.price;

    await client.query('BEGIN');
    // 같은 지갑에 동시에 주문이 들어와도 잔고가 어긋나지 않도록 행 잠금
    const { rows } = await client.query('SELECT * FROM wallet WHERE id = 1 FOR UPDATE');
    const w = {
      cash: Number(rows[0].cash),
      qty: Number(rows[0].qty),
      avgPrice: Number(rows[0].avg_price),
      realized: Number(rows[0].realized_pnl),
    };

    let qty, amount, fee, pnl = null, next_;

    if (side === 'buy') {
      // 금액으로 주문하면 현재가로 나눠 수량을 만든다
      qty = floorQty(hasQty ? reqQty : reqAmount / price);
      if (qty <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: '주문 수량이 너무 작습니다.' });
      }
      amount = roundKRW(qty * price);
      fee = roundKRW(amount * FEE_RATE);

      if (amount + fee > w.cash + 0.01) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          message: `보유 현금이 부족합니다. (필요 ${Math.round(amount + fee).toLocaleString('ko-KR')}원 / 보유 ${Math.round(w.cash).toLocaleString('ko-KR')}원)`,
        });
      }

      const newQty = w.qty + qty;
      next_ = {
        cash: roundKRW(w.cash - amount - fee),
        qty: newQty,
        avgPrice: roundKRW((w.avgPrice * w.qty + amount) / newQty),
        realized: w.realized,
      };
    } else {
      qty = floorQty(reqQty);
      if (qty <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: '주문 수량이 너무 작습니다.' });
      }
      if (qty > w.qty + QTY_EPS) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          success: false,
          message: `보유 수량이 부족합니다. (요청 ${qty} BTC / 보유 ${w.qty} BTC)`,
        });
      }

      amount = roundKRW(qty * price);
      fee = roundKRW(amount * FEE_RATE);
      pnl = roundKRW((price - w.avgPrice) * qty - fee);   // 실현손익 (수수료 반영)

      const restQty = w.qty - qty;
      const cleared = restQty < QTY_EPS;                  // 전량 청산이면 평단 초기화
      next_ = {
        cash: roundKRW(w.cash + amount - fee),
        qty: cleared ? 0 : restQty,
        avgPrice: cleared ? 0 : w.avgPrice,
        realized: roundKRW(w.realized + pnl),
      };
    }

    const inserted = await client.query(
      `INSERT INTO orders (market, side, qty, price, fee, pnl, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [MARKET, side, qty, price, fee, pnl, typeof memo === 'string' ? memo.slice(0, 500) : ''],
    );

    const updated = await client.query(
      `UPDATE wallet
          SET cash = $1, qty = $2, avg_price = $3, realized_pnl = $4, updated_at = NOW()
        WHERE id = 1
        RETURNING *`,
      [next_.cash, next_.qty, next_.avgPrice, next_.realized],
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: {
        order: toOrder(inserted.rows[0]),
        wallet: toWallet(updated.rows[0]),
        price: ticker,
      },
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 이미 끊긴 경우 무시 */ }
    next(err);
  } finally {
    client.release();
  }
});

// ── API: 계좌 초기화 ─────────────────────────
app.post('/api/reset', async (_req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM orders');
    const { rows } = await client.query(
      `UPDATE wallet
          SET cash = $1, qty = 0, avg_price = 0, realized_pnl = 0, updated_at = NOW()
        WHERE id = 1
        RETURNING *`,
      [INITIAL_CASH],
    );
    await client.query('COMMIT');
    res.json({ success: true, data: toWallet(rows[0]) });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 무시 */ }
    next(err);
  } finally {
    client.release();
  }
});

// ── API: 설정 (비밀값은 내려보내지 않고 준비 여부만) ──
app.get('/api/config', (_req, res) => {
  res.json({
    success: true,
    data: {
      market: MARKET,
      initialCash: INITIAL_CASH,
      feeRate: FEE_RATE,
      dbConfigured: Boolean(DATABASE_URL),
    },
  });
});

// 없는 API 경로는 HTML 대신 JSON 404 로 답한다
app.use('/api', (_req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

// ── SPA fallback (Express 5 문법) ─────────────
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Error handler ────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// Local: 서버 시작 / Vercel: app export
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!DATABASE_URL) console.warn('⚠ DATABASE_URL 이 비어 있습니다. .env 를 확인하세요.');
  });
}
module.exports = app;
