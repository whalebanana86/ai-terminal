import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({
  api: { kvSet: async () => {}, kvGet: async () => null, extensionsList: async () => [], extensionSet: async () => [] },
  errorText: String,
}));
vi.mock("./panels/TerminalView", () => ({ exposeTerminals: () => {} }));
import { useExtensions } from "./extensions";
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
