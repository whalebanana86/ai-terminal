import { describe, expect, it } from "vitest";
import type { GraphRow, Worktree } from "./api";
import { assignWorktreeColors, metroColors } from "./wtColors";

const wt = (path: string, head: string, isMain = false): Worktree => ({ path, head, branch: path, detached: false, bare: false, isMain, locked: null, prunable: null, exists: true });

describe("assignWorktreeColors", () => {
  it("메인은 0, 나머지는 빈 색을 차례로", () => {
    expect(assignWorktreeColors([wt("/m", "", true), wt("/a", ""), wt("/b", "")], {})).toEqual({ "/m": 0, "/a": 1, "/b": 2 });
  });
  it("예전 색을 유지(앞 워크트리를 지워도 바뀌지 않음)", () => {
    expect(assignWorktreeColors([wt("/m", "", true), wt("/b", "")], { "/a": 1, "/b": 2 })).toEqual({ "/m": 0, "/b": 2 });
  });
  it("새 워크트리는 남은 색 중 첫 번째, 같은 색은 두 번 주지 않음", () => {
    expect(assignWorktreeColors([wt("/m", "", true), wt("/b", ""), wt("/c", ""), wt("/d", "")], { "/b": 1, "/c": 1 })).toEqual({ "/m": 0, "/b": 1, "/c": 2, "/d": 3 });
  });
});

// main: c3 ← c1 ← c0, topic(c2) 은 c1 에서 갈라짐. 레인 배치는 Rust layout 과 같은 모양으로 손으로 적었다.
const rows: GraphRow[] = [
  { sha: "c3", parents: ["c1"], author: "", email: "", time: 0, coAuthors: [], subject: "", lane: 0, color: 0, width: 1, segments: [{ fromLane: 0, fromY: 1, toLane: 0, toY: 2, color: 0 }] },
  {
    sha: "c2", parents: ["c1"], author: "", email: "", time: 0, coAuthors: [], subject: "", lane: 1, color: 1, width: 2,
    segments: [{ fromLane: 0, fromY: 0, toLane: 0, toY: 2, color: 0 }, { fromLane: 1, fromY: 1, toLane: 1, toY: 2, color: 1 }],
  },
  {
    sha: "c1", parents: ["c0"], author: "", email: "", time: 0, coAuthors: [], subject: "", lane: 0, color: 0, width: 2,
    segments: [{ fromLane: 0, fromY: 0, toLane: 0, toY: 1, color: 0 }, { fromLane: 1, fromY: 0, toLane: 0, toY: 1, color: 1 }, { fromLane: 0, fromY: 1, toLane: 0, toY: 2, color: 0 }],
  },
  { sha: "c0", parents: [], author: "", email: "", time: 0, coAuthors: [], subject: "", lane: 0, color: 0, width: 1, segments: [{ fromLane: 0, fromY: 0, toLane: 0, toY: 1, color: 0 }] },
];

describe("metroColors", () => {
  const col = (p: string) => (p === "/m" ? "M" : "T");
  it("메인이 줄기를, 다른 워크트리는 갈라진 곳까지만", () => {
    const { node, seg } = metroColors(rows, [wt("/t", "c2"), wt("/m", "c3", true)], col);
    expect([...node.entries()]).toEqual([["c3", "M"], ["c1", "M"], ["c0", "M"], ["c2", "T"]]);
    expect(seg.get("c2")).toEqual(["M", "T"]);
    // 갈라진 지점으로 모이는 곡선은 topic 색, 아래 줄기는 메인 색
    expect(seg.get("c1")).toEqual(["M", "T", "M"]);
  });
  it("워크트리가 없는 갈래는 일반 레인색(undefined)", () => {
    const { seg } = metroColors(rows, [wt("/m", "c3", true)], col);
    expect(seg.get("c2")).toEqual(["M", undefined]);
    expect(seg.get("c1")).toEqual(["M", undefined, "M"]);
  });
});
