import { useMemo } from "react";
import type { GraphRow, RepoSummary, Worktree } from "./api";
import { useStore } from "./store";

/** 워크트리 색(노선 색). 0번은 메인 워크트리 = 앱 강조색. */
export const WT_COLORS = ["#4cc2ff", "#ff8a5b", "#4fd18b", "#c792ff", "#f5c542", "#ff6fb1", "#45d6c6", "#9fb0ff"];

const KEY = "aiterm.wtColors";

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * 한 저장소의 워크트리들에 색 번호를 준다. 메인은 늘 0, 나머지는 예전에 받은 색을 그대로 쓰고
 * (다른 워크트리를 지워도 색이 바뀌지 않게) 처음 보는 워크트리는 남은 색 중 첫 번째를 받는다.
 */
export function assignWorktreeColors(worktrees: { path: string; isMain: boolean }[], saved: Record<string, number>): Record<string, number> {
  const n = WT_COLORS.length;
  const out: Record<string, number> = {};
  const taken = new Set<number>();
  const main = worktrees.find((w) => w.isMain);
  if (main) {
    out[main.path] = 0;
    taken.add(0);
  }
  const rest = worktrees.filter((w) => w !== main);
  // 예전 색을 먼저 돌려준 다음, 새 워크트리에 빈 색을 나눈다.
  for (const w of rest) {
    const c = saved[w.path];
    if (Number.isInteger(c) && c > 0 && c < n && !taken.has(c)) {
      out[w.path] = c;
      taken.add(c);
    }
  }
  for (const w of rest) {
    if (out[w.path] !== undefined) continue;
    let c = -1;
    for (let i = 1; i < n; i++) if (!taken.has(i)) (c = i), (i = n);
    if (c < 0) c = 1 + (hash(w.path) % (n - 1)); // 색이 모자라면 겹치는 걸 감수
    out[w.path] = c;
    taken.add(c);
  }
  return out;
}

function loadSaved(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

let cache: { repos: RepoSummary[]; map: Map<string, string> } | null = null;

/** 저장소 목록 전체의 워크트리 경로 → 색. 저장소 목록이 바뀔 때만 다시 계산하고 배정은 기억해 둔다. */
export function worktreeColorMap(repos: RepoSummary[]): Map<string, string> {
  if (cache?.repos === repos) return cache.map;
  const saved = loadSaved();
  const map = new Map<string, string>();
  let dirty = false;
  for (const r of repos) {
    const idx = assignWorktreeColors(r.worktrees.filter((w) => !w.bare), saved);
    for (const [p, c] of Object.entries(idx)) {
      map.set(p, WT_COLORS[c]);
      if (saved[p] !== c) (saved[p] = c), (dirty = true);
    }
  }
  if (dirty) {
    // 렌더 중에 불리므로 저장 공간이 차도(QuotaExceeded) 던지지 않는다: 던지면 앱 화면 전체가 하얗게 된다
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* 색은 이번 실행 동안만 유지 */
    }
  }
  cache = { repos, map };
  return map;
}

/** 목록에 아직 없는 워크트리(방금 만든 것 등)는 경로로 정한 임시 색 */
export function colorOf(map: Map<string, string>, path: string | null | undefined): string {
  if (!path) return "var(--fg-faint)";
  return map.get(path) ?? WT_COLORS[1 + (hash(path) % (WT_COLORS.length - 1))];
}

export function useWtColors(): Map<string, string> {
  const repos = useStore((s) => s.repos);
  return useMemo(() => worktreeColorMap(repos), [repos]);
}

export function useWtColor(path: string | null | undefined): string {
  return colorOf(useWtColors(), path);
}

/**
 * 지하철 노선: 각 워크트리 HEAD 에서 첫 부모를 따라 내려간 커밋을 그 워크트리 색으로 칠한다.
 * 메인이 먼저 줄기를 차지하고, 다른 워크트리는 줄기와 만나는 곳(갈라진 지점)까지만 자기 색이다.
 * 반환: 커밋별 노선 색, 그리고 행마다 선분(segments 와 같은 순서)의 노선 색(없으면 undefined = 일반 레인).
 */
export function metroColors(
  rows: GraphRow[],
  worktrees: Worktree[],
  color: (path: string) => string,
  history: Record<string, string> = {},
): { node: Map<string, string>; seg: Map<string, (string | undefined)[]> } {
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const node = new Map<string, string>();
  const ordered = [...worktrees.filter((w) => w.isMain), ...worktrees.filter((w) => !w.isMain)];
  for (const w of ordered) {
    if (!w.head || w.bare) continue;
    const c = color(w.path);
    let cur = bySha.get(w.head);
    while (cur && !node.has(cur.sha)) {
      node.set(cur.sha, c);
      cur = cur.parents[0] ? bySha.get(cur.parents[0]) : undefined;
    }
  }
  // 브랜치/워크트리가 사라져도 커밋에 기록한 노선 색을 유지한다.
  // 병합의 두 번째 이후 부모는 별도 줄기로 칠하고, 공통 조상에서는 멈춘다.
  const paint = (start: string) => {
    let known = bySha.get(start);
    while (known && !node.has(known.sha) && !history[known.sha]) {
      known = known.parents[0] ? bySha.get(known.parents[0]) : undefined;
    }
    const c = (known && !node.has(known.sha) ? history[known.sha] : undefined)
      ?? WT_COLORS[1 + (hash(start) % (WT_COLORS.length - 1))];
    let cur = bySha.get(start);
    while (cur && !node.has(cur.sha)) {
      node.set(cur.sha, history[cur.sha] ?? c);
      cur = cur.parents[0] ? bySha.get(cur.parents[0]) : undefined;
    }
  };
  for (const r of rows) {
    if (!node.has(r.sha)) paint(r.sha);
    for (const parent of r.parents.slice(1)) paint(parent);
  }
  // 레인(색 번호)마다 지금 그 레인이 나르는 선의 노선 색. 위에서 아래로 한 번 훑는다.
  const slot = new Map<number, string | undefined>();
  const seg = new Map<string, (string | undefined)[]>();
  for (const r of rows) {
    const out: (string | undefined)[] = [];
    let pi = 0;
    for (const s of r.segments) {
      if (s.fromY === 0) {
        out.push(slot.get(s.color));
        continue;
      }
      // 이 커밋에서 부모로 내려가는 선: 첫 부모 선은 이 커밋의 노선, 병합으로 들어온 선은 부모 쪽 노선.
      const p = r.parents[pi];
      const c = pi === 0 ? node.get(r.sha) : (node.get(p) ?? node.get(r.sha));
      pi++;
      out.push(c);
      // 이미 다른 선이 쓰는 레인에 합류한 경우가 아니면 이 레인의 노선 색을 바꾼다.
      if (s.color === r.color || !slot.has(s.color)) slot.set(s.color, c);
    }
    seg.set(r.sha, out);
  }
  return { node, seg };
}
