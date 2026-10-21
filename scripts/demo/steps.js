// README 그림·시연 영상용 화면 조작. scripts/make_screenshots.sh 가 앱(automation 빌드)에 한 번 넣고 단계별로 부른다.
// 예시 저장소 경로는 DEMO_WORK 로 바뀐다.
(() => {
  const W = "DEMO_WORK";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => window.__aitermStore.getState();
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
  const tab = async (name) => {
    click($(`.tabs [data-tab=${name}]`));
    await wait(500);
  };
  const session = (title) => st().sessions.find((s) => s.title === title);
  const select = async (title) => {
    st().selectSession(session(title).id);
    await wait(1200);
  };
  const expand = async (name) => {
    const li = $$(".tree-row.dir").find((l) => $(".name", l).innerText === name && $(".twisty", l).innerText.includes("▸"));
    if (li) {
      click(li);
      await wait(350);
    }
  };
  const setText = (el, v) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  // 한 글자씩 치는 것처럼(영상용)
  const type = async (el, text, ms = 45) => {
    for (let i = 1; i <= text.length; i++) {
      setText(el, text.slice(0, i));
      await wait(ms);
    }
  };
  const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const menuAt = async (row) => {
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left + 160, clientY: r.top + 12 }));
    await wait(300);
  };

  window.__demo = {
    async setup() {
      await window.__TAURI_INTERNALS__.invoke("repo_add", { path: `${W}/todo-app` });
      await st().refreshRepos();
      await st().refreshSessions();
      return st().sessions.length;
    },
    async overview() {
      st().openViewer(null);
      st().setFocusWorktree(`${W}/todo-app`);
      await wait(1200);
      await select("정렬 버그 고치기");
      await tab("graph");
      await expand("src");
      await expand("lib");
      await expand("components");
      return 1;
    },
    async switchSession() {
      await select("로그인 화면 붙이기");
      await expand("src");
      await expand("pages");
      await wait(400);
      return st().focus.worktreePath;
    },
    async openDiff() {
      const row = $$(".tree-row.file").find((l) => $(".name", l).innerText === "Login.tsx");
      click(row);
      await wait(900);
      return 1;
    },
    async image() {
      await select("정렬 버그 고치기");
      await expand("public");
      const row = $$(".tree-row.file").find((l) => $(".name", l).innerText === "logo.png");
      click(row);
      await until(() => $$('[data-testid="image-view"] img').length >= 2);
      await wait(600);
      return 1;
    },
    async back() {
      st().openViewer(null);
      await select("정렬 버그 고치기");
      return 1;
    },
    async chat(slow) {
      click($('[aria-label="이어가기 방법 고르기"]'));
      await wait(slow ? 700 : 300);
      click($('[data-action="open-chat"]'));
      const input = await until(() => $('[data-testid="chat-input"]'));
      await wait(600);
      if (slow) await type(input, "고정한 일은 맨 위에 오게 해 줘.");
      else setText(input, "고정한 일은 맨 위에 오게 해 줘.");
      await wait(300);
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await until(() => $('[data-testid="permission-card"].pending'));
      await wait(400);
      return 1;
    },
    async allow() {
      const card = $('[data-testid="permission-card"].pending');
      click($$("button", card).find((b) => b.innerText.trim() === "허용"));
      await until(() => !$('[data-testid="permission-card"].pending'));
      await wait(1500);
      return 1;
    },
    async stage() {
      await tab("changes");
      const p = $('[data-testid="unstaged-list"] li[data-path="src/lib/sort.ts"] .path');
      click(p);
      await until(() => $('[data-testid="changes-stage"] .hunk'));
      await wait(400);
      return 1;
    },
    async stageHunk() {
      click($('[data-testid="changes-stage"] [data-side="unstaged"] [data-action="stage-hunk"]'));
      await wait(1200);
      return 1;
    },
    async graphMenu() {
      await tab("graph");
      const row = $$(".grow").find((r) => r.innerText.includes("feature/export"));
      await menuAt(row);
      const sub = $(".menu .has-sub");
      click(sub);
      await wait(400);
      return 1;
    },
    async closeMenu() {
      escape();
      await wait(300);
      return 1;
    },
    async worktrees() {
      await tab("worktrees");
      return 1;
    },
    async newSession(slow) {
      st().setNewSessionOpen(true);
      const box = await until(() => $('[data-testid="first-prompt"]'));
      await wait(400);
      if (slow) await type(box, "할 일을 끌어다 순서를 바꿀 수 있게 해 줘.");
      else setText(box, "할 일을 끌어다 순서를 바꿀 수 있게 해 줘.");
      await wait(300);
      return 1;
    },
    async closeDialog() {
      const b = $$("button").find((x) => x.innerText.trim() === "취소");
      if (b) click(b);
      await wait(300);
      return 1;
    },
  };
  return Object.keys(window.__demo).length;
})();
