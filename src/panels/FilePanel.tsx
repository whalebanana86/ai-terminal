import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Trash2 } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, errorText, type ChangeKind, type DirEntry, type FileContent, type FileDiff, type WorktreeStatus } from "../api";
import { Empty, WtDot } from "../components/Overlays";
import { FileIcon, imageMime } from "../fileIcons";
import { escapeHtml, highlightLines } from "../highlight";
import { baseName, decorationMap, kindLabel, kindLetter } from "../logic";
import { useStore } from "../store";
import { PanelHead } from "./GitPanel";

export function FilePanel() {
  const focus = useStore((s) => s.focus);
  const viewer = useStore((s) => s.viewer);
  const wt = focus?.worktreePath ?? null;
  return (
    <section className="panel" data-pane="3" tabIndex={-1}>
      <PanelHead title="파일">
        {wt && (
          <button className="icon-btn ghost" onClick={() => void api.revealInFinder(wt)} title="Finder 에서 보기" aria-label="Finder 에서 보기">
            <FolderOpen size={14} aria-hidden />
          </button>
        )}
      </PanelHead>
      {!wt ? (
        <Empty title="볼 워크트리가 없습니다">위에서 워크트리를 고르세요.</Empty>
      ) : (
        <Group orientation="vertical" className="file-split">
          <Panel id="tree" defaultSize={viewer ? "45" : "100"} minSize="15">
            <FileTree key={wt} worktree={wt} />
          </Panel>
          {viewer && (
            <>
              <Separator className="sep sep-h" />
              <Panel id="viewer" defaultSize="55" minSize="20">
                <FileViewer worktree={wt} />
              </Panel>
            </>
          )}
        </Group>
      )}
    </section>
  );
}

// ───────────────────────── 트리 ─────────────────────────

function FileTree({ worktree }: { worktree: string }) {
  const fsTick = useStore((s) => s.fsTick);
  const statusTick = useStore((s) => s.statusTick);
  const viewer = useStore((s) => s.viewer);
  const openViewer = useStore((s) => s.openViewer);
  const [children, setChildren] = useState<Map<string, DirEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadDir = useCallback(
    async (rel: string) => {
      try {
        const list = await api.fsList(worktree, rel);
        setChildren((m) => new Map(m).set(rel, list));
        setErr(null);
      } catch (e) {
        if (rel === "") setErr(errorText(e));
        // 하위 폴더가 사라졌으면 펼침 목록에서도 뺀다.
        setChildren((m) => {
          const n = new Map(m);
          n.delete(rel);
          return n;
        });
      }
    },
    [worktree],
  );

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);
  // 루트도 외부 변경 때 다시 읽는다(펼친 폴더 목록에 ""가 빠졌을 때 대비)
  useEffect(() => {
    if (fsTick) void loadDir("");
  }, [fsTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // 외부 변경(에이전트, 에디터)이 오면 펼쳐 둔 폴더를 모두 다시 읽는다.
  useEffect(() => {
    if (!fsTick) return;
    for (const rel of expanded) void loadDir(rel);
  }, [fsTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let alive = true;
    api.status(worktree).then((x) => alive && setStatus(x), () => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, [worktree, statusTick]);

  const deco = useMemo(() => decorationMap(status?.entries ?? []), [status]);

  const toggle = (rel: string) => {
    const next = new Set(expanded);
    if (next.has(rel)) next.delete(rel);
    else {
      next.add(rel);
      if (!children.has(rel)) void loadDir(rel);
    }
    setExpanded(next);
  };

  const openFile = (rel: string, kind: ChangeKind | undefined) =>
    openViewer({ kind: "file", rel, mode: kind && kind !== "untracked" ? "diff" : "preview" });

  const renderDir = (rel: string, depth: number): React.ReactNode[] => {
    const list = children.get(rel);
    if (!list) return [<li key={`${rel}/…`} className="tree-loading" style={{ paddingLeft: 10 + depth * 14 }}>…</li>];
    const rows: React.ReactNode[] = [];
    const names = new Set(list.map((e) => e.rel));
    for (const e of list) {
      if (e.ignored && !showIgnored) continue;
      if (e.isDir) {
        const open = expanded.has(e.rel);
        const n = deco.dirs.get(e.rel);
        rows.push(
          <li key={e.rel} className={`tree-row dir${e.ignored ? " ignored" : ""}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(e.rel)}>
            <span className="twisty">{open ? "▾" : "▸"}</span>
            <FileIcon name={e.name} dir open={open} />
            <span className="name">{e.name}</span>
            {n ? <span className="dir-count" title={`안에 바뀐 파일 ${n}개`}>{n}</span> : null}
          </li>,
        );
        if (open) rows.push(...renderDir(e.rel, depth + 1));
      } else {
        const k = deco.files.get(e.rel);
        const on = viewer?.kind === "file" && viewer.rel === e.rel;
        rows.push(
          <li
            key={e.rel}
            className={`tree-row file${on ? " on" : ""}${e.ignored ? " ignored" : ""}${k ? ` k-${k}` : ""}`}
            style={{ paddingLeft: 22 + depth * 14 }}
            onClick={() => openFile(e.rel, k)}
            data-rel={e.rel}
          >
            <FileIcon name={e.name} />
            <span className="name">{e.name}</span>
            {k && (
              <span className={`kind kind-${k}`} title={kindLabel(k)}>
                {kindLetter(k)}
              </span>
            )}
          </li>,
        );
      }
    }
    // 디스크에서 지워졌지만 Git 이 추적하던 파일
    for (const ent of status?.entries ?? []) {
      if (ent.kind !== "deleted") continue;
      const parent = ent.path.includes("/") ? ent.path.slice(0, ent.path.lastIndexOf("/")) : "";
      if (parent !== rel || names.has(ent.path)) continue;
      const on = viewer?.kind === "file" && viewer.rel === ent.path;
      rows.push(
        <li key={`del:${ent.path}`} className={`tree-row file k-deleted${on ? " on" : ""}`} style={{ paddingLeft: 22 + depth * 14 }} onClick={() => openViewer({ kind: "file", rel: ent.path, mode: "diff" })} data-rel={ent.path}>
          <FileIcon name={baseName(ent.path)} />
          <span className="name">{baseName(ent.path)}</span>
          <span className="kind kind-deleted">D</span>
        </li>,
      );
    }
    return rows;
  };

  const changed = (status?.entries ?? []).filter((e) => e.kind !== "ignored");
  return (
    <div className="tree-wrap">
      <div className="filters">
        <WtDot path={worktree} />
        <span className="muted path-text" title={worktree}>
          {baseName(worktree)}
        </span>
        <span className="spacer" />
        <label className="chk">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> 바뀐 파일만 ({changed.length})
        </label>
        <label className="chk" title=".gitignore 로 Git 이 무시하는 파일(빌드 결과물 등)">
          <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} /> 숨김 파일
        </label>
      </div>
      {err && <div className="banner banner-error">{err}</div>}
      <ul className="tree" aria-label="파일 트리">
        {onlyChanged
          ? changed.map((e) => {
              const on = viewer?.kind === "file" && viewer.rel === e.path;
              return (
                <li key={e.path} className={`tree-row file k-${e.kind}${on ? " on" : ""}`} style={{ paddingLeft: 10 }} onClick={() => openViewer({ kind: "file", rel: e.path, mode: "diff" })} data-rel={e.path}>
                  <FileIcon name={baseName(e.path)} />
                  <span className="name">{e.path}</span>
                  <span className={`kind kind-${e.kind}`}>{kindLetter(e.kind)}</span>
                </li>
              );
            })
          : renderDir("", 0)}
        {onlyChanged && !changed.length && <li className="muted pad">변경된 파일이 없습니다</li>}
      </ul>
    </div>
  );
}

// ───────────────────────── 보기 (미리보기 / diff) ─────────────────────────

function FileViewer({ worktree }: { worktree: string }) {
  const viewer = useStore((s) => s.viewer)!;
  const openViewer = useStore((s) => s.openViewer);
  const fileTick = useFileTick(viewer.rel);
  const [content, setContent] = useState<FileContent | null>(null);
  const [diff, setDiff] = useState<FileDiff[] | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mode = viewer.kind === "commit-file" ? "diff" : viewer.mode;
  // 그림 파일은 글자 대신 그림으로(내용 = 지금 그림, 변경 = 마지막 커밋과 나란히)
  const isImage = imageMime(viewer.rel) !== null;
  const key = viewer.kind === "commit-file" ? `${viewer.sha}:${viewer.rel}` : `${viewer.rel}:${mode}`;

  useEffect(() => {
    let alive = true;
    setErr(null);
    (async () => {
      try {
        if (isImage) {
          // ImageBox 가 직접 읽는다
        } else if (viewer.kind === "commit-file") {
          const d = await api.diffCommitFile(worktree, viewer.sha, viewer.rel);
          if (alive) setDiff(d);
        } else if (mode === "diff") {
          const d = await api.diffFile(worktree, viewer.rel);
          if (alive) setDiff(d);
        } else if (mode === "stage") {
          // StageView 가 직접 읽는다
        } else {
          const c = await api.fsRead(worktree, viewer.rel);
          if (!alive) return;
          setContent(c);
          setLines(null);
          if (c.text !== null) {
            const hl = await highlightLines(c.text, viewer.rel);
            if (alive) setLines(hl ?? c.text.split("\n").map(escapeHtml));
          }
        }
      } catch (e) {
        if (alive) setErr(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
    // 커밋 diff 는 변하지 않지만, 워크트리 파일은 외부 변경 때마다 다시 읽는다.
  }, [worktree, key, viewer.kind === "commit-file" ? 0 : fileTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = viewer.rel;
  return (
    <div className="viewer">
      <div className="viewer-head">
        <span className="path-text" title={title}>
          {viewer.kind === "commit-file" && <code className="sha">{viewer.sha.slice(0, 7)}</code>} {title}
        </span>
        <span className="spacer" />
        {viewer.kind === "file" && (
          <div className="seg">
            <button className={mode === "preview" ? "on" : ""} onClick={() => openViewer({ ...viewer, mode: "preview" })}>
              내용
            </button>
            <button className={mode === "diff" ? "on" : ""} onClick={() => openViewer({ ...viewer, mode: "diff" })} title="마지막 커밋과 비교한 전체 변경">
              변경
            </button>
            {!isImage && (
              <button className={mode === "stage" ? "on" : ""} onClick={() => openViewer({ ...viewer, mode: "stage" })} title="바뀐 부분(조각)만 골라 커밋에 담기">
                일부 담기
              </button>
            )}
          </div>
        )}
        <button className="btn btn-ghost btn-small" onClick={() => openViewer(null)} aria-label="닫기">
          ✕
        </button>
      </div>
      {err && <div className="banner banner-error">{err}</div>}
      <div className="viewer-body">
        {isImage ? (
          viewer.kind === "commit-file" ? (
            <ImageBox worktree={worktree} rel={viewer.rel} rev={viewer.sha} label={`커밋 ${viewer.sha.slice(0, 7)}`} />
          ) : mode === "diff" ? (
            <div className="img-compare">
              <ImageBox worktree={worktree} rel={viewer.rel} rev="HEAD" label="마지막 커밋" />
              <ImageBox worktree={worktree} rel={viewer.rel} label="지금" />
            </div>
          ) : (
            <ImageBox worktree={worktree} rel={viewer.rel} label="지금" />
          )
        ) : mode === "stage" && viewer.kind === "file" ? (
          <StageView worktree={worktree} rel={viewer.rel} />
        ) : mode === "diff" ? (
          diff ? <DiffView diff={diff} /> : <div className="loading">…</div>
        ) : content ? (
          content.binary ? (
            <Empty title="바이너리 파일">{(content.size / 1024).toFixed(1)} KB</Empty>
          ) : (
            <>
              {content.truncated && <div className="banner">처음 1MB 만 보여 줍니다</div>}
              <pre className="code" data-testid="file-preview">
                {(lines ?? []).map((l, i) => (
                  <div key={i} className="code-line">
                    <span className="ln">{i + 1}</span>
                    <span className="lc" dangerouslySetInnerHTML={{ __html: l || " " }} />
                  </div>
                ))}
              </pre>
            </>
          )
        ) : (
          <div className="loading">…</div>
        )}
      </div>
    </div>
  );
}

/** 그림 한 장: 바둑판 배경 위에 창에 맞춰 보여 주고, 누르면 실제 크기 ↔ 맞춤. */
function ImageBox({ worktree, rel, rev, label }: { worktree: string; rel: string; rev?: string; label: string }) {
  const fileTick = useFileTick(rel);
  const [url, setUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState(0);
  const [dims, setDims] = useState<[number, number] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [actual, setActual] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    api.fsReadImage(worktree, rel, rev).then(
      (buf) => {
        if (!alive) return;
        const blob = new Blob([buf], { type: imageMime(rel) ?? "application/octet-stream" });
        made = URL.createObjectURL(blob);
        setUrl(made);
        setBytes(blob.size);
        setErr(null);
      },
      (e) => {
        if (!alive) return;
        setUrl(null);
        setErr(errorText(e));
      },
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
    // 지금 그림은 파일이 바뀔 때마다, 커밋의 그림은 git 이 바뀔 때만 다시 읽는다
  }, [worktree, rel, rev, rev ? 0 : fileTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const missing = err && /exists on disk, but not in|does not exist|not exist|No such file|없습니다|invalid object/i.test(err);
  return (
    <figure className="img-box" data-testid="image-view">
      <figcaption className="img-cap">
        <b>{label}</b>
        {dims && (
          <span className="muted">
            {dims[0]}×{dims[1]} · {bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`}
          </span>
        )}
        {url && (
          <button className="link-btn" onClick={() => setActual(!actual)} title="실제 크기 ↔ 창에 맞춤">
            {actual ? "맞춤" : "실제 크기"}
          </button>
        )}
      </figcaption>
      <div className={`img-stage${actual ? " actual" : ""}`} onClick={() => url && setActual(!actual)}>
        {url ? (
          <img src={url} alt={rel} onLoad={(e) => setDims([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} onError={() => setErr("이 형식은 그릴 수 없습니다")} />
        ) : err ? (
          <div className="muted small pad">{missing ? (rev ? "마지막 커밋에는 없던 그림이에요" : "지금은 없는 그림이에요(지워짐)") : err}</div>
        ) : (
          <div className="loading">…</div>
        )}
      </div>
    </figure>
  );
}

/** 이 파일이 바뀐 신호(또는 .git 변경)일 때만 값이 바뀐다 → 다른 파일 이벤트로는 다시 읽지 않는다. */
function useFileTick(rel: string): number {
  const fs = useStore((s) => (s.changedPaths.includes(rel) ? s.fsTick : -1));
  const git = useStore((s) => s.gitTick);
  const last = useRef(0);
  if (fs >= 0) last.current = fs;
  return last.current * 100000 + git;
}

/** 한 파일의 바뀐 부분(hunk)을 담기·빼기·버리기. 깃 패널 '변경 사항' 아래와 오른쪽 보기에서 함께 쓴다. */
export function StageView({ worktree, rel }: { worktree: string; rel: string }) {
  const fileTick = useFileTick(rel);
  const toast = useStore((s) => s.toast);
  const ask = useStore((s) => s.ask);
  const [data, setData] = useState<[FileDiff[], FileDiff[]] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    api.diffSplit(worktree, rel).then(
      (d) => alive && (setData(d), setErr(null)),
      (e) => alive && setErr(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [worktree, rel, fileTick, nonce]);

  const apply = async (action: "stage" | "unstage" | "discard", index: number, id: string) => {
    if (action === "discard") {
      const ok = await ask({ title: "이 부분의 변경 버리기", body: `${rel} 의 이 부분을 바뀌기 전으로 되돌립니다. 되돌릴 수 없어요.`, danger: true, confirmLabel: "버리기" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await api.hunk(worktree, rel, action, index, id);
    } catch (e) {
      toast("error", errorText(e));
    } finally {
      setBusy(false);
      setNonce((n) => n + 1);
      useStore.getState().bumpGit();
    }
  };

  if (err) return <div className="banner banner-error">{err}</div>;
  if (!data) return <div className="loading">…</div>;
  const total = [...data[0], ...data[1]].reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.length, 0), 0);
  if (total > MAX_DIFF_LINES)
    return <Empty title="변경이 너무 큽니다">{total}줄이 바뀌어 부분 선택을 생략했어요. 왼쪽 목록의 + / − 로 파일 전체를 담거나 빼세요.</Empty>;
  const [unstaged, staged] = data;
  const section = (title: string, files: FileDiff[], side: "unstaged" | "staged") => (
    <div className="stage-section" data-side={side}>
      <div className="stage-title">
        {title} <span className="count">{files.reduce((n, f) => n + f.hunks.length, 0)}</span>
      </div>
      {!files.length || !files.some((f) => f.hunks.length) ? (
        <div className="muted pad small">{side === "unstaged" ? "담을 변경이 없어요" : "아직 담은 부분이 없어요"}</div>
      ) : (
        files.map((f, fi) =>
          f.hunks.map((h, hi) => (
            <div key={`${fi}:${hi}:${h.id}`} className="hunk" data-hunk={hi}>
              <div className="hunk-head hunk-bar">
                <span>{h.header}</span>
                <span className="spacer" />
                {side === "unstaged" ? (
                  <>
                    <button className="btn btn-small btn-ghost danger-text" disabled={busy} onClick={() => apply("discard", hi, h.id)} title="이 부분 변경 버리기 (되돌릴 수 없음)">
                      <Trash2 size={12} aria-hidden /> 버리기
                    </button>
                    <span className="gap" />
                    <button className="btn btn-small" disabled={busy} onClick={() => apply("stage", hi, h.id)} data-action="stage-hunk" title="이 부분만 커밋에 담기 (git add -p)">
                      담기
                    </button>
                  </>
                ) : (
                  <button className="btn btn-small" disabled={busy} onClick={() => apply("unstage", hi, h.id)} data-action="unstage-hunk" title="이 부분을 커밋에서 빼기">
                    빼기
                  </button>
                )}
              </div>
              {h.lines.map((l, li) => (
                <div key={li} className={`dl dl-${l.kind === "+" ? "add" : l.kind === "-" ? "del" : l.kind === "\\" ? "meta" : "ctx"}`}>
                  <span className="ln">{l.oldNo ?? ""}</span>
                  <span className="ln">{l.newNo ?? ""}</span>
                  <span className="sign">{l.kind === "\\" ? "" : l.kind}</span>
                  <span className="lc">{l.text}</span>
                </div>
              ))}
            </div>
          )),
        )
      )}
    </div>
  );
  return (
    <div className="diff stage-view" data-testid="stage-view">
      {section("아직 안 담은 부분", unstaged, "unstaged")}
      {section("커밋에 담은 부분", staged, "staged")}
    </div>
  );
}

/** 한 번에 그리는 diff 줄 수 상한(넘으면 앞부분만). 큰 생성 파일이 화면·메모리를 잡아먹지 않게. */
const MAX_DIFF_LINES = 4000;

function capDiff(diff: FileDiff[]): { files: FileDiff[]; hidden: number } {
  let left = MAX_DIFF_LINES;
  let hidden = 0;
  const files = diff.map((f) => ({
    ...f,
    hunks: f.hunks
      .map((h) => {
        const take = Math.max(0, Math.min(left, h.lines.length));
        hidden += h.lines.length - take;
        left -= take;
        return { ...h, lines: h.lines.slice(0, take) };
      })
      .filter((h) => h.lines.length > 0),
  }));
  return { files, hidden };
}

export function DiffView({ diff: full }: { diff: FileDiff[] }) {
  if (!full.length) return <Empty title="변경 없음">마지막 커밋과 같아요.</Empty>;
  const { files: diff, hidden } = capDiff(full);
  return (
    <div className="diff" data-testid="diff-view">
      {hidden > 0 && <div className="banner">변경이 커서 앞의 {MAX_DIFF_LINES}줄만 보여 줍니다 ({hidden}줄 생략).</div>}
      {diff.map((f, fi) => (
        <div key={fi} className="diff-file">
          <div className="diff-file-head">
            {f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : f.newPath ?? f.oldPath}
            <span className="add">+{f.additions}</span>
            <span className="del">−{f.deletions}</span>
          </div>
          {f.binary && <div className="muted pad">바이너리 파일이 바뀌었습니다</div>}
          {f.hunks.map((h, hi) => (
            <div key={hi} className="hunk">
              <div className="hunk-head">{h.header}</div>
              {h.lines.map((l, li) => (
                <div key={li} className={`dl dl-${l.kind === "+" ? "add" : l.kind === "-" ? "del" : l.kind === "\\" ? "meta" : "ctx"}`}>
                  <span className="ln">{l.oldNo ?? ""}</span>
                  <span className="ln">{l.newNo ?? ""}</span>
                  <span className="sign">{l.kind === "\\" ? "" : l.kind}</span>
                  <span className="lc">{l.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
