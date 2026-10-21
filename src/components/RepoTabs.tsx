import { FolderGit2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { RepoSummary } from "../api";
import { t } from "../i18n";
import { useStore } from "../store";

const KEY = "aiterm.repoWorktrees";
function rememberedWorktrees(): Record<string, string> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      return Object.fromEntries(Object.entries(saved).filter(([, path]) => typeof path === "string"));
    }
  } catch { /* A missing or invalid preference does not prevent opening a repository. */ }
  return {};
}

/** Registered repositories remain open as tabs; switching only changes the view. */
export function RepoTabs() {
  const repos = useStore((s) => s.repos);
  const path = useStore((s) => s.focus?.worktreePath);
  const setFocus = useStore((s) => s.setFocusWorktree);
  const remembered = useRef<Record<string, string> | null>(null);
  remembered.current ??= rememberedWorktrees();
  const active = repos.find((r) => r.worktrees.some((w) => w.path === path));
  const activeTab = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!active || !path) return;
    remembered.current![active.id] = path;
    try { localStorage.setItem(KEY, JSON.stringify(remembered.current)); } catch { /* Keep in memory. */ }
    activeTab.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id, path]);

  const targetFor = (repo: RepoSummary) => {
    const available = repo.worktrees.filter((w) => w.exists && !w.bare);
    return available.find((w) => w.path === remembered.current![repo.id]) ?? available.find((w) => w.isMain) ?? available[0];
  };
  const select = (repo: RepoSummary) => {
    const target = targetFor(repo);
    if (target) setFocus(target.path);
  };
  if (!repos.length) return null;
  return (
    <nav className="repo-tabs" role="tablist" aria-label={t("저장소 탭")}>
      {repos.map((repo) => {
        const selected = active?.id === repo.id;
        return (
          <button key={repo.id} ref={selected ? activeTab : undefined} type="button" role="tab"
            className={`repo-tab${selected ? " active" : ""}`} aria-selected={selected}
            tabIndex={selected || !active ? 0 : -1} disabled={!targetFor(repo)} title={repo.path}
            data-repo-id={repo.id} onClick={() => select(repo)}
            onKeyDown={(e) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              const available = repos.filter((r) => targetFor(r));
              const index = available.findIndex((r) => r.id === repo.id);
              const next = e.key === "Home" ? 0 : e.key === "End" ? available.length - 1
                : (index + (e.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
              const target = available[next];
              if (target) {
                select(target);
                const tabs = e.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
                [...(tabs ?? [])].find((tab) => tab.dataset.repoId === target.id)?.focus();
              }
            }}>
            <FolderGit2 size={13} aria-hidden />
            <span>{repo.name}</span>
          </button>
        );
      })}
    </nav>
  );
}
