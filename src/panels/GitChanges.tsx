import { useEffect, useMemo, useState } from "react";
import { api, errorText, type StatusEntry, type WorktreeStatus } from "../api";
import { Empty } from "../components/Overlays";
import { isNestedRepoEntry, kindLabel, kindLetter } from "../logic";
import { useStore } from "../store";

/** 스테이지된 변경(index ≠ HEAD) */
export const isStaged = (e: StatusEntry) => e.kind !== "ignored" && e.kind !== "untracked" && e.kind !== "conflicted" && e.index !== ".";
/** 스테이지 안 된 변경(워크트리 ≠ index, 새 파일, 충돌) */
export const isUnstaged = (e: StatusEntry) => e.kind !== "ignored" && (e.worktree !== "." || e.kind === "untracked" || e.kind === "conflicted");

/** 변경 사항 탭: 스테이지/안 됨을 나눠 보여 주고, 스테이지된 것만 커밋한다. hunk 단위는 오른쪽 '스테이징' 보기에서. */
export function ChangesView({ worktree, status, onChanged }: { worktree: string; status: WorktreeStatus | null; onChanged: () => void }) {
  const [msg, setMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const ask = useStore((s) => s.ask);
  const openViewer = useStore((s) => s.openViewer);
  const viewer = useStore((s) => s.viewer);
  const entries = useMemo(() => (status?.entries ?? []).filter((e) => e.kind !== "ignored"), [status]);
  const staged = entries.filter(isStaged);
  const unstaged = entries.filter(isUnstaged);
  useEffect(() => {
    setAmend(false);
  }, [worktree]);

  const act = async (label: string, fn: () => Promise<unknown>, quiet = true) => {
    setBusy(true);
    try {
      await fn();
      if (!quiet) toast("success", `${label} 완료`);
    } catch (e) {
      toast("error", `${label} 실패: ${errorText(e)}`);
    } finally {
      setBusy(false);
      onChanged();
      useStore.getState().bumpGit();
    }
  };
  // 일괄 스테이지에서는 중첩 저장소와 충돌 파일을 뺀다(충돌 파일은 '해결됨' 검사를 거쳐야 한다).
  const pathsOf = (list: StatusEntry[]) =>
    list.filter((e) => !isNestedRepoEntry(e.path) && e.kind !== "conflicted").flatMap((e) => (e.origPath ? [e.path, e.origPath] : [e.path]));
  const discard = async (e: StatusEntry) => {
    const ok = await ask({
      title: "변경 버리기",
      body: `${e.path} 의 스테이지하지 않은 변경을 버리고 마지막으로 스테이지한(또는 커밋한) 상태로 되돌립니다. 되돌릴 수 없습니다.`,
      danger: true,
      confirmLabel: "버리기",
    });
    if (ok) await act("변경 버리기", () => api.discard(worktree, [e.path]), false);
  };
  const commit = async () => {
    setBusy(true);
    try {
      if (!staged.length && !amend) {
        // 스테이지된 게 없으면 모두 스테이지하고 커밋(중첩 저장소 제외)
        await api.stage(worktree, pathsOf(unstaged));
      }
      await api.commitStaged(worktree, msg, amend);
      toast("success", amend ? "마지막 커밋을 고쳤습니다" : "커밋했습니다");
      setMsg("");
      setAmend(false);
    } catch (e) {
      toast("error", `커밋 실패: ${errorText(e)}`);
    } finally {
      setBusy(false);
      onChanged();
      useStore.getState().bumpGit();
    }
  };

  if (!status) return <div className="loading">상태를 읽는 중…</div>;
  if (!entries.length && !amend) return <Empty title="변경 사항 없음">워크트리가 HEAD 와 같습니다.</Empty>;

  const row = (e: StatusEntry, side: "staged" | "unstaged") => {
    const nested = isNestedRepoEntry(e.path);
    const on = viewer?.kind === "file" && viewer.rel === e.path;
    const kind = side === "staged" ? e.kind : e.kind === "untracked" ? "untracked" : e.worktree === "D" ? "deleted" : e.kind;
    return (
      <li key={`${side}:${e.path}`} className={on ? "on" : ""} data-path={e.path} data-side={side}>
        <span className={`kind kind-${kind}`} title={kindLabel(kind)}>
          {kindLetter(kind)}
        </span>
        <span className="path" onClick={() => openViewer({ kind: "file", rel: e.path, mode: e.kind === "untracked" || nested ? "preview" : "stage" })}>
          {e.path}
          {e.origPath && <span className="muted"> ← {e.origPath}</span>}
        </span>
        {nested && <span className="tag tag-warn" title="안쪽에 다른 Git 저장소나 워크트리가 있어 커밋하지 않습니다">중첩 저장소</span>}
        {side === "unstaged" && !nested && e.kind !== "untracked" && e.kind !== "conflicted" && (
          <button className="icon-btn" disabled={busy} title="변경 버리기" aria-label={`${e.path} 변경 버리기`} onClick={() => discard(e)}>
            ↺
          </button>
        )}
        {side === "unstaged" && !nested && (
          <button
            className="icon-btn"
            disabled={busy}
            title={e.kind === "conflicted" ? "충돌 표시가 없으면 해결됨으로 표시" : "스테이지"}
            aria-label={`${e.path} 스테이지`}
            onClick={() => (e.kind === "conflicted" ? act("해결됨 표시", () => api.resolve(worktree, e.path, "mark"), false) : act("스테이지", () => api.stage(worktree, [e.path])))}
          >
            +
          </button>
        )}
        {side === "staged" && (
          <button className="icon-btn" disabled={busy} title="스테이지 취소" aria-label={`${e.path} 스테이지 취소`} onClick={() => act("스테이지 취소", () => api.unstage(worktree, e.origPath ? [e.path, e.origPath] : [e.path]))}>
            −
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="changes">
      <div className="changes-scroll">
        <div className="changes-head">
          <b>스테이지 안 됨</b> <span className="count">{unstaged.length}</span>
          <span className="spacer" />
          <button className="btn btn-small" disabled={busy || !unstaged.length} onClick={() => act("모두 스테이지", () => api.stage(worktree, pathsOf(unstaged)))}>
            모두 스테이지
          </button>
        </div>
        <ul className="file-list" data-testid="unstaged-list">
          {unstaged.map((e) => row(e, "unstaged"))}
        </ul>
        <div className="changes-head">
          <b>스테이지됨</b> <span className="count">{staged.length}</span>
          <span className="spacer" />
          <button className="btn btn-small" disabled={busy || !staged.length} onClick={() => act("모두 스테이지 취소", () => api.unstage(worktree, pathsOf(staged)))}>
            모두 취소
          </button>
        </div>
        <ul className="file-list" data-testid="staged-list">
          {staged.map((e) => row(e, "staged"))}
          {!staged.length && <li className="muted small">파일 줄의 + 또는 오른쪽 '스테이징' 보기의 hunk 단위로 스테이지하세요.</li>}
        </ul>
      </div>
      <div className="commit-box">
        <textarea
          placeholder={amend ? "고칠 커밋 메시지" : "커밋 메시지"}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey && msg.trim()) void commit();
          }}
        />
        <div className="commit-row">
          <label className="chk" title="마지막 커밋에 스테이지된 변경을 더하고 메시지를 바꿉니다 (git commit --amend)">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> 마지막 커밋 고치기
          </label>
          <span className="spacer" />
          <button className="btn btn-primary" disabled={busy || !msg.trim() || (!staged.length && !unstaged.length && !amend)} onClick={commit} data-testid="commit-btn">
            {busy ? "커밋 중…" : amend ? "커밋 고치기" : staged.length ? `스테이지된 ${staged.length}개 커밋` : `모두 스테이지하고 커밋 (${pathsOf(unstaged).length})`}
          </button>
        </div>
      </div>
    </div>
  );
}
