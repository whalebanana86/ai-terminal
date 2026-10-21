# 테스트 결과

- 수행일: 2026-10-21
- 환경: macOS 26.3 (25D125), Apple Silicon(arm64), git 2.50.1, Claude Code 2.1.305, Codex CLI 0.155.0, Rust 1.99.1, Node 20.19.5
- 방식: 실제 CLI 와 실제 Git 저장소로 수행했다. 화면 조작은 `automation` 기능 빌드의 원격 조작 소켓(`scripts/aiterm-eval.py`)으로 실제 버튼을 누르는 방식이다. 결과는 앱 화면(DOM, 터미널 버퍼)과 git CLI 출력을 대조해 판정했다.
- 외부 터미널: 앱과 무관한 `tmux` 세션에서 대화형 `claude` / `codex` 를 실행했다.

## 자동 테스트

| 묶음 | 개수 | 결과 |
|---|---|---|
| Rust 단위(파서·레인·세션 기록·DB·감시 분류·PTY·경로 안전·환경변수 필터) | 26 | 통과 |
| Rust 통합(실제 git 저장소 + 워크트리 + 가짜 HOME) | 6 | 통과 |
| 프런트 단위(vitest: 브랜치 상태, 세션·실행 합치기, 경로, 변경 표시, 경고 문구) | 9 | 통과 |

통합 테스트 목록 (`src-tauri/src/core.rs`)
- `sessions_link_to_their_own_worktree_and_branches_stay_separate`: Claude 세션(워크트리 하위 폴더 cwd)과 Codex 세션(.zst)이 같은 저장소의 서로 다른 워크트리로 연결된다. 외부 브랜치 변경 뒤 "현재"만 바뀌고 "시작"은 유지된다. 조회 후 HEAD 가 그대로다. 워크트리를 지운 뒤에도 저장된 연결로 표시된다.
- `graph_matches_git_cli`: 그래프 행 순서가 `git log --topo-order --branches --remotes --tags` 와 같다. detached HEAD 커밋도 나온다.
- `status_and_diff_match_real_changes`: 상태·diff 가 실제 변경과 같고, 조회가 index 를 바꾸지 않는다.
- `checkout_refuses_branch_used_by_other_worktree`
- `commit_only_selected_paths`
- `resume_uses_recorded_cwd_and_codex_new_links_later`: 재개 인자(`--resume <id>`)와 작업 폴더가 정확하다. Codex 새 실행이 나중에 생긴 스레드와 연결된다.

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

## 테스트 중 발견해 고친 문제

1. **부모 세션 환경변수 누출 (심각)**: 에이전트 세션 안에서 띄운 앱(또는 그런 셸에서 `open` 한 앱)이 `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION` 등을 자식에게 물려줬다. 그 결과 재개한 Claude 가 "Transcript saving is off" 상태가 되어 대화가 저장되지 않았다. 세션에 묶인 변수만 걸러 내도록 고쳤다(`env.rs`, 테스트 포함). `open` 으로 연 릴리스 앱에도 이 변수가 들어오는 것을 확인했다.
2. 저장소가 아닌 폴더에서 Claude 가 `gitBranch: "HEAD"` 로 기록 → 브랜치처럼 보이던 문제.
3. Git 저장소가 아닌 cwd 의 판정을 캐시하지 않아 목록 갱신이 느리던 문제(432ms → 68ms).
4. 그래프 레인: 첫 부모가 다른 레인으로 합류하면 메인 줄기가 오른쪽으로 밀리던 문제.
5. 한 커밋에 배지가 많으면 커밋 제목이 가려지던 문제.

## 한계 / 수동 확인이 남은 것

- 폴더 선택 대화상자(+ 저장소, 다른 폴더…)는 자동화할 수 없어 같은 백엔드 명령(`repo_add`)을 호출해 검증했다.
- 인수 테스트는 이 맥 1대에서만 했다. 다른 macOS 버전, Intel, fish/bash 로그인 셸은 검증하지 않았다.
- 서명이 ad-hoc 이라 다른 맥에서는 Gatekeeper 경고가 나온다.
- 외부 터미널에서 **지금 실행 중인** 세션을 확실히 알아내지는 못한다(최근 기록 시각으로 추정). 같은 세션을 외부와 앱에서 동시에 재개하는 것은 막지 못한다.
- 터미널의 한글은 대체 글꼴 폭 때문에 글자 사이가 넓게 보인다(동작에는 문제 없음).
