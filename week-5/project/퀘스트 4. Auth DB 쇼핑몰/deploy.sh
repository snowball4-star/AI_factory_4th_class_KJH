#!/usr/bin/env bash
# ========================================
# Vercel 재배포 스크립트
#
# Vercel CLI는 .vercelignore에 .env를 적어도 배포 번들에 넣어 버리는 경우가 있다.
# 그래서 이 폴더에서 바로 `vercel deploy` 하지 않고,
# 배포에 필요한 파일만 임시 폴더로 복사해 그곳에서 배포한다.
#
# 사용법:  bash deploy.sh          (npm run deploy 와 동일)
# 사전 조건: vercel login 이 되어 있어야 한다.
# 환경변수(DATABASE_URL, SEED_USERS)는 Vercel 프로젝트에 이미 등록되어 있으며,
# 값을 바꾸려면  vercel env rm <NAME> production  후  vercel env add <NAME> production
# ========================================
set -euo pipefail

PROJECT="auth-db-shop"
SRC="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"

trap 'rm -rf "$TMP"' EXIT

# 배포에 필요한 파일만 복사한다 (.env, 스크린샷, node_modules 제외)
cp "$SRC/server.js" "$SRC/index.html" "$SRC/package.json" "$SRC/package-lock.json" "$SRC/vercel.json" "$TMP/"

cd "$TMP"
if [ -f "$TMP/.env" ]; then
  echo "중단: 임시 폴더에 .env 가 있습니다. 비밀정보가 업로드될 수 있습니다." >&2
  exit 1
fi

vercel link --project "$PROJECT" --yes
rm -f "$TMP/.env.local"   # vercel link 가 만든 로컬 개발용 토큰 파일
vercel deploy --prod --yes
