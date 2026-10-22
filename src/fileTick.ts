import { useRef } from "react";
import { useStore } from "./store";

/** 이 파일이 바뀐 신호(또는 .git 변경)일 때만 값이 바뀐다 → 다른 파일 이벤트로는 다시 읽지 않는다. */
export function useFileTick(rel: string): number {
  const fs = useStore((s) => (s.changedPaths.includes(rel) ? s.fsTick : -1));
  const git = useStore((s) => s.gitTick);
  const last = useRef(0);
  if (fs >= 0) last.current = fs;
  return last.current * 100000 + git;
}
