# 작업 기억 — 조사와 검토

> 상태: 1차 구현(브랜치 `feat/work-memory`, 2026-10-28). 검토·PoC 는 아래 3~7장, 구현 내용은 6장.

## 1. 목표

AI에게 과거 대화 전체를 매번 넘기지 않는다. 대화·오류·수정 내역을 DB에 원문으로 저장해 두고, 지금 작업에 필요한 기억만 찾아서 넘긴다.

1. **저장** — 대화, 오류 로그, 수정 내역을 원문으로 저장하고 임베딩을 만든다.
2. **검색** — "인증 API 버그"처럼 지금 작업과 의미가 가까운 과거 기록을 찾는다.
3. **재정렬** — 관련성이 높은 기록만 고른다.
4. **전달** — 최근 대화 + 고른 과거 기록만 AI 컨텍스트에 넣는다.

## 2. 지금 앱에 있는 것

| 필요한 것 | 이미 있는 것 | 위치 |
|---|---|---|
| 대화 원문 읽기 | Claude·Codex 기록을 사람 요청·AI 답·도구 호출·오류·고친 파일로 나눠 읽는 파서 | `src-tauri/src/sessions.rs` `claude_transcript`, `codex_transcript` |
| 이어 읽기 | 기록 파일의 어디까지 읽었는지(오프셋) 기억하고 새 줄만 읽는 코드 | `sessions.rs` `scan_prompts_forward` |
| 바뀐 기록 알림 | 기록 폴더 감시 → `sessions-changed` 이벤트 | `src-tauri/src/watch.rs`, `src/App.tsx` |
| 세션과 저장소·브랜치·시작 커밋 연결 | `session_links`, `executions`(시작 브랜치·HEAD) | `src-tauri/src/db.rs` |
| 이번 실행에만 설정 덧붙이기 | Claude를 `--settings '<JSON>'`(지금은 테마)로 띄움 | `src-tauri/src/core.rs` `start` |
| 앱 실행 파일을 특별 인자로 다시 띄워 앱에 붙기 | `--handoff-keeper` + 유닉스 소켓 | `src-tauri/src/handoff.rs`, `main.rs` |
| 믿지 않은 저장소 구분 | 저장소 믿기 | `src-tauri/src/trust.rs` |
| 원문 압축 | `zstd` 의존성 | `Cargo.toml` |
| 화면 자리 | 세션 상세 "이어가기" 버튼, 새 세션 창 | `src/panels/AgentPanel.tsx` |

## 3. 검토 — 꼭 짚어야 할 것

### 3.1 절약은 "새로 시작"할 때 생긴다
- 앱은 이미 돌고 있는 Claude·Codex 세션의 컨텍스트를 줄일 수 없다. 컨텍스트는 CLI가 관리한다.
- 줄일 수 있는 지점은 두 곳뿐이다.
  - **세션을 이어갈 때.** `--resume`은 대화 전체를 다시 보낸다. 대신 "최근 몇 턴 + 고른 기억"으로 새 세션을 연다.
  - **긴 세션 도중.** Claude는 `/clear` 뒤 SessionStart(`clear`) 훅으로 고른 기억만 다시 넣을 수 있다.
- 따라서 이 기능의 중심은 검색 엔진보다 **"가볍게 이어가기" 흐름**이다. 사용자가 이 버튼을 쓰는 만큼만 토큰이 준다.

### 3.2 원문은 우리 DB에 따로 보관해야 한다
- Claude Code는 기본 설정(`cleanupPeriodDays` 30일)으로 오래된 대화 원본을 지운다.
- 기억으로 쓰려면 지워지기 전에 우리 DB로 옮겨 둬야 한다. 별도 프로젝트(이걸내가)에서도 같은 이유로 보관함을 만들었다.

### 3.3 재정렬은 세 겹으로 나눈다
요청서의 "재정렬" 단계를 아래처럼 나눈다. 큰 재정렬 모델(400MB 이상)은 처음부터 넣지 않는다.

1. **규칙 재정렬 (1차 기본)** — 벡터 결과를 중심으로 다음을 적용한다.
   - 질의에 영문·숫자 식별자(함수명·오류 코드·파일명)가 있을 때만 키워드(BM25) 결과를 낮은 비중으로 섞는다. PoC에서 키워드를 같은 비중으로 섞으면 1위 적중이 오히려 떨어졌다(7장).
   - 같은 저장소 가중치
   - 최근 기록 가중치
   - 같은 세션·같은 턴 중복 제거
   - 이미 넣은 기록 빼기
2. **교차 인코더 재정렬 모델 (2차, 선택)** — 점수에 문턱값을 둘 수 있어서 "관련 기록 없음(0개)"을 판단할 수 있다.
   - 자동 주입에 꼭 필요하다.
   - PoC에서 벡터만으로 3위 안 적중이 30개 중 27~28개였다. 그래서 사람·에이전트가 고르는 1차 흐름에는 필요 없고, 자동 주입을 만들 때 다시 본다.
3. **최종 선택은 사람 또는 에이전트**
   - 새 세션을 열 때는 사용자가 미리보기에서 고른다.
   - MCP로 검색할 때는 에이전트가 짧은 목록을 보고 필요한 것만 상세 조회한다.
   - 이 경우 메인 모델이 재정렬기 역할을 하고, 비용은 목록 약 1천 토큰이다.

### 3.4 Claude와 Codex의 차이
| | Claude Code | Codex CLI |
|---|---|---|
| 이번 실행에만 훅 | `--settings`의 hooks — 사용자 훅과 **합쳐져** 함께 돎(실측) | `-c hooks.*` — 실측에서 **주입 안 됨**(훅 신뢰 검토 때문으로 추정) |
| 이번 실행에만 MCP | `--mcp-config <JSON>` (`--strict-mcp-config`는 쓰지 않음 — 사용자 MCP가 꺼짐) | `-c mcp_servers.<id>.command=…` (실측) |
| 새 세션에 기억 넣기 | SessionStart(`startup`) 훅 또는 첫 프롬프트 | 첫 프롬프트 또는 `-c developer_instructions` (`exec`에서 실측) |
| 주입 크기 제한 | 훅 출력 10,000자 | 훅 출력 약 2,500토큰 |
| 매 프롬프트 자동 주입 | 가능(UserPromptSubmit, 30초 제한) | 사용자 전역 설정을 고쳐야 함 → 하지 않음 |

### 3.5 위험
- **엉뚱하거나 오래된 기억**: 옛 기록이 지금 코드와 다를 수 있다. 기록마다 날짜·커밋·파일 경로를 붙이고 "당시 기록, 지금 코드로 확인할 것"이라고 표시한다.
- **프롬프트 인젝션**: 남의 저장소 README나 웹 내용이 도구 출력에 섞여 기록에 들어갈 수 있다. 대응은 이렇다.
  - 자동 주입은 사용자 요청·AI 답만 쓴다.
  - 검색 범위는 기본적으로 같은 저장소다.
  - 믿지 않은 저장소는 색인하지 않는다.
  - 시스템 프롬프트(`--append-system-prompt`)나 `developer_instructions`처럼 권한이 높은 자리에는 원문을 넣지 않는다.
- **비밀값**: 원문과 임베딩 모두에서 저장 **전에** 가린다(임베딩도 원문을 역산할 수 있다는 OWASP 경고).
- **앱 가벼움**
  - PoC에서 모델을 불러오면 0.4GB, 색인하는 동안 최대 0.7~0.9GB를 썼다.
  - 그래서 임베딩은 앱 본체가 아니라 **도우미 프로세스**(`코드행방 --memory-worker`)에서 돌린다. 일이 있을 때만 띄우고, 한동안 쉬면 끝내서 메모리를 돌려준다. 이렇게 하면 ONNX Runtime이 죽어도 앱은 멀쩡하다.
  - 색인은 스레드를 2개로 제한해 천천히 한다(초당 약 14조각).
- **유사 도구의 실패 사례(claude-mem 이슈)**
  - 매 턴 같은 블록 재주입
  - 주입 글에 분 단위 시각을 넣어 프롬프트 캐시가 깨짐
  - 배경 LLM 요약이 토큰을 대량으로 소모
  - 이 앱은 앱 안에서 LLM을 부르지 않는 원칙을 지킨다.

## 4. 설계안

### 4.1 저장
- **DB 파일**: 별도 파일 `memory.sqlite3`. 지금 DB와 떼어 두면 지우고 다시 만들기 쉽다.
- **테이블**
  - `records`: 원문, zstd 압축.
    - 종류: 대화 / 오류 / 수정 / 커밋
    - 출처: 사용자 / AI / 도구
    - 연결: 세션, 턴 번호, 저장소, 브랜치, 시각
  - `chunks`: 검색용 글(300~500자) + 머리말 `[저장소·브랜치·날짜·세션 제목]`.
  - `chunks_fts`: FTS5 `trigram`.
  - `vectors`: 청크당 256차원 int8 BLOB(256바이트). PoC는 고정 배율(×127)로 바꿨는데도 256차원 f32와 결과가 같았고, 768차원 f32와도 거의 같았다(1위 적중 23 대 24/30). 실제로는 벡터마다 배율을 두면 더 정확하다.
  - `ingest_state`: 기록 파일별 읽은 위치와 파서 버전. 해석 규칙을 바꾸면 버전을 올려 다시 읽는다.
- **수집 대상**
  - 대화: 사람 요청, AI 답.
  - 오류: Claude `tool_result.is_error`, Codex 명령 종료 코드 ≠ 0. 오류 줄 앞뒤 몇 줄만 남긴다.
  - 수정: Claude Edit/Write의 파일·바뀐 줄, Codex FileChange.
  - 커밋: 세션 동안 생긴 커밋 메시지. `executions.head_at_start`부터 따라간다.
- **수집하지 않는 것**
  - 파일 읽기 결과 같은 큰 도구 출력(원본에서 가장 큰 부분)
  - 서브에이전트 기록
  - `<private>` 표시가 있는 부분

### 4.2 검색
- 질의 → 벡터 상위 50개(256차원 int8 전수 내적) → (식별자가 있으면) FTS5 결과를 낮은 비중으로 RRF → 규칙 재정렬 → (2차) 교차 인코더 → 상위 3~5개.
- 키워드 검색은 정확한 문자열(오류 코드·경로)을 보조하는 역할이다. 2글자 이하 한국어 단어는 trigram으로 못 찾아 `LIKE`로 보충한다.

### 4.3 전달 (우선순위 순)
1. **가볍게 이어가기 / 기억 담아 새로 시작** (Claude·Codex 공통, 1차)
   - 세션 상세에서 "이어가기" 옆에 둔다.
   - 그 세션의 최근 몇 턴과 검색한 기억 후보를 미리보기로 보여 주고, 사용자가 고르면 새 세션을 연다.
   - Claude는 `--settings`의 SessionStart 훅, Codex는 첫 프롬프트로 넣는다.
   - 분량은 약 2천 토큰(약 8,000자) 이하로 한다.
2. **MCP 검색 도구** (Claude·Codex 공통, 1차 또는 2차)
   - 도구: `search_memory`(짧은 목록, 결과당 100토큰 이하), `get_record`(상세).
   - 명령: `코드행방 --memory-mcp`. 호출할 때마다 앱 소켓에 붙고, 앱이 꺼져 있으면 "기억 저장소 꺼짐"을 돌려준다. 모델은 앱 안에 하나만 둔다.
   - 붙이는 방법: Claude는 `--mcp-config` + `--settings`의 `permissions.allow`, Codex는 `-c mcp_servers.app_memory.*`.
3. **매 프롬프트 자동 주입** (Claude만, 기본 꺼짐, 2차)
   - 교차 인코더 점수가 문턱을 넘을 때만 넣는다. 1~2건까지이고, 세션 안에서 같은 기록은 다시 넣지 않는다.

주입 글 형식(사실 진술, 데이터로 표시):
```
<과거 작업 기록 — 참고용. 당시 기록이므로 지금 코드로 확인할 것>
[날짜 · 저장소 · 브랜치 · 커밋] 사용자: … / AI: … / 수정: 파일 경로
</과거 작업 기록>
```

### 4.4 설정 화면
- 기능 켜기(기본 꺼짐). 켜면 모델과 ONNX Runtime을 내려받고 기존 기록을 색인한다. 진행률을 보여 준다.
- Intel 맥·macOS 13 이하에서는 "이 맥에서는 쓸 수 없음"을 보여 주고 켜기 버튼을 막는다.
- 저장 공간 사용량, 기억 모두 지우기, 저장소별 제외.

## 5. 기술 선택

### 5.1 지원 범위 (2026-10-28 결정)
- **기억 기능은 Apple Silicon + macOS 14 이상에서만 켠다.**
- 앱 자체는 지금처럼 유니버설(Intel 포함)에 macOS 12.0 이상을 유지한다.
- Intel 맥이나 macOS 13 이하에서는 설정에 "이 맥에서는 쓸 수 없음"이라고 보여 주고, 기능을 켜는 버튼을 막는다.
- 이유: ONNX Runtime(ort)이 1.24부터 macOS x86_64 바이너리를 내지 않고 최소 macOS 14를 요구한다. 범위를 좁히면 가장 흔하고 빠른 로컬 임베딩 경로를 그대로 쓸 수 있다. cmake나 llama.cpp 소스 빌드도 필요 없다.

### 5.2 ONNX Runtime을 앱에 붙이는 방식 — 실행 중에 불러오기
- `ort`를 **`load-dynamic`** 으로 쓴다. 실행 파일에 ONNX Runtime을 묶지 않고, 기능을 켠 맥에서만 `libonnxruntime.dylib`를 불러온다.
- 실행 파일에 정적으로 묶으면 안 되는 이유:
  - macOS 14용 라이브러리가 들어가 macOS 12·13에서 앱 전체가 안 열릴 위험이 있다.
  - x86_64 쪽 빌드도 막힌다.
- `load-dynamic`이면 x86_64 쪽 빌드에는 영향이 없다(PoC에서 확인).
- dylib 구하는 곳:
  - 기능을 켤 때 모델과 함께 내려받는다.
  - 받을 주소는 Microsoft 공식 릴리즈(`onnxruntime-osx-arm64-<버전>.tgz`)로 고정한다.
  - 앱에 박아 둔 SHA-256과 맞을 때만 불러온다.
  - 이렇게 하면 앱 크기(지금 약 63MB)는 그대로이고, Intel 사용자가 쓸모없는 파일을 받지도 않는다.
- **서명 주의:** 지금 배포 앱은 임시(ad-hoc) 서명이라 내려받은 dylib를 불러올 수 있다. 나중에 Developer ID 서명과 공증(hardened runtime)을 켜면 다른 서명의 라이브러리는 막힌다. 그때는 둘 중 하나를 정한다.
  - dylib를 앱 안에 넣어 함께 서명한다(약 수십 MB 증가).
  - `com.apple.security.cs.disable-library-validation` 권한을 준다.

### 5.3 모델
| 용도 | 1순위 | 대안 |
|---|---|---|
| 임베딩 | **EmbeddingGemma 2 텍스트 ONNX int8** (`model_quantized`, 314MB) — Apache-2.0, 768차원(MRL로 256 저장), 최대 8192토큰, MMTEB 61.36(256차원 60.41). PoC로 확정 | 같은 모델 q4(174MB): 받는 양은 절반이지만 묶음 임베딩이 int8의 1/3 속도 |
| 재정렬(2차) | bge-reranker-v2-m3 ONNX — Apache-2.0, 한국어 0.852 | KURE-Reranker-nano — 149M, 한국어 0.876, 빠름. ONNX 변환이 되는지 확인 필요 |

- 한국어가 섞인 실제 작업 기록 질의 30개에서 1위 적중 23~24개, 3위 안 27~28개였다(7장). 1세대·bge-m3와의 비교는 모델을 더 받아야 해서 하지 않았다. 지금 점수로 충분하다고 본다.
- 질의와 문서에 붙이는 머리말(`task: search result | query: …`, `title: none | text: …`)을 그대로 쓴다.
- 네이티브 ONNX Runtime CPU에서는 q4·int8 모두 돈다. 브라우저(WASM)에서 실패했던 `GatherBlockQuantized`도 문제없다.
- 이 모델은 멀티모달이라 입력에 `image_features`·`video_features`·`audio_features`가 있다. 텍스트만 쓸 때도 `[0, 512]` 빈 텐서를 넘겨야 한다. 이 세 입력을 빈 상수로 바꾼 텍스트 전용 구조 파일(가중치는 같음)을 만들어 써도 결과가 똑같다.
- 토크나이저는 `tokenizers` 0.22(순수 Rust 정규식 `fancy-regex`)로 충분했다. `tokenizer.json`은 32MB다.
- fastembed 없이 `ort`를 직접 쓴다. 필요한 코드는 불러오기·토큰화·실행·정규화를 합쳐 100줄 남짓이다.

### 5.4 나머지
- **벡터 저장**: SQLite BLOB + Rust 전수 내적. 10만 개 × 256차원 int8은 약 26MB다. 아직 v1 전인 sqlite-vec은 100만 개가 넘을 때 다시 본다.
- **키워드 검색**: FTS5 `trigram`. rusqlite bundled는 FTS5가 켜져 있다.
- **모델 배포**: 앱에 넣지 않고 기능을 켤 때 내려받는다.
  - 받는 파일은 HF 커밋 고정 + SHA-256 검증, 저장 위치는 `~/Library/Application Support`, 이어받기 지원.
  - 받는 양: 모델 314MB + 토크나이저 32MB + ONNX Runtime 37MB(압축, 풀면 43MB) = 약 0.38GB. 재정렬 모델은 2차에 켤 때 따로 받는다.
- **실행 장치**: CPU. Core ML은 양자화 모델에서 CPU보다 4배 느리고 메모리를 5GB 써서 쓰지 않는다(7장).
- **`ort` 함정**: 2.0.0-rc.15는 세션을 만들 때 기본으로 '전력 효율 우선' 장치 선택을 켠다. 그래서 Apple 칩에서는 Core ML로 가 버린다. `with_auto_device(PreferCPU)`를 명시한다.
- 검토했지만 뺀 길:
  - llama.cpp(`llama-cpp-2`): Intel을 지원해야 할 때의 추천이었다. 빌드에 cmake가 필요하고 C++ 소스 빌드가 붙는다.
  - candle만 쓰는 방식: CPU에서 ort보다 약 5배 느리다.
  - Apple NaturalLanguage: 문장 의미 검색용 지표가 없고, 한국어 지원이 불분명하다.

모델별 한국어 검색 점수(KURE MTEB kor 검색 nDCG@10):

| 모델 | 점수 | 라이선스 |
|---|---|---|
| bge-m3 | 0.751 | MIT |
| EmbeddingGemma-300m | 0.725 | Gemma 약관 |
| Qwen3-Embedding-0.6B | 0.714 | Apache-2.0 |
| EmbeddingGemma 2 | 미공개(PoC 실측은 7장) | Apache-2.0 |
| jina-embeddings-v3 | — | CC BY-NC(상업 불가)라 제외 |

## 6. 단계

1. **PoC** — 끝남(2026-10-28). 결과는 7장, 코드는 `poc/work-memory/`.
2. **1차** — 구현(2026-10-28)
   - 수집·저장(`src-tauri/src/memory.rs`): 기록 감시가 깨우면 파일별 읽은 위치부터 이어 읽어 끝난 턴만 넣는다. 일하는 중인 마지막 턴은 기록이 2분 조용해지면 넣는다. 원문은 zstd, 비밀값(키 형식·접속 주소 자격 증명·`password=` 류·JWT·개인 키)은 저장 전에 가린다.
   - 임베딩 도우미(`memory_worker.rs`): 앱 실행 파일을 `--memory-worker` 로 띄우고 표준 입출력 JSON 으로 주고받는다. 2분 쉬면 끝낸다.
   - 내려받기(`memory_fetch.rs`): 모델 3개 파일 + ONNX Runtime tgz 를 커밋·릴리즈 고정 주소에서 받아 SHA-256 확인, 이어받기, dylib 도 해시 확인.
   - 검색: 256차원 int8 전수 내적 + 최근 가산점, 같은 저장소 기본, 믿지 않는 저장소 제외, 같은 내용 한 번만. 키워드 검색(FTS5)은 1차에서 뺐다(PoC 에서 이득이 없었다).
   - 화면: 세션 머리 **기억 담아 새로** 창(직전 3턴 + 관련 기록, 점수 0.82 이상만 미리 고름, 8,000자 상한, 미리 보기) — 작업 기억이 꺼져 있거나 쓸 수 없는 맥에서도 직전 대화만으로 쓸 수 있다. 설정 → 작업 기억(켜기·진행률·정리 상태·기억 지우기·모델 지우기).
   - 검증: Rust 테스트 10개(가리기·턴 수집·조각·벡터·검색 범위·중복·실행 인자), vitest 4개, 데모 앱(실제 내려받기 383MB 28초 → 정리 → 검색 1위 확인 → 창에서 새 세션 시작 → 가짜 claude 가 훅을 실행해 기억 글 확인, 앱 90MB·도우미 약 200MB, 도우미는 쉬면 끝남).
   - 실제 기록으로 읽기만 잰 값(배포 빌드, 임베딩 제외): 기록 1GB 당 처음 읽기 약 1.6초, 바뀐 것이 없을 때 다시 확인 0ms, 최대 메모리 41MB, DB 는 기록 크기의 약 0.6%. 기록 파일을 한 줄씩 읽어 큰 파일도 메모리에 통째로 올리지 않는다(`memory::tests::bench_real_logs`, 평소엔 건너뜀).
3. **2차**: MCP 검색 도구, 교차 인코더 재정렬, Claude 자동 주입(선택), `/clear` 뒤 다시 넣기(SessionStart `clear`)

## 7. PoC 결과 (2026-10-28, Apple M5 · 24GB · macOS 26)

코드와 실행 방법은 `poc/work-memory/README.md`에 있다. 질의와 기록은 실제 작업 기록에서 만들었기 때문에 저장소에 넣지 않았다.

### 7.1 붙이기
| 항목 | 결과 |
|---|---|
| ONNX Runtime 1.31.1 (`onnxruntime-osx-arm64`) | 압축 37MB, 풀면 dylib 43MB. arm64 전용, 최소 macOS 14.0. Core ML 실행 장치 포함 |
| `ort` 2.0.0-rc.15 `load-dynamic` | 불러오기 약 12~50ms(첫 실행 0.9초). 실행 파일에 ONNX Runtime이 링크되지 않는다 |
| x86_64 빌드 | 같은 코드가 `--target x86_64-apple-darwin`으로 빌드된다. 실행 파일의 최소 macOS도 11.0 그대로라, 유니버설·macOS 12 앱에 넣어도 된다 |
| EmbeddingGemma 2 q4·int8 | 둘 다 CPU에서 돈다. 예문으로 비교한 유사도가 q4와 int8에서 거의 같다(0.773 대 0.775) |

### 7.2 속도와 메모리 (CPU, 스레드 기본값)
| 조건 | 조각 1개 | 질의 1개 | 조각 100개 | 최대 메모리 |
|---|---|---|---|---|
| int8, 4개씩 묶음 | 62ms | 45ms | 5.0초(초당 20개) | 0.9GB |
| int8, 16개씩 묶음 | 78ms | 61ms | 6.2초(초당 16개) | 1.5GB |
| int8, 32개씩 묶음 | 64ms | 49ms | 6.8초(초당 15개) | 2.3GB |
| int8, 1개씩, arena 끔 | 68ms | 50ms | 7.9초(초당 13개) | 0.8GB |
| int8, 16개씩, 스레드 2개 | 86ms | 80ms | 7.3초(초당 14개) | 1.5GB |
| q4, 16개씩 묶음 | 39ms | 17ms | 15.5초(초당 6개) | 1.3GB |
| int8 텍스트 전용, Core ML | 179ms | 101ms | 21.1초(초당 5개) | 5.1GB |

- 실제 기록 약 30일 치(수천 조각, 조각 중간값 275자)를 길이순으로 4개씩 묶어 색인했다. 초당 18.5조각, 최대 메모리 0.71GB, DB는 768차원 f32 기준 약 26MB였다.
- ONNX Runtime의 메모리 미리 잡기(arena)를 끄면 오히려 최대 메모리가 늘었다.
- 결론: int8, 4개씩 묶음, 길이순 정렬, 도우미 프로세스에서 스레드 2개.

### 7.3 전수 검색 (256차원)
| 개수 | f32 | int8 |
|---|---|---|
| 10만 | 7.3ms (102MB) | 0.3ms (26MB) |
| 100만 | 135ms (1GB) | 17ms (256MB) |

별도 벡터 DB(sqlite-vec 등) 없이 충분하다.

### 7.4 검색 정확도 (질의 30개, 턴 단위)
질의는 무작위로 뽑은 과거 턴을 보고, 나중에 찾을 때처럼 짧게 다시 쓴 것이다. 의미형 21개(원문 단어를 피함)와 키워드형 9개(오류 코드·파일명·명령)로 나눴다. 정답은 그 턴 하나다(엄격).

| 방법 | 1위 | 3위 안 | 5위 안 | 10위 안 | MRR@10 |
|---|---|---|---|---|---|
| 키워드만 (FTS5 trigram + 짧은 낱말 LIKE) | 15 | 17 | 21 | 23 | 0.58 |
| 벡터 768 f32 | **24** | **28** | 29 | 30 | **0.87** |
| 벡터 256 f32 | 23 | 27 | 28 | 29 | 0.84 |
| 벡터 256 int8 | 23 | 27 | 29 | 29 | 0.84 |
| RRF 같은 비중 (키워드 + 256 int8) | 19 | 27 | 29 | 29 | 0.77 |
| RRF 키워드 0.3 | 21 | 28 | 29 | 29 | 0.82 |
| RRF 식별자 있을 때만 | 21 | 28 | 29 | 29 | 0.81 |

- 의미형 21개만 보면 키워드는 1위 7개, 벡터 768은 15개였다. 키워드형 9개는 벡터도 9개 모두 1위였다(코드·식별자에 강한 모델).
- 정답을 같은 세션의 앞 1턴~뒤 2턴까지 넓혀도(느슨) 순서는 같았다. 벡터 768이 1위 25개, 3위 안 29개였다.
- 한계
  - 질의를 정답을 보고 썼다(찾으려는 것을 아는 검색). 실제보다 좋게 나올 수 있다.
  - 30개는 적다.
  - 기록이 많아지면(수만 조각) 비슷한 조각이 늘어 정확도가 떨어질 수 있다.
  - 키워드 검색 구현이 단순하다(OR 묶음).

### 7.5 주입 경로
| 항목 | 결과 |
|---|---|
| 대화형 Claude + `--settings` SessionStart 훅, 믿는 폴더 | 훅이 실행됐다 |
| 대화형 Claude + 같은 훅, 처음 보는 폴더 | 폴더 신뢰 창이 먼저 뜨고, 수락 전에는 훅이 실행되지 않았다(바람직) |
| 위 두 시험의 부작용 | 프롬프트를 보내지 않아 세션 기록 파일이 생기지 않았다. 모델 호출도 없었다 |
| Codex TUI + `-c developer_instructions` | 미확인. 가짜 터미널이 색 질의에 답하지 않아 화면이 뜨지 않았다. 확인하려면 모델 호출이 필요하다. 첫 프롬프트에 붙이는 방법은 앱이 이미 쓰는 방식이라 확실하다 |

### 7.6 새로 알게 된 것
- **비밀값 가리기 빈틈**: `sk-…`·`AKIA…` 같은 키 형식만으로는 부족하다. 실제 기록에서 DB 접속 주소(`scheme://사용자:비밀번호@호스트`) 속 비밀번호가 그대로 남았다. URL 자격 증명 패턴을 PoC 스크립트에 더했다. 실제 구현은 gitleaks 규칙 묶음 수준으로 넓혀야 한다.
- 실제 기록의 AI 답에는 영어 혼잣말("Now I'll …")이 섞여 있어서, 그런 조각은 검색에 잘 안 걸린다. 마지막 보고 문단을 우선하는 게 낫다.

## 8. 아직 모르는 것
- Codex `-c hooks`가 신뢰 검토로 건너뛴 것인지, 지원하지 않는 것인지
- Codex TUI에서 `-c developer_instructions`가 적용되는지
- `codex resume`이 기록 전체를 다시 보내는지
- 재정렬 모델의 20~50쌍 시간(2차에서 잴 것)
- 기록이 수만 조각일 때의 정확도, 벡터 점수만으로 "관련 없음"을 가를 문턱값이 있는지(지금 미리 고르는 문턱 0.82 는 데모·PoC 몇 건으로 정한 임시값)
- macOS 14 Intel·macOS 13 Apple Silicon 맥에서 기능이 제대로 막히는지(실기기 필요)

## 9. 출처
- Claude Code: [hooks](https://code.claude.com/docs/en/hooks), [settings](https://code.claude.com/docs/en/settings), [cli-reference](https://code.claude.com/docs/en/cli-reference), [mcp](https://code.claude.com/docs/en/mcp), [sessions](https://code.claude.com/docs/en/sessions), [memory](https://code.claude.com/docs/en/memory)
- Codex: [hooks](https://learn.chatgpt.com/docs/hooks), [MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [config-reference](https://learn.chatgpt.com/docs/config-file/config-reference), [memories](https://learn.chatgpt.com/docs/customization/memories)
- ONNX Runtime: [ort load-dynamic](https://ort.pyke.io/setup/linking), x86_64 중단 — [ort-sys dist.tsv](https://docs.rs/crate/ort-sys/latest/source/build/download/dist.tsv), [onnxruntime 1.24.1](https://newreleases.io/project/pypi/onnxruntime/release/1.24.1)
- 런타임 속도 비교: [rust-embedding-bench](https://github.com/jerrythomas/rust-embedding-bench)
- 한국어 점수: [KURE](https://github.com/nlpai-lab/KURE), [재정렬 결과](https://github.com/nlpai-lab/KURE/blob/main/eval/cross-encoder/results/README.md)
- 모델: [EmbeddingGemma-300m](https://huggingface.co/google/embeddinggemma-300m), [GGUF](https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF), [EmbeddingGemma 2 ONNX](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), [bge-reranker-v2-m3 GGUF](https://huggingface.co/gpustack/bge-reranker-v2-m3-GGUF), [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B)
- 하이브리드·재정렬 효과: [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval), [BGE-M3 논문](https://arxiv.org/abs/2402.03216), [RRF](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf), [LongMemEval](https://arxiv.org/abs/2410.10813)
- 저장: [sqlite-vec releases](https://github.com/asg017/sqlite-vec/releases), [FTS5](https://www.sqlite.org/fts5.html)
- 토큰 절감 근거(분야가 달라 참고만): [Mem0](https://arxiv.org/abs/2504.19413), [Anthropic context management](https://www.anthropic.com/news/context-management)
- 유사 도구: [claude-mem](https://github.com/thedotmack/claude-mem), [episodic-memory](https://github.com/obra/episodic-memory), [OpenMemory](https://docs.mem0.ai/openmemory), [Basic Memory](https://github.com/basicmachines-co/basic-memory)
- 보안: [gitleaks](https://github.com/gitleaks/gitleaks), [OWASP LLM08](https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/), [MINJA](https://arxiv.org/abs/2503.03704)
