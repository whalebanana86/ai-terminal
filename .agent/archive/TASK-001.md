# TASK-001: 에이전트 작업 흐름 넣기

- 상태: COMPLETED
- 만든 날: 2026-11-04
- 브랜치: docs/agent-workflow

## 요청

"AGENTS.md로 바꾸면 클로드코드도 읽을수 있게 하고 문서에 나오는 폴더랑 파일들 생성 진행해"

## 요구사항

- agent.md 를 AGENTS.md 로 바꾼다(내용은 그대로).
- Claude Code 도 같은 규칙을 읽게 한다(Claude Code 는 CLAUDE.md 를 읽는다).
- AGENTS.md 에 나오는 폴더·파일을 만든다: `.agent/tasks/`, `.agent/attempts/`, `.agent/archive/`, `.agent/PROGRESS.md`, `scripts/auto-fix-loop.sh`.
- `auto-fix-loop.sh` 는 빌드·타입 검사·Lint·테스트로 검증하고, 실패 원인과 시도 내역을 `.agent/attempts/TASK-ID.jsonl` 에 남긴다.
- 루프는 설정된 최대 시도 횟수와 시간 제한을 지키고, 같은 오류가 반복되거나 제한을 넘으면 멈춘다. 멈춘 뒤에는 임의로 다시 돌지 않는다.
- 로그에 민감정보·토큰·비밀번호를 남기지 않는다.

## 완료 조건 (Acceptance Criteria)

- [x] AGENTS.md 가 있고 agent.md 는 없다.
- [x] CLAUDE.md 가 `@AGENTS.md` 로 AGENTS.md 를 불러온다.
- [x] `.agent/tasks/`, `.agent/attempts/`, `.agent/archive/` 폴더와 `.agent/PROGRESS.md` 가 git 에 들어간다. — 무시 규칙에 안 걸리는 것 확인(`git check-ignore` 없음), 사용자 승인으로 커밋.
- [x] `./scripts/auto-fix-loop.sh` 가 지금 코드에서 빌드·타입 검사·Lint·테스트를 모두 돌리고 통과한다.
- [x] 실패 기록, 같은 오류 반복 중단, 최대 시도 중단, 시간 제한 중단, 중단 뒤 실행 거부, 초기화가 테스트로 확인된다.
- [x] 로그에 토큰·비밀번호가 가려지는 것이 테스트로 확인된다.
- [x] 앱 코드(`src/`, `src-tauri/`)는 바꾸지 않는다.

## 계획

1. `.agent/` 폴더(빈 폴더는 `.gitkeep`), `PROGRESS.md`, TASK 양식(`.agent/TASK_TEMPLATE.md`), 루프 설정(`.agent/auto-fix.json`)을 만든다.
2. `CLAUDE.md` 에 `@AGENTS.md` 를 넣는다.
3. `scripts/auto-fix-loop.mjs`(본체)와 `scripts/auto-fix-loop.sh`(실행 입구)를 만든다. 실행 한 번 = 검증 한 번(시도 1회), 고치는 일은 에이전트가 한다.
4. `scripts/auto-fix-loop.test.mjs` 로 판단 규칙과 기록을 시험한다(vitest 가 자동으로 집는다).
5. 이 TASK 로 `./scripts/auto-fix-loop.sh` 를 실제로 돌려 통과시킨다.

## 진행 기록

- 2026-11-04: 브랜치 `docs/agent-workflow` 만듦, agent.md → AGENTS.md.
- 2026-11-04: `.agent/` 폴더·PROGRESS·TASK 양식·루프 설정, `CLAUDE.md`(`@AGENTS.md`) 만듦. Claude Code 가 CLAUDE.md 를 만들자마자 AGENTS.md 내용을 불러오는 것 확인.
- 2026-11-04: `scripts/auto-fix-loop.{sh,mjs,test.mjs}` 작성. 테스트 15개 통과. 사용법·잘못된 ID(`../x`)·없는 TASK 는 종료 코드 64.
- 2026-11-04: `./scripts/auto-fix-loop.sh` 시도 1번에 통과(19초, 빌드 캐시 있음). 화면 테스트 20파일 164개, Rust 테스트 106개 통과, clippy 경고 15개/허용 15개. 기록: `attempts/TASK-001.jsonl`.
- 2026-11-04: 사용자 승인("커밋 푸시 메인머지 푸시")으로 커밋. 완료 조건 전부 충족 → COMPLETED, archive/ 로 옮김.

## 발견한 문제

- Rust 코드는 rustfmt 서식이 아니다(`cargo fmt --check` 차이 643곳). 서식 검사는 Lint 에 넣지 않는다.
- clippy 경고가 이미 15개 있다. Lint 는 clippy 오류면 실패, 경고는 15개를 넘으면 실패(늘지 않게)로 잡는다. 기존 경고를 고치는 건 이 작업 범위 밖.
- 화면(TypeScript) 쪽에는 lint 도구가 없다. 타입 검사(tsc)가 그 몫을 한다.
- `pnpm install` 은 앱을 설치하므로(postinstall) 검증 단계에 넣지 않는다.
- 테스트에서 찾음: 전체 로그(`.last.log`)의 명령 줄 머리글은 비밀값 가리기를 안 거쳤다 → 머리글도 가리게 고침.
