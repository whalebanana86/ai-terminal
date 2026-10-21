import { Maximize2, Minus, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type StatusEntry, type WorktreeStatus } from "../api";
import { Empty } from "../components/Overlays";
import { isNestedRepoEntry, kindLabel, kindLetter } from "../logic";
import { useStore } from "../store";
import { StageView } from "./FilePanel";
import { t } from "../i18n";

/** 스테이지된 변경(index ≠ HEAD) */
export const isStaged = (e: StatusEntry) => e.kind !== "ignored" && e.kind !== "untracked" && e.kind !== "conflicted" && e.index !== ".";
/** 스테이지 안 된 변경(워크트리 ≠ index, 새 파일, 충돌) */
export const isUnstaged = (e: StatusEntry) => e.kind !== "ignored" && (e.worktree !== "." || e.kind === "untracked" || e.kind === "conflicted");

/** 변경 사항 탭: 스테이지/안 됨을 나눠 보여 주고, 스테이지된 것만 커밋한다. 파일을 누르면 바로 아래에서 부분(hunk) 단위로 담는다. */
export function ChangesView({ worktree, status, onChanged }: { worktree: string; status: WorktreeStatus | null; onChanged: () => void }) {
  const [msg, setMsg] = useState("");
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useStore((s) => s.toast);
  const ask = useStore((s) => s.ask);
  const openViewer = useStore((s) => s.openViewer);
  const [sel, setSel] = useState<string | null>(null);
  const [listH, setListH] = useState(() => Number(localStorage.getItem("aiterm.changesListH")) || 180);
  const box = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => (status?.entries ?? []).filter((e) => e.kind !== "ignored"), [status]);
  const staged = entries.filter(isStaged);
  const unstaged = entries.filter(isUnstaged);
  useEffect(() => {
    setAmend(false);
    setSel(null);
  }, [worktree]);
  // 고른 파일이 목록에서 사라지면(커밋·되돌림) 아래 칸도 닫는다.
  const selGone = sel !== null && !entries.some((e) => e.path === sel);
  useEffect(() => {
    if (selGone) setSel(null);
  }, [selGone]);
  const startResize = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const top = box.current?.getBoundingClientRect().top ?? 0;
    const max = (box.current?.clientHeight ?? 600) - 120;
    let h = listH;
    const move = (e: MouseEvent) => setListH((h = Math.max(80, Math.min(max, e.clientY - top))));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      localStorage.setItem("aiterm.changesListH", String(Math.round(h)));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const act = async (label: string, fn: () => Promise<unknown>, quiet = true) => {
    setBusy(true);
    try {
      await fn();
      if (!quiet) toast("success", t("{label} 완료", { label }));
    } catch (e) {
      toast("error", t("{label} 실패: {error}", { label, error: errorText(e) }));
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
      title: t("변경 버리기"),
      body: t("{path} 의 스테이지하지 않은 변경을 버리고 마지막으로 스테이지한(또는 커밋한) 상태로 되돌립니다. 되돌릴 수 없습니다.", { path: e.path }),
      danger: true,
      confirmLabel: t("버리기"),
    });
    if (ok) await act(t("변경 버리기"), () => api.discard(worktree, [e.path]), false);
  };
  const commit = async () => {
    setBusy(true);
    try {
      // 스테이지된 것만 커밋한다(에이전트가 남긴 임시 파일이 몰래 담기지 않게).
      await api.commitStaged(worktree, msg, amend);
      toast("success", amend ? t("마지막 커밋을 고쳤습니다") : t("커밋했습니다"));
      setMsg("");
      setAmend(false);
    } catch (e) {
      toast("error", t("커밋 실패: {error}", { error: errorText(e) }));
    } finally {
      setBusy(false);
      onChanged();
      useStore.getState().bumpGit();
    }
  };

  if (!status) return <div className="loading">{t("상태를 읽는 중…")}</div>;
  if (!entries.length && !amend) return <Empty title={t("변경 사항 없음")}>{t("워크트리가 HEAD 와 같습니다.")}</Empty>;

  const row = (e: StatusEntry, side: "staged" | "unstaged") => {
    const nested = isNestedRepoEntry(e.path);
    const on = sel === e.path;
    // 새 파일·중첩 저장소는 나눌 부분이 없으니 오른쪽에서 내용을 보여 준다.
    const wholeOnly = e.kind === "untracked" || nested;
    const kind = side === "staged" ? e.kind : e.kind === "untracked" ? "untracked" : e.worktree === "D" ? "deleted" : e.kind;
    return (
      <li key={`${side}:${e.path}`} className={on ? "on" : ""} data-path={e.path} data-side={side}>
        <span className={`kind kind-${kind}`} title={kindLabel(kind)}>
          {kindLetter(kind)}
        </span>
        <span className="path" onClick={() => (wholeOnly ? openViewer({ kind: "file", rel: e.path, mode: "preview" }) : setSel(on ? null : e.path))}>
          {e.path}
          {e.origPath && <span className="muted"> ← {e.origPath}</span>}
        </span>
        {nested && <span className="tag tag-warn" title={t("안쪽에 다른 Git 저장소나 워크트리가 있어 커밋하지 않습니다")}>{t("중첩 저장소")}</span>}
        {side === "unstaged" && !nested && e.kind !== "untracked" && e.kind !== "conflicted" && (
          <button className="icon-btn danger hover-only" disabled={busy} title={t("변경 버리기 (되돌릴 수 없음)")} aria-label={t("{path} 변경 버리기", { path: e.path })} onClick={() => discard(e)}>
            <Trash2 size={13} aria-hidden />
          </button>
        )}
        {side === "unstaged" && !nested && (
          <button
            className="icon-btn"
            disabled={busy}
            title={e.kind === "conflicted" ? t("충돌을 고쳤으면 해결됨으로 표시") : t("커밋에 담기")}
            aria-label={t("{path} 스테이지", { path: e.path })}
            onClick={() => (e.kind === "conflicted" ? act(t("해결됨 표시"), () => api.resolve(worktree, e.path, "mark"), false) : act(t("스테이지"), () => api.stage(worktree, [e.path])))}
          >
            <Plus size={14} aria-hidden />
          </button>
        )}
        {side === "staged" && (
          <button className="icon-btn" disabled={busy} title={t("스테이지 해제")} aria-label={t("{path} 스테이지 해제", { path: e.path })} onClick={() => act(t("스테이지 해제"), () => api.unstage(worktree, e.origPath ? [e.path, e.origPath] : [e.path]))}>
            <Minus size={14} aria-hidden />
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="changes" ref={box}>
      <div className="changes-scroll" style={sel ? { flex: `0 0 ${listH}px` } : undefined}>
        <div className="changes-head">
          <b>{t("바뀐 파일")}</b> <span className="count">{unstaged.length}</span>
          <span className="spacer" />
          <button className="btn btn-small" disabled={busy || !pathsOf(unstaged).length} onClick={() => act(t("모두 스테이지"), () => api.stage(worktree, pathsOf(unstaged)))}>
            {t("모두 담기")}
          </button>
        </div>
        <ul className="file-list" data-testid="unstaged-list">
          {unstaged.map((e) => row(e, "unstaged"))}
        </ul>
        <div className="changes-head">
          <b>{t("커밋에 담음")}</b> <span className="count">{staged.length}</span>
          <span className="spacer" />
          <button className="btn btn-small" disabled={busy || !staged.length} onClick={() => act(t("모두 스테이지 해제"), () => api.unstage(worktree, pathsOf(staged)))}>
            {t("모두 해제")}
          </button>
        </div>
        <ul className="file-list" data-testid="staged-list">
          {staged.map((e) => row(e, "staged"))}
          {!staged.length && <li className="muted small pad-s">{t("커밋할 파일을 + 로 담으세요. 파일을 누르면 바로 아래에서 일부 줄만 담을 수도 있어요.")}</li>}
        </ul>
      </div>
      {sel && (
        <div className="changes-stage" data-testid="changes-stage">
          <div className="split-grip" onMouseDown={startResize} title={t("끌어서 크기 조절")} />
          <div className="changes-stage-head">
            <span className="path-text" title={sel}>
              {sel}
            </span>
            <span className="muted small">{t("일부만 담기")}</span>
            <span className="spacer" />
            <button className="icon-btn" title={t("오른쪽 넓은 보기에서 열기")} aria-label={t("오른쪽에서 크게 보기")} onClick={() => openViewer({ kind: "file", rel: sel, mode: "stage" })}>
              <Maximize2 size={13} aria-hidden />
            </button>
            <button className="icon-btn" title={t("닫기")} aria-label={t("부분 담기 닫기")} onClick={() => setSel(null)}>
              <X size={13} aria-hidden />
            </button>
          </div>
          <div className="changes-stage-body">
            <StageView worktree={worktree} rel={sel} />
          </div>
        </div>
      )}
      <div className="commit-box">
        {(staged.length > 0 || amend) && (
          <div className="commit-preview muted small" data-testid="commit-preview">
            {amend && !staged.length
              ? t("마지막 커밋의 메시지만 바꿉니다")
              : staged.length > 3
                ? t("커밋될 파일: {files} 외 {n}개", { files: staged.slice(0, 3).map((e) => e.path).join(", "), n: staged.length - 3 })
                : t("커밋될 파일: {files}", { files: staged.map((e) => e.path).join(", ") })}
          </div>
        )}
        <textarea
          placeholder={amend ? t("고칠 커밋 메시지") : t("커밋 메시지")}
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          rows={3}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey && msg.trim() && (staged.length || amend)) void commit();
          }}
        />
        <div className="commit-row">
          <label className="chk" title={t("마지막 커밋에 스테이지된 변경을 더하고 메시지를 바꿉니다 (git commit --amend)")}>
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> {t("마지막 커밋 고치기")}
          </label>
          <span className="spacer" />
          <button
            className="btn btn-primary"
            disabled={busy || !msg.trim() || (!staged.length && !amend)}
            onClick={commit}
            data-testid="commit-btn"
            title={!staged.length && !amend ? t("먼저 커밋할 파일을 + 로 담으세요") : !msg.trim() ? t("커밋 메시지를 입력하세요") : "⌘⏎"}
          >
            {busy
              ? t("커밋 중…")
              : amend
                ? t("커밋 고치기")
                : staged.length === 1
                  ? t("커밋 (1개 파일)")
                  : staged.length
                    ? t("커밋 ({n}개 파일)", { n: staged.length })
                    : t("담은 파일 없음")}
          </button>
        </div>
      </div>
    </div>
  );
}
