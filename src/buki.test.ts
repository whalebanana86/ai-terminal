import { describe, expect, it } from "vitest";
import { BODY_RECTS, bukiSvg, color, EYES, H, LAYERS, PERCH_RECTS, POSE_LAYERS, PROPS, runs, W, type BukiPose } from "./buki";

const cells = (list: { x: number; y: number; w: number }[]) => list.flatMap((r) => Array.from({ length: r.w }, (_, i) => `${r.x + i},${r.y}`));

describe("부기 픽셀 그림", () => {
  it("가로로 이어진 같은 색을 사각형 하나로 묶는다", () => {
    expect(runs(["AAB.", ".BB."])).toEqual([
      { x: 0, y: 0, w: 2, c: "A" },
      { x: 2, y: 0, w: 1, c: "B" },
      { x: 1, y: 1, w: 2, c: "B" },
    ]);
  });

  it("모든 칸이 20×16 안에 있고, 가지 말고는 모두 색이 정해져 있다", () => {
    for (const r of [...BODY_RECTS, ...PERCH_RECTS, ...Object.values(LAYERS).flat()]) {
      expect(r.x >= 0 && r.x + r.w <= W && r.y >= 0 && r.y < H).toBe(true);
      if (!["b", "N", "n"].includes(r.c)) expect(color(r.c)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("겹마다 그릴 칸이 있고, 눈은 눈자리(위쪽 몸)에만·소품은 몸 밖 오른쪽에만 그린다", () => {
    const body = new Set(cells(BODY_RECTS));
    for (const name of EYES) {
      expect(LAYERS[name].length).toBeGreaterThan(0);
      for (const c of cells(LAYERS[name])) {
        expect(body.has(c)).toBe(true);
        expect(Number(c.split(",")[1])).toBeLessThan(8);
      }
    }
    for (const name of PROPS) {
      expect(LAYERS[name].length).toBeGreaterThan(0);
      for (const c of cells(LAYERS[name])) {
        expect(body.has(c)).toBe(false);
        expect(Number(c.split(",")[0])).toBeGreaterThanOrEqual(16);
      }
    }
  });

  it("모습마다 쓰는 겹이 있다", () => {
    for (const pose of Object.keys(POSE_LAYERS) as BukiPose[]) for (const l of POSE_LAYERS[pose]) expect(LAYERS[l]).toBeDefined();
  });

  it("README·홍보용 SVG 글을 만든다(가지 색·크기)", () => {
    const svg = bukiSvg({ px: 4, branch: "#123456", pose: "sleep" });
    expect(svg).toContain('width="80" height="64" viewBox="0 0 20 16"');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain(color("Z"));
    expect(bukiSvg()).not.toContain(color("Z"));
  });
});
