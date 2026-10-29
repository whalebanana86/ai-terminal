import { BODY_RECTS, color, EYES, H, LAYERS, PERCH_RECTS, PROPS, W, type BukiPose, type LayerName, type Rect } from "../buki";
import { useStore } from "../store";
import { useWtColor } from "../wtColors";

/** 요청 종류마다 1.6초 동작(styles.css 의 .buki.act-*). none = 대답만("진행해" 등) */
export type BukiAct = "add" | "modify" | "delete" | "bug" | "question" | "none";

const rects = (list: Rect[]) => list.map((r) => <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={color(r.c)} />);
// 겹은 늘 그려 두고 CSS 로 보였다 감춘다(모습이 바뀔 때 DOM 을 새로 만들지 않게)
const layers = (names: LayerName[]) =>
  names.map((name) => (
    <g key={name} className={`l-${name}`}>
      {rects(LAYERS[name])}
    </g>
  ));
const bodyEls = rects(BODY_RECTS);
// 모든 자리에서 5% 작게(2026-10-29 요청). 픽셀 한 칸이 정수 px 가 아니어도 crispEdges 가 칸 경계를 기기 픽셀에 맞춘다
const SCALE = 0.95;
const eyeEls = layers(EYES);
const propEls = layers(PROPS);

/**
 * 부기. px = 픽셀 하나의 크기(2 = 위쪽 막대·대화상자, 4 = 빈 화면, 실제로는 SCALE 만큼 작게). 가지는 지금 보는 워크트리 색(branch 로 바꿀 수 있음).
 * 꾸밈이라 화면 읽기에서는 건너뛴다.
 */
export function Buki({ px = 2, pose = "idle", act, branch, className, onClick }: { px?: number; pose?: BukiPose; act?: BukiAct; branch?: string; className?: string; onClick?: () => void }) {
  const focus = useStore((s) => s.focus?.worktreePath);
  const wt = useWtColor(focus);
  const fill = branch ?? wt;
  return (
    <svg
      className={`buki pose-${pose}${act ? ` act-${act}` : ""}${className ? ` ${className}` : ""}`}
      width={W * px * SCALE}
      height={H * px * SCALE}
      viewBox={`0 0 ${W} ${H}`}
      shapeRendering="crispEdges"
      aria-hidden
      onClick={onClick}
    >
      <g className="perch">
        {PERCH_RECTS.map((r) => (
          <rect key={`${r.x},${r.y}`} x={r.x} y={r.y} width={r.w} height={1} style={{ fill: r.c === "n" ? "var(--bg-1)" : fill }} />
        ))}
      </g>
      <g className="owl">
        {bodyEls}
        {eyeEls}
      </g>
      <g className="props">{propEls}</g>
    </svg>
  );
}
