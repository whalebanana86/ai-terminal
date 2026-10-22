import { openRepository } from "../openRepository";
import { Check, ChevronDown, FolderGit2, Plus, X } from "lucide-react";
import { t } from "../i18n";
import { baseName } from "../logic";
import { useStore } from "../store";
import { ExtensionSlot } from "../extensions";

export function TopBar() {
  const focus = useStore((s) => s.focus);
  const repos = useStore((s) => s.repos);
  const setFocus = useStore((s) => s.setFocusWorktree);

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region title={`${t("코드행방")} - ${t("AI가 어디서 무엇을 바꾸는지")}`}>
        <span className="brand-name" data-tauri-drag-region>{t("코드행방")}</span>
        <span className="brand-tagline" data-tauri-drag-region>{t("AI가 어디서 무엇을 바꾸는지")}</span>
      </div>
      <label className="folder-select" title={t("볼 워크트리를 고릅니다(저장소마다 하나 이상). 체크아웃은 하지 않아요.")}>
        <FolderGit2 size={14} aria-hidden className="wt-icon" />
        <select aria-label={t("볼 워크트리 고르기")} value={focus?.worktreePath ?? ""} onChange={(e) => e.target.value && setFocus(e.target.value)}>
          <option value="">{t("워크트리를 고르세요…")}</option>
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
      <button className="btn btn-small btn-ghost" onClick={openRepository} title={t("로컬 Git 저장소를 목록에 추가")}>
        <Plus size={14} aria-hidden /> {t("저장소 추가")}
      </button>
      <div className="spacer" data-tauri-drag-region />
      <ExtensionSlot name="topbar" />
    </header>
  );
}

/** 화면 맨 아래 상태줄: CLI 설치 상태 등 참고 정보 */
export function StatusBar() {
  const info = useStore((s) => s.info);
  const item = (name: string, path: string | null | undefined, extra?: string | null) => (
    <span className={path ? "ok" : "missing"} title={path ? `${path}${extra ? ` (${extra})` : ""}` : t("{name} 을(를) 찾지 못했습니다. 설치되어 있고 로그인 셸 PATH 에 있는지 확인하세요.", { name })}>
      {path ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />} {name}
    </span>
  );
  return (
    <footer className="statusbar" aria-label={t("상태")}>
      <span className="muted">CLI</span>
      {item("Claude Code", info?.claude)}
      {item("Codex", info?.codex)}
      {item("git", info?.git, info?.gitVersion)}
      <ExtensionSlot name="statusbar" />
      <span className="spacer" />
      <span className="muted" title={t("이 앱은 대화·코드를 외부로 보내지 않습니다")}>
        {t("로컬 전용")}
      </span>
    </footer>
  );
}
