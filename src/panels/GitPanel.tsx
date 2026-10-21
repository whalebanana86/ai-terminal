import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type CommitDetail, type GraphData, type WorktreeStatus } from "../api";
import { AgentBadge, Empty } from "../components/Overlays";
import { baseName, branchLabel, branchState, checkoutWarning, isNestedRepoEntry, kindLabel, kindLetter, relativeTime } from "../logic";
import { useFocusRepo, useSelectedSession, useStore } from "../store";
import { GraphView } from "./GraphView";

type Tab = "graph" | "changes" | "worktrees";

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
  const [error, setError] = useState<string | null>(null);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toHead, setToHead] = useState(0);
  const wtPath = focus?.worktreePath ?? null;

  // 응답이 늦게 와도 지금 보는 워크트리가 아니면 버린다(빠르게 세션을 바꿀 때 덮어쓰기 방지).
  const current = useRef(wtPath);
  current.current = wtPath;
  const load = useCallback(async () => {
    if (!wtPath) return;
    try {
      const [g, st] = await Promise.all([api.graph(wtPath, 1500), api.status(wtPath)]);
      if (current.current !== wtPath) return;
      setGraph(g);
      setStatus(st);
      setError(null);
    } catch (e) {
      if (current.current === wtPath) setError(errorText(e));
    }
  }, [wtPath]);

  // 포커스가 바뀌면 처음부터, git 신호가 오면 다시 읽는다.
  useEffect(() => {
    setGraph(null);
    setStatus(null);
    setSelectedSha(null);
    void load().then(() => setToHead((n) => n + 1));
  }, [wtPath]); // eslint-disable-line react-hooks/exhaustive-deps
  // .git 이 바뀌면 그래프까지, 파일만 바뀌면 status 만 다시 읽는다(큰 저장소에서 전체 log 반복 방지).
  useEffect(() => {
    if (gitTick) void load();
  }, [gitTick]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!statusTick || !wtPath) return;
    const path = wtPath;
    api.status(path).then(
      (st) => current.current === path && setStatus(st),
      () => {},
    );
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
          <span className="branch-chip strong" data-testid="git-current-branch">
            {status ? (status.detached ? `detached ${status.head?.slice(0, 7) ?? ""}` : branchLabel(status.branch)) : "…"}
          </span>
          {status?.head && <code className="sha">{status.head.slice(0, 7)}</code>}
          {status?.upstream && (
            <span className="muted">
              → {status.upstream} {status.ahead ? `↑${status.ahead}` : ""} {status.behind ? `↓${status.behind}` : ""}
            </span>
          )}
          {status?.operation && <span className="tag tag-warn">{status.operation} 진행 중</span>}
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
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "graph"} className={tab === "graph" ? "on" : ""} onClick={() => setTab("graph")}>
          그래프
        </button>
        <button role="tab" aria-selected={tab === "changes"} className={tab === "changes" ? "on" : ""} onClick={() => setTab("changes")}>
          변경 사항 {dirty ? <span className="count">{dirty}</span> : null}
        </button>
        <button role="tab" aria-selected={tab === "worktrees"} className={tab === "worktrees" ? "on" : ""} onClick={() => setTab("worktrees")}>
          워크트리 <span className="count">{graph?.worktrees.length ?? repo?.worktrees.length ?? 0}</span>
        </button>
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
                  scrollToHeadSignal={toHead}
                />
                {selectedSha && (
                  <CommitDetailView
                    key={selectedSha}
                    worktree={wtPath}
                    sha={selectedSha}
                    graph={graph}
                    dirty={dirty}
                    runningHere={runningHere}
                    onClose={() => setSelectedSha(null)}
                    onChanged={load}
                  />
                )}
              </div>
            ) : (
              <Empty title="아직 커밋이 없습니다" />
            )
          ) : (
            <div className="loading">그래프를 읽는 중…</div>
          ))}
        {tab === "changes" && <ChangesView worktree={wtPath} status={status} onCommitted={load} />}
        {tab === "worktrees" && <WorktreesView graph={graph} />}
      </div>
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

function CommitDetailView(props: {
  worktree: string;
  sha: string;
  graph: GraphData;
  dirty: number;
  runningHere: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [d, setD] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const openViewer = useStore((s) => s.openViewer);
  const viewer = useStore((s) => s.viewer);
  const ask = useStore((s) => s.ask);
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    api.commitDetail(props.worktree, props.sha).then(setD, (e) => setErr(errorText(e)));
  }, [props.worktree, props.sha]);

  const refsHere = props.graph.refs.filter((r) => r.target === props.sha && r.kind !== "tag");
  const usedBy = (branch: string) => props.graph.worktrees.find((w) => w.branch === branch && w.path !== props.worktree);

  const checkout = async (target: string, kind: "branch" | "remote" | "commit") => {
    if (kind === "branch") {
      const other = usedBy(target);
      if (other) {
        toast("error", `'${target}' 는 다른 워크트리(${baseName(other.path)})에서 사용 중이라 체크아웃할 수 없습니다.`);
        return;
      }
    }
    const warn = checkoutWarning(props.dirty, target, props.runningHere);
    const ok = await ask({
      title: kind === "commit" ? "커밋으로 이동 (detached HEAD)" : `'${target}' 체크아웃`,
      body: `워크트리 ${baseName(props.worktree)} 의 HEAD 를 ${kind === "commit" ? target.slice(0, 10) + " (detached)" : target} 로 바꿉니다.\n이 작업은 실제 Git 작업이며 워크트리의 파일이 바뀝니다.${warn ? "\n\n⚠ " + warn : ""}`,
      danger: !!warn,
      confirmLabel: "체크아웃",
    });
    if (!ok) return;
    try {
      await api.checkout(props.worktree, target, kind);
      toast("success", `${target} 로 체크아웃했습니다`);
    } catch (e) {
      toast("error", `체크아웃 실패: ${errorText(e)}`);
    } finally {
      props.onChanged();
      void useStore.getState().refreshRepos();
      void useStore.getState().refreshSessions();
    }
  };

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
              <button key={r.name} className="btn btn-small" onClick={() => checkout(r.short, r.kind === "remote" ? "remote" : "branch")}>
                {r.short} 체크아웃…
              </button>
            ))}
            <button className="btn btn-small btn-ghost" onClick={() => checkout(props.sha, "commit")}>
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

function ChangesView({ worktree, status, onCommitted }: { worktree: string; status: WorktreeStatus | null; onCommitted: () => void }) {
  const entries = useMemo(() => (status?.entries ?? []).filter((e) => e.kind !== "ignored"), [status]);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const openViewer = useStore((s) => s.openViewer);
  const viewer = useStore((s) => s.viewer);
  const selected = entries.filter((e) => !unchecked.has(e.path) && !isNestedRepoEntry(e.path));

  useEffect(() => setUnchecked(new Set()), [worktree]);

  const commit = async () => {
    setBusy(true);
    try {
      const paths = selected.flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path]));
      await api.commit(worktree, paths, msg);
      toast("success", `커밋했습니다 (${selected.length}개 파일)`);
      setMsg("");
      setUnchecked(new Set());
    } catch (e) {
      toast("error", `커밋 실패: ${errorText(e)}`);
    } finally {
      setBusy(false);
      onCommitted();
    }
  };

  if (!status) return <div className="loading">상태를 읽는 중…</div>;
  if (!entries.length) return <Empty title="변경 사항 없음">워크트리가 HEAD 와 같습니다.</Empty>;
  return (
    <div className="changes">
      <div className="changes-toolbar">
        <label>
          <input
            type="checkbox"
            checked={unchecked.size === 0}
            onChange={(e) => setUnchecked(e.target.checked ? new Set() : new Set(entries.map((x) => x.path)))}
          />{" "}
          전체 {entries.length}개
        </label>
      </div>
      <ul className="file-list grow-list">
        {entries.map((e) => {
          const on = viewer?.kind === "file" && viewer.rel === e.path;
          return (
            <li key={e.path} className={on ? "on" : ""}>
              <input
                type="checkbox"
                disabled={isNestedRepoEntry(e.path)}
                checked={!unchecked.has(e.path) && !isNestedRepoEntry(e.path)}
                onChange={(ev) => {
                  const next = new Set(unchecked);
                  if (ev.target.checked) next.delete(e.path);
                  else next.add(e.path);
                  setUnchecked(next);
                }}
                aria-label={`${e.path} 커밋에 포함`}
              />
              <span className={`kind kind-${e.kind}`} title={kindLabel(e.kind)}>
                {kindLetter(e.kind)}
              </span>
              <span className="path" onClick={() => openViewer({ kind: "file", rel: e.path, mode: e.kind === "deleted" ? "diff" : "diff" })}>
                {e.path}
              </span>
              {e.index !== "." && e.index !== "?" && <span className="tag" title="스테이지됨">S</span>}
              {isNestedRepoEntry(e.path) && (
                <span className="tag tag-warn" title="안쪽에 다른 Git 저장소나 워크트리가 있어 커밋하지 않습니다">중첩 저장소</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="commit-box">
        <textarea
          placeholder="커밋 메시지"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey && msg.trim() && selected.length) void commit();
          }}
        />
        <button className="btn btn-primary" disabled={busy || !msg.trim() || !selected.length} onClick={commit}>
          {busy ? "커밋 중…" : `커밋 (${selected.length})`}
        </button>
      </div>
    </div>
  );
}

function WorktreesView({ graph }: { graph: GraphData | null }) {
  const focus = useStore((s) => s.focus);
  const setFocus = useStore((s) => s.setFocusWorktree);
  const sessions = useStore((s) => s.sessions);
  const now = Date.now();
  if (!graph) return <div className="loading">…</div>;
  return (
    <ul className="wt-list">
      {graph.worktrees.map((w) => {
        const here = sessions.filter((s) => s.worktreePath === w.path);
        const running = here.filter((s) => s.runningExecId).length;
        const latest = here[0];
        return (
          <li key={w.path} className={w.path === focus?.worktreePath ? "on" : ""}>
            <div className="wt-line">
              <b>{baseName(w.path)}</b>
              {w.isMain && <span className="tag">메인</span>}
              {w.locked !== null && <span className="tag">잠김</span>}
              {!w.exists && <span className="tag tag-warn">폴더 없음</span>}
              <span className="spacer" />
              {w.exists && w.path !== focus?.worktreePath && (
                <button className="btn btn-small" onClick={() => setFocus(w.path)} title="체크아웃 없이 이 워크트리를 봅니다">
                  보기
                </button>
              )}
            </div>
            <div className="wt-line">
              <span className="branch-chip">{w.detached ? `detached ${w.head?.slice(0, 7)}` : w.branch ?? "(bare)"}</span>
              <span className="muted path-text" title={w.path}>
                {w.path}
              </span>
            </div>
            {here.length > 0 && (
              <div className="wt-line muted">
                세션 {here.length}개{running ? ` · 실행 중 ${running}` : ""}
                {latest ? ` · 최근 ${relativeTime(latest.updatedAt, now)}` : ""}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
