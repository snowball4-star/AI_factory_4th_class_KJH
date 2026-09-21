# 퀘스트 5. 관심분야 자동 리서치 스킬 만들기

**PubMed에서 `glaucoma`(녹내장) 키워드의 최근 1주일 신규 논문을 매주 금요일에 모아
주제별 한글 리포트로 만드는 Claude Code 스킬.**

## 왜 만들었나

녹내장 분야는 주당 70~80편이 새로 등재된다. 제목만 훑으면 "MIGS 논문이 또 나왔네" 수준에서
끝나고, 전부 읽으면 시간이 안 난다. 필요한 건 목록이 아니라 **"이번 주에 무슨 일이 있었는지"**다.
이 스킬은 수집을 자동화하고, 요약을 사람이 읽을 수 있는 글로 만든다.

## 폴더 구성

```
퀘스트 5. 관심분야 자동 리서치 스킬 만들기/
├─ README.md                        이 파일
├─ skill/
│  └─ SKILL.md                      스킬 정의 (제출본)
├─ scripts/
│  ├─ fetch-pubmed.js               PubMed E-utilities 수집기 (의존성 없음)
│  └─ run-weekly.cmd                Windows 작업 스케줄러용 실행 래퍼
├─ reports/
│  └─ 2026-09-20_glaucoma_weekly.md 1주차 리포트 (78편)
├─ data/
│  ├─ 2026-09-20_glaucoma_papers.json  구조화된 서지정보 + 초록
│  └─ 2026-09-20_glaucoma_medline.txt  MEDLINE 원본
├─ logs/                            run-weekly.log (gitignore 대상)
└─ 에이전트 탐색과정 1~3.png         작업 과정 스크린샷
```

스킬의 **동작하는 설치본**은 저장소 루트의 `.claude/skills/glaucoma_1wk/SKILL.md` 에 있다.
`.claude/` 는 `.gitignore` 에 들어 있어 커밋되지 않으므로, 제출본을 `skill/` 에 따로 둔다.
스킬 내용을 고치면 두 파일을 같이 고쳐야 한다.

## 사용법

```bash
# Claude Code 안에서
/glaucoma_1wk

# 수집만 따로 (기본: glaucoma, 최근 7일)
node scripts/fetch-pubmed.js --keyword glaucoma --days 7 --out data

# 기간을 직접 지정
node scripts/fetch-pubmed.js --keyword glaucoma --from 2026/09/14 --to 2026/09/20 --out data
```

키워드를 바꾸면 다른 분야에도 그대로 쓸 수 있다 (`--keyword "diabetic retinopathy"`).

## 매주 금요일 자동 실행

Windows 작업 스케줄러에 **`PubMed Weekly - glaucoma`** 작업으로 등록되어 있다.
**매주 금요일 08:00**에 [scripts/run-weekly.cmd](scripts/run-weekly.cmd)가 실행되어
**직전 7일**의 신규 논문을 `data/` 에 쌓고 `logs/run-weekly.log` 에 결과를 남긴다.
PC가 꺼져 있어 놓친 회차는 `-StartWhenAvailable` 설정 덕에 다음 부팅 때 한 번 따라잡는다.

수집까지가 자동이고, **요약 리포트는 Claude Code에서 `/glaucoma_1wk` 로 만든다.**
이미 받아둔 `data/` 의 JSON을 읽어 쓰므로 금요일에 켜두지 못했어도 주말에 이어서 쓸 수 있다.

```powershell
# 상태 확인
Get-ScheduledTaskInfo -TaskName "PubMed Weekly - glaucoma" |
  Select-Object LastRunTime, LastTaskResult, NextRunTime

# 지금 바로 한 번 실행
Start-ScheduledTask -TaskName "PubMed Weekly - glaucoma"

# 실행 시각 변경 (예: 금요일 오전 7시)
$t = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At 07:00
Set-ScheduledTask -TaskName "PubMed Weekly - glaucoma" -Trigger $t

# 등록 해제
Unregister-ScheduledTask -TaskName "PubMed Weekly - glaucoma" -Confirm:$false
```

로그는 UTF-8이므로 PowerShell에서 볼 때 `Get-Content ... -Encoding utf8` 을 붙인다.
붙이지 않으면 한글이 깨져 보인다(파일이 깨진 게 아니라 읽는 쪽 문제다).

## 설계에서 막혔던 지점

### PubMed 웹페이지는 Playwright로 긁을 수 없다

처음에 `https://pubmed.ncbi.nlm.nih.gov/?term=glaucoma&filter=dates...` 를 브라우저로 열었더니
검색 결과 대신 **reCAPTCHA "브라우저 확인 중" 페이지**가 떴다. NCBI가 자동화 트래픽을 막고 있다.

해결은 우회가 아니라 **원래 그 용도로 열려 있는 문을 쓰는 것**이었다.
NCBI는 프로그램 접근용으로 [E-utilities API](https://www.ncbi.nlm.nih.gov/books/NBK25501/)를
공개한다. `esearch.fcgi` 로 조건에 맞는 PMID를 받고, `efetch.fcgi` 로 그 PMID들의
서지정보와 초록을 한 번에 받는다. 인증 없이도 초당 3회까지 허용되고,
무료 API 키를 받으면 초당 10회가 된다.

```bash
# 1) 조건에 맞는 PMID 목록
esearch.fcgi?db=pubmed&term=glaucoma[Title/Abstract] AND 2026/09/14:2026/09/20[EDAT]

# 2) 그 PMID들의 서지정보 + 초록 (POST, id가 길어서)
efetch.fcgi  db=pubmed  rettype=medline  retmode=text  id=<PMID들>
```

### 날짜 필터는 `EDAT`을 쓴다

PubMed의 날짜 필드는 여러 개다. `DP`(발행일)는 저널마다 "2026 Oct", "2026 Fall" 처럼 제각각이고
온라인 선공개와 지면 발행이 몇 달씩 벌어진다. 주간 리서치에서 알고 싶은 건
**"이번 주에 새로 볼 수 있게 된 논문"** 이므로 PubMed 등재일인 `EDAT`으로 거른다.
실제로 이번 주 78편 중에는 발행일이 `2026 Oct`, `2026 Dec` 인 선공개 논문도 섞여 있다.

### MEDLINE 포맷의 줄바꿈

`efetch` 의 MEDLINE 텍스트는 긴 초록을 여러 줄로 쪼개고 **이어지는 줄을 공백 6칸으로 들여쓴다.**
`AB  - ` 로 시작하는 줄만 읽으면 초록의 첫 줄만 얻는다.
파서는 들여쓴 줄을 직전 필드에 이어 붙인다 ([fetch-pubmed.js](scripts/fetch-pubmed.js)의 `parseMedline`).

### 배치 파일에 한글 주석을 넣으면 실행이 깨진다

`run-weekly.cmd` 를 한글 주석과 함께 UTF-8로 저장했더니 작업 스케줄러가
`LastTaskResult 0`(성공)을 돌려주는데도 **아무 일도 일어나지 않았다.**
직접 실행해 보니 `'직전' is not recognized as an internal or external command` 가 쏟아졌다.

cmd.exe는 배치 파일을 **시스템 ANSI 코드페이지(한국어 Windows는 CP949)로 한 줄씩 파싱**한다.
파일 안의 `chcp 65001` 은 이미 파싱이 시작된 뒤에 실행되므로 소용이 없다.
UTF-8로 저장된 한글의 바이트열이 CP949로 잘못 해석되면서 `REM` 줄이 명령어로 쪼개진 것이다.

그래서 **배치 파일 본문은 ASCII만** 쓴다. 한글 설명은 이 README에 둔다.
반면 node가 배치 안에서 출력하는 한글은 UTF-8 그대로 로그에 쌓이므로 문제없다.

### 제목만 보고 분류하면 틀린다

`glaucoma[Title/Abstract]` 로 잡힌 78편 중 상당수는 녹내장이 **주제가 아니라 배경**으로
언급된 논문이다. 90대 백내장수술 논문, 소아 포도막염 역학 논문, 난소암 약물의 FAERS 분석까지
걸린다. 그래서 스킬은 **초록을 전부 읽고 나서** 분류하도록 못박았다.

## 1주차 결과 (2026/09/14 ~ 09/20)

총 **78편**. 전체 정리는 [reports/2026-09-20_glaucoma_weekly.md](reports/2026-09-20_glaucoma_weekly.md).

| 주제 | 편수 |
|---|---|
| 수술·시술 (MIGS, 유출장치, 레이저) | 21 |
| 유전학·분자 기전 | 14 |
| 진단·영상·AI | 12 |
| 역학·보건의료·환자 경험 | 12 |
| 약물 치료와 약물 전달 | 10 |
| 증례보고·감별진단 | 9 |

가장 두드러진 신호는 **PreserFlo MicroShunt 4편이 한 주에 몰린 것**이다.
효과(2년 IOP 24.0 → 13.5 mmHg)와 합병증(각막내피부전, 여과포 감염)이 같은 주에 함께 보고되면서,
논점이 "듣는가"에서 "누구에게 쓸 것인가"로 옮겨가고 있음이 드러난다.

## 보안 메모

- NCBI API 키는 선택 사항이고, 쓸 경우 `NCBI_API_KEY` **환경변수로만** 읽는다.
  코드·리포트·커밋에 키 문자열을 넣지 않는다.
- 이 스킬은 공개 문헌 데이터베이스만 조회하며 환자 정보를 다루지 않는다.
