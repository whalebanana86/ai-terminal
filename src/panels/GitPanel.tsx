import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { api, errorText, type CommitDetail, type GitRef, type GraphData, type OpState, type WorktreeStatus } from "../api";
import { ArrowDownToLine, ArrowUpFromLine, Crosshair, RefreshCw, X } from "lucide-react";
import { ContextMenu, Empty, WtDot, type MenuItem } from "../components/Overlays";
import * as ga from "../gitActions";
import { baseName, branchLabel, branchState, kindLetter } from "../logic";
import { useFocusRepo, useSelectedSession, useShownViewer, useStore } from "../store";
import { BranchesView, BranchSwitcher, WorktreesView } from "./GitBranches";
import { ChangesView } from "./GitChanges";
import { GraphView } from "./GraphView";
import { locale, t } from "../i18n";
import { AI_NAME, aiAgentOf, parseIdentity } from "../aiAuthors";
import { AiMark } from "../components/AiMark";
import { askTrust, firstAsk } from "../repoTrust";

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
  const detailLayout = useDefaultLayout({ id: "graph-detail", storage: localStorage, panelIds: selectedSha ? ["graph", "detail"] : ["graph"] });
  const [busy, setBusy] = useState<string | null>(null);
  const [toHead, setToHead] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const wtPath = focus?.worktreePath ?? null;
  /** 믿지 않은 저장소에서 꺼 둔 실행 명령 */
  const [untrusted, setUntrusted] = useState<string[]>([]);

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

  // 저장소 설정에 실행 명령이 있으면 믿을지 처음 한 번 묻고, 믿기 전에는 안내 막대를 둔다.
  const trust = useCallback(async (items: string[]) => {
    if (!wtPath) return;
    try {
      if (!(await askTrust(wtPath, items))) return;
      setUntrusted([]);
      void load();
    } catch (e) {
      toast("error", errorText(e));
    }
  }, [wtPath, load, toast]);
  useEffect(() => {
    setUntrusted([]);
    if (!wtPath) return;
    const path = wtPath;
    void api.repoTrustInfo(path).then((items) => {
      if (current.current !== path) return;
      setUntrusted(items);
      const repoId = useStore.getState().repos.find((r) => r.worktrees.some((w) => w.path === path))?.id ?? path;
      if (items.length && firstAsk(repoId)) void trust(items);
    }, () => {});
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
      toast("success", out.trim() ? t("{label} 완료: {out}", { label, out: out.trim().split("\n").slice(-1)[0] }) : t("{label} 완료", { label }));
    } catch (e) {
      toast("error", t("{label} 실패: {error}", { label, error: errorText(e) }));
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
      title: t("원격에서 받기"),
      body:
        t("{wt} 의 {branch} 를 원격에서 받아옵니다.\n내 커밋과 섞어야 하는 경우에는 아무것도 바꾸지 않고 멈춰요(병합 커밋·리베이스 없음).", { wt: baseName(wtPath), branch: status?.branch ?? t("현재 브랜치") }) +
        (dirty ? "\n\n" + t("커밋하지 않은 변경 {n}개가 있어요.", { n: dirty }) : "") +
        (runningHere ? "\n" + t("이 워크트리에서 에이전트 {n}개가 실행 중이에요.", { n: runningHere }) : ""),
      confirmLabel: t("받기"),
    });
    if (ok) await runOp(t("받기"), () => api.pull(wtPath));
  };
  const onPush = async () => {
    if (!wtPath || !status) return;
    if (status.detached) return toast("error", t("브랜치가 없는 상태에서는 올릴 수 없어요. 브랜치를 먼저 만드세요."));
    let upstream: string | undefined;
    if (!status.upstream) {
      const remotes = await api.remotes(wtPath).catch(() => [] as string[]);
      if (!remotes.length) return toast("error", t("원격 저장소(remote)가 없습니다."));
      upstream = remotes.includes("origin") ? "origin" : remotes[0];
    }
    const ok = await ask({
      title: t("원격에 올리기"),
      body: upstream
        ? t("'{branch}' 에 추적 브랜치가 없습니다. {target} 로 올리고 추적을 설정합니다.", { branch: status.branch, target: `${upstream}/${status.branch}` })
        : t("'{branch}' 의 커밋 {n}개를 {upstream} 로 올립니다. 강제 푸시는 하지 않습니다.", { branch: status.branch, n: status.ahead, upstream: status.upstream }),
      confirmLabel: t("올리기"),
    });
    if (ok) await runOp(t("올리기"), () => api.push(wtPath, upstream));
  };

  /** 그래프 행 우클릭: 그 커밋/브랜치로 할 수 있는 작업 */
  const onGraphMenu = (sha: string, x: number, y: number) => {
    if (!wtPath || !graph) return;
    const cur = status?.branch ?? null;
    const localNames = new Set(graph.refs.filter((r) => r.kind === "branch").map((r) => r.short));
    // 같은 이름의 로컬 브랜치가 있으면 원격 브랜치는 따로 보여 주지 않는다.
    const refs = graph.refs.filter((r) => r.target === sha && r.kind !== "tag" && !(r.kind === "remote" && localNames.has(r.short.split("/").slice(1).join("/"))));
    const items: MenuItem[] = [];
    // 브랜치마다 한 줄("브랜치 x ▸")로 접고, 그 브랜치로 할 일은 하위 메뉴에 둔다.
    for (const r of refs) {
      const isCur = r.kind === "branch" && r.short === cur;
      if (isCur) continue; // 지금 브랜치 자신에게 할 동작은 없다
      const usedElsewhere = r.kind === "branch" && graph.worktrees.some((w) => w.branch === r.short);
      const children: MenuItem[] = [
        {
          label: usedElsewhere ? t("그 워크트리 보기") : t("이 브랜치로 전환…"),
          hint: usedElsewhere ? t("다른 워크트리가 이미 쓰고 있어요") : t("지금 워크트리를 체크아웃합니다"),
          onClick: () => ga.checkout(wtPath, r.short, r.kind === "remote" ? "remote" : "branch", graph.worktrees),
        },
      ];
      if (r.kind === "branch" && !usedElsewhere) {
        children.push({ label: t("새 워크트리에서 열기…"), hint: t("지금 워크트리는 그대로 둡니다"), onClick: () => ga.newWorktree(repo?.path ?? wtPath, { existingBranch: r.short }) });
      }
      // 지금 위치와 같은 커밋이면 병합·리베이스는 아무 변화가 없으므로 보여 주지 않는다.
      if (cur && sha !== status?.head) {
        children.push({ label: t("지금 브랜치에 병합…"), hint: `${r.short} → ${cur}`, onClick: () => ga.merge(wtPath, cur, r.short) });
        children.push({ label: t("지금 브랜치를 이 위로 리베이스…"), hint: t("⚠ {branch} 의 커밋 해시가 바뀝니다", { branch: cur }), onClick: () => ga.rebase(wtPath, cur, r.short, status?.upstream ?? null) });
      }
      items.push({ label: r.kind === "remote" ? t("원격 브랜치 {name}", { name: r.short }) : t("브랜치 {name}", { name: r.short }), children, testId: `ref:${r.short}` });
    }
    if (items.length) items.push({ separator: true, label: "" });
    items.push(
      { label: t("여기서 새 브랜치…"), onClick: () => ga.createBranch(wtPath, sha, sha.slice(0, 10)) },
      { label: t("여기서 새 워크트리…"), hint: t("새 브랜치 + 새 워크트리"), onClick: () => ga.newWorktree(repo?.path ?? wtPath, { base: sha }) },
      { label: t("이 커밋으로 이동…"), hint: t("⚠ 브랜치 없이 커밋을 직접 봅니다"), onClick: () => ga.checkout(wtPath, sha, "commit", graph.worktrees) },
      { label: t("커밋 해시 복사"), onClick: () => void navigator.clipboard.writeText(sha) },
    );
    setSelectedSha(sha);
    setMenu({ x, y, items });
  };

  if (!wtPath) {
    return (
      <section className="panel" data-pane="1" tabIndex={-1}>
        <PanelHead title="Git" />
        <Empty title={t("볼 워크트리가 없습니다")}>{t("위에서 워크트리를 고르거나 '저장소 추가' 로 Git 저장소를 여세요.")}</Empty>
      </section>
    );
  }

  const wt = graph?.worktrees.find((w) => w.path === wtPath);
  return (
    <section className="panel" data-pane="1" tabIndex={-1}>
      <PanelHead title="Git">
        <button className="btn btn-small" disabled={!!busy} onClick={() => runOp(t("원격 확인"), () => api.fetch(wtPath))} title={t("원격 저장소의 새 커밋을 확인만 합니다 (git fetch)")}>
          <RefreshCw size={12} aria-hidden className={busy === t("원격 확인") ? "spin" : ""} /> {t("원격 확인")}
        </button>
        <button
          className="btn btn-small"
          disabled={!!busy || !status?.upstream}
          onClick={onPull}
          title={status?.upstream ? t("원격의 새 커밋을 받아옵니다 (git pull --ff-only)") : t("연결된 원격 브랜치가 없어 받을 수 없어요. 먼저 올리기로 원격 브랜치를 만드세요.")}
        >
          <ArrowDownToLine size={12} aria-hidden /> {t("받기")}{status?.behind ? ` ${status.behind}` : ""}
        </button>
        <button className="btn btn-small" disabled={!!busy || !status || status.detached} onClick={onPush} title={status?.detached ? t("브랜치가 없어 올릴 수 없어요") : t("내 커밋을 원격에 올립니다 (git push)")}>
          <ArrowUpFromLine size={12} aria-hidden /> {t("올리기")}{status?.ahead ? ` ${status.ahead}` : ""}
        </button>
      </PanelHead>

      <div className="git-focus">
        <div className="git-focus-line">
          <span className="repo-name">{repo?.name ?? baseName(wtPath)}</span>
          <span className="muted">/</span>
          <span title={wtPath} className="wt-name">
            <WtDot path={wtPath} />
            {baseName(wtPath)}
          </span>
          {wt?.isMain === false && <span className="tag" title={t("같은 저장소를 다른 브랜치로 연 작업 폴더")}>{t("추가 워크트리")}</span>}
        </div>
        <div className="git-focus-line">
          <span className="muted">{t("브랜치")}</span>
          {graph && status ? (
            <BranchSwitcher worktree={wtPath} status={status} graph={graph} onManage={() => setTab("branches")} />
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
        {sessionHere && bs?.changedSinceLast && bs.last && dismissed !== `${sessionHere.id}:${bs.last}:${bs.current}` && (
          <div className="banner banner-warn branch-mismatch" data-testid="branch-mismatch">
            <span className="branch-mismatch-text">
              {t("이 세션은")} <b>{branchLabel(bs.last)}</b>
              {t("에서 작업했어요. 지금 워크트리는")} <b>{bs.currentDetached ? t("브랜치 없음|세션 경고") : branchLabel(bs.current)}</b>
              {t("입니다.")}
            </span>
            {graph && bs.last !== "HEAD" && (
              <button className="btn btn-small branch-mismatch-switch" onClick={() => ga.checkout(wtPath, bs.last!, "branch", graph.worktrees)}>
                {t("{branch}로 전환…", { branch: branchLabel(bs.last) })}
              </button>
            )}
            <button className="icon-btn ghost branch-mismatch-close" aria-label={t("닫기")} onClick={() => setDismissed(`${sessionHere.id}:${bs.last}:${bs.current}`)}>
              <X size={13} aria-hidden />
            </button>
          </div>
        )}
        {untrusted.length > 0 && (
          <div className="banner banner-warn branch-mismatch" data-testid="untrusted-repo">
            <span className="branch-mismatch-text">{t("이 저장소 설정의 실행 명령 {n}개를 끈 채로 보고 있어요.", { n: untrusted.length })}</span>
            <button className="btn btn-small branch-mismatch-switch" onClick={() => void trust(untrusted)}>
              {t("확인…")}
            </button>
          </div>
        )}
        {op?.operation && <OpBanner worktree={wtPath} op={op} onChanged={load} />}
      </div>

      <div className="tabs git-tabs" role="tablist">
        {(
          [
            ["graph", t("그래프"), null],
            ["worktrees", t("워크트리|탭"), graph?.worktrees.length ?? repo?.worktrees.length ?? null],
            ["changes", t("변경 사항"), dirty || null],
            ["branches", t("브랜치|탭"), graph ? graph.refs.filter((r) => r.kind === "branch").length : null],
          ] as [Tab, string, number | null][]
        ).map(([k, label, n]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)} data-tab={k}>
            {label} {n ? <span className="count">{n}</span> : null}
          </button>
        ))}
        <span className="spacer" />
        {tab === "graph" && (
          <button className="btn btn-ghost btn-small" onClick={() => setToHead((n) => n + 1)} title={t("지금 워크트리가 가리키는 커밋으로 스크롤")}>
            <Crosshair size={12} aria-hidden /> {t("현재 위치")}
          </button>
        )}
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      <div className="panel-body">
        {tab === "graph" &&
          (graph ? (
            graph.rows.length ? (
              <Group orientation="vertical" className="graph-split" defaultLayout={detailLayout.defaultLayout} onLayoutChanged={detailLayout.onLayoutChanged}>
                <Panel id="graph" minSize="20">
                <GraphView
                  data={graph}
                  focusWorktree={wtPath}
                  sessionStartBranch={bs?.changedSinceStart ? bs.start : null}
                  selectedSha={selectedSha}
                  onSelect={setSelectedSha}
                  onContextMenu={onGraphMenu}
                  scrollToHeadSignal={toHead}
                />
                </Panel>
                {selectedSha && (
                  <>
                    {/* 커밋 상세: 경계를 끌어 높이 조절(크기는 기억) */}
                    <Separator className="sep sep-h" />
                    <Panel id="detail" defaultSize="35" minSize="12">
                      <CommitDetailView key={selectedSha} worktree={wtPath} sha={selectedSha} graph={graph} status={status} onClose={() => setSelectedSha(null)} />
                    </Panel>
                  </>
                )}
              </Group>
            ) : (
              <Empty title={t("아직 커밋이 없습니다")} />
            )
          ) : (
            <div className="loading">{t("그래프를 읽는 중…")}</div>
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

const OP_NAME: Record<string, string> = {
  merge: t("병합"),
  rebase: t("리베이스"),
  "cherry-pick": t("커밋 가져오기(cherry-pick)"),
  revert: t("되돌리기(revert)"),
  bisect: t("원인 찾기(bisect)"),
  am: t("패치 적용(am)"),
};

/** 병합/rebase 진행 중: 충돌 파일 해결과 계속·건너뛰기·중단 */
function OpBanner({ worktree, op, onChanged }: { worktree: string; op: OpState; onChanged: () => void }) {
  const toast = useStore((s) => s.toast);
  const ask = useStore((s) => s.ask);
  const openViewer = useStore((s) => s.openViewer);
  const [busy, setBusy] = useState(false);
  const name = OP_NAME[op.operation ?? ""] ?? op.operation;
  // rebase 에서는 --ours 가 "올라탈 대상", --theirs 가 "내 커밋" 이다.
  const ours = op.operation === "rebase" ? t("대상 쪽(onto)") : t("현재 브랜치 쪽");
  const theirs = op.operation === "rebase" ? t("내 커밋 쪽") : t("가져오는 쪽");

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      const r = (await fn()) as { conflict?: boolean } | void;
      if (r && r.conflict) toast("error", t("{label}: 다음 커밋에서 다시 충돌했습니다", { label }));
      else toast("success", t("{label} 완료", { label }));
    } catch (e) {
      toast("error", t("{label} 실패: {error}", { label, error: errorText(e) }));
    } finally {
      setBusy(false);
      onChanged();
      useStore.getState().bumpGit();
    }
  };
  const abort = async () => {
    if (await ask({ title: t("{op} 중단", { op: name }), body: t("{op} 을(를) 시작하기 전 상태로 되돌립니다. 지금까지 해결한 충돌도 버려집니다.", { op: name }), danger: true, confirmLabel: t("중단|git 작업") }))
      await act(t("{op} 중단", { op: name }), () => api.opControl(worktree, "abort"));
  };
  return (
    <div className="banner banner-op" data-testid="op-banner">
      <div className="op-line">
        <b>{t("{op} 진행 중", { op: name })}</b>
        {op.step && (
          <span className="muted">
            {" "}
            ({op.step[0]}/{op.step[1]})
          </span>
        )}
        {op.onto && <span className="muted"> · {op.onto}</span>}
        <span className="spacer" />
        {op.operation !== "bisect" && (
          <button className="btn btn-small btn-primary" disabled={busy || op.conflicted.length > 0} onClick={() => act(t("{op} 계속", { op: name }), () => api.opControl(worktree, "continue"))}>
            {t("계속")}
          </button>
        )}
        {op.operation !== "merge" && op.operation !== "bisect" && (
          <button className="btn btn-small" disabled={busy} onClick={() => act(t("건너뛰기"), () => api.opControl(worktree, "skip"))}>
            {t("건너뛰기")}
          </button>
        )}
        <button className="btn btn-small btn-danger" disabled={busy} onClick={abort}>
          {t("중단|git 작업")}
        </button>
      </div>
      {op.conflicted.length > 0 ? (
        <ul className="conflicts">
          {op.conflicted.map((f) => (
            <li key={f}>
              <span className="kind kind-conflicted">!</span>
              <span className="path" onClick={() => openViewer({ kind: "file", rel: f, mode: "preview" })} title={t("내용 보기 (충돌 표시 포함)")}>
                {f}
              </span>
              <button className="btn btn-small" disabled={busy} onClick={() => act(`${f}: ${ours}`, () => api.resolve(worktree, f, "ours"))} title={t("--ours: {side} 내용으로", { side: ours })}>
                {ours}
              </button>
              <button className="btn btn-small" disabled={busy} onClick={() => act(`${f}: ${theirs}`, () => api.resolve(worktree, f, "theirs"))} title={t("--theirs: {side} 내용으로", { side: theirs })}>
                {theirs}
              </button>
              <button className="btn btn-small" disabled={busy} onClick={() => act(t("{file}: 해결 표시", { file: f }), () => api.resolve(worktree, f, "mark"))} title={t("에디터에서 직접 고친 뒤 해결로 표시(git add)")}>
                {t("해결됨")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="muted small">{t("충돌이 모두 해결되었습니다. '계속' 을 누르세요.")}</div>
      )}
    </div>
  );
}

/** 공동 작성자 한 사람: AI 면 로봇 + 설명 */
function CoAuthor({ identity }: { identity: string }) {
  const { name, email } = parseIdentity(identity);
  const ai = aiAgentOf({ name, email });
  return (
    <span className={`cd-coauthor${ai ? " is-ai" : ""}`} title={ai ? t("함께 쓴 AI: {names}", { names: AI_NAME[ai] }) : undefined}>
      {ai && <AiMark agent={ai} />}
      {name || email}
      {name && email && <span className="cd-email">&lt;{email}&gt;</span>}
    </span>
  );
}

function CommitDetailView(props: { worktree: string; sha: string; graph: GraphData; status: WorktreeStatus | null; onClose: () => void }) {
  const [d, setD] = useState<CommitDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const openViewer = useStore((s) => s.openViewer);
  const viewer = useShownViewer(props.worktree);
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
        <button className="btn btn-ghost btn-small" onClick={props.onClose} aria-label={t("닫기")}>
          ✕
        </button>
      </div>
      {err && <div className="banner banner-error">{err}</div>}
      {d && (
        <>
          <div className="cd-msg">{d.message}</div>
          <div className="cd-meta">
            {d.author} {d.email && <span className="cd-email">&lt;{d.email}&gt;</span>} · {new Date(d.time * 1000).toLocaleString(locale)} · {t("부모")} {d.parents.map((p) => p.slice(0, 7)).join(", ") || t("없음")}
          </div>
          {d.coAuthors.length > 0 && (
            <div className="cd-meta cd-people">
              <span className="cd-label">{t("공동 작성자")}</span>
              {d.coAuthors.map((c) => (
                <CoAuthor key={c} identity={c} />
              ))}
            </div>
          )}
          {d.committer !== d.author && (
            <div className="cd-meta cd-people">
              <span className="cd-label">{t("커밋한 사람")}</span>
              <span>
                {d.committer} · {new Date(d.commitTime * 1000).toLocaleString(locale)}
              </span>
            </div>
          )}
          <div className="cd-actions">
            {refsHere.filter((r) => !(r.kind === "branch" && r.short === cur)).map((r) => (
              <button
                key={r.name}
                className="btn btn-small"
                onClick={() => ga.checkout(props.worktree, r.short, r.kind === "remote" ? "remote" : "branch", props.graph.worktrees)}
              >
                {t("전환: {name}", { name: r.short })}
              </button>
            ))}
            <button className="btn btn-small btn-ghost" onClick={() => ga.newWorktree(repo?.path ?? props.worktree, { base: props.sha })}>
              {t("새 워크트리…")}
            </button>
            <button className="btn btn-small btn-ghost" onClick={() => ga.checkout(props.worktree, props.sha, "commit", props.graph.worktrees)}>
              {t("이 커밋으로 이동…")}
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
