# TASK-013: git status 중복 호출 합치기

- 상태: COMPLETED
- 만든 날: 2026-11-06
- 브랜치: perf/git-status-dedupe (main b4ef342 에서)

## 요청

"git status 중복 호출 합치기 해줘" (TASK-011 기술 스택 검토에서 고칠 것 2번)

## 요구사항

- 지금 `git status` 는 이렇게 중복된다.
  - 파일 하나가 바뀌면 statusTick 이 오르고, Git 패널(GitPanel)·파일 트리(FilePanel)·에이전트 "바꾼 파일"(TouchedFilesView)이 같은 워크트리의 `git status --porcelain=v2 --untracked-files=all` 을 각자 부른다. 최대 3번.
  - git 신호(bumpGit·.git 변경)에서는 GitPanel 이 그래프 뒤에 한 번, statusTick 으로 한 번 더 부른다.
  - 스테이지·커밋 뒤에는 `onChanged()` 로 바로 한 번, `bumpGit()` 신호로 또 부른다. 최대 5번.
- 한 신호에 한 워크트리의 git status 는 한 번만 돈다. 결과는 화면들이 같이 쓴다.
- 늦은(낡은) 상태를 보여 주면 안 된다.
  - 신호가 오른 뒤에 부른 것은 오르기 전에 시작한 결과를 같이 쓰지 않는다.
  - 끝난 결과를 다시 쓰는 것은 짧은 시간(1초) 안에서만 한다. 감시하지 않는 워크트리처럼 신호 없이 바뀌는 경우가 있어서다.
  - 실패한 결과는 같이 쓰지 않는다.
  - 스테이지·커밋 직후의 다시 읽기는 바뀐 뒤 상태여야 한다.
- 위험 작업 전의 변경 개수 세기(gitActions·editWorktree)는 지금처럼 바로 읽는다. 공유하지 않는다.
- Rust 변경 없음, 새 타이머·프로세스 없음.

## 완료 조건 (Acceptance Criteria)

- [x] 같은 신호 세대에 같은 워크트리를 여러 번 부르면 git_status 가 한 번만 불린다. 세대가 바뀌거나, 1초가 지나거나, 실패한 뒤에는 새로 부른다.
- [x] 단위 시험이 있고, 대상 코드를 일부러 깨뜨리면 실패한다(깨뜨린 결과 기록).
- [x] 실제 시험 앱에서 파일 변경 1번·스테이지 1번에 git_status 가 몇 번 불리는지 전과 후로 잰다. 화면(Git 변경 목록·파일 트리 표시·바꾼 파일)이 새 상태로 바뀌는 것도 확인한다. 일부러 깨뜨린 빌드(공유 안 함·늘 공유)에서 실패하는 것도 확인한다.
- [x] `./scripts/auto-fix-loop.sh` 통과
- [x] 시험 앱 데이터·번들 정리

## 계획

1. `src/gitStatus.ts` 에 `worktreeStatus(path)` 를 만든다.
   - 세대는 statusTick + fsSignals[path] + gitSignals[path] 로 정한다.
   - 같은 세대 안에서 돌고 있거나, 끝난 지 1초 안이면 그 결과를 같이 쓴다.
2. GitPanel·FilePanel·TouchedFilesView 가 이것을 쓴다.
3. GitChanges 는 `bumpGit()` 을 먼저 부르고 그다음 `onChanged()` 를 부른다.
4. 단위 시험을 쓰고 깨뜨려 본다.
5. 시험 앱에서 invoke 를 세어 전과 후를 재고, 깨뜨린 빌드로도 돌린다.
6. auto-fix-loop 를 돌리고 정리한다.

## 진행 기록

- 2026-11-06 구현:
  - `src/gitStatus.ts` 의 `worktreeStatus`:
    - 세대는 statusTick·fsSignals[path]·gitSignals[path] 로 정한다.
    - 같은 세대 안에서 돌고 있거나, 끝난 지 1초 안이면 그 결과를 같이 쓴다. 실패는 같이 쓰지 않는다.
  - GitPanel·FilePanel·TouchedFilesView 가 이것을 쓴다.
  - GitChanges 는 `bumpGit()` 을 먼저, 그다음 `onChanged()` 를 부른다(두 곳).
  - 위험 작업 전 개수 세기(gitActions·editWorktree)는 그대로 바로 읽는다.
- 단위 시험 `src/gitStatus.test.ts` 7개 통과. 화면 시험 전체 통과.
- 단위 깨뜨림(scratchpad `git-status/break.py`) 9가지 → 9/9 잡힘. 원본은 다시 통과.
  - 세대에서 statusTick·파일 신호·git 신호를 각각 뺌
  - 끝난 결과 안 씀 / 언제까지나 씀
  - 돌고 있는 것 안 씀, 실패도 같이 씀, 아예 안 씀, 워크트리 안 가림
- 실제 시험 앱(scratchpad `git-status/run.py`):
  - 첫 방법은 화면 쪽 `window.__TAURI_INTERNALS__.invoke` 를 감싸 세는 것이었다. 하나도 세지 못했다. Tauri 가 바꿀 수 없는 속성으로 정의한 것으로 보인다(화면은 정상으로 바뀜).
  - 그래서 앱이 띄우는 git 자체를 셌다.
    - 앱은 `$SHELL -l -i -c` 로 PATH 를 읽는다(env.rs).
    - 시험 앱을 `--env SHELL=<가짜 셸>` 로 띄워 PATH 앞에 가짜 git 을 두었다. 가짜 git 은 폴더와 인자를 기록한 뒤 /usr/bin/git 을 실행한다.
  - 세 화면이 모두 status 를 쓰는 상태(세션 고름 + 바꾼 파일 탭 + Git 변경 사항 탭)에서 14/14 통과. 한 번 할 때 one 의 git status 수:
    - 새 파일 1, 있던 파일 고침 1
    - 스테이지 2(작업 뒤 1 + .git/index 감시 신호 1)
    - 0.6초 사이 두 파일 2, 앱 밖 git commit 1
  - 화면(변경 목록·트리 표시)은 매번 새 상태로 바뀌었다.
- 전과 깨뜨림(scratchpad `git-status/breakall.py`, 빌드마다 run.py):

  | 경우 | 새 파일 | 파일 고침 | 스테이지 | 0.6초 사이 두 파일 | 앱 밖 commit |
  |---|---|---|---|---|---|
  | 전(main 의 원래 화면 코드 4개) | 3 | 3 | 9 | 6 | 4 |
  | 후 | 1 | 1 | 2 | 2 | 1 |

  - 전은 실패 5개(수가 기대보다 많음).
  - 깨뜨림 A "같이 쓰지 않음"은 실패 5개. 수는 전과 같다(3·3·9·6·4).
  - 깨뜨림 B "세대·시간을 무시하고 늘 같이 씀"은 실패 9개. 변경 목록이 비고 트리 표시가 안 바뀌는 낡은 화면이 됐다.
  - 원본 되돌림은 cmp 로 확인했다.
- `./scripts/auto-fix-loop.sh TASK-013` 1/5 번에 통과했다.
  - 빌드: 화면 1초, Rust 30초
  - 타입 3초
  - clippy 15/15
  - 테스트: 화면 2초, Rust 8초
- 정리:
  - 시험 DB 는 run.py 가 `.backup`/`.restore` 로 되돌렸다(repositories 1, executions 0, session_links 6, kv 5, e2e.* 없음).
  - 소켓은 run.py 가 지웠다.
  - 시험 번들은 `lsregister -u` 한 뒤 지웠다(남은 등록은 ai_db 의 Dolmen.app).

## 발견한 문제

- Tauri 2 의 `window.__TAURI_INTERNALS__.invoke` 는 바꿔 끼울 수 없어, 화면 쪽에서 IPC 를 세는 시험은 안 된다. 실제 프로세스를 세려면 가짜 SHELL 로 PATH 를 넣는다.
