# TASK-009: 코드행방 0.16.0 릴리즈

- 상태: COMPLETED
- 만든 날: 2026-11-06
- 브랜치: chore/release-0.16.0

## 요청

"커밋하고 메인머지 릴리즈 푸시해" (TASK-008 커밋·main 머지에 이어 릴리즈)

## 요구사항

- 0.15.0 뒤 앱에 들어간 것을 0.16.0 으로 낸다. 들어간 것은 저장소 탭의 AI 표시(TASK-008)다.
- 버전은 package.json·tauri.conf.json·Cargo.toml·Cargo.lock 을 올린다. 노트는 docs/release-notes/0.16.0.md(한·영)에 쓴다.
- 순서:
  1. main 받기.
  2. 머지.
  3. main 푸시.
  4. 푸시가 된 뒤에만 주석 태그 `v0.16.0` 을 푸시한다.
  5. Actions 가 게시하면 확인한다.
- 게시 확인은 github.com 내려받기 주소를 60초마다 본다(api.github.com 반복 호출 금지).

## 완료 조건 (Acceptance Criteria)

- [x] 버전 넷이 0.16.0, 노트 작성
- [x] `./scripts/auto-fix-loop.sh` 통과
- [x] main 푸시(원격 main = 로컬 main), 그 뒤 태그 v0.16.0 푸시(원격 태그 확인)
- [x] 릴리즈 게시 확인:
  - DMG 체크섬
  - latest.json 0.16.0·두 플랫폼
  - 앱 버전 0.16.0
  - 겸용(arm64·x86_64)
  - 서명
  - 최신 릴리즈가 v0.16.0

## 계획

1. 버전·노트 → 자동 검증 → 커밋.
2. main 받기 → 머지 → main 푸시 → 태그 → 태그 푸시.
3. scratchpad `wait_release.sh 0.16.0` 로 게시 확인.

## 진행 기록

- 2026-11-06 TASK-008 커밋 `97905ab`, main 에 머지 `47972b3`(main 받기: 바뀐 것 없음, 아직 푸시 전).
- 버전 넷 0.16.0, 노트 `docs/release-notes/0.16.0.md`, 자동 검증 1번에 통과(빌드 화면 1초·Rust 10초, 타입 2초, clippy 15/15, 테스트 화면 1초·Rust 9초).
- 커밋·머지·푸시:
  - 커밋 `800288b`.
  - main 받기(바뀐 것 없음) → 머지 `76bb212` → `pnpm exec tsc --noEmit` 0 → 한 번 더 받기(바뀐 것 없음) → `git push origin main`(75773dd..76bb212).
  - 원격 main = 76bb212 확인.
  - 그 뒤 주석 태그 `v0.16.0`(코드행방 0.16.0) 푸시. 원격 태그 `v0.16.0^{}` = 76bb212 확인.
- 게시 확인: scratchpad `wait_release.sh 0.16.0`(github.com 내려받기 주소 60초마다, api.github.com 안 씀).
  - 1차: 60분 동안 404 로 끝남. Actions Release Run 25(runs/42127039503) 가 실패.
- 멈춘 상태(2026-11-06 09:10):
  - 완료한 것: 커밋·머지·main 푸시·태그 푸시.
  - 실패 원인:
    - Actions 의 Tools·Install·Test·Package·Release notes 는 성공했다.
    - 마지막 `softprops/action-gh-release`(릴리즈 만들기) 단계만 "Too many retries." 로 실패했다. 그래서 Publish 단계는 건너뛰었다.
    - 실행 시각은 23:06Z~23:22Z 이고, githubstatus.com 에 23:36Z "Degraded performance for multiple GitHub services"(Actions 포함)가 있다.
    - 워크플로는 0.3.0 뒤로 바뀐 적이 없고 0.15.0 까지 매번 성공했으니, GitHub 쪽 일시 장애로 본다.
  - 이미 해 본 것: 단계 로그를 보려 했지만 로그인이 있어야 해서 못 봤다.
  - 다음 행동:
    - 사용자가 GitHub 에서 반쯤 만들어진 0.16.0 초안이 있으면 지우고, Run 25 를 "Re-run failed jobs" 로 다시 돌린다.
    - 이 세션에는 쓰기 권한이 있는 GitHub 로그인이 없다(gh 없음, 키체인 자격 증명은 쓰지 않음).
    - 그 뒤 `wait_release.sh 0.16.0` 결과로 완료 조건 4번을 확인한다.
- 재개(2026-11-06): 사용자가 초안을 지우고(있으면) Run 25 를 "Re-run failed jobs" 로 다시 돌렸다. Actions 화면에서 "currently running" 을 확인했다.
  - 게시 확인은 사용자 허락으로 5분 간격(`wait_release.sh 0.16.0 300`)으로 했다.
  - 결과:
    - `Code-Whereabouts-0.16.0-macOS.dmg: OK`, `latest.json: OK`(SHA256SUMS.txt)
    - latest.json version 0.16.0, 플랫폼 darwin-aarch64·darwin-x86_64
    - DMG 속 앱 버전 0.16.0, 겸용 x86_64·arm64, `codesign --verify --deep --strict` 통과
    - 최신 릴리즈 = v0.16.0

## 발견한 문제

- 1차 Actions 실행이 GitHub 쪽 일시 장애(같은 시각 githubstatus 의 Actions 성능 저하)로 릴리즈 만들기 단계에서 "Too many retries." 로 실패했다. 다시 돌리기로 해결했다. 워크플로는 고치지 않았다.
