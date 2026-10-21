import { open } from "@tauri-apps/plugin-dialog";
import { api, errorText } from "../api";
import { Check, ChevronDown, FolderGit2, Plus, X } from "lucide-react";
import { baseName } from "../logic";
import { useStore } from "../store";
import { StickBuddy } from "./StickBuddy";

export function TopBar() {
  const focus = useStore((s) => s.focus);
  const repos = useStore((s) => s.repos);
  const refreshRepos = useStore((s) => s.refreshRepos);
  const setFocus = useStore((s) => s.setFocusWorktree);
  const toast = useStore((s) => s.toast);

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
      <label className="folder-select" title="볼 워크트리를 고릅니다(저장소마다 하나 이상). 체크아웃은 하지 않아요.">
        <FolderGit2 size={14} aria-hidden className="wt-icon" />
        <select aria-label="볼 워크트리 고르기" value={focus?.worktreePath ?? ""} onChange={(e) => e.target.value && setFocus(e.target.value)}>
          <option value="">워크트리를 고르세요…</option>
          {repos.map((r) => (
            <optgroup key={r.id} label={r.name}>
              {r.worktrees
                .filter((w) => w.exists && !w.bare)
                .map((w) => (
                  <option key={w.path} value={w.path}>
                    {baseName(w.path) === r.name ? r.name : `${r.name} / ${baseName(w.path)}`}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown size={14} aria-hidden className="select-caret" />
      </label>
      <button className="btn btn-small btn-ghost" onClick={addRepo} title="로컬 Git 저장소를 목록에 추가">
        <Plus size={14} aria-hidden /> 저장소 추가
      </button>
      <div className="spacer" data-tauri-drag-region />
      <StickBuddy />
    </header>
  );
}

/** 화면 맨 아래 상태줄: CLI 설치 상태 등 참고 정보 */
export function StatusBar() {
  const info = useStore((s) => s.info);
  const item = (name: string, path: string | null | undefined, extra?: string | null) => (
    <span className={path ? "ok" : "missing"} title={path ? `${path}${extra ? ` (${extra})` : ""}` : `${name} 을(를) 찾지 못했습니다. 설치되어 있고 로그인 셸 PATH 에 있는지 확인하세요.`}>
      {path ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />} {name}
    </span>
  );
  return (
    <footer className="statusbar" aria-label="상태">
      <span className="muted">CLI</span>
      {item("Claude Code", info?.claude)}
      {item("Codex", info?.codex)}
      {item("git", info?.git, info?.gitVersion)}
      <span className="spacer" />
      <span className="muted" title="이 앱은 대화·코드를 외부로 보내지 않습니다">로컬 전용</span>
    </footer>
  );
}
