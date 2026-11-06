# TASK-014: 코드행방 0.17.1 릴리즈

- 상태: IN_PROGRESS
- 만든 날: 2026-11-06
- 브랜치: chore/release-0.17.1

## 요청

"커밋 메인머지 릴리즈 푸시해" (TASK-013 커밋·main 머지에 이어 릴리즈)

## 요구사항

- 0.17.0 뒤 앱에 들어간 것을 0.17.1 로 낸다. 들어간 것은 git status 중복 호출 합치기(TASK-013)다. 새 기능이 아닌 성능 개선이라 끝자리만 올린다.
- 버전은 package.json·tauri.conf.json·Cargo.toml·Cargo.lock 을 올린다. 노트는 docs/release-notes/0.17.1.md(한·영)에 쓴다.
- 순서:
  1. main 받기.
  2. 머지.
  3. main 푸시.
  4. 푸시가 된 뒤에만 주석 태그 `v0.17.1` 을 푸시한다.
  5. Actions 가 게시하면 확인한다.
- 게시 확인은 github.com 내려받기 주소만 본다(api.github.com 반복 호출 금지). 간격은 사용자 허락으로 5분이다.

## 완료 조건 (Acceptance Criteria)

- [x] 버전 넷이 0.17.1, 노트 작성
- [x] `./scripts/auto-fix-loop.sh` 통과
- [ ] main 푸시(원격 main = 로컬 main), 그 뒤 태그 v0.17.1 푸시(원격 태그 확인)
- [ ] 릴리즈 게시 확인:
  - DMG 체크섬
  - latest.json 0.17.1·두 플랫폼
  - 앱 버전 0.17.1
  - 겸용(arm64·x86_64)
  - 서명
  - 최신 릴리즈가 v0.17.1

## 계획

1. 버전·노트 → 자동 검증 → 커밋.
2. main 받기 → 머지 → main 푸시 → 태그 → 태그 푸시.
3. scratchpad `wait_release.sh 0.17.1 300` 로 게시 확인.

## 진행 기록

- 2026-11-06 TASK-013 커밋 `ec1170e`, main 에 머지 `a0288ec`(main 받기: 바뀐 것 없음, 아직 푸시 전).
- 버전 넷 0.17.1, 노트 `docs/release-notes/0.17.1.md`, 자동 검증 1번에 통과(빌드 화면 1초·Rust 12초, 타입 3초, clippy 15/15, 테스트 화면 2초·Rust 10초).

## 발견한 문제
