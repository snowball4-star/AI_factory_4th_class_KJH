# 퀘스트 3. Auth 커뮤니티 앱 — 우리가족 커뮤니티

로그인한 가족 구성원이 게시글을 **작성 · 조회 · 수정 · 삭제**할 수 있는 커뮤니티 앱.
백엔드는 `server.js` 하나(Express 5 + Supabase PostgreSQL), 프런트는 `index.html` 하나
(CDN React 18 + Tailwind)로 끝난다. 데이터는 퀘스트 1과 같은 Supabase 인스턴스에
`community_*` 테이블로 저장한다.

## 실행 방법

```bash
cp .env.example .env    # DATABASE_URL·SEED_USERS 를 실제 값으로 채운다
npm install
node server.js
# → http://localhost:3000
```

첫 요청이 들어올 때 테이블이 없으면 자동으로 만들고(`CREATE TABLE IF NOT EXISTS`),
`community_users`가 비어 있으면 `SEED_USERS`에 적힌 가족 계정과 예시 글 4개를 넣는다.

### 환경변수 (`.env`, git에 커밋되지 않음)

| 변수 | 용도 |
|---|---|
| `DATABASE_URL` | Supabase PostgreSQL 연결 문자열 (Transaction pooler, 포트 6543) |
| `PORT` | 로컬 서버 포트 (Vercel에서는 무시됨) |
| `SEED_USERS` | 최초 실행 시 만들 가족 계정. `아이디:표시이름:비밀번호` 를 쉼표로 구분 |

**계정 아이디·비밀번호는 코드·HTML·이 문서 어디에도 적지 않는다.** 오직 `.env`에만 두며,
자리표시자 형식은 `.env.example`에서 볼 수 있다. 계정을 추가하려면 `SEED_USERS`에 한 명을
덧붙이고 서버를 재시작하거나, 화면의 회원가입을 쓰면 된다. 이미 있는 아이디는
`ON CONFLICT DO NOTHING`으로 건너뛰므로 기존 비밀번호가 덮어써지지 않는다.

## 화면 (해시 라우팅)

| 경로 | 화면 |
|---|---|
| `/#/` | 전체 게시글 목록 (제목·작성자·작성 시간, **최신순**) + 카테고리 필터 + 검색 |
| `/#/posts/:id` | 게시글 상세 (본인 글이면 수정·삭제 버튼 노출) |
| `/#/write` | 새 글 쓰기 (로그인 필요, 미로그인 시 `/#/login`으로 리다이렉트) |
| `/#/posts/:id/edit` | 게시글 수정 (작성자 본인만) |
| `/#/login` | 로그인 |
| `/#/signup` | 회원가입 |

카테고리는 **맛집정보 · 여행정보 · 생활정보 · 포트폴리오** 네 가지로 고정되어 있고,
DB의 `CHECK` 제약과 서버 검증 양쪽에서 막는다.

## 인증 방식 — 브라우저에는 아무것도 남기지 않는다

- 로그인에 성공하면 서버가 랜덤 토큰을 만들어 **`HttpOnly`·`SameSite=Lax` 쿠키**(`sid`)로
  내려보낸다. HTTPS로 접속한 경우 `Secure`가 함께 붙는다.
- 쿠키가 `HttpOnly`이므로 페이지 스크립트는 `document.cookie`로 토큰을 읽을 수 없고,
  프런트는 `localStorage`·`sessionStorage`를 전혀 쓰지 않는다. 프런트가 하는 일은
  `credentials: 'same-origin'`으로 요청을 보내는 것뿐이다.
- 서버는 토큰 **원문이 아니라 SHA-256 해시**를 `community_sessions`에 저장한다.
  DB가 유출돼도 세션을 그대로 재사용할 수 없다.
- 비밀번호는 사용자마다 16바이트 salt를 만들어 `crypto.scryptSync`로 해시해 보관하고,
  검증은 `timingSafeEqual`로 한다. API 응답에는 `{ id, username, displayName }`만 나간다.
- 정적 서빙은 `index.html`만 명시적으로 한다. `app.use(express.static(__dirname))`을 쓰면
  같은 폴더의 `.env`가 `/.env`로 노출되기 때문이다.

## DB 스키마

| 테이블 | 주요 컬럼 |
|---|---|
| `community_users` | `id`, `username`(UNIQUE), `display_name`, `password_salt`, `password_hash`, `created_at` |
| `community_posts` | `id`, `title`, `category`(CHECK 4종), `content`, `author_id`→users, `created_at`, `updated_at` |
| `community_sessions` | `token_hash`(PK, SHA-256), `user_id`→users, `expires_at`, `created_at` |

인덱스는 목록 정렬용 `community_posts (created_at DESC)`와 필터용 `(category)`,
만료 세션 정리용 `community_sessions (expires_at)`를 둔다. 사용자를 지우면 그 사람의
게시글과 세션도 `ON DELETE CASCADE`로 함께 지워진다.

## API

응답은 모두 `{ success, data?, message? }` 형태. 인증은 쿠키로 자동 처리된다.

| 메서드 | 경로 | 인증 | 요청 body | 설명 |
|---|---|---|---|---|
| POST | `/api/auth/signup` | – | `{ username, password, displayName? }` | 회원가입 (아이디 3자·비밀번호 6자 이상), 세션 쿠키 발급 |
| POST | `/api/auth/login` | – | `{ username, password }` | 로그인, 세션 쿠키 발급 |
| GET | `/api/auth/me` | ✔ | – | 현재 로그인 사용자 |
| POST | `/api/auth/logout` | ✔ | – | 세션 삭제 + 쿠키 만료 |
| GET | `/api/categories` | – | – | 카테고리 목록 |
| GET | `/api/posts` | – | – | 목록 (최신순). `?category=여행정보&q=검색어` |
| GET | `/api/posts/:id` | – | – | 상세 |
| POST | `/api/posts` | ✔ | `{ title, category, content }` | 작성 |
| PUT | `/api/posts/:id` | ✔ | `{ title, category, content }` | 수정 (작성자 본인만, 아니면 403) |
| DELETE | `/api/posts/:id` | ✔ | – | 삭제 (작성자 본인만, 아니면 403) |

## 검증 기록

Supabase에 실제로 연결한 상태에서 확인했다.

- **API**: 비로그인 401, 틀린 비밀번호 401, 남의 글 수정·삭제 403, 잘못된 카테고리·빈 제목 400,
  중복 아이디 409, 삭제 후 조회 404, 로그아웃 후 `me` 401.
  로그인 응답의 `Set-Cookie`가 `HttpOnly; SameSite=Lax; Max-Age=604800`이고 비밀번호를 담지 않음을 확인.
- **정적 파일 유출**: `/.env`, `/server.js`, `/package.json` 요청이 파일 내용 대신
  `index.html`(SPA fallback)을 돌려준다.
- **브라우저(Playwright)**: 회원가입 → 글쓰기 → 상세 → 수정 → 삭제까지 콘솔 에러 없이 동작.
  `Object.keys(localStorage)`가 빈 배열이고 `document.cookie`도 빈 문자열이며,
  새로고침 후에도 로그인 상태가 유지된다(쿠키 기반).
- 검증에 쓴 임시 계정과 글은 테스트 후 DB에서 삭제했다.

| 파일 | 내용 |
|---|---|
| `화면-1-로그인.png` | 로그인 화면 (계정 안내 문구 없음) |
| `화면-2-게시글목록.png` | 최신순 목록 (제목·작성자·작성 시간) |
| `화면-3-게시글상세.png` | 게시글 상세 (수정됨 표시) |
| `화면-4-글쓰기.png` | 글쓰기 폼 (카테고리 선택) |
| `화면-5-삭제확인.png` | 삭제 확인 모달 |
