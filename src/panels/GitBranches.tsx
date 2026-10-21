import { FolderOpen, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type GitRef, type GraphData, type Worktree, type WorktreeStatus } from "../api";
import { ContextMenu, type MenuItem } from "../components/Overlays";
import * as ga from "../gitActions";
import { baseName, branchLabel, relativeTime } from "../logic";
import { useStore } from "../store";

/** 머리글의 현재 브랜치 표시 겸 빠른 전환 메뉴 */
export function BranchSwitcher({ worktree, status, graph, repoPath }: { worktree: string; status: WorktreeStatus; graph: GraphData; repoPath: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", esc, true);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const label = status.detached ? `브랜치 없음 (${status.head?.slice(0, 7) ?? ""})` : branchLabel(status.branch);
  const needle = q.trim().toLowerCase();
  const refs = graph.refs.filter((r) => r.kind !== "tag" && (!needle || r.short.toLowerCase().includes(needle)));
  const pick = (r: GitRef) => {
    setOpen(false);
    void ga.checkout(worktree, r.short, r.kind === "remote" ? "remote" : "branch", graph.worktrees);
  };
  return (
    <div className="switcher" ref={box}>
      <button className="branch-chip strong as-button" data-testid="git-current-branch" onClick={() => setOpen(!open)} title="눌러서 브랜치 전환 (체크아웃)">
        {label}
      </button>
      {open && (
        <div className="switcher-pop" role="dialog" aria-label="브랜치 바꾸기">
          <input className="text-input" autoFocus placeholder="브랜치 찾기" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="switcher-actions">
            <button
              className="btn btn-small"
              onClick={() => {
                setOpen(false);
                void ga.createBranch(worktree, "HEAD", `현재 HEAD (${label})`);
              }}
            >
              새 브랜치…
            </button>
            <button
              className="btn btn-small"
              title="지금 워크트리를 건드리지 않고 다른 폴더에서 작업"
              onClick={() => {
                setOpen(false);
                void ga.newWorktree(repoPath, { base: status.branch ?? "HEAD" });
              }}
            >
              새 워크트리…
            </button>
          </div>
          <ul className="switcher-list">
            {refs.map((r) => {
              const cur = r.kind === "branch" && r.short === status.branch;
              const other = r.kind === "branch" ? graph.worktrees.find((w) => w.branch === r.short && w.path !== worktree) : undefined;
              return (
                <li key={r.name}>
                  <button className={`switcher-item${cur ? " cur" : ""}`} disabled={cur} onClick={() => pick(r)}>
                    <span className={`ref ref-${r.kind}`}>{r.short}</span>
                    {cur && <span className="muted small">현재</span>}
                    {other && <span className="muted small">📁 {baseName(other.path)} 에서 사용 중 · 누르면 그 폴더로</span>}
                    {r.track && <span className="muted small">{r.track}</span>}
                  </button>
                </li>
              );
            })}
            {!refs.length && <li className="muted pad">일치하는 브랜치가 없습니다</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

/** 브랜치 탭: 로컬·원격·태그와 각 작업 */
export function BranchesView({ worktree, repoPath, graph, status }: { worktree: string; repoPath: string; graph: GraphData; status: WorktreeStatus }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [q, setQ] = useState("");
  const timeOf = useMemo(() => new Map(graph.rows.map((r) => [r.sha, r.time])), [graph.rows]);
  const now = Date.now();
  const cur = status.branch;
  const needle = q.trim().toLowerCase();
  const groups: [string, GitRef[]][] = [
    ["로컬 브랜치", graph.refs.filter((r) => r.kind === "branch")],
    ["원격 브랜치", graph.refs.filter((r) => r.kind === "remote")],
    ["태그", graph.refs.filter((r) => r.kind === "tag")],
  ];

  const itemsFor = (r: GitRef): MenuItem[] => {
    const isCur = r.kind === "branch" && r.short === cur;
    const usedBy = r.kind === "branch" ? graph.worktrees.find((w) => w.branch === r.short) : undefined;
    const list: MenuItem[] = [];
    if (r.kind !== "tag") {
      list.push({ label: "이 브랜치로 전환…", hint: "지금 폴더를 체크아웃합니다", disabled: isCur, onClick: () => ga.checkout(worktree, r.short, r.kind === "remote" ? "remote" : "branch", graph.worktrees) });
    }
    if (r.kind === "branch") {
      list.push({ label: "새 워크트리에서 열기…", disabled: !!usedBy, hint: usedBy ? `이미 ${usedBy.path} 에서 사용 중` : "지금 워크트리를 건드리지 않습니다", onClick: () => ga.newWorktree(repoPath, { existingBranch: r.short }) });
    }
    if (usedBy && usedBy.path !== worktree) list.push({ label: `그 폴더로 가기 (${baseName(usedBy.path)})`, onClick: () => useStore.getState().setFocusWorktree(usedBy.path) });
    list.push(
      { separator: true, label: "" },
      { label: "지금 브랜치에 병합…", hint: `${r.short} → ${cur ?? "?"}`, disabled: isCur || !cur, onClick: () => ga.merge(worktree, cur, r.short) },
      { label: "지금 브랜치를 이 위로 리베이스…", hint: `⚠ ${cur ?? "?"} 의 커밋 해시가 바뀝니다`, disabled: isCur || !cur, onClick: () => ga.rebase(worktree, cur, r.short, status.upstream) },
      { separator: true, label: "" },
      { label: "여기서 새 브랜치…", onClick: () => ga.createBranch(worktree, r.short, r.short) },
    );
    if (r.kind === "branch") {
      list.push({ label: "브랜치 삭제…", danger: true, disabled: !!usedBy, hint: usedBy ? "워크트리에서 사용 중" : undefined, onClick: () => ga.deleteBranch(repoPath, r) });
    }
    return list;
  };

  return (
    <div className="branches">
      <div className="filters">
        <input className="search" placeholder="브랜치 찾기" value={q} onChange={(e) => setQ(e.target.value)} aria-label="브랜치 찾기" />
        <button className="btn btn-small" onClick={() => ga.createBranch(worktree, "HEAD", "현재 HEAD")}>
          새 브랜치
        </button>
      </div>
      <div className="branch-groups">
        {groups.map(([title, list]) => {
          const shown = list.filter((r) => !needle || r.short.toLowerCase().includes(needle));
          if (!shown.length) return null;
          return (
            <section key={title}>
              <h4>
                {title} <span className="count">{shown.length}</span>
              </h4>
              <ul className="branch-list">
                {shown.map((r) => {
                  const isCur = r.kind === "branch" && r.short === cur;
                  const usedBy = r.kind === "branch" ? graph.worktrees.find((w) => w.branch === r.short) : undefined;
                  const t = timeOf.get(r.target);
                  return (
                    <li
                      key={r.name}
                      className={isCur ? "cur" : ""}
                      data-ref={r.short}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setMenu({ x: e.clientX, y: e.clientY, items: itemsFor(r) });
                      }}
                      onDoubleClick={() => r.kind !== "tag" && !isCur && ga.checkout(worktree, r.short, r.kind === "remote" ? "remote" : "branch", graph.worktrees)}
                      title="더블클릭: 이 브랜치로 전환 · 우클릭/⋯: 메뉴"
                    >
                      <span className={`ref ref-${r.kind}${isCur ? " ref-focus" : ""}`}>{r.short}</span>
                      {usedBy && <span className="muted small" title={usedBy.path}>📁 {baseName(usedBy.path)}</span>}
                      {r.track && <span className="muted small">{r.track}</span>}
                      <span className="spacer" />
                      {t ? <span className="muted small">{relativeTime(t * 1000, now)}</span> : null}
                      <button
                        className="btn btn-ghost btn-small"
                        aria-label={`${r.short} 메뉴`}
                        onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, items: itemsFor(r) })}
                      >
                        <MoreHorizontal size={15} aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

export function WorktreesView({ graph, repoPath }: { graph: GraphData | null; repoPath: string }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocusWorktree);
  const sessions = useStore((s) => s.sessions);
  const liveRuns = useStore((s) => s.liveRuns);
  const now = Date.now();
  if (!graph) return <div className="loading">…</div>;
  const prunable = graph.worktrees.some((w) => w.prunable !== null || !w.exists);
  return (
    <div className="worktrees">
      <div className="filters">
        <span className="muted">같은 저장소를 여러 폴더로 열어, 폴더마다 다른 브랜치에서 에이전트를 동시에 돌릴 수 있어요.</span>
        <span className="spacer" />
        <button className="btn btn-small btn-primary" onClick={() => ga.newWorktree(repoPath, { base: "HEAD" })}>
          <FolderOpen size={13} aria-hidden /> 새 워크트리
        </button>
        {prunable && (
          <button
            className="btn btn-small"
            title="폴더가 사라진 워크트리 등록 정리 (git worktree prune)"
            onClick={async () => {
              await api.worktreePrune(repoPath).catch((e) => useStore.getState().toast("error", errorText(e)));
              useStore.getState().bumpGit();
              void useStore.getState().refreshRepos();
            }}
          >
            정리
          </button>
        )}
      </div>
      <ul className="wt-list">
        {graph.worktrees.map((w: Worktree) => {
          const here = sessions.filter((s) => s.worktreePath === w.path);
          const running = here.filter((s) => s.runningExecId).length;
          const ext = liveRuns.filter((r) => !r.ownedByApp && r.cwd && (r.cwd === w.path || r.cwd.startsWith(w.path + "/"))).length;
          const latest = here[0];
          return (
            <li key={w.path} className={w.path === focus?.worktreePath ? "on" : ""} data-wt={w.path}>
              <div className="wt-line">
                <b>{baseName(w.path)}</b>
                {w.isMain && <span className="tag">메인</span>}
                {w.locked !== null && <span className="tag">잠김</span>}
                {!w.exists && <span className="tag tag-warn">폴더 없음</span>}
                <span className="spacer" />
                {w.path === focus?.worktreePath ? (
                  <span className="tag tag-on">보는 중</span>
                ) : (
                  w.exists && (
                    <button className="btn btn-small" onClick={() => setFocus(w.path)} title="이 폴더로 화면을 옮깁니다 (체크아웃하지 않음)">
                      열기
                    </button>
                  )
                )}
                <button
                  className="icon-btn ghost"
                  aria-label={`${baseName(w.path)} 메뉴`}
                  data-action="wt-menu"
                  onClick={(e) =>
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { label: "Finder 에서 보기", disabled: !w.exists, onClick: () => void api.revealInFinder(w.path) },
                        { separator: true, label: "" },
                        {
                          label: w.exists ? "워크트리 삭제…" : "사라진 워크트리 정리…",
                          danger: true,
                          disabled: w.isMain,
                          hint: w.isMain ? "메인 워크트리는 지울 수 없어요" : "폴더를 지웁니다. 커밋은 남아요",
                          testId: "wt-delete",
                          onClick: () => ga.removeWorktree(repoPath, w),
                        },
                      ],
                    })
                  }
                >
                  <MoreHorizontal size={15} aria-hidden />
                </button>
              </div>
              <div className="wt-line">
                <span className="branch-chip">{w.detached ? `detached ${w.head?.slice(0, 7)}` : w.branch ?? "(bare)"}</span>
                <span className="muted path-text" title={w.path}>
                  {w.path}
                </span>
              </div>
              {(here.length > 0 || ext > 0) && (
                <div className="wt-line muted">
                  세션 {here.length}개{running ? ` · 앱에서 실행 ${running}` : ""}
                  {ext ? ` · 외부 실행 ${ext}` : ""}
                  {latest ? ` · 최근 ${relativeTime(latest.updatedAt, now)}` : ""}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
