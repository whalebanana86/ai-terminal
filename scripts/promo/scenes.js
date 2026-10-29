// 소개 영상용 장면 만들기. scripts/promo/make_promo.sh 가 데모 앱(automation 빌드)에 scripts/demo/steps.js 다음에 넣는다.
// 장면마다 화면을 맞춰 두면 셸이 화면 구조를 떠서 그림으로 만든다. 예시 저장소 경로는 DEMO_WORK 로, 화면 언어는 DEMO_LANG 으로 바뀐다.
// (2026-10-28 판: 0.8~0.11 새 기능 — 기억 담아 새로·작업 기억·브랜치 색·저장소 믿기. 이전 판은 git 기록에)
(() => {
  const W = "DEMO_WORK";
  // 영어판은 예시 세션 제목·버튼 글자가 영어다(scripts/demo/make_demo.py 의 DEMO_LANG=en)
  const T = (ko, en) => ("DEMO_LANG" === "en" ? en : ko);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => window.__aitermStore.getState();
  const inv = window.__TAURI_INTERNALS__.invoke;
  const $ = (q, root = document) => root.querySelector(q);
  const $$ = (q, root = document) => [...root.querySelectorAll(q)];
  const until = async (f, ms = 8000) => {
    for (let i = 0; i < ms / 100; i++) {
      const v = await f();
      if (v) return v;
      await wait(100);
    }
    throw new Error("timeout");
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const select = async (title) => {
    await st().refreshSessions();
    st().selectSession(st().sessions.find((s) => s.title === title).id);
    await wait(1200);
  };
  const tab = async (name) => {
    click($(`.tabs [data-tab=${name}]`));
    await wait(900);
  };
  const escape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const closeModal = async () => {
    const back = $$(".modal-backdrop").pop();
    if (back) back.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await wait(300);
  };

  window.__promo = {
    async setup() {
      // 영상에 실제 구독 사용률(이 맥의 로그인)이 찍히지 않게
      await window.__aitermExt.getState().set("usage", false);
      await inv("repo_trust", { worktree: `${W}/todo-app` });
      // 작업 기억: 켜고(모델이 없으면 받는다) 예시 기록 정리가 끝날 때까지 기다린다
      await inv("memory_set_enabled", { on: true });
      const s = await until(async () => {
        const x = await inv("memory_status");
        return x.state === "ready" && x.turns > 0 && x;
      }, 900000);
      return `${s.turns}턴`;
    },
    /** 장면: 기억 담아 새로 — 직전 대화 + 관련된 지난 작업 */
    async memoryStart() {
      await select(T("로그인 화면 붙이기", "Add login screen"));
      click(await until(() => $("[data-testid=fresh-with-memory]")));
      await until(() => $("[data-testid=memory-hits] li"), 20000);
      await wait(400);
      // 위쪽 관련 기록 두 개를 골라 담는다(사용자가 고르는 모습)
      for (const box of $$("[data-testid=memory-hits] li input").slice(0, 2)) if (!box.checked) click(box);
      await wait(500);
      return $$("[data-testid=memory-hits] li input:checked").length;
    },
    /** 장면: 넣을 글 미리 보기 */
    async memoryPreview() {
      const b = $$("[data-testid=memory-start] .link-btn").find((x) => x.innerText.includes(T("미리 보기", "Preview")));
      click(b);
      await until(() => $(".mem-preview"));
      await wait(300);
      // 미리 보기가 보이게 창을 끝까지 내리고 위치를 적어 둔다(그림을 그릴 때 되돌린다)
      for (const el of [$("[data-testid=memory-start]"), $(".mem-preview")]) {
        el.scrollTop = el.scrollHeight;
        el.dataset.promoScroll = String(el.scrollTop);
      }
      const m = $("[data-testid=memory-start]");
      await wait(300);
      return m.scrollTop;
    },
    async closeMemory() {
      await closeModal();
      return 1;
    },
    /** 장면: 설정 → 작업 기억 */
    async memorySettings() {
      await inv("plugin:event|emit", { event: "open-settings", payload: null });
      await until(() => $("[data-testid=memory-settings] .mem-state"));
      await wait(500);
      return $("[data-testid=memory-settings] .mem-state").innerText;
    },
    async closeSettings() {
      escape();
      await wait(400);
      return 1;
    },
    /** 장면: 그래프와 브랜치 탭의 같은 브랜치 색 */
    async graph() {
      await select(T("정렬 버그 고치기", "Fix sorting bug"));
      await tab("graph");
      return 1;
    },
    async branches() {
      await tab("branches");
      return 1;
    },
    /** 장면: 남의 저장소를 처음 열면 — Git 설정 속 실행 명령은 믿기 전엔 꺼 둔다 */
    async trust() {
      const lib = `${W}/shared-lib`;
      await inv("repo_add", { path: lib });
      await st().refreshRepos();
      st().setFocusWorktree(lib);
      await until(() => $$(".modal h3").find((h) => h.innerText.includes(T("믿을까요", "Trust this"))), 10000);
      await wait(500);
      return 1;
    },
    async closeTrust() {
      const b = $$(".modal button").find((x) => x.innerText.trim() === T("취소", "Cancel"));
      if (b) click(b);
      await wait(300);
      st().setFocusWorktree(`${W}/todo-app`);
      await wait(800);
      return 1;
    },
  };
  return Object.keys(window.__promo).length;
})();
