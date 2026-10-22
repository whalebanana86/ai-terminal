// 소개 영상용 장면 만들기. scripts/promo/make_promo.sh 가 데모 앱(automation 빌드)에 scripts/demo/steps.js 다음에 넣는다.
// 장면마다 화면을 맞춰 두면 셸이 화면 구조를 떠서 그림으로 만든다. 예시 저장소 경로는 DEMO_WORK 로 바뀐다.
(() => {
  const W = "DEMO_WORK";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => window.__aitermStore.getState();
  const inv = window.__TAURI_INTERNALS__.invoke;
  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => [...root.querySelectorAll(q)];
  const until = async (f, ms = 8000) => {
    for (let i = 0; i < ms / 100; i++) {
      const v = f();
      if (v) return v;
      await wait(100);
    }
    throw new Error("timeout");
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const select = async (title) => {
    st().selectSession(st().sessions.find((s) => s.title === title).id);
    await wait(1200);
  };
  const expand = async (name) => {
    const li = $$(".tree-row.dir").find((l) => $(".name", l).innerText === name && $(".twisty", l).innerText.includes("▸"));
    if (li) {
      click(li);
      await wait(350);
    }
  };
  const cm = () => $(".cm-content")?.cmTile?.view;
  const LOGIN = `${W}/todo-app-login`;

  window.__promo = {
    async setup() {
      await window.__aitermExt.getState().set("editor", true);
      // 영상에 실제 구독 사용률(이 맥의 로그인)이 찍히지 않게
      await window.__aitermExt.getState().set("usage", false);
      await wait(300);
      return 1;
    },
    /** 장면 1: 파일을 열면 가운데 칸 탭에서 바로 편집 */
    async editor() {
      await select("로그인 화면 붙이기");
      await expand("src");
      await expand("lib");
      await expand("pages");
      click($$(".tree-row.file").find((l) => $(".name", l).innerText === "validate.ts"));
      await wait(700);
      click($$(".tree-row.file").find((l) => $(".name", l).innerText === "Login.tsx"));
      await until(() => cm() && cm().state.doc.length > 0);
      await wait(600);
      const v = cm();
      const at = v.state.doc.toString().indexOf("<form>") + "<form>".length;
      const add = "\n      {/* 이메일·비밀번호 칸 */}\n      <input type=\"email\" placeholder=\"이메일\" />\n      <input type=\"password\" placeholder=\"비밀번호\" />\n      <button>로그인</button>\n    ";
      v.dispatch({ changes: { from: at, to: at + "…".length, insert: add }, selection: { anchor: at + add.length - 5 }, userEvent: "input.type" });
      v.focus();
      await wait(500);
      return 1;
    },
    /** 장면 2: 고치는 사이 AI 가 같은 파일을 바꾸면 덮어쓰지 않고 묻는다 */
    async protect() {
      const now = await inv("fs_read_for_edit", { worktree: LOGIN, rel: "src/pages/Login.tsx" });
      await inv("fs_save", { args: { worktree: LOGIN, rel: "src/pages/Login.tsx", text: now.text.replace("export function Login() {", "// AI: 폼 상태를 훅으로 뺐어요\nexport function Login() {"), crlf: now.crlf, bom: now.bom, expected: now.hash, force: false } });
      await until(() => $("[data-testid=outside-note]"));
      await wait(300);
      click($('[data-action="save-file"]'));
      await until(() => $("[data-testid=outside-note]")?.textContent.includes("저장하지 않았어요"));
      await wait(400);
      return 1;
    },
    /** 장면 3: 설정 → 기능 */
    async settings() {
      await inv("plugin:event|emit", { event: "open-settings", payload: null });
      await until(() => $("[data-testid=settings-dialog]"));
      await wait(500);
      return 1;
    },
    async closeSettings() {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await wait(300);
      // 장면 2 의 저장 안 한 수정은 버리고(다시 불러오기) 탭을 닫는다
      const reload = $('[data-action="reload"]');
      if (reload) {
        click(reload);
        await wait(500);
      }
      st().closeTabs(st().fileTabs.map((x) => x.id));
      await wait(300);
      return 1;
    },
    /** 장면 4: 그래프의 🤖(AI 와 함께 쓴 커밋)과 커밋 상세의 공동 작성자 */
    async graph() {
      await select("정렬 버그 고치기");
      click($(".tabs [data-tab=graph]") ?? $$(".tabs button").find((b) => b.innerText.trim() === "그래프"));
      await wait(800);
      const row = await until(() => $$(".grow").find((r) => r.innerText.includes("정렬이 끝난 일을 섞던 문제 고침")));
      click(row);
      await until(() => $(".cd-people, .cd-coauthor"));
      await wait(500);
      return $$(".grow .gai svg").length;
    },
    /** 장면 5: 세션 목록을 접어 대화·터미널을 크게 */
    async listOpen() {
      if ($("[data-action=toggle-session-list]")?.getAttribute("aria-pressed") === "true") click($("[data-action=toggle-session-list]"));
      await wait(600);
      return 1;
    },
    async listClosed() {
      click($("[data-action=toggle-session-list]"));
      await wait(800);
      return 1;
    },
  };
  return Object.keys(window.__promo).length;
})();
