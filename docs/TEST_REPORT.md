# 테스트 결과

- 수행일: 2026-10-21
- 환경: macOS 26.3 (25D125), Apple Silicon(arm64), git 2.50.1, Claude Code 2.1.305, Codex CLI 0.155.0, Rust 1.99.1, Node 20.19.5
- 방식: 실제 CLI 와 실제 Git 저장소로 수행했다. 화면 조작은 `automation` 기능 빌드의 원격 조작 소켓(`scripts/aiterm-eval.py`)으로 실제 버튼을 누르는 방식이다. 결과는 앱 화면(DOM, 터미널 버퍼)과 git CLI 출력을 대조해 판정했다.
- 외부 터미널: 앱과 무관한 `tmux` 세션에서 대화형 `claude` / `codex` 를 실행했다.

## 자동 테스트

| 묶음 | 개수 | 결과 |
|---|---|---|
| Rust 단위(파서·레인·세션 기록·DB·감시 분류·PTY·경로 안전·환경변수·셸 읽기·git 교착/리터럴 경로/이름변경 커밋) | 33 | 통과 |
| Rust 통합(실제 git 저장소 + 워크트리 + 가짜 HOME) | 7 | 통과 |
| 프런트 단위(vitest: 브랜치 상태, 세션·실행 합치기, 경로·별칭, 변경 표시, 경고 문구) | 11 | 통과 |
| 앱 회귀 스크립트 `scripts/e2e/regression.sh` (실행 중인 앱 + 새 테스트 저장소, CLI 토큰 불필요) | 20 | 통과 |

실행: `pnpm check` (tsc + vitest + cargo test), 앱 회귀는 automation 빌드를 띄운 뒤 `scripts/e2e/regression.sh`.

통합 테스트 목록 (`src-tauri/src/core.rs`)
- `sessions_link_to_their_own_worktree_and_branches_stay_separate`: Claude 세션(워크트리 하위 폴더 cwd)과 Codex 세션(.zst)이 같은 저장소의 서로 다른 워크트리로 연결된다. 외부 브랜치 변경 뒤 "현재"만 바뀌고 "시작"은 유지된다. 조회 후 HEAD 가 그대로다. 워크트리를 지운 뒤에도 저장된 연결로 표시된다.
- `graph_matches_git_cli`: 그래프 행 순서가 `git log --topo-order --branches --remotes --tags` 와 같다. detached HEAD 커밋도 나온다.
- `status_and_diff_match_real_changes`: 상태·diff 가 실제 변경과 같고, 조회가 index 를 바꾸지 않는다.
- `checkout_refuses_branch_used_by_other_worktree`
- `commit_only_selected_paths`
- `resume_uses_recorded_cwd_and_codex_new_links_later`: 재개 인자(`--resume <id>`)와 작업 폴더가 정확하다. Codex 새 실행이 나중에 생긴 스레드와 연결되고, 같은 폴더의 두 번째 실행이 첫 실행의 스레드를 가져가지 않는다.
- `alias_for_symlinked_tmp_and_moved_cwd`: `/tmp`↔`/private/tmp` 경로 별칭, 대화 도중 다른 워크트리로 옮긴 세션은 지금 일하는 워크트리에 연결되고 재개는 첫 cwd 로 한다.

## 인수 테스트 (실제 CLI)

테스트 저장소: `/private/tmp/aiterm-e2e/` — `origin.git`(bare, 비공개 원격 역할), `demo`(main), `demo-claude`(feature/agent-a), `demo-codex`(feature/agent-b), 머지 커밋 포함.

| 테스트 | 결과 | 근거 |
|---|---|---|
| **A. Git 인식** | 통과 | 저장소 추가 후 워크트리 3개의 경로·브랜치·HEAD 가 `git worktree list` 와 같다. 그래프 4행(머지 + 갈라진 커밋)의 순서와 배지가 `git log --graph --all` 과 같다. |
| **B. Claude 외부 세션** | 통과 | tmux 에서 `claude` 를 실행해 암호 단어 "파란고래-42" 를 알려 주고 종료했다. 앱이 세션을 찾아 저장소 demo / 워크트리 demo-claude / 시작 브랜치 feature/agent-a 로 연결했고 기록 2개를 표시했다. 재개 버튼(`claude --resume`) 뒤 "암호 단어를 말해 줘" 에 **"파란고래-42"** 로 답했다. |
| **C. Codex 외부 세션** | 통과 | 같은 방식으로 "초록여우-77" 을 알려 줬다. 앱이 `~/.codex/state_5.sqlite` + rollout 에서 찾아 demo-codex / feature/agent-b 로 연결했고, `codex resume <id> -C <cwd>` 재개 후 **"초록여우-77"** 로 답했다. 재개 뒤 나눈 대화도 원본 기록에 저장되어 앱의 기록 탭에 나타났다. |
| **D. 세 패널 동기화** | 통과 | Claude 세션을 고르면 Git 패널은 feature/agent-a, 파일 트리는 demo-claude(notes/ 포함)를 보여 준다. Codex 세션을 고르면 feature/agent-b, demo-codex(divide.ts 포함)로 함께 바뀐다. 전환 전후 세 워크트리의 `HEAD` 가 같다(체크아웃 없음). |
| **E. 파일 변경** | 통과 | 에이전트가 `src/math.ts` 를 수정하고 `notes/todo.md` 를 만들자 트리에 새 폴더와 변경 점, 변경 수 2 가 나타났다(`git status` 와 같음). diff 줄이 `git diff HEAD` 와 글자 단위로 같다. 외부 에디터 방식(임시 파일 → rename)으로 고친 내용도 열린 diff 와 README 의 M 표시로 자동 반영됐다. |
| **F. 브랜치 변경·위험 작업** | 통과 | Claude 실행 중 외부에서 `git switch -c feature/agent-a-v2` 를 하자, 목록·헤더·Git 패널이 "시작 feature/agent-a / 지금 feature/agent-a-v2" 로 구분하고 경고 배너를 띄웠다. 그래프에서 시작 브랜치에 ◷ 를 표시한다. 변경이 있는 워크트리에서 체크아웃하면 위험 확인창(변경 3개, 실행 중 에이전트 1개 명시, 기본 포커스는 취소)이 뜨고, 취소하면 아무것도 바뀌지 않는다. 다른 워크트리가 쓰는 `main` 은 실행 전에 막힌다. |
| **G. 병렬 작업** | 통과 | Claude(demo-claude)와 Codex(demo-codex)를 동시에 실행했다. Codex 에 파일 생성을 시키고 곧바로 Claude 세션으로 전환해도 Codex 가 작업을 끝냈다("완료"). 두 워크트리의 변경은 서로 섞이지 않았다. |
| **H. macOS 실행** | 통과 | `pnpm tauri build` 로 `.app`(arm64, 8.5MB)과 `.dmg`(5.0MB)를 만들었다. `open` 으로 실행(부모 launchd)해도 claude·codex·git 을 찾고, 저장소 목록·선택 세션·보던 워크트리가 복원됐다. 앱 프로세스에 네트워크 소켓이 없다(`lsof -i`). 배포 바이너리에 원격 조작 소켓 코드가 없다. |

추가로 확인한 것
- 기본 Git 작업(UI): 파일 선택 커밋 → Push(추적 없음 → `-u origin` 확인창) → Fetch → (다른 클론에서 원격을 앞서게 만든 뒤) Pull `↓1` → ff-only 로 받아옴. 모두 CLI 결과와 같다.
- 앱에서 새 Claude 세션: `--session-id` 로 시작하자마자 세션과 연결되고, 첫 응답 뒤 실제 세션(제목 자동)으로 바뀐다.
- 실제 사용자 기록: 세션 57개 목록 83ms(캐시), 310MB 짜리 기록을 2.0초(디버그 빌드)에 열었다.

## 리뷰 반영 후 재검증 (최종 코드)

독립 리뷰 2건(정확성 / 보안·macOS)의 지적을 반영한 뒤 같은 시나리오를 다시 돌렸다. 판정 스크립트(`scripts/e2e/resume-check.js`)는 **이번에 보낸 질문 뒤의 답만** 인정하도록 엄격하게 바꿨다(처음 판정 방식은 화면에 남은 이전 답을 정답으로 잘못 셀 수 있었다).

| 시나리오 | 결과 | 근거 |
|---|---|---|
| Claude 외부 세션 재개 | 통과 | 질문 1→2개, 새 실행이 "파란고래-42" 응답. 세 패널 = demo-claude / feature/agent-a-v2, 헤더 "시작 feature/agent-a · 마지막 feature/agent-a-v2 · 지금 feature/agent-a-v2" |
| Codex 외부 세션 재개 | 통과 | tmux 에서 새로 만든 세션("보라토끼-19"). 질문 2→3개, 새 실행이 정답 응답. 세 패널 = demo-codex / feature/agent-b |
| 앱에서 새 Claude / Codex 세션 | 통과 | Claude 는 `--session-id` 로 즉시 연결, Codex 는 첫 응답 뒤 스레드와 자동 연결되고 선택도 옮겨 감 |
| 앱 종료 시 정리 | 통과 | Claude·Codex 실행 중 정상 종료 → 남은 에이전트 프로세스 0개(손자 포함). `tauri dev` 강제 재시작 때도 0개 |
| 배포 빌드(H) | 통과 | `open` 실행, 부모 launchd, claude·codex·git 찾음, 저장소·선택 세션·워크트리 복원, 네트워크 소켓 0, 자동화 코드 미포함 |

## 리뷰로 찾아 고친 문제

| 심각도 | 문제 | 고친 방법 |
|---|---|---|
| 높음 | 큰 `.gitignore` 폴더를 펼치면 `git check-ignore` 와 서로 기다려 영구 정지 | 표준입력 쓰기를 별도 스레드로. 3만 경로 회귀 테스트 |
| 높음 | 파일명 `app/[id]/page.tsx` 를 커밋하면 `app/i/page.tsx` 까지 커밋(glob 해석) | `GIT_LITERAL_PATHSPECS=1` (check-ignore 만 예외 — 리터럴 모드를 지원하지 않음을 회귀 테스트로 발견) |
| 높음 | `git mv` 한 파일·추가 후 삭제(AD) 파일이 있으면 커밋 전체 실패 | 디스크/인덱스/HEAD 에 있는 경로만 골라 add·commit. 회귀 테스트 |
| 높음 | 같은 폴더의 새 Codex 실행 두 개가 같은 스레드에 연결, 끝난 실행이 며칠 뒤 외부 세션과 연결 | 실행 중인 것만, 시작 순서대로, 10분 창 안에서, 이미 연결된 스레드 제외 |
| 높음 | 대화 도중 cwd 를 옮긴 Claude 세션이 첫 폴더(엉뚱한 저장소)에 연결 | 마지막 cwd 로 워크트리 연결, 재개는 첫 cwd. 옮겼으면 시작 브랜치 비교 안 함 |
| 높음 | 감시를 걸 때 워크트리 전체를 심볼릭 링크까지 따라가며 훑음(홈을 가리키는 링크가 있으면 홈 전체) | 파일 id 캐시 없는 디바운서. 등록은 별도 스레드 |
| 중간 | 웹뷰가 아무 경로나 `fs_read`/`git_*` 에 넘길 수 있음 | 등록·발견된 저장소의 워크트리(또는 그 하위)만 허용. 앱 회귀 스크립트로 `/etc/hosts`, 홈, `../` 거부 확인. 쓰지 않는 opener 권한 제거 |
| 중간 | `.git/config` 의 `core.fsmonitor`·`textconv` 명령이 조회만으로 실행 | `-c core.fsmonitor=false`, diff 에 `--no-textconv` |
| 중간 | 끝난 실행의 PTY·버퍼·xterm 이 계속 쌓임 | 종료 즉시 PTY 반납, 끝난 실행 8개만 보관, 보이지 않는 끝난 터미널은 그리지 않음 |
| 중간 | 중지/종료가 리더 프로세스에만 신호 → 에이전트가 띄운 개발 서버가 남을 수 있음 | 프로세스 그룹에 SIGHUP → 유예 후 SIGKILL. 손자 프로세스 회귀 테스트 |
| 중간 | 로그인 셸 출력이 64KB 를 넘거나 `.zshrc` 가 `exec tmux` 하면 환경 읽기 실패 → CLI 를 못 찾음 | 출력 별도 읽기, `-l` 만으로 재시도, 흔한 설치 경로를 PATH 끝에 추가, csh 대응 |
| 중간 | 커밋에도 30초 제한 → 느린 pre-commit 훅이 강제 종료 | 커밋은 15분 |
| 중간 | 파일만 바뀌어도 전체 `git log` 를 250ms 마다 다시 실행, 세션 목록 갱신이 겹쳐 돎 | status 와 그래프 신호 분리, 갱신 합치기와 최신 응답만 반영 |
| 중간 | 큰 기록을 1초마다 처음부터 다시 파싱 | 최소 3초 간격 |
| 낮음 | 중첩 저장소(`dir/`)를 커밋하면 gitlink 가 생김 | 커밋 대상에서 제외하고 표시 |
| 낮음 | 공백으로 시작하는 파일명, `"`·탭이 든 diff 경로, 사용자 `diff.noprefix` 설정 | 파서 수정·C 따옴표 해제·설정 고정 |
| 낮음 | 레인 14개 초과 시 마지막 레인에 겹쳐 그림 | 넘치는 레인은 그리지 않고 › 표시 |
| 낮음 | 세션 파일 이름(id)이 `-` 로 시작하면 CLI 옵션으로 해석 가능 | id 형식 검증. 테스트용 환경변수는 디버그 빌드에서만 |
| 낮음 | `/tmp/...` 로 기록된 경로가 `/private/tmp` 워크트리 밖으로 보임 | 기록 형태의 워크트리 별칭을 함께 비교 |
| 발견 | 지웠다 같은 경로에 다시 만든 저장소를 보면 그래프가 빈 채로 남음 | 같은 워크트리 재선택 시 다시 읽기, 감시 대상 inode 가 바뀌면 다시 등록(회귀 스크립트) |

## 테스트 중 발견해 고친 문제

1. **부모 세션 환경변수 누출 (심각)**: 에이전트 세션 안에서 띄운 앱(또는 그런 셸에서 `open` 한 앱)이 `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` 등을 자식에게 물려줬다. 그 결과 재개한 Claude 가 "Transcript saving is off" 상태가 되어 대화가 저장되지 않았다. 세션에 묶인 변수만 걸러 내도록 고쳤다(`env.rs`, 테스트 포함). `open` 으로 연 릴리스 앱에도 이 변수가 들어오는 것을 확인했다.
2. 저장소가 아닌 폴더에서 Claude 가 `gitBranch: "HEAD"` 로 기록 → 브랜치처럼 보이던 문제.
3. Git 저장소가 아닌 cwd 의 판정을 캐시하지 않아 목록 갱신이 느리던 문제(432ms → 68ms).
4. 그래프 레인: 첫 부모가 다른 레인으로 합류하면 메인 줄기가 오른쪽으로 밀리던 문제.
5. 한 커밋에 배지가 많으면 커밋 제목이 가려지던 문제.

## 테스트 중 사고와 조치

- Codex 재개 화면의 **업데이트 안내**에 스크립트가 화면 확인 없이 Enter 를 보내 기본값 "Update now" 가 눌렸다. `npm install -g @openai/codex` 가 실행되어 Volta 의 Node 폴더에 쓰이지 않는 Codex 0.163.0 사본(`~/.volta/tools/image/node/20.19.5/lib/node_modules/@openai`, `.../bin/codex`, 08:52 생성)이 설치됐다. 실제로 쓰이는 Volta 관리 Codex 는 0.155.0 그대로였고, 새로 생긴 두 경로만 지워 원래 상태로 되돌렸다. 이후 스크립트는 입력 전에 화면을 확인하고 "Skip" 에 커서가 있는지 검사한 뒤에만 Enter 를 보낸다.
- 처음 Codex 재검증에서 "open in another app" 으로 재개가 거부됐다. Codex 로그(`~/.codex/logs_2.sqlite`, 읽기 전용 조회)로 보니 상주 중인 **Codex Desktop(ChatGPT 앱)** 이 09:18 에 그 대화를 열어 쓰기 권한을 갖고 있었다(`thread-store conflict: already has an active writer`). 앱 버그가 아니라 Codex 의 동시 쓰기 보호이며, 앱은 CLI 의 안내를 그대로 보여 준다. 사용자 앱은 건드리지 않고 새 외부 세션으로 재검증했다.

## 한계 / 수동 확인이 남은 것

- 폴더 선택 대화상자(+ 저장소, 다른 폴더…)는 자동화할 수 없어 같은 백엔드 명령(`repo_add`)을 호출해 검증했다.
- 인수 테스트는 이 맥 1대에서만 했다. 다른 macOS 버전, Intel, fish/bash 로그인 셸은 검증하지 않았다.
- 서명이 ad-hoc 이라 다른 맥에서는 Gatekeeper 경고가 나온다.
- 외부 터미널에서 **지금 실행 중인** 세션을 확실히 알아내지는 못한다(최근 기록 시각으로 추정). 같은 세션을 외부와 앱에서 동시에 재개하는 것은 막지 못한다.
- 터미널의 한글은 대체 글꼴 폭 때문에 글자 사이가 넓게 보인다(동작에는 문제 없음).
- 같은 Codex 대화를 Codex Desktop 등 다른 앱이 열고 있으면 재개할 수 없다(Codex 가 막음). 앱이 미리 알려 주지는 않는다.
- "작업한 파일" 은 기록의 Edit/Write/NotebookEdit(Claude)·apply_patch(Codex) 도구만 본다. 에이전트가 `printf >>` 같은 셸 명령으로 고친 파일은 빠진다(실제 E2E 에서 확인). 현재 변경은 Git 패널·파일 트리에는 정확히 나온다.
- 대용량 저장소(수만 파일)에서의 성능, 파일 트리 가상화는 검증·구현하지 않았다.
- `.gitattributes` 의 clean 필터(LFS 등)는 status 계산 때 실행될 수 있다(Git 동작 그대로).
