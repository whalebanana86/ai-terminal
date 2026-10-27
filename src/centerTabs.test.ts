import { beforeEach, describe, expect, it, vi } from "vitest";
const saved = vi.hoisted(() => ({ calls: [] as string[], conflict: new Set<string>() }));
vi.mock("./api", () => ({
  api: {
    kvSet: async () => {},
    kvGet: async () => null,
    extensionsList: async () => [],
    extensionSet: async () => [],
    saveFile: async (a: { rel: string; text: string }) => {
      saved.calls.push(`${a.rel}=${a.text}`);
      return { saved: !saved.conflict.has(a.rel), hash: "h2" };
    },
  },
  errorText: String,
}));
vi.mock("./panels/TerminalView", () => ({ exposeTerminals: () => {} }));
vi.mock("./panels/FilePanel", () => ({ FileViewer: () => null }));
import { Text } from "@codemirror/state";
import { getDraft, setDraft } from "./extensions/editor/drafts";
import { useExtensions } from "./extensions";
import { closeFileTabs } from "./panels/CenterTabs";
import { fileTabId, useStore } from "./store";

const editor = (on: boolean) => useExtensions.setState({ loaded: true, enabled: { editor: on, stickman: true, usage: true } });
const focus = (p: string) => useStore.setState({ focus: { worktreePath: p, source: "manual" } });

describe("가운데 칸 파일 탭", () => {
  beforeEach(() => {
    editor(false);
    useStore.setState({ viewer: null, fileTabs: [], activeTab: null, focus: null, sessions: [] });
  });

  it("파일 편집이 꺼져 있으면 오른쪽 아래에 연다", () => {
    focus("/w");
    useStore.getState().openViewer({ kind: "file", rel: "a.ts", mode: "preview" });
    expect(useStore.getState().viewer).toEqual({ kind: "file", rel: "a.ts", mode: "preview" });
    expect(useStore.getState().fileTabs).toEqual([]);
  });

  it("지금 탭을 닫으면 같은 저장소의 탭으로 간다(다른 저장소의 숨은 탭이 아니라)", () => {
    editor(true);
    const open = (wt: string, rel: string) => {
      focus(wt);
      useStore.getState().openViewer({ kind: "file", rel, mode: "preview" });
    };
    open("/a", "a1.ts");
    open("/b", "b1.ts");
    open("/a", "a2.ts");
    const [a1, , a2] = useStore.getState().fileTabs.map((x) => x.id);
    useStore.getState().setActiveTab(a1);
    useStore.getState().setTabViewer(a1, null);
    expect(useStore.getState().activeTab).toBe(a2);
    open("/a", "a3.ts");
    useStore.getState().closeTabs([useStore.getState().activeTab!]);
    expect(useStore.getState().activeTab).toBe(a2);
  });

  it("켜져 있으면 탭으로 열고, 같은 파일은 한 탭만", () => {
    editor(true);
    focus("/w");
    const s = () => useStore.getState();
    const modeOf = (i: number) => {
      const v = s().fileTabs[i].viewer;
      return v.kind === "file" ? v.mode : null;
    };
    s().openViewer({ kind: "file", rel: "a.ts", mode: "preview" });
    s().openViewer({ kind: "file", rel: "b.ts", mode: "diff" });
    expect(s().fileTabs.map((x) => x.viewer.rel)).toEqual(["a.ts", "b.ts"]);
    expect(s().activeTab).toBe(fileTabId("/w", { kind: "file", rel: "b.ts", mode: "diff" }));
    expect(s().viewer).toBeNull();
    // 트리에서 다시 누르면(keepMode) 보던 모드 그대로, 다른 곳에서 모드를 정해 열면 그 모드로
    s().setTabViewer(s().fileTabs[0].id, { kind: "file", rel: "a.ts", mode: "ext:editor" });
    s().openViewer({ kind: "file", rel: "a.ts", mode: "diff" }, { keepMode: true });
    expect(modeOf(0)).toBe("ext:editor");
    expect(s().fileTabs).toHaveLength(2);
    s().openViewer({ kind: "file", rel: "a.ts", mode: "stage" });
    expect(modeOf(0)).toBe("stage");
    // 다른 워크트리의 같은 이름 파일·커밋 파일은 다른 탭
    focus("/w2");
    s().openViewer({ kind: "file", rel: "a.ts", mode: "preview" });
    s().openViewer({ kind: "commit-file", sha: "abc1234", rel: "a.ts" });
    expect(s().fileTabs).toHaveLength(4);
    expect(new Set(s().fileTabs.map((x) => x.worktree))).toEqual(new Set(["/w", "/w2"]));
  });

  it("닫으면 옆 탭, 마지막이면 에이전트. 세션을 고르면 에이전트로", () => {
    editor(true);
    focus("/w");
    const s = () => useStore.getState();
    for (const rel of ["a", "b", "c"]) s().openViewer({ kind: "file", rel, mode: "preview" });
    s().setActiveTab(s().fileTabs[1].id);
    s().setTabViewer(s().fileTabs[1].id, null);
    expect(s().fileTabs.map((x) => x.viewer.rel)).toEqual(["a", "c"]);
    expect(s().activeTab).toBe(s().fileTabs[1].id);
    s().setTabViewer(s().fileTabs[1].id, null);
    s().setTabViewer(s().fileTabs[0].id, null);
    expect(s().activeTab).toBeNull();
    s().openViewer({ kind: "file", rel: "a", mode: "preview" });
    s().selectSession(null);
    expect(s().activeTab).toBeNull();
    expect(s().fileTabs).toHaveLength(1);
  });

  it("기능을 끄면 지금 탭은 오른쪽 아래로, 켜면 오른쪽 아래 파일을 탭으로", () => {
    editor(true);
    focus("/w");
    const s = () => useStore.getState();
    s().openViewer({ kind: "file", rel: "a", mode: "diff" });
    editor(false);
    expect(s().fileTabs).toEqual([]);
    expect(s().viewer).toEqual({ kind: "file", rel: "a", mode: "diff" });
    editor(true);
    expect(s().viewer).toBeNull();
    expect(s().fileTabs.map((x) => x.viewer.rel)).toEqual(["a"]);
  });
});

describe("탭 여러 개 닫기", () => {
  const s = () => useStore.getState();
  const open = (...rels: string[]) => rels.forEach((rel) => s().openViewer({ kind: "file", rel, mode: "preview" }));
  const id = (rel: string) => fileTabId("/w", { kind: "file", rel, mode: "preview" });
  const draft = (rel: string, text: string) => setDraft("/w", rel, { doc: Text.of([text]), hash: "h1", crlf: false, bom: false });
  /** 확인창이 뜨면 답한다 */
  const answer = async (a: boolean | "alt") => {
    for (let i = 0; i < 20 && !s().confirm; i++) await new Promise((r) => setTimeout(r, 0));
    s().confirm!.resolve(a);
  };
  beforeEach(() => {
    useExtensions.setState({ loaded: true, enabled: { editor: true, stickman: true, usage: true } });
    useStore.setState({ viewer: null, fileTabs: [], activeTab: null, focus: { worktreePath: "/w", source: "manual" }, confirm: null, toasts: [] });
    saved.calls = [];
    saved.conflict.clear();
  });

  it("지금 탭이 닫히면 가장 가까운 남은 탭으로", () => {
    open("a", "b", "c", "d");
    s().setActiveTab(id("b"));
    s().closeTabs([id("b"), id("c")]);
    expect(s().fileTabs.map((x) => x.viewer.rel)).toEqual(["a", "d"]);
    expect(s().activeTab).toBe(id("d"));
    s().closeTabs([id("d")]);
    expect(s().activeTab).toBe(id("a"));
    s().closeTabs([id("a")]);
    expect(s().activeTab).toBeNull();
  });

  it("저장 안 한 수정이 없으면 묻지 않고 모두 닫는다", async () => {
    open("a", "b");
    await closeFileTabs(s().fileTabs.map((x) => x.id));
    expect(s().fileTabs).toEqual([]);
  });

  it("묻고: 취소 → 그대로, 저장하지 않고 닫기 → 수정 버림", async () => {
    open("a", "b");
    draft("a", "mine");
    let p = closeFileTabs(s().fileTabs.map((x) => x.id));
    await answer(false);
    await p;
    expect(s().fileTabs).toHaveLength(2);
    expect(getDraft("/w", "a")).toBeDefined();
    p = closeFileTabs(s().fileTabs.map((x) => x.id));
    await answer("alt");
    await p;
    expect(s().fileTabs).toEqual([]);
    expect(getDraft("/w", "a")).toBeUndefined();
    expect(saved.calls).toEqual([]);
  });

  it("저장하고 닫기 → 저장한 건 닫고, 밖에서 바뀌어 못 저장한 건 남긴다", async () => {
    open("a", "b", "c");
    draft("a", "mine a");
    draft("b", "mine b");
    saved.conflict.add("b");
    const p = closeFileTabs(s().fileTabs.map((x) => x.id));
    await answer(true);
    await p;
    expect(saved.calls).toEqual(["a=mine a", "b=mine b"]);
    expect(s().fileTabs.map((x) => x.viewer.rel)).toEqual(["b"]);
    expect(getDraft("/w", "a")).toBeUndefined();
    expect(getDraft("/w", "b")).toBeDefined();
    expect(s().toasts.some((x) => x.kind === "error" && x.text.includes("b"))).toBe(true);
  });
});

describe("저장소마다 따로 보이는 탭", () => {
  const wt = (path: string, isMain = true) => ({ path, head: null, branch: "main", detached: false, bare: false, isMain, locked: null, prunable: null, exists: true });
  const repo = (id: string, ...paths: string[]) => ({ id, path: paths[0], name: id, pinned: false, addedAt: 0, exists: true, worktrees: paths.map((p, i) => wt(p, i === 0)), error: null });
  const s = () => useStore.getState();
  const shown = () => (s().activeTab && s().fileTabs.some((x) => x.id === s().activeTab) ? s().activeTab : null);
  beforeEach(() => {
    editor(true);
    useStore.setState({ viewer: null, fileTabs: [], activeTab: null, tabMemory: {}, focus: null, sessions: [], selectedSessionId: null, repos: [repo("A", "/a", "/a-wt"), repo("B", "/b")] });
  });

  it("다른 저장소에서 연 탭은 숨기고, 돌아오면 마지막으로 보던 탭을 다시 보여 준다", async () => {
    const { visibleTabs, shownTab } = await import("./store");
    s().setFocusWorktree("/a");
    s().openViewer({ kind: "file", rel: "Makefile", mode: "preview" });
    const aTab = s().activeTab;
    s().setFocusWorktree("/b");
    expect(visibleTabs(s())).toEqual([]);
    expect(shownTab(s())).toBeUndefined();
    expect(shown()).toBeNull();
    s().openViewer({ kind: "file", rel: "README.md", mode: "preview" });
    expect(visibleTabs(s()).map((x) => x.viewer.rel)).toEqual(["README.md"]);
    s().setFocusWorktree("/a");
    expect(visibleTabs(s()).map((x) => x.viewer.rel)).toEqual(["Makefile"]);
    expect(s().activeTab).toBe(aTab);
    // 같은 저장소의 다른 워크트리로 옮겨도 탭은 그대로
    s().setFocusWorktree("/a-wt");
    expect(visibleTabs(s()).map((x) => x.viewer.rel)).toEqual(["Makefile"]);
    expect(s().activeTab).toBe(aTab);
  });
});
