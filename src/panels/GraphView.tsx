import { useEffect, useMemo, useRef, useState } from "react";
import type { GitRef, GraphData, GraphRow, Worktree } from "../api";
import { baseName, laneColor, relativeTime } from "../logic";

const ROW_H = 26;
const LANE_W = 13;
const MAX_LANES_SHOWN = 14;

interface Props {
  data: GraphData;
  focusWorktree: string;
  /** 세션 시작 브랜치 (현재와 다르면 따로 표시) */
  sessionStartBranch: string | null;
  selectedSha: string | null;
  onSelect: (sha: string) => void;
  /** 우클릭: 그 커밋에서 할 수 있는 작업 메뉴 */
  onContextMenu?: (sha: string, x: number, y: number) => void;
  scrollToHeadSignal: number;
}

export function GraphView({ data, focusWorktree, sessionStartBranch, selectedSha, onSelect, onContextMenu, scrollToHeadSignal }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const now = Date.now();

  const refsBySha = useMemo(() => {
    const m = new Map<string, GitRef[]>();
    for (const r of data.refs) {
      const list = m.get(r.target) ?? [];
      list.push(r);
      m.set(r.target, list);
    }
    // 로컬 브랜치 → 원격 → 태그 순
    const order = { branch: 0, remote: 1, tag: 2 } as const;
    for (const list of m.values()) list.sort((a, b) => order[a.kind] - order[b.kind] || a.short.localeCompare(b.short));
    return m;
  }, [data.refs]);

  const wtBySha = useMemo(() => {
    const m = new Map<string, Worktree[]>();
    for (const w of data.worktrees) {
      if (!w.head) continue;
      m.set(w.head, [...(m.get(w.head) ?? []), w]);
    }
    return m;
  }, [data.worktrees]);

  // 포커스 HEAD 에서 첫 번째 부모만 따라간 "줄기"
  const chain = useMemo(() => {
    const bySha = new Map(data.rows.map((r) => [r.sha, r]));
    const set = new Set<string>();
    let cur = data.head ? bySha.get(data.head) : undefined;
    while (cur && set.size < 5000) {
      set.add(cur.sha);
      cur = cur.parents[0] ? bySha.get(cur.parents[0]) : undefined;
    }
    return set;
  }, [data.rows, data.head]);

  const maxWidth = useMemo(() => Math.min(MAX_LANES_SHOWN, Math.max(1, ...data.rows.map((r) => r.width))), [data.rows]);
  const graphW = maxWidth * LANE_W + 10;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!scrollToHeadSignal || !data.head) return;
    const idx = data.rows.findIndex((r) => r.sha === data.head);
    if (idx >= 0 && scroller.current) scroller.current.scrollTop = Math.max(0, idx * ROW_H - height / 3);
  }, [scrollToHeadSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const last = Math.min(data.rows.length, Math.ceil((scrollTop + height) / ROW_H) + 8);
  const visible = data.rows.slice(first, last);

  return (
    <div className="graph" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} tabIndex={0} aria-label="커밋 그래프">
      <div style={{ height: data.rows.length * ROW_H, position: "relative" }}>
        {visible.map((row, i) => (
          <Row
            key={row.sha}
            row={row}
            top={(first + i) * ROW_H}
            graphW={graphW}
            refs={refsBySha.get(row.sha) ?? []}
            worktrees={wtBySha.get(row.sha) ?? []}
            focusWorktree={focusWorktree}
            headBranch={data.headBranch}
            isHead={row.sha === data.head}
            onChain={chain.has(row.sha)}
            sessionStartBranch={sessionStartBranch}
            selected={row.sha === selectedSha}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            now={now}
          />
        ))}
      </div>
      {data.truncated && <div className="graph-more">최근 {data.limit}개 커밋만 표시합니다</div>}
    </div>
  );
}

function x(l: number) {
  return 7 + l * LANE_W;
}
const Y = [0, ROW_H / 2, ROW_H];

function Row(props: {
  row: GraphRow;
  top: number;
  graphW: number;
  refs: GitRef[];
  worktrees: Worktree[];
  focusWorktree: string;
  headBranch: string | null;
  isHead: boolean;
  onChain: boolean;
  sessionStartBranch: string | null;
  selected: boolean;
  onSelect: (sha: string) => void;
  onContextMenu?: (sha: string, x: number, y: number) => void;
  now: number;
}) {
  const { row, isHead } = props;
  const color = laneColor(row.color);
  // 표시 폭을 넘는 레인은 그리지 않는다(마지막 레인에 겹쳐 그리면 다른 브랜치가 한 줄기처럼 보인다).
  const fits = (l: number) => l < MAX_LANES_SHOWN;
  const clip = (l: number) => l;
  return (
    <div
      className={`grow${props.selected ? " selected" : ""}${props.onChain ? " on-chain" : ""}${isHead ? " is-head" : ""}`}
      style={{ top: props.top, height: ROW_H }}
      onClick={() => props.onSelect(row.sha)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onContextMenu?.(row.sha, e.clientX, e.clientY);
      }}
      data-sha={row.sha}
      title={`${row.sha.slice(0, 10)} · ${row.author}`}
    >
      <svg width={props.graphW} height={ROW_H} className="glanes" aria-hidden>
        {row.segments.filter((s) => fits(s.fromLane) && fits(s.toLane)).map((s, i) => {
          const x1 = x(clip(s.fromLane));
          const x2 = x(clip(s.toLane));
          const y1 = Y[s.fromY];
          const y2 = Y[s.toY];
          const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
          return <path key={i} d={d} stroke={laneColor(s.color)} strokeWidth={2} fill="none" />;
        })}
        {!fits(row.lane) && (
          <text x={x(MAX_LANES_SHOWN - 1)} y={ROW_H / 2 + 4} fontSize={10} fill="var(--fg-faint)" textAnchor="middle">
            ›
          </text>
        )}
        {fits(row.lane) && isHead && <circle cx={x(clip(row.lane))} cy={ROW_H / 2} r={7.5} fill="none" stroke="#fff" strokeWidth={1.5} />}
        {fits(row.lane) && <circle
          cx={x(clip(row.lane))}
          cy={ROW_H / 2}
          r={row.parents.length > 1 ? 3.5 : 4.5}
          fill={row.parents.length > 1 ? "var(--bg-1)" : color}
          stroke={color}
          strokeWidth={2}
        />}
      </svg>
      <div className="gmsg">
        <span className="grefs">
          {badges(props).map((b) => (
            <span key={b.key} className={b.cls} title={b.title}>
              {b.label}
            </span>
          ))}
        </span>
        <span className="gsubject">{row.subject}</span>
      </div>
      <div className="gauthor">{row.author}</div>
      <div className="gtime">{relativeTime(row.time * 1000, props.now)}</div>
    </div>
  );
}

interface Badge {
  key: string;
  cls: string;
  title: string;
  label: string;
  rank: number;
}

const MAX_BADGES = 3;

/** 보고 있는 HEAD·브랜치를 맨 앞에, 나머지는 개수가 많으면 "+N" 으로 접는다(제목이 가려지지 않게). */
function badges(p: { refs: GitRef[]; worktrees: Worktree[]; focusWorktree: string; headBranch: string | null; sessionStartBranch: string | null }): Badge[] {
  const out: Badge[] = [];
  for (const w of p.worktrees) {
    const mine = w.path === p.focusWorktree;
    out.push({
      key: `wt:${w.path}`,
      cls: `ref ref-wt${mine ? " ref-focus" : ""}`,
      title: mine ? "지금 보는 폴더가 가리키는 커밋" : `다른 폴더(워크트리) ${w.path} 가 가리키는 커밋`,
      label: mine ? "현재" : `📁 ${baseName(w.path)}`,
      rank: mine ? 0 : 3,
    });
  }
  for (const r of p.refs) {
    const focusBranch = r.kind === "branch" && r.short === p.headBranch;
    const startBranch = r.kind === "branch" && r.short === p.sessionStartBranch && !focusBranch;
    out.push({
      key: r.name,
      cls: `ref ref-${r.kind}${focusBranch ? " ref-focus" : ""}${startBranch ? " ref-start" : ""}`,
      title: `${r.kind === "branch" ? "로컬 브랜치" : r.kind === "remote" ? "원격 브랜치" : "태그"} ${r.short}${r.track ? " " + r.track : ""}${startBranch ? " · 세션이 시작된 브랜치" : ""}`,
      label: r.short + (startBranch ? " (세션 시작)" : ""),
      rank: focusBranch ? 1 : startBranch ? 2 : r.kind === "branch" ? 4 : r.kind === "remote" ? 5 : 6,
    });
  }
  out.sort((a, b) => a.rank - b.rank);
  if (out.length <= MAX_BADGES + 1) return out;
  const shown = out.slice(0, MAX_BADGES);
  const rest = out.slice(MAX_BADGES);
  shown.push({ key: "more", cls: "ref ref-more", title: rest.map((b) => b.label).join("\n"), label: `+${rest.length}`, rank: 99 });
  return shown;
}
