import { Minus, Plus, Trash2 } from "lucide-react";
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
      // 스테이지된 것만 커밋한다(에이전트가 남긴 임시 파일이 몰래 담기지 않게).
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
          <button className="icon-btn danger hover-only" disabled={busy} title="변경 버리기 (되돌릴 수 없음)" aria-label={`${e.path} 변경 버리기`} onClick={() => discard(e)}>
            <Trash2 size={13} aria-hidden />
          </button>
        )}
        {side === "unstaged" && !nested && (
          <button
            className="icon-btn"
            disabled={busy}
            title={e.kind === "conflicted" ? "충돌을 고쳤으면 해결됨으로 표시" : "커밋에 담기"}
            aria-label={`${e.path} 스테이지`}
            onClick={() => (e.kind === "conflicted" ? act("해결됨 표시", () => api.resolve(worktree, e.path, "mark"), false) : act("스테이지", () => api.stage(worktree, [e.path])))}
          >
            <Plus size={14} aria-hidden />
          </button>
        )}
        {side === "staged" && (
          <button className="icon-btn" disabled={busy} title="스테이지 해제" aria-label={`${e.path} 스테이지 해제`} onClick={() => act("스테이지 해제", () => api.unstage(worktree, e.origPath ? [e.path, e.origPath] : [e.path]))}>
            <Minus size={14} aria-hidden />
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="changes">
      <div className="changes-scroll">
        <div className="changes-head">
          <b>바뀐 파일</b> <span className="count">{unstaged.length}</span>
          <span className="spacer" />
          <button className="btn btn-small" disabled={busy || !pathsOf(unstaged).length} onClick={() => act("모두 스테이지", () => api.stage(worktree, pathsOf(unstaged)))}>
            모두 담기
          </button>
        </div>
        <ul className="file-list" data-testid="unstaged-list">
          {unstaged.map((e) => row(e, "unstaged"))}
        </ul>
        <div className="changes-head">
          <b>커밋에 담음</b> <span className="count">{staged.length}</span>
          <span className="spacer" />
          <button className="btn btn-small" disabled={busy || !staged.length} onClick={() => act("모두 스테이지 해제", () => api.unstage(worktree, pathsOf(staged)))}>
            모두 해제
          </button>
        </div>
        <ul className="file-list" data-testid="staged-list">
          {staged.map((e) => row(e, "staged"))}
          {!staged.length && <li className="muted small pad-s">커밋할 파일을 + 로 담으세요. 파일을 누르면 오른쪽에서 일부 줄만 담을 수도 있어요.</li>}
        </ul>
      </div>
      <div className="commit-box">
        {(staged.length > 0 || amend) && (
          <div className="commit-preview muted small" data-testid="commit-preview">
            {amend && !staged.length ? "마지막 커밋의 메시지만 바꿉니다" : `커밋될 파일: ${staged.slice(0, 3).map((e) => e.path).join(", ")}${staged.length > 3 ? ` 외 ${staged.length - 3}개` : ""}`}
          </div>
        )}
        <textarea
          placeholder={amend ? "고칠 커밋 메시지" : "커밋 메시지"}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey && msg.trim() && (staged.length || amend)) void commit();
          }}
        />
        <div className="commit-row">
          <label className="chk" title="마지막 커밋에 스테이지된 변경을 더하고 메시지를 바꿉니다 (git commit --amend)">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> 마지막 커밋 고치기
          </label>
          <span className="spacer" />
          <button
            className="btn btn-primary"
            disabled={busy || !msg.trim() || (!staged.length && !amend)}
            onClick={commit}
            data-testid="commit-btn"
            title={!staged.length && !amend ? "먼저 커밋할 파일을 + 로 담으세요" : !msg.trim() ? "커밋 메시지를 입력하세요" : "⌘⏎"}
          >
            {busy ? "커밋 중…" : amend ? "커밋 고치기" : staged.length ? `커밋 (${staged.length}개 파일)` : "담은 파일 없음"}
          </button>
        </div>
        {!staged.length && !amend && pathsOf(unstaged).length > 0 && (
          <button className="link-btn" disabled={busy} onClick={() => act("모두 담기", () => api.stage(worktree, pathsOf(unstaged)))} data-testid="stage-all-link">
            변경 {pathsOf(unstaged).length}개 모두 담기
          </button>
        )}
      </div>
    </div>
  );
}
