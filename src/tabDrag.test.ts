import { beforeEach, describe, expect, it, vi } from "vitest";
const kv = vi.hoisted(() => ({ sets: [] as { key: string; value: string }[] }));
vi.mock("./api", () => ({
  api: {
    kvSet: async (key: string, value: string) => void kv.sets.push({ key, value }),
    kvGet: async () => null,
    extensionsList: async () => [],
    extensionSet: async () => [],
  },
  errorText: String,
}));
vi.mock("./panels/TerminalView", () => ({ exposeTerminals: () => {} }));
vi.mock("./panels/FilePanel", () => ({ FileViewer: () => null }));
import { fileTabId, useStore, type FileTab } from "./store";
import { createTabDrag, dragClass, moveNear, slotAt, slotTarget, type DragView } from "./tabDrag";

const id = (x: string) => x;
const last = <T,>(l: T[]) => l[l.length - 1];

describe("순서 바꾸기", () => {
  it("target 앞·뒤로 옮긴다", () => {
    expect(moveNear(["a", "b", "c", "d"], id, "d", "a", false)).toEqual(["d", "a", "b", "c"]);
    expect(moveNear(["a", "b", "c", "d"], id, "a", "c", true)).toEqual(["b", "c", "a", "d"]);
    expect(moveNear(["a", "b", "c", "d"], id, "b", "d", true)).toEqual(["a", "c", "d", "b"]);
    expect(moveNear(["a", "b", "c", "d"], id, "c", "b", false)).toEqual(["a", "c", "b", "d"]);
  });
  it("옮길 것이 없으면 같은 목록 그대로(저장·다시 그리기를 하지 않게)", () => {
    const l = ["a", "b"];
    expect(moveNear(l, id, "a", "a", false)).toBe(l);
    expect(moveNear(l, id, "x", "a", false)).toBe(l);
    expect(moveNear(l, id, "a", "x", false)).toBe(l);
  });
});

// 탭 셋: a(0~100) b(100~200) c(200~300) → 가운데 50·150·250
const rects = [
  { id: "a", left: 0, width: 100 },
  { id: "b", left: 100, width: 100 },
  { id: "c", left: 200, width: 100 },
];

describe("놓일 자리", () => {
  it("가운데가 포인터보다 왼쪽인 탭 수", () => {
    expect(slotAt(10, rects)).toBe(0);
    expect(slotAt(60, rects)).toBe(1);
    expect(slotAt(250, rects)).toBe(2);
    expect(slotAt(251, rects)).toBe(3);
    expect(slotAt(999, rects)).toBe(3);
  });
  it("제자리(자기 바로 앞·뒤)는 null, 맨 끝은 마지막 탭 뒤", () => {
    const ids = ["a", "b", "c"];
    expect(slotTarget(ids, "b", 1)).toBeNull();
    expect(slotTarget(ids, "b", 2)).toBeNull();
    expect(slotTarget(ids, "b", 0)).toEqual({ target: "a", after: false });
    expect(slotTarget(ids, "b", 3)).toEqual({ target: "c", after: true });
    expect(slotTarget(ids, "a", 2)).toEqual({ target: "c", after: false });
    expect(slotTarget(ids, "x", 0)).toBeNull();
  });
  it("표시: 끄는 탭은 흐리게, 자리 막대는 그 자리 탭 앞(맨 끝이면 마지막 탭 뒤)", () => {
    const ids = ["a", "b", "c"];
    const v = (slot: number | null): DragView => ({ id: "b", slot });
    expect(ids.map((x) => dragClass(null, ids, x))).toEqual(["", "", ""]);
    expect(ids.map((x) => dragClass(v(null), ids, x))).toEqual(["", " drag-src", ""]);
    expect(ids.map((x) => dragClass(v(0), ids, x))).toEqual([" drop-before", " drag-src", ""]);
    expect(ids.map((x) => dragClass(v(3), ids, x))).toEqual(["", " drag-src", " drop-after"]);
  });
});

describe("끌기 진행", () => {
  const setup = () => {
    const views: (DragView | null)[] = [];
    const moves: string[] = [];
    const d = createTabDrag({ id: "b", x: 150, y: 10, items: () => rects, onView: (v) => views.push(v), onMove: (i, t, after) => moves.push(`${i}→${after ? "뒤" : "앞"}:${t}`) });
    return { d, views, moves };
  };
  it("5px 넘게 움직여야 끌기. 그냥 누르고 떼면 옮기지 않고 누르기도 막지 않는다", () => {
    const { d, views, moves } = setup();
    d.move(153, 12);
    expect(d.state).toBe("idle");
    expect(views).toEqual([]);
    expect(d.drop(153)).toBe(false);
    expect(moves).toEqual([]);
  });
  it("끌어 맨 끝에 놓으면 마지막 탭 뒤로, 놓은 뒤 누르기는 막는다", () => {
    const { d, views, moves } = setup();
    d.move(160, 10);
    expect(d.state).toBe("drag");
    expect(last(views)).toEqual({ id: "b", slot: null });
    d.move(280, 10);
    expect(last(views)).toEqual({ id: "b", slot: 3 });
    d.move(20, 10);
    expect(last(views)).toEqual({ id: "b", slot: 0 });
    d.move(280, 10);
    expect(d.drop(280)).toBe(true);
    expect(moves).toEqual(["b→뒤:c"]);
    expect(last(views)).toBeNull();
  });
  it("맨 앞에 놓기", () => {
    const { d, moves } = setup();
    d.move(30, 10);
    d.drop(30);
    expect(moves).toEqual(["b→앞:a"]);
  });
  it("제자리로 돌아와 놓으면 옮기지 않지만 누르기는 막는다", () => {
    const { d, moves } = setup();
    d.move(260, 10);
    d.move(140, 10);
    expect(d.drop(140)).toBe(true);
    expect(moves).toEqual([]);
  });
  it("Esc 로 그만두면 막대가 사라지고, 그 뒤 움직이거나 놓아도 옮기지 않으며 누르기는 막는다", () => {
    const { d, views, moves } = setup();
    d.move(280, 10);
    d.cancel();
    expect(last(views)).toBeNull();
    d.move(20, 10);
    expect(last(views)).toBeNull();
    expect(d.drop(20)).toBe(true);
    expect(moves).toEqual([]);
  });
});

describe("스토어", () => {
  const W1 = "/r/one";
  const W2 = "/r/two";
  const tab = (worktree: string, rel: string): FileTab => {
    const viewer = { kind: "file" as const, rel, mode: "preview" as const };
    return { id: fileTabId(worktree, viewer), worktree, viewer };
  };
  beforeEach(() => {
    kv.sets.length = 0;
  });

  it("저장소 탭: 순서를 바꾸고 저장한다. 그대로면 저장하지 않는다", async () => {
    useStore.setState({ openRepoIds: ["r1", "r2", "r3"], repoTabPaths: { r1: "/p1" }, repoTabSessions: {} });
    useStore.getState().moveRepoTab("r3", "r1", false);
    expect(useStore.getState().openRepoIds).toEqual(["r3", "r1", "r2"]);
    await new Promise((r) => setTimeout(r, 0));
    const saved = kv.sets.filter((x) => x.key === "repoTabs").map((x) => JSON.parse(x.value).ids);
    expect(saved).toEqual([["r3", "r1", "r2"]]);
    useStore.getState().moveRepoTab("r1", "r1", true);
    await new Promise((r) => setTimeout(r, 0));
    expect(kv.sets.filter((x) => x.key === "repoTabs")).toHaveLength(1);
  });

  it("파일 탭: 보이는 탭 사이에서 옮기고, 섞여 있는 다른 저장소 탭끼리의 순서·보던 탭은 그대로", () => {
    const [a1, b1, a2, b2, a3] = [tab(W1, "a1.ts"), tab(W2, "b1.ts"), tab(W1, "a2.ts"), tab(W2, "b2.ts"), tab(W1, "a3.ts")];
    useStore.setState({ fileTabs: [a1, b1, a2, b2, a3], activeTab: a2.id });
    useStore.getState().moveFileTab(a3.id, a1.id, false);
    const ids = () => useStore.getState().fileTabs.map((x) => x.viewer.rel);
    expect(ids()).toEqual(["a3.ts", "a1.ts", "b1.ts", "a2.ts", "b2.ts"]);
    useStore.getState().moveFileTab(a1.id, a2.id, true);
    expect(ids()).toEqual(["a3.ts", "b1.ts", "a2.ts", "a1.ts", "b2.ts"]);
    const w1 = useStore.getState().fileTabs.filter((x) => x.worktree === W1).map((x) => x.viewer.rel);
    const w2 = useStore.getState().fileTabs.filter((x) => x.worktree === W2).map((x) => x.viewer.rel);
    expect(w1).toEqual(["a3.ts", "a2.ts", "a1.ts"]);
    expect(w2).toEqual(["b1.ts", "b2.ts"]);
    expect(useStore.getState().activeTab).toBe(a2.id);
  });
});
