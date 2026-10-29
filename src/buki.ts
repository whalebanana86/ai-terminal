/**
 * 코드행방 캐릭터 부기(가지에 앉은 부엉이)의 픽셀 그림. 글자 하나가 픽셀 하나('.' = 빈칸), 20×16 칸.
 * 몸(BODY)은 늘 그리고, 눈·소품은 겹(LAYERS)으로 따로 그려 CSS 로 보였다 감춘다(components/Buki.tsx).
 * 가지(PERCH)의 색은 지금 보는 워크트리 색을 따른다.
 */

export const W = 20;
export const H = 16;

const PALETTE: Record<string, string> = {
  P: "#b58cff", // 몸
  Q: "#8c62db", // 그림자·날개
  L: "#ece0ff", // 배
  F: "#cdb4ff", // 배 깃털 무늬
  C: "#fff5dc", // 눈 테
  K: "#141a22", // 눈동자
  Y: "#f5c542", // 부리·발
  O: "#d99a1e", // 부리 아래
  G: "#4fd18b", // 소품: 추가(+)
  B: "#4cc2ff", // 소품: 수정(렌치)
  R: "#ff8a5b", // 소품: 삭제(상자)
  U: "#c792ff", // 소품: 버그
  X: "#e2c08d", // 소품: 질문(?)
  Z: "#8b93a3", // 소품: 졸기(z)
};
/** 가지(b)와 끝 점(N)은 워크트리 색, 점 가운데(n)는 바탕색 */
export const BRANCH = "b";

const BODY = [
  ".P............P.....",
  ".PP..........PP.....",
  ".PPPPPPPPPPPPPP.....",
  "PPPCCPPPPPPCCPPP....",
  "PPCKKCPPPPCKKCPP....",
  "PPCKKCPPPPCKKCPP....",
  "PPPCCPPYYPPCCPPP....",
  "PPPPPPPOOPPPPPPP....",
  "QPPLLLLLLLLLLPPQ....",
  "QPLLFLLLLLLFLLPQ....",
  "QPLLLFLLLLFLLLPQ....",
  "QPPLLLLFFLLLLPPQ....",
  ".QPPLLLLLLLLPPQ.....",
  "..QQPYQQQQYPQQ......",
  ".....Y....Y.........",
  "....................",
];

const PERCH = [
  ...Array<string>(13).fill("...................."),
  ".................NNN",
  "bbbbbbbbbbbbbbbbbNnN",
  ".................NNN",
];

/** 몸에서 바뀐 줄만 적은 겹. 숫자 = 줄 번호 */
const EDITS: Record<string, Record<number, string>> = {
  // 눈: 감음(깜빡·졸기), 웃음(^ ^), 왼쪽·오른쪽 보기
  shut: { 3: "PPPPPPPPPPPPPPPP....", 4: "PPPPPPPPPPPPPPPP....", 5: "PPKKKKPPPPKKKKPP....", 6: "PPPPPPPYYPPPPPPP...." },
  happy: { 3: "PPPPPPPPPPPPPPPP....", 4: "PPPKKPPPPPPKKPPP....", 5: "PPKPPKPPPPKPPKPP....", 6: "PPPPPPPYYPPPPPPP...." },
  lookL: { 4: "PPKKCCPPPPKKCCPP....", 5: "PPKKCCPPPPKKCCPP...." },
  lookR: { 4: "PPCCKKPPPPCCKKPP....", 5: "PPCCKKPPPPCCKKPP...." },
  // 소품: 오른쪽 빈칸에
  plus: { 1: ".................G..", 2: "................GGG.", 3: ".................G.." },
  wrench: { 1: ".................B.B", 2: ".................BBB", 3: "..................B.", 4: "..................B.", 5: "..................B." },
  box: { 9: "................RRR.", 10: "................RKR.", 11: "................RRR." },
  bug: { 9: "................U..U", 10: ".................UU.", 11: "................UUUU", 12: ".................UU." },
  what: { 0: "................XXX.", 1: "..................X.", 2: ".................XX.", 4: ".................X.." },
  z: { 0: "................ZZZZ", 1: "..................Z.", 2: ".................Z..", 3: "................ZZZZ" },
};

export type Rect = { x: number; y: number; w: number; c: string };

/** 가로로 이어진 같은 글자를 사각형 하나로 묶는다. only 가 있으면 그 칸만(겹: 몸과 달라진 칸) */
export function runs(grid: string[], only?: (x: number, y: number, c: string) => boolean): Rect[] {
  const out: Rect[] = [];
  grid.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x];
      const keep = (i: number) => row[i] === c && c !== "." && (!only || only(i, y, c));
      if (!keep(x)) {
        x++;
        continue;
      }
      let e = x + 1;
      while (e < row.length && keep(e)) e++;
      out.push({ x, y, w: e - x, c });
      x = e;
    }
  });
  return out;
}

function layer(edits: Record<number, string>): Rect[] {
  const grid = BODY.map((row, y) => edits[y] ?? row);
  return runs(grid, (x, y, c) => BODY[y][x] !== c);
}

export const BODY_RECTS = runs(BODY);
export const PERCH_RECTS = runs(PERCH);
export const LAYERS = Object.fromEntries(Object.entries(EDITS).map(([k, v]) => [k, layer(v)])) as Record<keyof typeof EDITS, Rect[]>;
export type LayerName = keyof typeof EDITS;
/** 몸과 함께 움직이는 겹(눈)과 제자리에 있는 겹(소품) */
export const EYES: LayerName[] = ["shut", "happy", "lookL", "lookR"];
export const PROPS: LayerName[] = ["plus", "wrench", "box", "bug", "what", "z"];

/** 고정 색. 가지 색(b·N)과 점 가운데(n)는 그리는 쪽이 정한다 */
export const color = (c: string): string => PALETTE[c] ?? "";

/** 그대로 쓰는 모습(정지). 요청 동작(act-*)은 CSS 애니메이션 */
export type BukiPose = "idle" | "blink" | "happy" | "look-l" | "look-r" | "sleep" | "puzzled";
export const POSE_LAYERS: Record<BukiPose, LayerName[]> = {
  idle: [],
  blink: ["shut"],
  happy: ["happy"],
  "look-l": ["lookL"],
  "look-r": ["lookR"],
  sleep: ["shut", "z"],
  puzzled: ["lookR", "what"],
};

/** README·홍보용 SVG 글(앱 밖). 앱 안에서는 components/Buki.tsx. hole 이 비면 가지 끝 점 가운데를 비워 바탕이 보이게 */
export function bukiSvg({ px = 8, pose = "idle" as BukiPose, branch = "#ff6fb1", hole = "" } = {}): string {
  const fill = (c: string) => (c === "b" || c === "N" ? branch : c === "n" ? hole : color(c));
  const rect = (r: Rect) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${fill(r.c)}"/>`;
  const rects = [...PERCH_RECTS, ...BODY_RECTS, ...POSE_LAYERS[pose].flatMap((l) => LAYERS[l])]
    .filter((r) => fill(r.c))
    .map(rect)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * px}" height="${H * px}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${rects}</svg>`;
}
