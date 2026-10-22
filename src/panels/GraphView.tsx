import { useEffect, useMemo, useRef, useState } from "react";
import type { GitRef, GraphData, GraphRow, Worktree } from "../api";
import { baseName, laneColor, relativeTime } from "../logic";
import { colorOf, metroColors, useWtColors } from "../wtColors";
import { t } from "../i18n";
import { AI_NAME, aiAgentsIn } from "../aiAuthors";
import { AiMark } from "../components/AiMark";
import { authorLabel, isSingleAuthor } from "../author";
import { AuthorCell } from "./AuthorCell";

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

  // 워크트리마다 노선 색: HEAD 에서 갈라진 곳까지의 선과 커밋을 그 색으로
  const wtColors = useWtColors();
  const metro = useMemo(() => metroColors(data.rows, data.worktrees, (p) => colorOf(wtColors, p)), [data.rows, data.worktrees, wtColors]);
  const colorFor = (p: string) => colorOf(wtColors, p);

  // 작성자가 한 명뿐이면 작성자 칸을 그리지 않는다(보이는 줄이 아니라 불러온 전체 기준이라 스크롤해도 그대로)
  const showAuthor = useMemo(() => !isSingleAuthor(data.rows), [data.rows]);

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
    <div className="graph" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} tabIndex={0} aria-label={t("커밋 그래프")}>
      <div style={{ height: data.rows.length * ROW_H, position: "relative" }}>
        {visible.map((row, i) => (
          <Row
            key={row.sha}
            row={row}
            top={(first + i) * ROW_H}
            graphW={graphW}
            refs={refsBySha.get(row.sha) ?? []}
            worktrees={wtBySha.get(row.sha) ?? []}
            segColors={metro.seg.get(row.sha)}
            nodeColor={metro.node.get(row.sha)}
            colorFor={colorFor}
            focusWorktree={focusWorktree}
            headBranch={data.headBranch}
            isHead={row.sha === data.head}
            onChain={chain.has(row.sha)}
            sessionStartBranch={sessionStartBranch}
            selected={row.sha === selectedSha}
            onSelect={onSelect}
            onContextMenu={onContextMenu}
            showAuthor={showAuthor}
            now={now}
          />
        ))}
      </div>
      {data.truncated && <div className="graph-more">{t("최근 {n}개 커밋만 표시합니다", { n: data.limit })}</div>}
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
  segColors: (string | undefined)[] | undefined;
  nodeColor: string | undefined;
  colorFor: (path: string) => string;
  focusWorktree: string;
  headBranch: string | null;
  isHead: boolean;
  onChain: boolean;
  sessionStartBranch: string | null;
  selected: boolean;
  onSelect: (sha: string) => void;
  onContextMenu?: (sha: string, x: number, y: number) => void;
  showAuthor: boolean;
  now: number;
}) {
  const { row, isHead } = props;
  const color = laneColor(row.color);
  // 지금 보는 워크트리를 맨 앞(안쪽 고리)에
  const stations = [...props.worktrees.filter((w) => w.path === props.focusWorktree), ...props.worktrees.filter((w) => w.path !== props.focusWorktree)];
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
      title={`${row.sha.slice(0, 10)} · ${authorLabel(row.author, row.email)}${row.coAuthors.length ? `\n${t("공동 작성자: {names}", { names: row.coAuthors.join(", ") })}` : ""}`}
    >
      <svg width={props.graphW} height={ROW_H} className="glanes" aria-hidden>
        {row.segments.map((s, i) => {
          if (!fits(s.fromLane) || !fits(s.toLane)) return null;
          const x1 = x(clip(s.fromLane));
          const x2 = x(clip(s.toLane));
          const y1 = Y[s.fromY];
          const y2 = Y[s.toY];
          const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
          // 워크트리 노선은 굵고 선명하게, 워크트리가 없는 갈래는 가늘고 흐리게
          const metro = props.segColors?.[i];
          return metro ? (
            <path key={i} d={d} stroke={metro} strokeWidth={3} fill="none" strokeLinecap="round" />
          ) : (
            <path key={i} d={d} stroke={laneColor(s.color)} strokeWidth={1.5} strokeOpacity={0.45} fill="none" />
          );
        })}
        {!fits(row.lane) && (
          <text x={x(MAX_LANES_SHOWN - 1)} y={ROW_H / 2 + 4} fontSize={10} fill="var(--fg-faint)" textAnchor="middle">
            ›
          </text>
        )}
        {fits(row.lane) &&
          (stations.length ? (
            // 역: 워크트리가 가리키는 커밋. 여러 워크트리가 같은 커밋이면 환승역처럼 고리를 겹친다.
            <g data-station={stations.map((w) => w.path).join("|")}>
              {isHead && <circle cx={x(clip(row.lane))} cy={ROW_H / 2} r={6 + 3 * stations.length} fill="none" stroke="#fff" strokeWidth={1.5} />}
              {stations
                .slice(0, 2)
                .reverse()
                .map((w, k, arr) => (
                  <circle key={w.path} cx={x(clip(row.lane))} cy={ROW_H / 2} r={5.5 + 3 * (arr.length - 1 - k)} fill="var(--bg-1)" stroke={props.colorFor(w.path)} strokeWidth={3} />
                ))}
            </g>
          ) : (
            <>
              {isHead && <circle cx={x(clip(row.lane))} cy={ROW_H / 2} r={7.5} fill="none" stroke="#fff" strokeWidth={1.5} />}
              <circle
                cx={x(clip(row.lane))}
                cy={ROW_H / 2}
                r={row.parents.length > 1 ? 3.5 : props.nodeColor ? 4 : 3.5}
                fill={row.parents.length > 1 ? "var(--bg-1)" : (props.nodeColor ?? color)}
                stroke={props.nodeColor ?? color}
                strokeOpacity={props.nodeColor ? 1 : 0.6}
                fillOpacity={props.nodeColor ? 1 : 0.6}
                strokeWidth={2}
              />
            </>
          ))}
      </svg>
      <div className="gmsg">
        <span className="grefs">
          {badges(props).map((b) => (
            <span key={b.key} className={b.cls} title={b.title} style={b.color ? ({ "--wc": b.color } as React.CSSProperties) : undefined}>
              {b.color && <i className="wt-dot" aria-hidden />}
              {b.label}
            </span>
          ))}
        </span>
        <span className="gsubject">{row.subject}</span>
      </div>
      <AiCell coAuthors={row.coAuthors} />
      {props.showAuthor && <AuthorCell name={row.author} email={row.email} />}
      <div className="gtime">{relativeTime(row.time * 1000, props.now)}</div>
    </div>
  );
}

/** 공동 작성자 중 AI 가 있으면 작은 로봇, 없으면 같은 폭의 빈 칸(작성자 칸이 줄 맞게) */
function AiCell({ coAuthors }: { coAuthors: string[] }) {
  const ais = aiAgentsIn(coAuthors);
  if (!ais.length) return <span className="gai" />;
  const label = t("함께 쓴 AI: {names}", { names: ais.map((a) => AI_NAME[a]).join(", ") });
  return (
    <span className="gai" title={label} role="img" aria-label={label}>
      <AiMark agent={ais[0]} />
    </span>
  );
}

interface Badge {
  key: string;
  cls: string;
  title: string;
  label: string;
  rank: number;
  /** 워크트리 역 표시면 그 노선 색 */
  color?: string;
}

const MAX_BADGES = 3;

/** 보고 있는 HEAD·브랜치를 맨 앞에, 나머지는 개수가 많으면 "+N" 으로 접는다(제목이 가려지지 않게). */
function badges(p: { refs: GitRef[]; worktrees: Worktree[]; colorFor: (path: string) => string; focusWorktree: string; headBranch: string | null; sessionStartBranch: string | null }): Badge[] {
  const out: Badge[] = [];
  for (const w of p.worktrees) {
    const mine = w.path === p.focusWorktree;
    out.push({
      key: `wt:${w.path}`,
      cls: `ref ref-wt${mine ? " ref-wt-focus" : ""}`,
      title: mine ? t("지금 보는 워크트리가 가리키는 커밋") : t("다른 워크트리 {path} 가 가리키는 커밋", { path: w.path }),
      label: mine ? t("현재") : baseName(w.path),
      rank: mine ? 0 : 3,
      color: p.colorFor(w.path),
    });
  }
  for (const r of p.refs) {
    const focusBranch = r.kind === "branch" && r.short === p.headBranch;
    const startBranch = r.kind === "branch" && r.short === p.sessionStartBranch && !focusBranch;
    out.push({
      key: r.name,
      cls: `ref ref-${r.kind}${focusBranch ? " ref-focus" : ""}${startBranch ? " ref-start" : ""}`,
      title:
        (r.kind === "branch" ? t("로컬 브랜치 {name}", { name: r.short }) : r.kind === "remote" ? t("원격 브랜치 {name}", { name: r.short }) : t("태그 {name}", { name: r.short })) +
        (r.track ? " " + r.track : "") +
        (startBranch ? " · " + t("세션이 시작된 브랜치") : ""),
      label: r.short + (startBranch ? ` (${t("세션 시작")})` : ""),
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
