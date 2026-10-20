import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { branchLabel, baseName } from "../logic";
import { useFocusRepo, useSelectedSession, useStore } from "../store";

export function TopBar() {
  const info = useStore((s) => s.info);
  const focus = useStore((s) => s.focus);
  const repos = useStore((s) => s.repos);
  const refreshRepos = useStore((s) => s.refreshRepos);
  const setFocus = useStore((s) => s.setFocusWorktree);
  const toast = useStore((s) => s.toast);
  const repo = useFocusRepo();
  const session = useSelectedSession();
  const wt = repo?.worktrees.find((w) => w.path === focus?.worktreePath);

  const addRepo = async () => {
    const dir = await open({ directory: true, multiple: false, title: "Git 저장소 폴더 선택" });
    if (typeof dir !== "string") return;
    try {
      const r = await api.repoAdd(dir);
      await refreshRepos();
      const fresh = useStore.getState().repos.find((x) => x.id === r.id);
      const target = fresh?.worktrees.find((w) => w.path === dir) ?? fresh?.worktrees[0];
      if (target) setFocus(target.path);
      toast("success", `저장소를 추가했습니다: ${r.name}`);
    } catch (e) {
      toast("error", errorText(e));
    }
  };

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        AI Terminal
      </div>
      <select
        className="repo-select"
        aria-label="저장소와 워크트리 선택"
        value={focus?.worktreePath ?? ""}
        onChange={(e) => e.target.value && setFocus(e.target.value)}
      >
        <option value="">저장소 / 워크트리 선택…</option>
        {repos.map((r) => (
          <optgroup key={r.id} label={`${r.name}${r.pinned ? "" : " (세션에서 발견)"}`}>
            {r.worktrees
              .filter((w) => w.exists && !w.bare)
              .map((w) => (
                <option key={w.path} value={w.path}>
                  {baseName(w.path)} — {w.detached ? `detached ${w.head?.slice(0, 7) ?? ""}` : w.branch ?? "?"}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <button className="btn btn-small" onClick={addRepo} title="로컬 Git 저장소 추가">
        + 저장소
      </button>
      <div className="focus-path" data-tauri-drag-region title={focus?.worktreePath}>
        {focus ? (
          <>
            <span className="muted">보는 중</span> <b>{repo?.name ?? baseName(focus.worktreePath)}</b>
            <span className="muted"> › </span>
            {baseName(focus.worktreePath)}
            <span className="muted"> › </span>
            <span className="branch-chip">{wt ? (wt.detached ? `detached ${wt.head?.slice(0, 7)}` : branchLabel(wt.branch)) : "…"}</span>
            {focus.source === "session" && session && <span className="muted"> · 세션 기준</span>}
          </>
        ) : (
          <span className="muted">세션이나 저장소를 고르세요</span>
        )}
      </div>
      <div className="cli-status">
        <span className={info?.claude ? "ok" : "missing"} title={info?.claude ?? "claude 를 PATH 에서 찾지 못함"}>
          claude
        </span>
        <span className={info?.codex ? "ok" : "missing"} title={info?.codex ?? "codex 를 PATH 에서 찾지 못함"}>
          codex
        </span>
        <span className={info?.git ? "ok" : "missing"} title={info?.gitVersion ?? "git 없음"}>
          git
        </span>
      </div>
    </header>
  );
}
