import { FolderGit2, Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { openRepository } from "../openRepository";
import { useStore } from "../store";

export function RepoTabs() {
  const repos = useStore((s) => s.repos);
  const ids = useStore((s) => s.openRepoIds);
  const path = useStore((s) => s.focus?.worktreePath);
  const select = useStore((s) => s.openRepoTab);
  const close = useStore((s) => s.closeRepoTab);
  const nav = useRef<HTMLElement>(null);
  const active = repos.find((r) => r.worktrees.some((w) => w.path === path));
  const opened = ids.flatMap((id) => repos.filter((r) => r.id === id));
  useEffect(() => { nav.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active?.id]);
  const closeTab = (id: string) => {
    close(id);
    requestAnimationFrame(() => (nav.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? nav.current?.querySelector<HTMLButtonElement>('.repo-tab-add'))?.focus());
  };
  return <nav ref={nav} className="repo-tabs" role="tablist" aria-label={t("저장소 탭")}>
    {opened.map((repo) => {
      const selected = active?.id === repo.id;
      return <div key={repo.id} className={`repo-tab-group${selected ? " active" : ""}`}>
        <button type="button" role="tab" className="repo-tab" aria-selected={selected}
          tabIndex={selected || !active ? 0 : -1} title={repo.path} data-repo-id={repo.id}
          disabled={!repo.worktrees.some((w) => w.exists && !w.bare)} onClick={() => select(repo.id)}
          onKeyDown={(e) => {
            if (e.key === "Delete") { e.preventDefault(); closeTab(repo.id); return; }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const tabs = [...(nav.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])];
            const index = tabs.indexOf(e.currentTarget);
            const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.click(); tabs[next]?.focus();
          }}><FolderGit2 size={13} aria-hidden /><span>{repo.name}</span></button>
        <button className="repo-tab-close" aria-label={t("{name} 탭 닫기", { name: repo.name })} title={t("탭 닫기")} onClick={() => closeTab(repo.id)}><X size={12} aria-hidden /></button>
      </div>;
    })}
    <button className="repo-tab-add" aria-label={t("저장소 추가")} title={t("저장소 추가")} onClick={openRepository}><Plus size={15} aria-hidden /></button>
  </nav>;
}
