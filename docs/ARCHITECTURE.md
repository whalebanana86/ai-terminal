# AI Terminal — 아키텍처와 데이터 모델

> 이 문서는 구현 전에 작성한 설계이고, 구현하면서 바뀐 점은 각 절의 "변경" 메모로 남긴다.

## 1. 목표 한 줄

AI 코딩 에이전트(Claude Code, Codex)의 **대화 세션**을 중심에 두고, 그 세션이 실제로 일하는
**Repository → Worktree → Branch/HEAD** 와 **파일**을 세 패널에서 동시에, 정확하게 보여 준다.

## 2. 요구사항 분류

### P0 — MVP 에 반드시 들어가고 검증까지 끝나야 하는 것
| 영역 | 기능 |
|---|---|
| 레이아웃 | 3패널(각 33%) 드래그 조절, 크기 기억 |
| Git | 저장소 열기(비공개 포함, 로컬 경로 기준), 워크트리 목록, HEAD/브랜치, 커밋 그래프(레인), 커밋 상세, 변경 파일 상태, Fetch/Pull(ff-only)/Push/Commit, 명시적 Checkout(확인창) |
| 세션 | Claude/Codex 외부 세션 발견, 저장소·워크트리 연결, 기록 보기, 재개(PTY), 새 세션 시작(PTY), 여러 세션 전환(프로세스 유지), 에이전트가 건드린 파일 목록 |
| 동기화 | 세션 선택 → Git 패널과 파일 탐색기가 그 워크트리로 이동(체크아웃 없음), 시작 브랜치 ≠ 현재 브랜치 표시 |
| 실시간 | 파일 변경 감지(FSEvents) → 탐색기·상태·diff 갱신, .git 변경 → 그래프·HEAD 갱신, 세션 파일 변경 → 세션 목록 갱신 |
| 파일 | 트리 탐색, 코드 미리보기, 수정/추가/삭제 표시, diff |
| 보존 | 저장소 목록·세션 연결·실행 이력·선택 상태를 SQLite 에 저장, 재시작 시 복원 |
| 안전 | 조회 때문에 Git 상태를 바꾸지 않음, 위험 작업 사전 확인, 외부 전송 없음 |
| 배포 | macOS(Apple Silicon) .app/.dmg 빌드, README, MIT |

### P1 — 핵심 검증 뒤
자체 채팅 UI(stream-json 기반), 워크트리 생성/삭제, 브랜치 생성, 스테이징 일부(hunk) 선택, stash,
외부에서 실행 중인 에이전트 프로세스 감지(lsof), 그래프 페이지네이션, 검색, 설정 화면 확장.

### P2
Merge/Rebase UI, AI PR 작성, 에이전트 활동 타임라인 시각화, 다중 창, 테마 커스터마이즈, 자동 업데이트, 코드 서명/공증.

## 3. 도메인 모델

```
Repository 1 ──< Worktree (live: git worktree list)
    │                 │
    │                 └── HEAD: branch | detached sha
    │
    └──< AgentSession ──< AgentExecution
             │ (대화 정체성)     (프로세스 1회 실행)
             └─ recorded: cwd, startBranch, lastRecordedBranch (CLI 가 기록한 과거 값)
```

### Repository
- **정체성 = 정규화한 `git rev-parse --git-common-dir` 절대 경로.** 같은 저장소의 워크트리들은
  common dir 이 같으므로 하나의 Repository 로 묶인다. 이름은 메인 워크트리 폴더 이름.
- 사용자가 직접 추가한 것(`pinned`)과 세션에서 발견된 것(`discovered`)을 구분한다.

### Worktree (저장하지 않는 실시간 값)
- `git worktree list --porcelain` 이 유일한 진실. `path`, `head`, `branch | null(detached)`,
  `isMain`, `locked`, `prunable`, `bare`.
- 앱은 워크트리 정보를 캐시만 하고, 표시할 때마다 Git 에서 다시 읽는다.

### AgentSession (대화)
| 필드 | 뜻 |
|---|---|
| `id` | `claude:<uuid>` / `codex:<uuid>` |
| `agent` | `claude` \| `codex` |
| `externalId` | CLI 가 쓰는 세션 id (재개에 사용) |
| `cwd` | CLI 가 기록한 작업 폴더 (재개할 때 이 폴더에서 실행해야 함) |
| `worktreePath` | `cwd` 를 `git rev-parse --show-toplevel` 로 올린 값. cwd 가 사라지면 `null` + `missing` |
| `repoId` | 위 워크트리의 common dir |
| `startBranch` | 세션 **시작 시** CLI 가 기록한 브랜치 (Claude 첫 레코드 `gitBranch`, Codex `session_meta.git.branch`) |
| `lastRecordedBranch` | 세션 **마지막 기록**의 브랜치 (Claude 는 레코드마다 기록, Codex 는 thread.git_branch) |
| `title`, `createdAt`, `updatedAt`, `sourcePath`, `origin(external|app)` | |

**세 가지 브랜치를 절대 섞지 않는다**: 시작(과거 기록) / 마지막 기록(과거 기록) / 현재(Git 실시간).
UI 는 셋이 다르면 경고 배지를 띄운다. 어떤 값도 체크아웃의 근거로 쓰지 않는다.

### AgentExecution (프로세스 1회)
| 필드 | 뜻 |
|---|---|
| `id` | uuid |
| `sessionId` | 연결된 세션 (Codex 새 세션은 시작 직후 미정 → 발견되면 채움) |
| `kind` | `new` \| `resume` |
| `argv`, `cwd` | 실제 실행한 명령 |
| `branchAtStart`, `headAtStart` | 실행 순간 Git 에서 읽은 값 |
| `startedAt`, `endedAt`, `exitCode`, `pid` | |

하나의 세션은 여러 번 실행(재개)될 수 있으므로 1:N. 실행 중인 PTY 는 Rust 쪽 `PtyManager` 가 소유하고
화면 전환과 무관하게 계속 돈다. 출력은 실행별 링버퍼(2MB)에 쌓여 다시 붙을 때 재생된다.

### Workspace 포커스 (UI 상태)
`selectedSessionId` → `focus = { repoId, worktreePath }`.
- 세션을 고르면 focus 가 그 세션의 `worktreePath` 로 바뀌고, Git 패널·파일 탐색기가 같은 focus 를 구독한다.
- 세션 없이 저장소/워크트리를 직접 고를 수도 있다.
- focus 변경은 **읽기만** 한다. checkout, reset, stash 등 쓰기 작업은 사용자가 버튼을 누르고 확인해야만 실행된다.

## 4. 프로세스 구조

```
┌──────── WebView (React + TS) ────────┐        ┌──────────── Rust (Tauri) ────────────┐
│ GitPanel   AgentPanel   FilePanel    │ invoke │ git::*      git CLI 래퍼(porcelain)   │
│   │           │ xterm.js   │         │ ─────▶ │ graph::*    레인 계산(순수 함수)      │
│   └──── zustand store (focus) ───────│        │ sessions::* Claude/Codex 색인         │
│                                      │ ◀───── │ pty::*      portable-pty + 링버퍼     │
│        Channel(바이트) / 이벤트       │        │ watch::*    notify(FSEvents) 디바운스 │
└──────────────────────────────────────┘        │ db::*       rusqlite(bundled)         │
                                                │ env::*      로그인 셸 환경 가져오기    │
                                                └───────────────────────────────────────┘
```

## 5. 아키텍처 결정 (ADR 요약)

| # | 결정 | 근거 | 버린 대안 |
|---|---|---|---|
| 1 | **Git 은 CLI 만 호출** | 사용자의 `~/.ssh/config`, credential helper, 키체인, fsmonitor 를 그대로 씀 → 비공개 저장소 제한 없음. 결과가 "실제 Git CLI 결과와 일치"해야 하는 인수 기준과 같은 출처 | git2-rs: ssh config 무시, 인증 직접 구현 필요. 성능 이슈가 생기면 읽기 전용으로만 도입 |
| 2 | **커밋 그래프 레인 계산은 Rust 에서 직접 구현** | 재사용 가능한 라이브러리가 없음(@gitgraph 아카이브, vscode-git-graph 재배포 금지 조항, gitamine GPL). 순수 함수라 단위 테스트 쉬움 | 프런트에서 계산: 테스트·성능 불리 |
| 3 | **PTY 로 원본 CLI 실행** | 인증·구독·권한 승인 UI·슬래시 명령까지 100% 호환. 승인 요청은 CLI 화면 그대로 보임 | stream-json 자체 채팅: P1 |
| 4 | portable-pty 직접 사용 + `tauri::ipc::Channel` 스트리밍 | Tauri 문서가 대용량 스트림은 Channel 권장. tauri-plugin-pty 는 JS 폴링 방식 | tauri-plugin-pty |
| 5 | rusqlite(bundled), DB 는 Rust 만 접근 | 색인·감시 로직이 Rust 에 있음. 프런트에 SQL 권한을 열지 않음 | tauri-plugin-sql |
| 6 | 세션 기록은 **읽기 전용**으로만 접근 | Claude/Codex 의 원본 기록을 앱이 손상시키면 안 됨. Codex sqlite 는 `mode=ro` | 원본 복사/수정 |
| 7 | 외부 CLI 실행 환경 = 로그인 셸에서 읽은 환경변수 | Finder 에서 연 앱은 PATH 가 `/usr/bin:/bin` 뿐이라 volta/brew 의 claude·codex 를 못 찾음 | 셸을 매번 `-ilc` 로 감싸 실행: rc 출력이 PTY 에 섞임 |
| 8 | 파일 감시: notify 8 + debouncer-full 0.7 (FSEvents) | 외부 에디터·에이전트 수정 모두 잡힘. `.git` 변경은 별도 신호로 분리 | 폴링 |
| 9 | diff 는 `git diff` 출력을 그대로 파싱해 렌더 | "Diff 가 실제 변경과 일치" 기준을 Git 자체 출력으로 보장 | JS diff 라이브러리 재계산 |
| 10 | 네트워크 요청 없음, CSP 로 외부 연결 차단 | 비공개 코드·대화 보호. Git 원격 작업과 CLI 자체 통신만 예외 | — |

## 6. 세션 발견 규칙

### Claude Code
- `~/.claude/projects/*/<uuid>.jsonl` (하위 폴더의 subagent 기록은 제외).
- 폴더 이름은 경로를 `-` 로 바꾼 것이라 원래 경로로 되돌릴 수 없다 → **레코드의 `cwd` 필드**를 읽는다.
- 머리(앞부분): 첫 `cwd`, 첫 `gitBranch`, 생성 시각, 첫 사용자 메시지(명령/메타/첨부 제외).
- 꼬리(뒤 256KB): 마지막 `gitBranch`, 마지막 시각, 마지막 `ai-title`/`custom-title`.
- `(경로, 크기, mtime)` 가 같으면 다시 읽지 않는다(색인 캐시).
- 재개: `cwd` 에서 `claude --resume <uuid>`. 새 세션: `claude --session-id <미리 만든 uuid>` → 실행 즉시 세션과 연결.

### Codex
- `~/.codex/state_*.sqlite`(가장 큰 번호) `threads` 테이블을 읽기 전용으로 조회:
  `id, rollout_path, cwd, title, git_branch, created_at, updated_at, archived, source`.
- `rollout_path` 는 `.jsonl` 로 적혀 있어도 실제로는 `.jsonl.zst` 일 수 있다 → 둘 다 시도.
- sqlite 가 없으면 `~/.codex/sessions/**/rollout-*.jsonl[.zst]` 의 첫 줄 `session_meta` 로 대체.
- 재개: `codex resume <id> -C <cwd>`. 새 세션은 id 를 미리 정할 수 없으므로 실행 후
  같은 cwd·시작 시각 이후에 생긴 스레드를 찾아 실행과 연결한다.

## 7. 실시간 갱신 경로

1. `watch` 가 focus 워크트리와 실행 중인 워크트리를 감시(재귀).
2. 이벤트 경로가 `.git` 디렉터리(링크 워크트리는 `.git/worktrees/<name>` 포함) 안이면 `git-changed`,
   아니면 `fs-changed{paths}` 를 300ms 디바운스로 보낸다.
3. 프런트는 `fs-changed` → 상태·열린 폴더·열린 파일 갱신, `git-changed` → HEAD·워크트리·그래프 갱신.
4. 세션 디렉터리(`~/.claude/projects`, `~/.codex/sessions`, state sqlite) 감시 → `sessions-changed`.

## 8. 테스트 전략

- **단위(Rust)**: 레인 계산, porcelain 파서(status v2, worktree, log), Claude/Codex 레코드 파서, cwd→worktree 해석.
- **통합(Rust)**: 임시 저장소 + 워크트리 2개를 실제 git 으로 만들고 앱 함수 결과를 git CLI 결과와 대조.
  가짜 HOME 에 Claude/Codex 기록을 만들어 발견·연결·브랜치 구분을 검증.
- **수동 E2E**: 실제 CLI 로 외부 세션 생성 → 앱에서 발견·재개·맥락 확인. 결과는 `docs/TEST_REPORT.md`.

## 9. 구현하면서 바뀐 점 (변경 기록)

- **세션 연결은 마지막 cwd 기준**: Claude 세션은 대화 도중 다른 폴더/워크트리로 옮겨 갈 수 있다. 워크트리 연결과 "현재 브랜치"는 마지막 기록의 cwd 로, 재개는 첫 cwd(Claude 가 기록을 저장한 프로젝트 폴더)에서 한다. 옮겨 갔으면(`cwdMoved`) 시작 브랜치는 다른 워크트리의 값이라 불일치 비교에서 뺀다.
- **경로 별칭**: 기록의 경로가 `/tmp/x` 처럼 심볼릭 링크 형태이면 `worktreeAlias` 로 함께 내려 준다.
- **명령 인자 범위 검증**: Git·파일·Finder 명령은 앱이 아는 워크트리(등록·발견된 저장소의 워크트리, 세션 워크트리)와 그 하위만 받는다. 웹뷰가 뚫려도 임의 경로를 읽지 못하게 하는 2차 방어선.
- **파일 쓰기 잠금(변경 2026-10-22)**: 앱이 파일 내용을 쓰는 길은 확장 기능 "파일 편집"의 `fs_save` 하나뿐이고, 기능이 꺼져 있으면 Rust 가 거절한다. 기능 상태(kv `ext.*`)는 `extension_set` 으로만 바뀌고(화면의 `kv_set` 은 거절), 파일 편집은 켤 때 Rust 가 맥 확인창을 띄워 사람이 눌러야 켜진다. 저장은 불러올 때의 지문과 디스크가 같을 때만(다르면 사용자가 덮어쓰기를 골라야), 임시 파일 → rename, 권한·CRLF·BOM 유지.
- **부모 세션 환경변수 차단**: 에이전트 세션(Claude Code, Orca 등) 안에서 띄운 앱이 `CLAUDECODE`, `CLAUDE_CODE_*_SESSION*` 등을 물려주면 재개한 Claude 가 하위 세션으로 동작해 기록을 저장하지 않는다. 세션에 묶인 변수만 지운다.
- **Codex 새 실행 연결 규칙**: 실행 중 + 같은 cwd(정규화) + 시작 5초 전~10분 후 생성 + 아직 다른 실행과 연결되지 않은 스레드 중 가장 이른 것. 실행은 시작 순서대로 처리.
- **갱신 신호 분리**: `fsTick`(파일 내용·목록) / `statusTick`(git status) / `gitTick`(HEAD·refs → 그래프). 파일만 바뀌면 전체 log 를 다시 읽지 않는다. 세션·저장소 갱신은 합치고 최신 응답만 반영한다.
- **PTY 수명**: 종료 즉시 PTY 장치 반납, 끝난 실행은 최근 8개만 출력 재생용으로 보관. 중지·앱 종료는 프로세스 그룹 단위(SIGHUP → SIGKILL).
- **파일 감시**: 파일 id 캐시 없는 디바운서(감시 등록 때 하위 전체를 훑지 않음), 무시 폴더 목록 20초마다 갱신, 감시 루트의 inode 가 바뀌면 다시 등록.
- **Git 실행 고정 옵션**: `GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`(check-ignore 제외), `core.fsmonitor=false`, `diff.noprefix=false`, `diff.mnemonicPrefix=false`, `core.quotepath=false`, diff 는 `--no-ext-diff --no-textconv`.

## 10. 2차 작업에서 추가된 구조

- **채팅(`chat.rs`)**: 원본 CLI 를 JSON 모드로 실행하고 출력을 공통 `ChatEvent`(session/user/assistant/tool/permission/fileChange/turnEnd/error/exit)로 바꾼다. 화면은 `Channel` 로 받는다.
  - Claude: `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompts host --permission-prompt-tool stdio --permission-mode <모드> --resume <id>|--session-id <새 id>`. 시작 때 `initialize` 제어 요청을 보내면 도구 실행 전 `control_request(can_use_tool)` 가 오고, `control_response(allow|deny)` 로 답한다. 허용 시 입력은 요청 때 받은 원본만 쓴다.
  - Codex: 메시지마다 `codex exec --json -s <샌드박스> -C <cwd> -` / `codex exec resume --json -c sandbox_mode=… <id> -` (프롬프트는 표준입력).
  - 프로세스는 각 리더 스레드가 소유하고, 공유 상태는 턴 번호·pid·busy 만 갖는다(교착 방지).
- **실행 감지(`procs.rs`)**: libproc(`proc_listallpids`, `PROC_PIDTBSDINFO`, `proc_pidpath`, `PROC_PIDLISTFDS`+`PROC_PIDFDVNODEPATHINFO`, `PROC_PIDVNODEPATHINFO`)로 외부 프로그램 없이 읽는다. Claude 는 `~/.claude/sessions/<pid>.json`(세션 id·cwd·상태·시작 시각)과 대조, Codex 는 `~/.codex/thread-writer-locks/<thread>.lock` 을 연 프로세스. 앱이 띄운 pid 와 그 자손은 `ownedByApp`.
- **열기 규칙**: 한 대화는 한 곳에서만. 앱 안(터미널·채팅)은 막고, 외부 실행 중이면 `EXTERNAL_RUNNING` 오류 → 화면에서 확인 후 `force`. 열기 직전 감지를 새로 하고 열기 잠금으로 경쟁을 막는다.
- **Git 쓰기(`gitops.rs`)**: 브랜치·워크트리·hunk(`git apply --cached [-R]`, 지문으로 화면과 실제 일치 확인)·merge/rebase/continue/abort/skip·충돌 해결. 모든 git 은 `GIT_EDITOR=true`, `GIT_SEQUENCE_EDITOR=true` 로 편집기를 띄우지 않는다.
- **성능 원칙**: 자주 도는 경로는 외부 프로세스를 띄우지 않는다(HEAD 파일 직접 읽기, libproc). 같은 데이터면 화면 상태를 바꾸지 않는다. 무거운 화면 모듈(xterm, Shiki 언어)은 필요할 때 불러온다.
