import { useCallback, useEffect, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api, errorText, type ChangeKind, type DirEntry, type FileContent, type FileDiff, type WorktreeStatus } from "../api";
import { Empty } from "../components/Overlays";
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
          <button className="btn btn-ghost btn-small" onClick={() => void api.revealInFinder(wt)} title="Finder 에서 보기">
            Finder
          </button>
        )}
      </PanelHead>
      {!wt ? (
        <Empty title="볼 워크트리가 없습니다" />
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
  const gitTick = useStore((s) => s.gitTick);
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

  // 외부 변경(에이전트, 에디터)이 오면 펼쳐 둔 폴더를 모두 다시 읽는다.
  useEffect(() => {
    if (!fsTick) return;
    for (const rel of expanded) void loadDir(rel);
  }, [fsTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.status(worktree).then(setStatus, () => setStatus(null));
  }, [worktree, gitTick, fsTick]);

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
            <span className="name">{e.name}</span>
            {n ? <span className="dir-dot" title={`변경 ${n}개`}>●</span> : null}
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
        <span className="muted path-text" title={worktree}>
          {baseName(worktree)}
        </span>
        <span className="spacer" />
        <label className="chk">
          <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> 변경만 ({changed.length})
        </label>
        <label className="chk" title=".gitignore 로 무시되는 파일">
          <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} /> 무시된 파일
        </label>
      </div>
      {err && <div className="banner banner-error">{err}</div>}
      <ul className="tree" aria-label="파일 트리">
        {onlyChanged
          ? changed.map((e) => {
              const on = viewer?.kind === "file" && viewer.rel === e.path;
              return (
                <li key={e.path} className={`tree-row file k-${e.kind}${on ? " on" : ""}`} style={{ paddingLeft: 10 }} onClick={() => openViewer({ kind: "file", rel: e.path, mode: "diff" })} data-rel={e.path}>
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
  const fsTick = useStore((s) => s.fsTick);
  const gitTick = useStore((s) => s.gitTick);
  const [content, setContent] = useState<FileContent | null>(null);
  const [diff, setDiff] = useState<FileDiff[] | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const mode = viewer.kind === "commit-file" ? "diff" : viewer.mode;
  const key = viewer.kind === "commit-file" ? `${viewer.sha}:${viewer.rel}` : `${viewer.rel}:${mode}`;

  useEffect(() => {
    let alive = true;
    setErr(null);
    (async () => {
      try {
        if (viewer.kind === "commit-file") {
          const d = await api.diffCommitFile(worktree, viewer.sha, viewer.rel);
          if (alive) setDiff(d);
        } else if (mode === "diff") {
          const d = await api.diffFile(worktree, viewer.rel);
          if (alive) setDiff(d);
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
  }, [worktree, key, viewer.kind === "commit-file" ? 0 : fsTick + gitTick]); // eslint-disable-line react-hooks/exhaustive-deps

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
            <button className={mode === "diff" ? "on" : ""} onClick={() => openViewer({ ...viewer, mode: "diff" })}>
              변경
            </button>
          </div>
        )}
        <button className="btn btn-ghost btn-small" onClick={() => openViewer(null)} aria-label="닫기">
          ✕
        </button>
      </div>
      {err && <div className="banner banner-error">{err}</div>}
      <div className="viewer-body">
        {mode === "diff" ? (
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

export function DiffView({ diff }: { diff: FileDiff[] }) {
  if (!diff.length) return <Empty title="변경 없음">HEAD 와 같습니다.</Empty>;
  return (
    <div className="diff" data-testid="diff-view">
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
