import { useRef } from "react";
import { useStore } from "./store";

/**
 * 이 파일이 바뀐 신호(또는 .git 변경)일 때만 값이 바뀐다 → 다른 파일 이벤트로는 다시 읽지 않는다.
 * 보고 있는 워크트리는 화면 전체가 쓰는 신호를, 다른 워크트리(가운데 탭에 연 파일)는 워크트리별 신호를 따른다.
 */
export function useFileTick(rel: string, worktree: string): number {
  const fs = useStore((s) => {
    if (s.focus?.worktreePath === worktree) return s.changedPaths.includes(rel) ? s.fsTick : -1;
    const g = s.fsSignals[worktree];
    return g && g.paths.includes(rel) ? g.n : -1;
  });
  const git = useStore((s) => (s.focus?.worktreePath === worktree ? s.gitTick : (s.gitSignals[worktree] ?? 0)));
  const last = useRef(0);
  if (fs >= 0) last.current = fs;
  return last.current * 100000 + git;
}
