# TASK-003: 파일 패널 오른쪽 클릭 메뉴(새 파일·이름 바꾸기·삭제)

- 상태: COMPLETED
- 만든 날: 2026-11-05
- 브랜치: feat/file-tree-menu

## 요청

"파일패널에서 파일생성하고 이름수정하고 삭제할 수 있게 오른쪽마우스클릭 기능 넣어줘"

## 요구사항

- 파일 트리의 줄(파일·폴더)과 빈 곳을 오른쪽 클릭하면 메뉴가 뜬다. 기존 `ContextMenu`(Overlays.tsx)를 쓴다.
  - 폴더 줄: 새 파일 · 새 폴더(그 폴더 안) · 이름 바꾸기 · 휴지통으로 옮기기
  - 파일 줄: 새 파일 · 새 폴더(그 파일이 든 폴더 안) · 이름 바꾸기 · 휴지통으로 옮기기
  - 빈 곳: 새 파일 · 새 폴더(워크트리 맨 위)
  - 디스크에서 이미 지워진 줄(D)은 메뉴를 띄우지 않는다.
- 새 파일: 빈 파일을 만들고, 든 폴더를 펼쳐 보이며 바로 연다. 같은 이름이 있으면 덮어쓰지 않고 거부한다.
- 새 폴더: 만들고 펼쳐 보인다. 파일을 만들 때 함께 쓰는 짝이라 같이 넣는다.
- 이름 바꾸기: 같은 폴더 안에서 이름만 바꾼다. 입력칸에는 지금 이름을 넣고 확장자 앞까지 골라 둔다.
  - 같은 이름이 있으면 덮어쓰지 않는다.
  - 대소문자만 바꾸는 것(a.ts → A.ts)은 된다.
  - 링크는 링크 이름만 바꾼다.
  - 열려 있던 파일 보기·가운데 탭과 저장하지 않은 수정이 새 이름(폴더면 안의 파일들)을 따라간다.
- 삭제: 확인창을 거쳐 맥 휴지통으로 옮긴다(Finder 에서 되살릴 수 있음).
  - 링크는 링크만 지우고 가리키는 곳은 건드리지 않는다.
  - 열려 있던 보기·탭은 닫는다.
  - 저장하지 않은 수정이 있으면 확인창에서 알린다.
- 안전:
  - 워크트리 밖·.git 안·워크트리 자체는 거부한다.
  - 새 이름에 다음이 들어가면 거부한다: 빈 이름, `.`/`..`, `/`, 제어 문자, `.git`, 앞뒤 빈칸, 255바이트 넘는 이름.
- 화면 글자는 한국어·영어 둘 다(i18n 검사).

## 완료 조건 (Acceptance Criteria)

- [x] Rust `create_entry`·`rename_entry`·`trash_entry` 와 명령 `fs_create`·`fs_rename`·`fs_trash` 가 위 규칙대로 동작한다(Rust 테스트).
- [x] 화면 쪽 순수 로직(이름 검사, 경로 따라가기, 메뉴 항목)을 vitest 로 확인한다.
- [x] 새로 쓴 테스트를 일부러 깨뜨리면 잡히는지 확인한다: 대상 코드를 깨뜨려 실제로 실패하는 것을 보고 되돌린다.
  - 덮어쓰기 막기
  - 대소문자만 바꾸기
  - 링크
  - .git·밖 거부
  - 이름 검사
  - 탭 따라가기
- [x] `./scripts/auto-fix-loop.sh` 통과.
- [x] 실제 앱(자동화 빌드, 시험용 앱 ID)에서 오른쪽 클릭 메뉴로 새 파일·새 폴더·이름 바꾸기·휴지통 옮기기가 된다.
  - [x] 디스크 결과와 화면(트리·열린 탭)을 함께 확인한다.
  - [x] 시험 뒤 시험 앱·시험 저장소를 치운다.
  - [x] 휴지통에 넣은 시험 항목을 치운다: `~/.Trash/ui-e2e082916`·`Renamed-e2e082916.md`·`notes-e2e082916`.
    - 이 세션(코드행방 안 터미널)은 맥 권한 때문에 시험 앱이 넣은 항목을 지울 수 없어(Operation not permitted) 사용자에게 알렸다.
    - 2026-11-05 사용자가 지운 것을 `ls -d` 로 확인(셋 다 없음).

## 계획

1. Rust(files.rs): 이름 검사 `check_name`, 부모 폴더 풀기, 만들기·이름 바꾸기·휴지통(NSFileManager trashItemAtURL), 테스트. 휴지통은 함수로 받아 테스트에서는 가짜 휴지통 폴더로 옮긴다(테스트마다 사용자 휴지통이 차지 않게).
2. commands.rs·lib.rs 에 명령 등록, Cargo.toml 의 objc2-foundation 에 NSFileManager·NSError 기능.
3. 화면: api.ts 함수, `src/treeOps.ts`(이름 검사·경로 따라가기·메뉴 항목·동작), store 에 열린 보기·탭 따라가기, drafts 에 수정 옮기기, FilePanel 에 onContextMenu, PromptDialog 에 이름 앞부분 골라 두기.
4. 영어 사전, vitest.
5. 깨뜨림 확인 → auto-fix-loop → 자동화 빌드로 실제 확인.

## 진행 기록

- 2026-11-05 구현
  - Rust: `files.rs` 에 `check_name`·`split_inside`·`create_entry`·`rename_entry`·`trash_entry`(`trash_with` + NSFileManager `trashItemAtURL`), 테스트 4개(이름 검사·만들기·이름 바꾸기·휴지통). `commands.rs` 에 `fs_create`·`fs_rename`·`fs_trash`, `lib.rs` 등록, Cargo 에 objc2-foundation `NSFileManager`·`NSError` 기능.
  - 화면: `api.ts` 함수 3개.
  - 새 파일 `treeOps.ts`: 이름 검사 `nameProblem`, 메뉴 `treeMenu`, 동작 `newEntry`·`renameEntry`·`trashEntry`, `followExpanded`.
  - `logic.ts`: `movedRel`·`stemEnd`.
  - `store.ts`: `pathsMoved`·`followPaths`, PromptField `selectEnd`.
  - `drafts.ts`: `draftRelsUnder`·`moveDrafts`.
  - `Overlays.tsx`: 처음 골라 두기.
  - `FilePanel.tsx`: 줄·빈 곳 `onContextMenu`, 메뉴가 가리키는 줄 테두리 `.menu-on`.
  - 영어 사전 `en/ui.ts`.
  - 테스트 `treeOps.test.ts` 20개.
- Rust files:: 18개 통과, vitest 21파일 187개 통과, tsc 통과.
- 깨뜨림 확인: 원본을 scratchpad 에 떠 두고 한 가지씩 깨뜨려 해당 테스트를 돌린 뒤 되돌림. 끝에 원본과 지문이 같은지 확인. 결과는 19가지 모두 잡힘.

  | ID | 깨뜨린 것 | 잡은 테스트 |
  |---|---|---|
  | R1 | 새 파일을 create_new 대신 create+truncate(덮어씀) | creates_files_and_folders_without_overwriting |
  | R2 | 이름 바꾸기를 그냥 rename(덮어씀) | renames_in_place |
  | R3 | 같은 이름이 '있으면' 먼저 거부(대소문자만 바꾸기가 막힘) | renames_in_place |
  | R4 | 같은 inode 면 그냥 rename(하드 링크에서 아무것도 안 하고 성공) | renames_in_place |
  | R5 | 링크도 휴지통 함수로 | trash_moves_items_and_unlinks_links |
  | R6 | `.git` 글자 검사 뺌 | renames_in_place, trash_moves_items_and_unlinks_links |
  | R7 | 부모 폴더를 실제 경로로 풀지 않음(밖을 가리키는 링크 폴더 통과) | renames_in_place, trash_moves_items_and_unlinks_links |
  | R8 | Rust 이름 검사에서 제어 문자 뺌 | names_are_checked |
  | R9 | `a/.`(폴더 자신) 검사 뺌 | trash_moves_items_and_unlinks_links |
  | F1 | 화면 이름 검사에서 제어 문자 뺌 | 새 이름 검사 |
  | F2 | NFC 맞추기 뺌(한글 자모 나눔 이름 겹침 못 봄) | 새 이름 검사 |
  | F3 | 대소문자만 바꾸기 막힘 | 새 이름 검사, 이름 바꾸기 동작 |
  | F4 | `src` 가 `src2/…` 도 품음 | 경로 돕기, 탭·보기·수정 따라가기 |
  | F5 | 이름 바꾼 탭 id 를 새로 안 만듦 | 탭 따라가기, 이름 바꾸기 동작 |
  | F6 | 보던 탭을 지워도 옆 탭으로 안 옮김 | 탭 닫기, 휴지통 동작 |
  | F7 | moveDrafts 가 아무것도 안 함 | 수정 옮기기, 이름 바꾸기 동작 |
  | F8 | 휴지통 실패 전에 수정 버리고 탭 닫음 | 휴지통 취소·실패 |
  | F9 | 이름 바꿔도 열린 탭이 안 따라감 | 이름 바꾸기 동작 |
  | F10 | 파일 줄에서 새 파일을 파일 경로 안에 만들려 함 | 파일 줄 메뉴 |
  | F11 | (고치기 전 코드) 새 md 파일을 빈 미리보기로 엶 | 새 md 파일은 '내용'(편집)으로 — 고치기 전에 실패 확인 |

- 실제 앱 확인(scratchpad `tree-e2e/run.sh`·`ui.js`):
  - 시험 앱 `dev.aiterminal.promo` 자동화 빌드를 가짜 홈(`AITERM_HOME`)으로 띄웠다.
  - 시험 저장소에서 줄에 `contextmenu` 이벤트를 보내 메뉴를 눌렀다.
  - 1차에서 14개 통과 뒤 "바로 고칠 수 있음" 실패 → 아래 발견한 문제 2. 고친 뒤 2차 **39개 모두 통과**.
  - 확인한 것:
    - 지워진 줄 메뉴 없음, 빈 곳·폴더 줄 메뉴 항목, 메뉴가 가리키는 줄 테두리.
    - 접힌 폴더도 같은 이름을 입력칸에서 막음, 새 파일이 디스크에 빈 파일로 생기고 가운데 탭 편집으로 열림.
    - 고치던 중 이름 바꾸기: 탭·저장 안 한 수정이 따라가고, 새 이름으로 저장됨. 확장자 앞까지 골라 둠.
    - 대소문자만 바꾸기, 같은 이름으로 못 바꿈, 펼친 폴더 이름 바꾸기에 펼침·안의 탭이 따라감.
    - 폴더·파일·링크·빈 폴더 휴지통: 확인창 글, 취소, 탭 닫힘, 알림. 링크가 가리키던 밖의 파일은 그대로(셸에서 확인).
  - 휴지통 확인: 같은 API(`FileManager.trashItem`) 시험 파일이 `~/.Trash/` 로 감. 앱이 옮긴 세 항목도 `~/.Trash/` 에 있음(`ls -d`, 목록 읽기는 권한으로 막힘).
  - 정리:
    - 시험 앱은 `--quit` 로 껐고, 시험 앱 DB 의 시험 저장소 2행을 지웠다.
    - 번들은 `lsregister -u` 뒤 지웠고, 시험 폴더·HFS+ 이미지도 지웠다.
    - 휴지통 속 세 항목은 못 지움(위).
- 자동 검증 루프 3번 통과(구현 뒤, md 열기 고친 뒤, 이름 정리 뒤). 마지막: vitest 21파일 188개, Rust 113개, clippy 경고 15개(허용 15).

## 발견한 문제

- 깨뜨림 1차에서 R3("대소문자만 바꾸기"용 같은 inode 갈래를 막음)이 **못 잡혔다**.
  - 원인: 대소문자만 바꾸면 맥 디스크가 `renamex_np(RENAME_EXCL)` 에서 이미 같은 항목으로 보고 바꿔 준다. 그래서 그 갈래는 쓰이지 않았다.
  - 시험 범위: APFS, 그리고 20MB HFS+ 디스크 이미지(`TMPDIR` 을 그 위로 두고 같은 테스트)에서 확인했다.
  - 처리: 쓰이지 않는 갈래(같은 inode 면 그냥 rename + 하드 링크 nlink 검사)를 지우고 `rename_no_replace` 하나로 줄였다. 하드 링크 둘은 그것만으로 거부된다.
  - R3·R4 는 줄인 코드에 맞는 흔한 잘못 두 가지로 바꿔 다시 깨뜨렸고, 둘 다 잡혔다. 줄인 뒤 APFS 18개·HFS+ 10개 통과.
- 실제 앱 1차: 새 `.md` 파일이 빈 '미리보기'(꼴 갖춘 문서)로 열려 바로 쓸 수 없었다.
  - 원인: 처음 여는 md 는 미리보기로 바꾸는 `mdFirst`.
  - 처리: `openViewer` 에 `exact` 를 더해, 방금 만든 파일만 준 모드('내용' = 편집 켜면 편집 화면) 그대로 연다. 트리에서 그냥 여는 md 는 원래대로 미리보기.
  - 테스트를 먼저 써서 고치기 전 코드에서 실패하는 것을 보고 고쳤다.
- 접힌 폴더에 새 파일을 만들 때 그 폴더 이름 목록이 아직 없어 입력칸 검사가 빠졌다. 메뉴를 누를 때 읽어 오게 했다(실제 앱 확인 항목 "접힌 폴더도 같은 이름을 입력칸에서 막음").

## 중단 기록 (중단했을 때만)

- 휴지통 시험 항목 정리를 기다리며 잠시 IN_PROGRESS 로 두었다. 사용자가 지운 것을 확인하고 COMPLETED 로 옮겼다(2026-11-05).
