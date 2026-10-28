import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import cargo from "../src-tauri/Cargo.toml?raw";
import data from "./generated/third-party-licenses.json";

describe("오픈소스 라이선스 고지", () => {
  it("직접 쓰는 의존성이 모두 들어 있고 원문이 있다 (빠졌으면 node scripts/licenses.mjs)", () => {
    const names = new Set(data.packages.map((p) => p.name));
    const section = cargo.split(/\n\[/).find((s: string) => s.startsWith("dependencies]")) ?? "";
    // 자동화 빌드에서만 쓰는 선택 의존성은 배포 앱에 들어가지 않는다
    const rust = section
      .split("\n")
      .slice(1)
      .filter((l: string) => /^[a-z0-9_-]+\s*=/.test(l) && !/optional\s*=\s*true/.test(l))
      .map((l: string) => l.split("=")[0].trim());
    expect([...Object.keys(pkg.dependencies), ...rust].filter((n) => !names.has(n))).toEqual([]);
    expect(data.packages.filter((p) => !p.texts.length).map((p) => p.name)).toEqual([]);
  });
});
