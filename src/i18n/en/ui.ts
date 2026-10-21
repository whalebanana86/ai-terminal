/** 영어 사전: ui (위쪽 막대·상태줄·스틱맨·파일 패널·공통 대화상자·앱 알림) */
export default {
  // 공통 대화상자
  취소: "Cancel",
  확인: "OK",
  닫기: "Close",

  // 위쪽 막대·상태줄
  "Git 저장소 폴더 선택": "Choose a Git repository folder",
  "저장소를 추가했습니다: {name}": "Added repository: {name}",
  "볼 워크트리를 고릅니다(저장소마다 하나 이상). 체크아웃은 하지 않아요.": "Choose the worktree to view (one or more per repository). Nothing is checked out.",
  "볼 워크트리 고르기": "Choose a worktree to view",
  "워크트리를 고르세요…": "Choose a worktree…",
  "로컬 Git 저장소를 목록에 추가": "Add a local Git repository to the list",
  "저장소 추가": "Add repository",
  "{name} 을(를) 찾지 못했습니다. 설치되어 있고 로그인 셸 PATH 에 있는지 확인하세요.": "{name} not found. Make sure it's installed and on your login shell's PATH.",
  상태: "Status",
  "이 앱은 대화·코드를 외부로 보내지 않습니다": "This app never sends your conversations or code anywhere",
  "로컬 전용": "Local only",

  // 스틱맨(오늘 보낸 요청)
  추가: "Add",
  수정: "Modify",
  삭제: "Delete",
  "버그·오류": "Bug/Error",
  질문: "Question",
  "오늘 AI 에게 보낸 요청 (눌러서 목록)": "Requests sent to AI today (click for list)",
  "오늘 요청 {n}개": "Requests today: {n}",
  "오늘 받은 요청": "Today's requests",
  "오늘 AI 에게 보낸 요청": "Requests sent to AI today",
  "아직 없어요. AI 에게 요청을 보내면 여기에 쌓여요.": "Nothing yet. Requests you send to AI will show up here.",
  "요청 글자로 추가·수정·삭제·버그·질문을 나눠요(앱 안에서만, 어디에도 보내지 않음). \"진행해\"처럼 어디에도 안 맞는 말(·)은 세지 않아요. 하루가 지나면 0 부터.":
    "Requests are sorted into Add, Modify, Delete, Bug/Error and Question by their wording (inside the app only, nothing is sent anywhere). Replies that fit none, like \"go ahead\" (·), aren't counted. Resets to 0 each day.",

  // 파일 패널: 트리
  파일: "Files",
  "Finder 에서 보기": "Show in Finder",
  "볼 워크트리가 없습니다": "No worktree to show",
  "위에서 워크트리를 고르세요.": "Choose a worktree above.",
  "안에 바뀐 파일 {n}개": "Changed files inside: {n}",
  "바뀐 파일만 ({n})": "Changed only ({n})",
  ".gitignore 로 Git 이 무시하는 파일(빌드 결과물 등)": "Files Git ignores via .gitignore (build output, etc.)",
  "숨김 파일": "Ignored files",
  "파일 트리": "File tree",
  "변경된 파일이 없습니다": "No changed files",

  // 파일 패널: 보기
  내용: "Content",
  "마지막 커밋과 비교한 전체 변경": "All changes since the last commit",
  변경: "Diff",
  "바뀐 부분(조각)만 골라 커밋에 담기": "Pick individual hunks to stage for commit",
  "일부 담기": "Stage hunks",
  "커밋 {sha}": "Commit {sha}",
  "마지막 커밋": "Last commit",
  지금: "Now",
  "바이너리 파일": "Binary file",
  "처음 1MB 만 보여 줍니다": "Showing only the first 1 MB",
  "실제 크기 ↔ 창에 맞춤": "Actual size ↔ Fit to window",
  맞춤: "Fit",
  "실제 크기": "Actual size",
  "이 형식은 그릴 수 없습니다": "Can't display this format",
  "마지막 커밋에는 없던 그림이에요": "This image isn't in the last commit",
  "지금은 없는 그림이에요(지워짐)": "This image no longer exists (deleted)",

  // 파일 패널: 일부 담기
  "이 부분의 변경 버리기": "Discard changes in this hunk",
  "{rel} 의 이 부분을 바뀌기 전으로 되돌립니다. 되돌릴 수 없어요.": "Reverts this hunk of {rel} to how it was before. This can't be undone.",
  버리기: "Discard",
  "변경이 너무 큽니다": "Diff too large",
  "{n}줄이 바뀌어 부분 선택을 생략했어요. 왼쪽 목록의 + / − 로 파일 전체를 담거나 빼세요.":
    "{n} lines changed, so hunk selection is skipped. Use + / − in the list on the left to stage or unstage the whole file.",
  "담을 변경이 없어요": "No changes to stage",
  "아직 담은 부분이 없어요": "Nothing staged yet",
  "이 부분 변경 버리기 (되돌릴 수 없음)": "Discard changes in this hunk (can't be undone)",
  "이 부분만 커밋에 담기 (git add -p)": "Stage only this hunk (git add -p)",
  담기: "Stage",
  "이 부분을 커밋에서 빼기": "Unstage this hunk",
  빼기: "Unstage",
  "아직 안 담은 부분": "Unstaged hunks",
  "커밋에 담은 부분": "Staged hunks",

  // 파일 패널: diff
  "변경 없음": "No changes",
  "마지막 커밋과 같아요.": "Same as the last commit.",
  "변경이 커서 앞의 {max}줄만 보여 줍니다 ({hidden}줄 생략).": "Large diff: showing the first {max} lines ({hidden} more hidden).",
  "바이너리 파일이 바뀌었습니다": "Binary file changed",

  // 앱 알림
  "에이전트 프로세스가 종료되었습니다 (코드 {code})": "Agent process exited (code {code})",
  "터미널이나 입력칸 위에 놓으면 파일 경로가 들어가요": "Drop onto a terminal or text field to insert the file path",
  "세션과 저장소를 읽는 중…": "Loading sessions and repositories…",
} satisfies Record<string, string>;
