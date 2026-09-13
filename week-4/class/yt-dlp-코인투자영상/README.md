# yt-dlp 실습 — 인기 코인 투자 영상 1편 내려받기

## 선정한 영상

| 항목 | 값 |
|---|---|
| 제목 | "미국이 전재산 걸었다" 일주일도 안남았습니다 곧 비트코인, 금 완전 뒤집힌다 (김창익 대표 / 풀버전) |
| 채널 | 웅달 책방 |
| 업로드 | 2026-09-06 |
| 길이 | 56분 52초 (3,412초) |
| 조회수 | 106,612회 |
| 좋아요 | 887 |
| URL | https://www.youtube.com/watch?v=ET0Lqrm_zXQ |

### 왜 이 영상인가

`코인 투자` / `비트코인 투자` 두 키워드를 **"이번 달 업로드 + 조회수순"** 으로 검색해 상위 27편을 뽑은 뒤 조회수로 정렬했다. 순수 조회수 1·2위는 코인 실패담 다큐(16.1만)와 코미디 스킷(13.9만)이라 "투자 영상"으로 보기 어려웠고, **실제 투자 전망·분석 콘텐츠 중 최다 조회수**가 이 영상(10.6만)이었다.

조회수 상위 후보:

| 조회수 | 채널 | 제목 | 성격 |
|---|---|---|---|
| 161,265 | 피플빌리지 | 남편 비트코인 실패 후 빚 4억 엄마 | 사연·다큐 |
| 138,896 | 이과장 | 코인 투자자 근황 | 코미디 |
| **106,612** | **웅달 책방** | **김창익 대표 인터뷰 풀버전** | **투자 분석 ← 선정** |
| 38,397 | Jason Pizzino | 비트코인: 매크로 확정 (분석) | 투자 분석 |
| 35,597 | 어슴새벽 | 리플XRP 9월 아주 중요한 이유 | 투자 분석 |

## 산출물

| 파일 | 내용 |
|---|---|
| `video.mp4` | 영상 본편 (360p, 139MB) — **git 추적 제외** |
| `subs.ko.vtt` | 유튜브 한국어 자동 자막 원본 |
| `transcript.md` | 시간표시·중복 제거한 문장 텍스트 (27,705자) |
| `meta.json` | 제목·채널·조회수·업로드일·길이 |
| `thumbnail.webp` | 썸네일 |

`video.mp4`는 139MB로 GitHub 파일 크기 제한(100MB)을 넘기 때문에 `.gitignore`에 넣어 커밋되지 않게 했다. 아래 명령으로 언제든 다시 받을 수 있다.

## 재현 명령

```bash
# 0) 설치 (Windows)
winget install --id yt-dlp.yt-dlp -e     # ffmpeg, deno 가 의존성으로 함께 설치된다

# 1) 검색 — "이번 달 + 조회수순" 은 검색 URL 의 sp 파라미터로 지정한다
yt-dlp "https://www.youtube.com/results?search_query=코인+투자&sp=CAMSBAgCEAE%253D" \
  --flat-playlist --dump-json --skip-download --playlist-end 15

# 2) 메타데이터
yt-dlp "https://www.youtube.com/watch?v=ET0Lqrm_zXQ" --dump-json --skip-download --no-playlist

# 3) 자막 + 썸네일 (수동 자막은 없고 자동 자막 ko 만 있다)
yt-dlp "https://www.youtube.com/watch?v=ET0Lqrm_zXQ" --no-playlist \
  --write-auto-subs --sub-langs ko --convert-subs vtt --write-thumbnail --skip-download

# 4) 영상 — mweb 클라이언트로 받는다 (아래 "막힌 지점" 참고)
yt-dlp "https://www.youtube.com/watch?v=ET0Lqrm_zXQ" --no-playlist \
  --extractor-args "youtube:player_client=mweb" -f 18 -o video.mp4

# 5) vtt -> 문장 텍스트
PYTHONIOENCODING=utf-8 python .claude/skills/yt-dlp/scripts/vtt2md.py subs.ko.vtt > transcript.md
```

## 막힌 지점과 해결 (2026-09 기준)

유튜브가 클라이언트별로 **PO Token** 을 요구하기 시작해서 기본 설정으로는 영상 데이터가 받아지지 않았다. 실제로 겪은 순서:

| 시도 | 결과 |
|---|---|
| 기본값 (`android_vr`) | 포맷 목록은 나오는데 다운로드에서 `HTTP Error 403: Forbidden` |
| `player_client=web` | `Only images are available` — GVS PO Token 없어서 영상 포맷이 전부 걸러짐 |
| `player_client=tv,ios` | `The page needs to be reloaded` |
| `player_client=tv_embedded` | 지원 중단된 클라이언트라 무시되고 기본값으로 폴백 |
| **`player_client=mweb` + `-f 18`** | **성공** — 360p 병합 포맷(video+audio 한 파일) |

`mweb` 도 경고는 뜨지만 포맷 18(360p mp4)은 실제로 내려받아진다. 720p 이상(`398+140` 등 분리 스트림)을 받으려면 PO Token 이나 브라우저 쿠키(`--cookies-from-browser`)가 필요하다. `PYTHONIOENCODING=utf-8` 은 Windows 기본 콘솔 인코딩이 cp949 라서 붙였다 — 안 붙이면 `transcript.md` 가 cp949 로 저장돼 깨진다.

## 영상 내용 3줄 요약

- **금**: 바젤 3 협약에서 금이 무위험 자산(Tier 1)으로 회계 처리되면서 각국 중앙은행·기업·개인의 실물 비축 경쟁이 구조화됐고, 이 흐름은 되돌아가지 않는다.
- **달러와 국채**: 미국 부채 40조 달러·이자 1조 달러, 장기 국채 금리 5.3% 상황에서 재무부는 보유 현물(부동산·금·비트코인·석유)의 가치를 올려 팔아 장기 국채를 사야 하므로 **돈을 풀 수밖에 없다**.
- **비트코인**: 그 유동성 국면에서 레버리지·유동성 민감 자산인 비트코인이 급등하며, 레이 달리오가 말한 부채 사이클의 마지막 국면(1~5년 내)이 오면 화폐 가치가 떨어지고 실물 자산 보유자와 미보유자의 격차가 회복 불가능해진다 — "100만 원어치라도 사서 쥐고 있어야 한다"는 것이 결론.

> 영상은 출연자 개인의 전망이며 투자 권유가 아니다. 자동 자막 기반이라 인명·수치에 오탈자가 있다(예: "김익" → 김창익, "레이달리오" → 레이 달리오). 정확한 인용이 필요하면 `whisper` 스킬로 다시 받아쓰는 것이 좋다.

## 사용 범위

개인 리서치·수업 실습 목적의 다운로드다. 영상 재업로드·배포는 하지 않는다.
