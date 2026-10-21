import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, type CommitDetail, type GitRef, type GraphData, type OpState, type WorktreeStatus } from "../api";
import { AgentBadge, ContextMenu, Empty, type MenuItem } from "../components/Overlays";
import * as ga from "../gitActions";
import { baseName, branchLabel, branchState, kindLetter } from "../logic";
import { useFocusRepo, useSelectedSession, useStore } from "../store";
import { BranchesView, BranchSwitcher, WorktreesView } from "./GitBranches";
import { ChangesView } from "./GitChanges";
import { GraphView } from "./GraphView";

type Tab = "graph" | "changes" | "branches" | "worktrees";

export function GitPanel() {
  const focus = useStore((s) => s.focus);
  const gitTick = useStore((s) => s.gitTick);
  const statusTick = useStore((s) => s.statusTick);
  const repo = useFocusRepo();
  const session = useSelectedSession();
  const toast = useStore((s) => s.toast);
  const [tab, setTab] = useState<Tab>("graph");
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [op, setOp] = useState<OpState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toHead, setToHead] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const wtPath = focus?.worktreePath ?? null;

  // 응답이 늦게 와도 지금 보는 워크트리가 아니면 버린다(빠르게 세션을 바꿀 때 덮어쓰기 방지).
  const current = useRef(wtPath);
  current.current = wtPath;
  const loadStatus = useCallback(async () => {
    if (!wtPath) return;
    const path = wtPath;
    const st = await api.status(path).catch(() => null);
    if (current.current !== path || !st) return;
    setStatus(st);
    // 병합/rebase 중일 때만 진행 상태를 읽는다
    setOp(st.operation ? await api.opState(path).catch(() => null) : null);
  }, [wtPath]);
  const load = useCallback(async () => {
    if (!wtPath) return;
    const path = wtPath;
    try {
      const g = await api.graph(path, 1500);
      if (current.current !== path) return;
      setGraph(g);
      setError(null);
    } catch (e) {
      if (current.current === path) setError(errorText(e));
    }
    await loadStatus();
  }, [wtPath, loadStatus]);

  // 포커스가 바뀌면 처음부터, git 신호가 오면 그래프까지, 파일 신호면 status 만 다시 읽는다.
  useEffect(() => {
    setGraph(null);
    setStatus(null);
    setOp(null);
    setSelectedSha(null);
    void load().then(() => setToHead((n) => n + 1));
  }, [wtPath]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (gitTick) void load();
  }, [gitTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (statusTick) void loadStatus();
  }, [statusTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const sessionHere = session && session.worktreePath === wtPath ? session : null;
  const bs = sessionHere ? branchState(sessionHere) : null;
  const dirty = status?.entries.filter((e) => e.kind !== "ignored").length ?? 0;
  const runningHere = useStore((s) => s.sessions.filter((x) => x.runningExecId && x.worktreePath === wtPath).length);

  const runOp = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    try {
      const out = await fn();
      toast("success", `${label} 완료${out.trim() ? `: ${out.trim().split("\n").slice(-1)[0]}` : ""}`);
    } catch (e) {
      toast("error", `${label} 실패: ${errorText(e)}`);
    } finally {
      setBusy(null);
      void load();
      void useStore.getState().refreshRepos();
    }
  };

  const ask = useStore((s) => s.ask);
  const onPull = async () => {
    if (!wtPath) return;
    const ok = await ask({
      title: "Pull (fast-forward 만)",
      body: `${baseName(wtPath)} 의 ${status?.branch ?? "현재 브랜치"} 를 원격에서 받아옵니다.\n병합 커밋이나 rebase 는 하지 않으며, fast-forward 가 불가능하면 아무것도 바꾸지 않고 실패합니다.${dirty ? `\n\n커밋하지 않은 변경 ${dirty}개가 있습니다.` : ""}${runningHere ? `\n이 워크트리에서 에이전트 ${runningHere}개가 실행 중입니다.` : ""}`,
      confirmLabel: "Pull",
    });
    if (ok) await runOp("Pull", () => api.pull(wtPath));
  };
  const onPush = async () => {
    if (!wtPath || !status) return;
    if (status.detached) return toast("error", "detached HEAD 에서는 Push 할 수 없습니다. 브랜치를 먼저 만드세요.");
    let upstream: string | undefined;
    if (!status.upstream) {
      const remotes = await api.remotes(wtPath).catch(() => [] as string[]);
      if (!remotes.length) return toast("error", "원격 저장소(remote)가 없습니다.");
      upstream = remotes.includes("origin") ? "origin" : remotes[0];
    }
    const ok = await ask({
      title: "Push",
      body: upstream
        ? `'${status.branch}' 에 추적 브랜치가 없습니다. ${upstream}/${status.branch} 로 올리고 추적을 설정합니다.`
        : `'${status.branch}' 의 커밋 ${status.ahead}개를 ${status.upstream} 로 올립니다. 강제 푸시는 하지 않습니다.`,
      confirmLabel: "Push",
    });
    if (ok) await runOp("Push", () => api.push(wtPath, upstream));
  };

  /** 그래프 행 우클릭: 그 커밋/브랜치로 할 수 있는 작업 */
  const onGraphMenu = (sha: string, x: number, y: number) => {
    if (!wtPath || !graph) return;
    const refs = graph.refs.filter((r) => r.target === sha && r.kind !== "tag");
    const cur = status?.branch ?? null;
    const items: MenuItem[] = [];
    for (const r of refs) {
      const isCur = r.kind === "branch" && r.short === cur;
      items.push(
        { label: `'${r.short}' 체크아웃…`, disabled: isCur, onClick: () => ga.checkout(wtPath, r.short, r.kind === "remote" ? "remote" : "branch", graph.worktrees) },
        {
          label: `'${r.short}' 을(를) 새 워크트리에서 열기…`,
          disabled: r.kind !== "branch" || graph.worktrees.some((w) => w.branch === r.short),
          hint: "지금 워크트리를 건드리지 않습니다",
          onClick: () => ga.newWorktree(repo?.path ?? wtPath, { existingBranch: r.short }),
        },
        { label: `'${r.short}' → '${cur ?? "?"}' 병합…`, disabled: isCur || !cur, onClick: () => ga.merge(wtPath, cur, r.short) },
        { label: `'${cur ?? "?"}' 을(를) '${r.short}' 위로 rebase…`, disabled: isCur || !cur, onClick: () => ga.rebase(wtPath, cur, r.short, status?.upstream ?? null) },
        { separator: true, label: "" },
      );
    }
    items.push(
      { label: "여기서 새 브랜치…", onClick: () => ga.createBranch(wtPath, sha, sha.slice(0, 10)) },
      { label: "여기서 새 워크트리…", hint: "새 브랜치 + 새 폴더", onClick: () => ga.newWorktree(repo?.path ?? wtPath, { base: sha }) },
      { label: "이 커밋으로 이동 (detached)…", onClick: () => ga.checkout(wtPath, sha, "commit", graph.worktrees) },
      { separator: true, label: "" },
      { label: "커밋 해시 복사", onClick: () => void navigator.clipboard.writeText(sha) },
    );
    setSelectedSha(sha);
    setMenu({ x, y, items });
  };

  if (!wtPath) {
    return (
      <section className="panel" data-pane="1" tabIndex={-1}>
        <PanelHead title="Git" />
        <Empty title="볼 워크트리가 없습니다">가운데에서 세션을 고르거나, 위에서 저장소를 추가하세요.</Empty>
      </section>
    );
  }

  const wt = graph?.worktrees.find((w) => w.path === wtPath);
  return (
    <section className="panel" data-pane="1" tabIndex={-1}>
      <PanelHead title="Git">
        <button className="btn btn-small" disabled={!!busy} onClick={() => runOp("Fetch", () => api.fetch(wtPath))} title="git fetch --all --prune">
          {busy === "Fetch" ? "…" : "Fetch"}
        </button>
        <button className="btn btn-small" disabled={!!busy || !status?.upstream} onClick={onPull} title="git pull --ff-only">
          {busy === "Pull" ? "…" : `Pull${status?.behind ? ` ↓${status.behind}` : ""}`}
        </button>
        <button className="btn btn-small" disabled={!!busy || !status || status.detached} onClick={onPush} title="git push">
          {busy === "Push" ? "…" : `Push${status?.ahead ? ` ↑${status.ahead}` : ""}`}
        </button>
      </PanelHead>

      <div className="git-focus">
        <div className="git-focus-line">
          <span className="repo-name">{repo?.name ?? baseName(wtPath)}</span>
          <span className="muted">/</span>
          <span title={wtPath}>{baseName(wtPath)}</span>
          {wt?.isMain === false && <span className="tag">링크 워크트리</span>}
        </div>
        <div className="git-focus-line">
          <span className="muted">현재</span>
          {graph && status ? (
            <BranchSwitcher worktree={wtPath} status={status} graph={graph} repoPath={repo?.path ?? wtPath} />
          ) : (
            <span className="branch-chip strong" data-testid="git-current-branch">
              …
            </span>
          )}
          {status?.head && <code className="sha">{status.head.slice(0, 7)}</code>}
          {status?.upstream && (
            <span className="muted">
              → {status.upstream} {status.ahead ? `↑${status.ahead}` : ""} {status.behind ? `↓${status.behind}` : ""}
            </span>
          )}
        </div>
        {sessionHere && bs && (bs.changedSinceStart || bs.changedSinceLast) && (
          <div className="banner banner-warn" data-testid="branch-mismatch">
            <AgentBadge agent={sessionHere.agent} small /> 세션은 <b>{branchLabel(bs.start)}</b>에서 시작
            {bs.last && bs.last !== bs.start ? (
              <>
                {" "}· 마지막 기록 <b>{branchLabel(bs.last)}</b>
              </>
            ) : null}
            , 지금 워크트리는 <b>{bs.currentDetached ? "detached HEAD" : branchLabel(bs.current)}</b>입니다. 화면은 현재 상태를 보여 주며 자동으로 체크아웃하지 않습니다.
          </div>
        )}
        {op?.operation && <OpBanner worktree={wtPath} op={op} onChanged={load} />}
      </div>

      <div className="tabs" role="tablist">
        {(
          [
            ["graph", "그래프", null],
            ["changes", "변경 사항", dirty || null],
            ["branches", "브랜치", graph ? graph.refs.filter((r) => r.kind === "branch").length : null],
            ["worktrees", "워크트리", graph?.worktrees.length ?? repo?.worktrees.length ?? null],
          ] as [Tab, string, number | null][]
        ).map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)} data-tab={k}>
            {label} {n ? <span className="count">{n}</span> : null}
          </button>
        ))}
        <span className="spacer" />
        {tab === "graph" && (
          <button className="btn btn-ghost btn-small" onClick={() => setToHead((n) => n + 1)} title="HEAD 로 스크롤">
            HEAD로
          </button>
        )}
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="panel-body">
        {tab === "graph" &&
          (graph ? (
            graph.rows.length ? (
              <div className="graph-split">
                <GraphView
                  data={graph}
                  focusWorktree={wtPath}
                  sessionStartBranch={bs?.changedSinceStart ? bs.start : null}
                  selectedSha={selectedSha}
                  onSelect={setSelectedSha}
                  onContextMenu={onGraphMenu}
                  scrollToHeadSignal={toHead}
                />
                {selectedSha && (
                  <CommitDetailView key={selectedSha} worktree={wtPath} sha={selectedSha} graph={graph} status={status} onClose={() => setSelectedSha(null)} />
                )}
              </div>
            ) : (
              <Empty title="아직 커밋이 없습니다" />
            )
          ) : (
            <div className="loading">그래프를 읽는 중…</div>
          ))}
        {tab === "changes" && <ChangesView worktree={wtPath} status={status} onChanged={loadStatus} />}
        {tab === "branches" && graph && status && <BranchesView worktree={wtPath} repoPath={repo?.path ?? wtPath} graph={graph} status={status} />}
        {tab === "worktrees" && <WorktreesView graph={graph} repoPath={repo?.path ?? wtPath} />}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </section>
  );
}

export function PanelHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="panel-head">
      <h2>{title}</h2>
      <div className="panel-actions">{children}</div>
    </div>
  );
}

const OP_NAME: Record<string, string> = { merge: "병합", rebase: "rebase", "cherry-pick": "cherry-pick", revert: "revert", bisect: "bisect" };

/** 병합/rebase 진행 중: 충돌 파일 해결과 계속·건너뛰기·중단 */
function OpBanner({ worktree, op, onChanged }: { worktree: string; op: OpState; onChanged: () => void }) {
  const toast = useStore((s) => s.toast);
  const ask = useStore((s) => s.ask);
  const openViewer = useStore((s) => s.openViewer);
  const [busy, setBusy] = useState(false);
  const name = OP_NAME[op.operation ?? ""] ?? op.operation;
  // rebase 에서는 --ours 가 "올라탈 대상", --theirs 가 "내 커밋" 이다.
  const ours = op.operation === "rebase" ? "대상 쪽(onto)" : "현재 브랜치 쪽";
  const theirs = op.operation === "rebase" ? "내 커밋 쪽" : "가져오는 쪽";

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const r = (await fn()) as { conflict?: boolean } | void;
      if (r && r.conflict) toast("error", `${label}: 다음 커밋에서 다시 충돌했습니다`);
      else toast("success", `${label} 완료`);
    } catch (e) {
      toast("error", `${label} 실패: ${errorText(e)}`);
    } finally {
      setBusy(false);
      onChanged();
      useStore.getState().bumpGit();
    }
  };
  const abort = async () => {
    if (await ask({ title: `${name} 중단`, body: `${name} 을(를) 시작하기 전 상태로 되돌립니다. 지금까지 해결한 충돌도 버려집니다.`, danger: true, confirmLabel: "중단" }))
      await act(`${name} 중단`, () => api.opControl(worktree, "abort"));
  };
  return (
    <div className="banner banner-op" data-testid="op-banner">
      <div className="op-line">
        <b>{name} 진행 중</b>
        {op.step && (
          <span className="muted">
            {" "}
            ({op.step[0]}/{op.step[1]})
          </span>
        )}
        {op.onto && <span className="muted"> · {op.onto}</span>}
        <span className="spacer" />
        <button className="btn btn-small btn-primary" disabled={busy || op.conflicted.length > 0} onClick={() => act(`${name} 계속`, () => api.opControl(worktree, "continue"))}>
          계속
        </button>
        {op.operation !== "merge" && (
          <button className="btn btn-small" disabled={busy} onClick={() => act("건너뛰기", () => api.opControl(worktree, "skip"))}>
            건너뛰기
          </button>
        )}
        <button className="btn btn-small btn-danger" disabled={busy} onClick={abort}>
          중단
        </button>
      </div>
      {op.conflicted.length > 0 ? (
        <ul className="conflicts">
          {op.conflicted.map((f) => (
            <li key={f}>
              <span className="kind kind-conflicted">!</span>
              <span className="path" onClick={() => openViewer({ kind: "file", rel: f, mode: "preview" })} title="내용 보기 (충돌 표시 포함)">
                {f}
              </span>
              <button className="btn btn-small" disabled={busy} onClick={() => act(`${f}: ${ours}`, () => api.resolve(worktree, f, "ours"))} title={`--ours: ${ours} 내용으로`}>
                {ours}
              </button>
              <button className="btn btn-small" disabled={busy} onClick={() => act(`${f}: ${theirs}`, () => api.resolve(worktree, f, "theirs"))} title={`--theirs: ${theirs} 내용으로`}>
                {theirs}
              </button>
              <button className="btn btn-small" disabled={busy} onClick={() => act(`${f}: 해결 표시`, () => api.resolve(worktree, f, "mark"))} title="에디터에서 직접 고친 뒤 해결로 표시(git add)">
                해결됨
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted small">충돌이 모두 해결되었습니다. '계속' 을 누르세요.</div>
      )}
    </div>
  );
}

function CommitDetailView(props: { worktree: string; sha: string; graph: GraphData; status: WorktreeStatus | null; onClose: () => void }) {
  const [d, setD] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const openViewer = useStore((s) => s.openViewer);
  const viewer = useStore((s) => s.viewer);
  const repo = useFocusRepo();
  useEffect(() => {
    api.commitDetail(props.worktree, props.sha).then(setD, (e) => setErr(errorText(e)));
  }, [props.worktree, props.sha]);

  const refsHere: GitRef[] = props.graph.refs.filter((r) => r.target === props.sha && r.kind !== "tag");
  const cur = props.status?.branch ?? null;

  return (
    <div className="commit-detail">
      <div className="cd-head">
        <code className="sha">{props.sha.slice(0, 10)}</code>
        <span className="spacer" />
        <button className="btn btn-ghost btn-small" onClick={props.onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      {err && <div className="banner banner-error">{err}</div>}
      {d && (
        <>
          <div className="cd-msg">{d.message}</div>
          <div className="cd-meta">
            {d.author} · {new Date(d.time * 1000).toLocaleString()} · 부모 {d.parents.map((p) => p.slice(0, 7)).join(", ") || "없음"}
          </div>
          <div className="cd-actions">
            {refsHere.map((r) => (
              <button
                key={r.name}
                className="btn btn-small"
                disabled={r.kind === "branch" && r.short === cur}
                onClick={() => ga.checkout(props.worktree, r.short, r.kind === "remote" ? "remote" : "branch", props.graph.worktrees)}
              >
                {r.short} 체크아웃…
              </button>
            ))}
            <button className="btn btn-small btn-ghost" onClick={() => ga.newWorktree(repo?.path ?? props.worktree, { base: props.sha })}>
              새 워크트리…
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => ga.checkout(props.worktree, props.sha, "commit", props.graph.worktrees)}>
              이 커밋으로 이동…
            </button>
          </div>
          <ul className="file-list">
            {d.files.map((f) => {
              const on = viewer?.kind === "commit-file" && viewer.sha === props.sha && viewer.rel === f.path;
              return (
                <li key={f.path} className={on ? "on" : ""} onClick={() => openViewer({ kind: "commit-file", sha: props.sha, rel: f.path })}>
                  <span className={`kind kind-${f.kind}`}>{kindLetter(f.kind)}</span>
                  <span className="path">{f.path}</span>
                  {f.origPath && <span className="muted"> ← {f.origPath}</span>}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
