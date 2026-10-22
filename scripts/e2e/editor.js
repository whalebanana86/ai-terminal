// 확장 기능 "파일 편집" E2E. 키보드 없이(입력은 편집기 트랜잭션으로) 돈다 → 다른 앱을 쓰는 중에도 돌릴 수 있다.
// 준비·실행: scripts/e2e/editor.sh (시험 저장소를 만들고 __REPO__·__PLAIN__ 을 바꿔 넣는다)
const st = window.__aitermStore;
const ext = window.__aitermExt;
const inv = window.__TAURI_INTERNALS__.invoke;
const REPO = "__REPO__";
const PLAIN = "__PLAIN__";
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const results = [];
const check = (ok, name, detail) => {
  results.push(`${ok ? "통과" : "실패"} ${name}${ok || detail === undefined ? "" : ` (${JSON.stringify(detail)})`}`);
  return ok;
};
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await wait(100);
  }
  return null;
};
const cm = () => $(".cm-content")?.cmTile?.view;
const type = async (text) => {
  const v = cm();
  v.dispatch({ changes: { from: v.state.doc.length, insert: text }, selection: { anchor: v.state.doc.length + text.length }, userEvent: "input.type" });
  await wait(150); // 화면이 '저장 안 됨'으로 바뀔 때까지(그 전엔 저장 버튼이 꺼져 있다)
};
const readDisk = async (rel, wt = REPO) => (await inv("fs_read", { worktree: wt, rel })).text;
const openEdit = async (rel, wt = REPO) => {
  st.getState().openViewer({ kind: "file", rel, mode: "ext:editor" });
  return until(() => cm() && $(`[data-testid=editor-state]`) && cm().state.doc.length > 0 && cm());
};
const click = (sel) => {
  const el = $(sel);
  el?.click();
  return !!el;
};
const confirmDialog = async () => {
  const btn = await until(() => [...document.querySelectorAll(".modal-actions .btn-primary, .modal-actions .btn-danger")].pop());
  btn?.click();
  return !!btn;
};

const prevExt = { ...ext.getState().enabled };
// 이 앱 데이터는 설치된 앱과 같이 쓰므로 탭·선택 상태를 끝나고 되돌린다
const kvKeys = ["focus", "selectedSession", "repoTabs"];
const prevKv = await Promise.all(kvKeys.map((key) => inv("kv_get", { key })));
const prevState = (({ focus, selectedSessionId, viewer, openRepoIds, repoTabPaths, repoTabSessions }) => ({ focus, selectedSessionId, viewer, openRepoIds, repoTabPaths, repoTabSessions }))(st.getState());
try {
  await inv("repo_add", { path: REPO });
  await st.getState().refreshRepos();
  st.getState().setFocusWorktree(REPO);
  await wait(800);

  // 1. 꺼져 있으면 탭도 저장도 없다
  if (prevExt.editor) await ext.getState().set("editor", false);
  st.getState().openViewer({ kind: "file", rel: "src/hello.ts", mode: "preview" });
  await wait(500);
  check(!$('[data-mode="ext:editor"]'), "꺼져 있으면 편집 탭 없음");
  check(!!$('[data-action="open-external"]'), "외부 편집기 버튼은 늘 있음");
  let err = "";
  try {
    await inv("fs_save", { args: { worktree: REPO, rel: "src/hello.ts", text: "x", crlf: false, bom: false, expected: "", force: true } });
  } catch (e) {
    err = String(e);
  }
  check(err.includes("꺼져") || err.includes("off"), "꺼져 있으면 저장 거절", err);
  err = "";
  try {
    await inv("kv_set", { key: "ext.editor", value: "1" });
  } catch (e) {
    err = String(e);
  }
  check(err !== "", "kv 로 몰래 켜기 거절", err);

  // 2. 켜고 편집·저장
  check(await ext.getState().set("editor", true), "편집 켜기(자동화 빌드는 확인창 없이)");
  check(!!(await openEdit("src/hello.ts")), "편집 탭이 열림");
  check(!!$('[data-mode="ext:editor"].on'), "편집 탭 선택됨");
  check(!!$(".cm-content .ͼp, .cm-content span[class]"), "코드 색칠");
  await type("// 한글 수정\n");
  await wait(100);
  check($("[data-testid=editor-state]").textContent.includes("저장 안 됨"), "고치면 '저장 안 됨'");
  check(!!$('[data-mode="ext:editor"] .tab-dot'), "탭에 저장 안 됨 점");
  click('[data-action="save-file"]');
  await until(() => $("[data-testid=editor-state]").textContent.includes("저장했어요"));
  check((await readDisk("src/hello.ts")) === 'export const hello = "hi";\n// 한글 수정\n', "디스크에 저장", await readDisk("src/hello.ts"));
  check(!$('[data-mode="ext:editor"] .tab-dot'), "저장하면 점이 사라짐");
  await wait(800); // 내 저장이 만든 파일 변경 신호는 무시돼야 한다
  check(!$("[data-testid=outside-note]"), "내 저장은 '밖에서 바뀜'으로 치지 않음");

  // 3. 밖에서 바뀜: 고치던 게 없으면 새 내용으로, 있으면 알리고 저장 때 묻기
  const now = await inv("fs_read_for_edit", { worktree: REPO, rel: "src/hello.ts" });
  await inv("fs_save", { args: { worktree: REPO, rel: "src/hello.ts", text: now.text + "// agent 1\n", crlf: false, bom: false, expected: now.hash, force: false } });
  check(!!(await until(() => cm().state.doc.toString().includes("agent 1"))), "고치던 게 없으면 밖의 변경을 바로 보여 줌");
  await type("// mine\n");
  const now2 = await inv("fs_read_for_edit", { worktree: REPO, rel: "src/hello.ts" });
  await inv("fs_save", { args: { worktree: REPO, rel: "src/hello.ts", text: now2.text + "// agent 2\n", crlf: false, bom: false, expected: now2.hash, force: false } });
  check(!!(await until(() => $("[data-testid=outside-note]"))), "고치는 중 밖에서 바뀌면 알림");
  check(cm().state.doc.toString().includes("// mine") && !cm().state.doc.toString().includes("agent 2"), "내 수정은 그대로");
  click('[data-action="save-file"]');
  await wait(600);
  check(!(await readDisk("src/hello.ts")).includes("// mine"), "그냥 저장하면 덮어쓰지 않음");
  check($("[data-testid=outside-note]")?.textContent.includes("저장하지 않았어요"), "저장 거절 안내");
  click('[data-action="overwrite"]');
  await wait(800);
  const disk = await readDisk("src/hello.ts");
  check(disk.includes("// mine") && !disk.includes("agent 2"), "고르면 내 것으로 덮어씀", disk);

  // 4. 저장하지 않은 수정은 탭을 옮겨도 남는다
  await type("// draft\n");
  st.getState().openViewer({ kind: "file", rel: "src/hello.ts", mode: "preview" });
  await wait(500);
  check(!!$('[data-mode="ext:editor"] .tab-dot'), "다른 탭에서도 저장 안 됨 점");
  await openEdit("src/hello.ts");
  check(cm().state.doc.toString().includes("// draft") && !!$("[data-testid=draft-note]"), "돌아오면 이어서 보여 줌");
  click("[data-testid=draft-note] .btn");
  await until(() => !cm().state.doc.toString().includes("// draft"));
  check(!cm().state.doc.toString().includes("// draft"), "수정 버리기");

  // 5. Esc 로 내용 보기, ⌘S 단축키
  await type("// key\n");
  cm().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", code: "KeyS", keyCode: 83, metaKey: true, bubbles: true, cancelable: true }));
  await until(() => $("[data-testid=editor-state]").textContent.includes("저장했어요"));
  check((await readDisk("src/hello.ts")).includes("// key"), "⌘S 로 저장");
  cm().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }));
  await wait(300);
  check(st.getState().viewer?.mode === "preview", "Esc 로 내용 보기");

  // 6. CRLF·BOM 유지, 고칠 수 없는 파일
  await openEdit("win.txt");
  await type("c\n");
  click('[data-action="save-file"]');
  await until(() => $("[data-testid=editor-state]").textContent.includes("저장했어요"));
  const win = await inv("fs_read_for_edit", { worktree: REPO, rel: "win.txt" });
  check(win.crlf && win.text === "a\nb\nc\n", "CRLF 파일은 CRLF 로 저장", win);
  st.getState().openViewer({ kind: "file", rel: "euckr.txt", mode: "ext:editor" });
  check(!!(await until(() => [...document.querySelectorAll(".empty-title")].find((e) => e.textContent.includes("고칠 수 없어요")))), "UTF-8 아닌 파일은 읽기 전용 안내");

  // 7. AI 가 일하는 워크트리 → 내 수정 워크트리 → 커밋 → AI 브랜치에 합치기
  const fakeRun = { sessionId: "e2e", agent: "claude", pid: 999999, client: "cli", status: null, cwd: REPO, startedAt: Date.now(), ownedByApp: false };
  st.setState({ liveRuns: [fakeRun] });
  await openEdit("src/hello.ts");
  st.setState({ liveRuns: [fakeRun] });
  check(!!(await until(() => $("[data-testid=agent-note]"))), "AI 가 일하는 중 안내");
  click('[data-action="open-edit-worktree"]');
  check(await confirmDialog(), "내 수정 워크트리 확인창");
  const editWt = await until(() => (st.getState().focus?.worktreePath ?? "").includes("-edit-main") && st.getState().focus.worktreePath, 8000);
  check(!!editWt, "내 수정 워크트리로 이동", st.getState().focus);
  check(!!(await until(() => $("[data-testid=edit-worktree-note]"), 6000)), "내 수정 워크트리 안내");
  check(!!(await until(() => cm()?.state.doc.length > 0 && cm())), "같은 파일을 편집으로 엶");
  await type("// from edit worktree\n");
  click('[data-action="save-file"]');
  await until(() => $("[data-testid=editor-state]")?.textContent.includes("저장했어요"));
  click('[data-action="merge-into-agent"]');
  await wait(600);
  check([...document.querySelectorAll(".toast")].some((t) => t.textContent.includes("커밋")), "커밋 전에는 먼저 커밋하라고 알림");
  await inv("git_commit", { path: editWt, paths: ["src/hello.ts"], message: "edit: from my worktree" });
  await st.getState().refreshRepos();
  click('[data-action="merge-into-agent"]');
  check(await confirmDialog(), "합치기 확인창");
  await wait(1500);
  const mainLog = await inv("git_graph", { path: REPO, limit: 5 });
  check(JSON.stringify(mainLog).includes("edit: from my worktree"), "AI 브랜치(main)에 합쳐짐");
  st.setState({ liveRuns: [] });

  // 8. Git 이 아닌 폴더
  const probe = await inv("repo_probe", { path: PLAIN });
  check(!probe.isRepo && probe.canInit, "Git 아닌 폴더는 시작 제안", probe);
  const home = await inv("repo_probe", { path: "/Users" });
  check(!home.isRepo && !home.canInit, "/Users 같은 곳은 제안하지 않음", home);
  await inv("repo_init", { path: PLAIN });
  await st.getState().refreshRepos();
  st.getState().setFocusWorktree(PLAIN);
  await wait(1500);
  check(!!(await inv("repo_probe", { path: PLAIN })).isRepo, "git init 후 저장소");
  check(!$(".panel .banner-error"), "커밋 없는 새 저장소도 오류 없이 보임", $(".panel .banner-error")?.textContent);

  // 9. 끄면 탭이 사라지고 저장도 막힘, 스틱맨·구독 한도 끄고 켜기
  st.getState().setFocusWorktree(REPO);
  await wait(500);
  await openEdit("src/hello.ts");
  await ext.getState().set("editor", false);
  await wait(300);
  check(!$('[data-mode="ext:editor"]') && !$("[data-testid=editor-pane]"), "끄면 편집 탭이 사라지고 내용 보기로");
  await ext.getState().set("stickman", false);
  await ext.getState().set("usage", false);
  await wait(300);
  check(!$(".stick-buddy") && !$(".subscription-usage"), "스틱맨·구독 한도 끄기");
  check((await inv("subscription_usage")).length === 0, "구독 한도를 끄면 조회하지 않음");
  await ext.getState().set("stickman", true);
  await ext.getState().set("usage", true);
  check(!!(await until(() => $(".stick-buddy") && $(".subscription-usage"))), "다시 켜면 보임");
} catch (e) {
  results.push(`오류 ${e && e.stack ? e.stack : e}`);
} finally {
  st.setState(prevState);
  await wait(300);
  await Promise.all(kvKeys.map((key, i) => (prevKv[i] === null ? Promise.resolve() : inv("kv_set", { key, value: prevKv[i] }))));
  for (const [id, on] of Object.entries(prevExt)) if (ext.getState().enabled[id] !== on) await ext.getState().set(id, on).catch(() => {});
}
return results.join("\n");
