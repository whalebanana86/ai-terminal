import { FolderOpen, MoreHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type GitRef, type GraphData, type Worktree, type WorktreeStatus } from "../api";
import { ContextMenu, WtDot, type MenuItem } from "../components/Overlays";
import { useWtColors, colorOf } from "../wtColors";
import { refLineColors, useMetroColors } from "./GraphView";
import * as ga from "../gitActions";
import { baseName, branchLabel, relativeTime } from "../logic";
import { useStore } from "../store";
import { t } from "../i18n";

/** 머리글의 현재 브랜치 표시 겸 빠른 전환 메뉴 */
/** 머리글 브랜치 칩: 전환만 한다. 만들기·지우기·병합 같은 관리는 브랜치 탭에서. */
export function BranchSwitcher({ worktree, status, graph, onManage }: { worktree: string; status: WorktreeStatus; graph: GraphData; onManage: () => void }) {
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
  const label = status.detached ? t("브랜치 없음 ({sha})", { sha: status.head?.slice(0, 7) ?? "" }) : branchLabel(status.branch);
  const needle = q.trim().toLowerCase();
  const refs = graph.refs.filter((r) => r.kind !== "tag" && (!needle || r.short.toLowerCase().includes(needle)));
  const pick = (r: GitRef) => {
    setOpen(false);
    void ga.checkout(worktree, r.short, r.kind === "remote" ? "remote" : "branch", graph.worktrees);
  };
  return (
    <div className="switcher" ref={box}>
      <button className="branch-chip strong as-button" data-testid="git-current-branch" onClick={() => setOpen(!open)} title={t("눌러서 브랜치 전환 (체크아웃)")}>
        {label}
      </button>
      {open && (
        <div className="switcher-pop" role="dialog" aria-label={t("브랜치 바꾸기")}>
          <input className="text-input" autoFocus placeholder={t("브랜치 찾기")} value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="switcher-list">
            {refs.map((r) => {
              const cur = r.kind === "branch" && r.short === status.branch;
              const other = r.kind === "branch" ? graph.worktrees.find((w) => w.branch === r.short && w.path !== worktree) : undefined;
              return (
                <li key={r.name}>
                  <button className={`switcher-item${cur ? " cur" : ""}`} disabled={cur} onClick={() => pick(r)}>
                    <span className={`ref ref-${r.kind}`}>{r.short}</span>
                    {cur && <span className="muted small">{t("현재")}</span>}
                    {other && (
                      <span className="muted small wt-name">
                        → <WtDot path={other.path} />
                        {t("{name} 워크트리 보기", { name: baseName(other.path) })}
                      </span>
                    )}
                    {r.track && <span className="muted small">{r.track}</span>}
                  </button>
                </li>
              );
            })}
            {!refs.length && <li className="muted pad">{t("일치하는 브랜치가 없습니다")}</li>}
          </ul>
          <button
            className="link-btn switcher-manage"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            {t("브랜치 만들기·지우기·병합은 브랜치 탭에서 →")}
          </button>
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
  // 브랜치 이름표는 그래프 탭과 같은 색(가리키는 커밋의 노선 색, 원격은 테두리만)
  const { metro } = useMetroColors(graph, worktree);
  const lineOf = useMemo(() => refLineColors(graph.rows, metro), [graph.rows, metro]);
  const now = Date.now();
  const cur = status.branch;
  const needle = q.trim().toLowerCase();
  const groups: [string, GitRef[]][] = [
    [t("로컬 브랜치"), graph.refs.filter((r) => r.kind === "branch")],
    [t("원격 브랜치"), graph.refs.filter((r) => r.kind === "remote")],
    [t("태그"), graph.refs.filter((r) => r.kind === "tag")],
  ];

  const itemsFor = (r: GitRef): MenuItem[] => {
    const isCur = r.kind === "branch" && r.short === cur;
    const usedBy = r.kind === "branch" ? graph.worktrees.find((w) => w.branch === r.short) : undefined;
    const list: MenuItem[] = [];
    if (r.kind !== "tag") {
      list.push({ label: t("이 브랜치로 전환…"), hint: t("지금 워크트리를 체크아웃합니다"), disabled: isCur, onClick: () => ga.checkout(worktree, r.short, r.kind === "remote" ? "remote" : "branch", graph.worktrees) });
    }
    if (r.kind === "branch") {
      list.push({ label: t("새 워크트리에서 열기…"), disabled: !!usedBy, hint: usedBy ? t("이미 {path} 에서 사용 중", { path: usedBy.path }) : t("지금 워크트리를 건드리지 않습니다"), onClick: () => ga.newWorktree(repoPath, { existingBranch: r.short }) });
    }
    if (usedBy && usedBy.path !== worktree) list.push({ label: t("그 워크트리 보기 ({name})", { name: baseName(usedBy.path) }), onClick: () => useStore.getState().setFocusWorktree(usedBy.path) });
    list.push(
      { separator: true, label: "" },
      { label: t("지금 브랜치에 병합…"), hint: `${r.short} → ${cur ?? "?"}`, disabled: isCur || !cur, onClick: () => ga.merge(worktree, cur, r.short) },
      { label: t("지금 브랜치를 이 위로 리베이스…"), hint: t("⚠ {branch} 의 커밋 해시가 바뀝니다", { branch: cur ?? "?" }), disabled: isCur || !cur, onClick: () => ga.rebase(worktree, cur, r.short, status.upstream) },
      { separator: true, label: "" },
      { label: t("여기서 새 브랜치…"), onClick: () => ga.createBranch(worktree, r.short, r.short) },
    );
    if (r.kind === "branch") {
      list.push({ label: t("브랜치 삭제…"), danger: true, disabled: !!usedBy, hint: usedBy ? t("워크트리에서 사용 중") : undefined, onClick: () => ga.deleteBranch(repoPath, r) });
    }
    return list;
  };

  return (
    <div className="branches">
      <div className="filters">
        <input className="search" placeholder={t("브랜치 찾기")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("브랜치 찾기")} />
        <button className="btn btn-small" onClick={() => ga.createBranch(worktree, "HEAD", t("현재 HEAD"))}>
          {t("새 브랜치")}
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
                  const ts = timeOf.get(r.target);
                  const lc = r.kind !== "tag" ? lineOf.get(r.target) : undefined;
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
                      title={t("더블클릭: 이 브랜치로 전환 · 우클릭/⋯: 메뉴")}
                    >
                      <span className={`ref ref-${r.kind}${lc ? " ref-line" : ""}${isCur ? " ref-focus" : ""}`} style={lc ? ({ "--lc": lc } as React.CSSProperties) : undefined}>
                        {r.short}
                      </span>
                      {usedBy && (
                        <span className="muted small wt-name" title={t("{path} 워크트리가 쓰는 중", { path: usedBy.path })}>
                          <WtDot path={usedBy.path} />
                          {baseName(usedBy.path)}
                        </span>
                      )}
                      {r.track && <span className="muted small">{r.track}</span>}
                      <span className="spacer" />
                      {ts ? <span className="muted small">{relativeTime(ts * 1000, now)}</span> : null}
                      <button
                        className="btn btn-ghost btn-small"
                        aria-label={t("{name} 메뉴", { name: r.short })}
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
  const wtColors = useWtColors();
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
        <span className="muted">{t("워크트리 = 같은 저장소를 다른 브랜치로 연 작업 폴더. 워크트리마다 에이전트를 따로 돌리면 서로 방해하지 않아요.")}</span>
        <span className="spacer" />
        <button className="btn btn-small btn-primary" onClick={() => ga.newWorktree(repoPath, { base: "HEAD" })}>
          <FolderOpen size={13} aria-hidden /> {t("새 워크트리")}
        </button>
        {prunable && (
          <button
            className="btn btn-small"
            title={t("폴더가 사라진 워크트리 등록 정리 (git worktree prune)")}
            onClick={async () => {
              await api.worktreePrune(repoPath).catch((e) => useStore.getState().toast("error", errorText(e)));
              useStore.getState().bumpGit();
              void useStore.getState().refreshRepos();
            }}
          >
            {t("정리")}
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
            <li key={w.path} className={w.path === focus?.worktreePath ? "on" : ""} data-wt={w.path} style={{ "--wc": colorOf(wtColors, w.path) } as React.CSSProperties}>
              <div className="wt-line">
                <WtDot path={w.path} />
                <b>{baseName(w.path)}</b>
                {w.isMain && <span className="tag">{t("메인")}</span>}
                {w.locked !== null && <span className="tag">{t("잠김")}</span>}
                {!w.exists && <span className="tag tag-warn">{t("폴더 없음")}</span>}
                <span className="spacer" />
                {w.path === focus?.worktreePath ? (
                  <span className="tag tag-on">{t("보는 중")}</span>
                ) : (
                  w.exists && (
                    <button className="btn btn-small" onClick={() => setFocus(w.path)} title={t("이 워크트리로 화면을 옮깁니다 (체크아웃하지 않음)")}>
                      {t("열기")}
                    </button>
                  )
                )}
                <button
                  className="icon-btn ghost"
                  aria-label={t("{name} 메뉴", { name: baseName(w.path) })}
                  data-action="wt-menu"
                  onClick={(e) =>
                    setMenu({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        { label: t("Finder 에서 보기"), disabled: !w.exists, onClick: () => void api.revealInFinder(w.path) },
                        { separator: true, label: "" },
                        {
                          label: w.exists ? t("워크트리 삭제…") : t("사라진 워크트리 정리…"),
                          danger: true,
                          disabled: w.isMain,
                          hint: w.isMain ? t("메인 워크트리는 지울 수 없어요") : t("워크트리 폴더를 지웁니다. 커밋은 남아요"),
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
                  {t("세션 {n}개", { n: here.length })}
                  {running ? ` · ${t("앱에서 실행 {n}", { n: running })}` : ""}
                  {ext ? ` · ${t("외부 실행 {n}", { n: ext })}` : ""}
                  {latest ? ` · ${t("최근 {time}", { time: relativeTime(latest.updatedAt, now) })}` : ""}
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
