# TASK-005: 코드행방 0.15.0 릴리즈

- 상태: COMPLETED
- 만든 날: 2026-11-05
- 브랜치: chore/release-0.15.0

## 요청

"커밋 메인머지 릴리즈 푸시해" (TASK-004 커밋·main 머지에 이어 릴리즈)

## 요구사항

- 0.14.0 뒤 앱에 들어간 것을 0.15.0 으로 낸다. 들어간 것은 파일 트리 오른쪽 클릭(TASK-003)과 탭 순서 바꾸기(TASK-004)다. 개발 규칙·검증 스크립트(TASK-001·002)는 앱 변경이 아니라 노트에 넣지 않는다.
- 버전은 package.json·tauri.conf.json·Cargo.toml·Cargo.lock 을 올린다. 노트는 docs/release-notes/0.15.0.md(한·영)에 쓴다.
- 순서:
  1. main 받기.
  2. 머지.
  3. main 푸시.
  4. 푸시가 된 뒤에만 주석 태그 `v0.15.0` 을 푸시한다.
  5. Actions 가 게시하면 확인한다.
- 게시 확인은 github.com 내려받기 주소를 60초마다 본다(api.github.com 반복 호출 금지).

## 완료 조건 (Acceptance Criteria)

- [x] 버전 넷이 0.15.0, 노트 작성
- [x] `./scripts/auto-fix-loop.sh` 통과
- [x] main 푸시(원격 main = 로컬 main), 그 뒤 태그 v0.15.0 푸시(원격 태그 확인)
- [x] 릴리즈 게시 확인:
  - DMG 체크섬
  - latest.json 0.15.0·두 플랫폼
  - 앱 버전 0.15.0
  - 겸용(arm64·x86_64)
  - 서명
  - 최신 릴리즈가 v0.15.0

## 계획

1. 버전·노트 → 자동 검증 → 커밋.
2. main 받기 → 머지 → main 푸시 → 태그 → 태그 푸시.
3. scratchpad `wait_release.sh 0.15.0` 로 게시 확인.

## 진행 기록

- 2026-11-05 버전 넷 0.15.0, 노트 `docs/release-notes/0.15.0.md`, 자동 검증 통과.
- 커밋·머지·푸시:
  - 커밋 `5d3108f`.
  - main 받기(바뀐 것 없음) → 머지 `757dd50` → `git push origin main`(0416306..757dd50).
  - 원격 main = 757dd50 확인.
  - 그 뒤 주석 태그 `v0.15.0`(코드행방 0.15.0) 푸시. 원격 태그 `v0.15.0^{}` = 757dd50 확인.
  - main 에 같이 올라간 것: TASK-003(f3705bd)·TASK-004(89c1078) 머지.
- 게시 확인: scratchpad `wait_release.sh 0.15.0`(github.com 내려받기 주소 60초마다, api.github.com 안 씀). 결과:
  - `Code-Whereabouts-0.15.0-macOS.dmg: OK`, `latest.json: OK`(SHA256SUMS.txt)
  - latest.json version 0.15.0, 플랫폼 darwin-aarch64·darwin-x86_64
  - DMG 속 앱 버전 0.15.0, 겸용 x86_64·arm64, `codesign --verify --deep --strict` 통과
  - 최신 릴리즈 = v0.15.0

## 발견한 문제
