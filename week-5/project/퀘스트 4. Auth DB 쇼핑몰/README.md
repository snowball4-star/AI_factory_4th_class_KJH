# 퀘스트 4. Auth DB 쇼핑몰 — 오늘의 마켓

로그인 없이 누구나 상품을 둘러볼 수 있고, 장바구니에 담고 주문할 때만 로그인이 필요한 쇼핑몰 앱.
Express 백엔드(`server.js`) 한 개 + React 프런트(`index.html`) 한 개, 데이터는 Supabase PostgreSQL에 저장한다.

## 공개 / 비공개 경계

| 기능 | 로그인 | 설명 |
| --- | --- | --- |
| 상품 목록 (상품명·가격·이미지·요약) | ❌ 불필요 | 검색·카테고리 필터·정렬 포함 |
| 상품 상세 (설명·재고·평점·연관 상품) | ❌ 불필요 | 긴 상품 설명 전문 공개 |
| 카테고리 목록 | ❌ 불필요 | 전자기기 / 패션 / 홈·리빙 / 뷰티 |
| 장바구니 담기·조회·수량변경·삭제·비우기·합계 | ✅ 필요 | 회원별로 DB에 저장 |
| 주문(결제)·주문내역 | ✅ 필요 | 본인 주문만 조회 가능 |

비로그인 상태로 `/api/cart`(GET·POST·PATCH·DELETE), `/api/orders`를 부르면 모두 `401`이 돌아오고,
프런트는 목록·상세 화면에서 "로그인이 필요해요" 모달로 안내한 뒤 계속 둘러볼 수 있게 한다.

## 장바구니 기능 (로그인 사용자 전용)

| 기능 | 화면 | API |
| --- | --- | --- |
| 담기 | 상품 목록 카드의 `장바구니 담기`, 상세의 `장바구니`·`바로 구매` | `POST /api/cart` |
| 조회 | `/#/cart` 목록 + 헤더의 개수 배지 + 목록 카드의 "담은 수량 N개" 표시 | `GET /api/cart` |
| 수량변경 | 장바구니 행의 `−` / `+` | `PATCH /api/cart/:productId` |
| 삭제 | 장바구니 행의 `삭제` | `DELETE /api/cart/:productId` |
| 비우기 | 제목 옆 `장바구니 비우기` (확인 모달) | `DELETE /api/cart` |
| 합계 | 제목 아래 요약(상품 N종 M개 · 합계), 행별 소계, 결제 금액 카드 | 모든 장바구니 응답에 `totalQuantity`·`totalAmount` 포함 |

합계는 프런트에서 따로 더하지 않고 **서버가 계산해 내려준 값**을 그대로 쓴다. 담기·수량변경·삭제·비우기
응답이 언제나 갱신된 장바구니 전체를 돌려주므로, 화면과 DB가 어긋날 일이 없다.
같은 상품을 다시 담으면 수량이 합산되며, 재고와 최대 20개 범위를 서버에서 넘지 못하게 자른다.

## 배포 주소

**https://auth-db-shop.vercel.app** (Vercel · 프로젝트 `ai-factory6/auth-db-shop`)

로그인 없이 상품 목록·상세가 바로 열린다. 장바구니·주문은 배포본에서도 로그인해야 한다.

## 실행 방법

```bash
npm install
npm start          # http://localhost:5004
npm run deploy     # Vercel 재배포 (vercel login 이 되어 있어야 한다)
```

- `.env`에 `DATABASE_URL`(Supabase PostgreSQL)과 `PORT`, `SEED_USERS`를 넣어 둔다. 형식은 `.env.example` 참고.
- 서버가 처음 뜰 때 `shop_*` 테이블을 만들고, 상품 14개와 `SEED_USERS`의 데모 계정을 한 번만 채운다.
- 데모 계정 아이디·비밀번호는 `.env`의 `SEED_USERS`에만 있다 (저장소에 커밋되지 않음).
  회원가입 탭에서 새 계정을 만들어 시연해도 된다.

## 화면

| 파일 | 내용 |
| --- | --- |
| `화면-1-상품목록(비로그인).png` | 로그인하지 않은 상태의 상품 목록 |
| `화면-2-상품상세(비로그인).png` | 로그인하지 않아도 보이는 상품 설명·가격·이미지 |
| `화면-3-로그인안내모달(비로그인).png` | 비로그인 상태에서 장바구니를 누르면 뜨는 안내 |
| `화면-4-로그인.png` | 로그인 / 회원가입 |
| `화면-5-상품상세(로그인).png` | 로그인 후 상세 — 헤더에 장바구니 개수 배지 |
| `화면-6-장바구니.png` | 조회·수량변경·삭제·합계·비우기 |
| `화면-7-주문완료.png` | 주문 완료 모달 |
| `화면-8-주문내역.png` | 내 주문내역 |
| `화면-9-모바일.png` | 390px 모바일 레이아웃 |
| `화면-10-목록에서담기-로그인안내.png` | 비로그인 상태로 목록에서 담기를 누른 경우 |
| `화면-11-목록에서담기(로그인).png` | 목록에서 바로 담기 + 담은 수량 표시 |
| `화면-12-장바구니비우기확인.png` | 비우기 확인 모달 |
| `화면-13-빈장바구니.png` | 비운 뒤의 빈 상태 |
| `화면-14-배포본(vercel).png` | 배포 주소에서 비로그인 담기 → 로그인 안내 |
| `화면-15-배포본-장바구니(로그인).png` | 배포 주소에서 로그인 후 장바구니 |

## API

공개 (인증 불필요)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/products?category=&q=&sort=` | 상품 목록. `sort`는 `recommended`(기본)·`price_asc`·`price_desc`·`name` |
| GET | `/api/products/:id` | 상품 상세 + 같은 카테고리 추천 3개 |
| GET | `/api/categories` | 카테고리 목록 |

인증

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| POST | `/api/auth/signup` | 회원가입 (아이디 3자 이상, 비밀번호 6자 이상) |
| POST | `/api/auth/login` | 로그인 |
| GET | `/api/auth/me` | 로그인 여부 확인. 비로그인이면 `data: null` (에러 아님) |
| POST | `/api/auth/logout` | 로그아웃 |

로그인 필요

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/cart` | 내 장바구니 (합계 포함) |
| POST | `/api/cart` | 담기. 이미 있으면 수량 합산, 재고·최대 20개로 제한 |
| PATCH | `/api/cart/:productId` | 수량 변경 |
| DELETE | `/api/cart/:productId` · `/api/cart` | 한 건 삭제 · 전체 비우기 |
| POST | `/api/orders` | 결제. 장바구니 → 주문 + 재고 차감 + 장바구니 비우기를 한 트랜잭션으로 |
| GET | `/api/orders` | 내 주문내역 (주문 상품 포함) |

## DB 스키마 (`shop_*`)

- `shop_users` — 회원. 비밀번호는 `scrypt(비밀번호, salt)` 해시로만 저장하고 평문은 남기지 않는다.
- `shop_sessions` — 세션. 쿠키에 담긴 토큰 원문이 아니라 **SHA-256 해시**를 저장한다.
- `shop_products` — 상품(공개 데이터). 이름·카테고리·가격·이미지·요약·설명·재고·평점.
- `shop_cart_items` — 회원별 장바구니. `(user_id, product_id)` 유니크.
- `shop_orders` / `shop_order_items` — 주문과 주문 상품. 주문 시점의 **상품명·가격을 복사해 둬서**
  나중에 상품 가격이 바뀌어도 지난 영수증 금액은 그대로 남는다.

퀘스트 3과 같은 Supabase 프로젝트를 쓰되 테이블 접두사를 `shop_`으로 분리해 서로 간섭하지 않는다.

## 보안 처리

- **비밀정보는 `.env`에서만 읽는다.** DB 접속 문자열도, 데모 계정의 아이디·비밀번호도
  브라우저로 내려가는 `index.html`이나 커밋되는 문서에 적지 않는다. `.env`는 `.gitignore` 대상.
- **세션은 `HttpOnly`·`SameSite=Lax` 쿠키.** 페이지 스크립트가 토큰을 읽을 수 없고,
  `localStorage`에는 아무것도 저장하지 않는다. 프런트는 `credentials: 'same-origin'`만 붙여 보낸다.
- **정적 서빙은 `index.html`만 명시적으로 한다.** 폴더를 통째로 `express.static` 하면
  같은 폴더의 `.env`가 `/.env`로 노출되기 때문이다.
- **Vercel 배포 시** `process.env.VERCEL`이 있으면 `.env` 파일을 읽지 않는다.
  Vercel CLI가 `.vercelignore`를 무시하고 `.env`를 번들에 넣는 경우를 막기 위함이다.
  나아가 `deploy.sh`는 이 폴더에서 바로 배포하지 않고 **`server.js`·`index.html`·
  `package.json`·`package-lock.json`·`vercel.json`만 임시 폴더에 복사해** 그곳에서
  `vercel deploy`를 실행한다. `.env`가 업로드 대상에 아예 포함되지 않는다.
- **배포본의 비밀정보는 Vercel 환경변수(Production, Secret 타입)로만 들어간다.**
  `DATABASE_URL`과 `SEED_USERS`가 등록되어 있고, 대시보드에서도 값이 가려진다.
  값을 바꾸려면 `vercel env rm <NAME> production` 후 `vercel env add <NAME> production`.
- 장바구니·주문 API는 모두 `user_id` 기준으로 본인 데이터만 읽고 쓴다.
- 재고보다 많은 수량은 담기·변경·결제 단계에서 각각 막고, 결제 시에는 `FOR UPDATE`로 상품 행을
  잠가 동시에 들어온 주문이 재고를 초과해 빼 가지 못하게 한다.

## 사용 기술

- 백엔드: Node.js + Express 5, `pg` (Supabase PostgreSQL), `crypto.scrypt` 해시
- 프런트: React 18 + ReactDOM + Babel standalone + Tailwind CSS (전부 CDN, 버전 고정), 해시 라우팅
- 화면 경로: `/#/`, `/#/products/:id`, `/#/cart`, `/#/orders`, `/#/login`
