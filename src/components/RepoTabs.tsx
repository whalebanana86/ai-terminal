import { FolderGit2, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { t } from "../i18n";
import { openRepository } from "../openRepository";
import { agentSummary, agentsByRepo, stateLabel, topState } from "../repoAgents";
import { useStore } from "../store";
import { dragClass, useTabDrag } from "../tabDrag";

export function RepoTabs() {
  const repos = useStore((s) => s.repos);
  const ids = useStore((s) => s.openRepoIds);
  const path = useStore((s) => s.focus?.worktreePath);
  const select = useStore((s) => s.openRepoTab);
  const close = useStore((s) => s.closeRepoTab);
  const move = useStore((s) => s.moveRepoTab);
  const sessions = useStore((s) => s.sessions);
  const liveRuns = useStore((s) => s.liveRuns);
  const execs = useStore((s) => s.execs);
  const nav = useRef<HTMLElement>(null);
  // 탭을 끌어 순서 바꾸기(누르기만 하면 그대로 고르기)
  const drag = useTabDrag(nav, move);
  const active = repos.find((r) => r.worktrees.some((w) => w.path === path));
  const opened = ids.flatMap((id) => repos.filter((r) => r.id === id));
  const order = opened.map((r) => r.id);
  // 저장소마다 지금 도는 AI(앱 터미널 + 앱 밖). 실행 감지가 5초마다 바뀐 것만 알려 준다
  const agents = useMemo(() => agentsByRepo(repos, sessions, liveRuns, execs), [repos, sessions, liveRuns, execs]);
  useEffect(() => { nav.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [active?.id]);
  const closeTab = (id: string) => {
    close(id);
    requestAnimationFrame(() => (nav.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ?? nav.current?.querySelector<HTMLButtonElement>('.repo-tab-add'))?.focus());
  };
  return <nav ref={nav} className="repo-tabs" role="tablist" aria-label={t("저장소 탭")} onClickCapture={drag.guardClick}>
    {opened.map((repo) => {
      const selected = active?.id === repo.id;
      const ai = agents.get(repo.id);
      const state = topState(ai);
      return <div key={repo.id} className={`repo-tab-group${selected ? " active" : ""}${dragClass(drag.view, order, repo.id)}`}
        data-drag-id={repo.id} onMouseDown={(e) => drag.start(e, repo.id)}>
        <button type="button" role="tab" className="repo-tab" aria-selected={selected}
          tabIndex={selected || !active ? 0 : -1} title={ai && state ? `${repo.path}\n${agentSummary(ai)}` : repo.path} data-repo-id={repo.id}
          disabled={!repo.worktrees.some((w) => w.exists && !w.bare)} onClick={() => select(repo.id)}
          onKeyDown={(e) => {
            if (e.key === "Delete") { e.preventDefault(); closeTab(repo.id); return; }
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const tabs = [...(nav.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? [])];
            const index = tabs.indexOf(e.currentTarget);
            const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next]?.click(); tabs[next]?.focus();
          }}><FolderGit2 size={13} aria-hidden /><span>{repo.name}</span>
          {state && <span className={`repo-tab-ai ai-${state}`} role="img" aria-label={t("AI {state}", { state: stateLabel(state) })} data-ai={state} />}</button>
        <button className="repo-tab-close" aria-label={t("{name} 탭 닫기", { name: repo.name })} title={t("탭 닫기")} onClick={() => closeTab(repo.id)}><X size={12} aria-hidden /></button>
      </div>;
    })}
    <button className="repo-tab-add" aria-label={t("저장소 추가")} title={t("저장소 추가")} onClick={openRepository}><Plus size={15} aria-hidden /></button>
  </nav>;
}
