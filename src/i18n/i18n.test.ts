import { describe, expect, it } from "vitest";
import en, { parts } from "./en";

// 화면 코드 원문(테스트·사전 제외)을 모두 읽어 t("…") 열쇠를 모은다
const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../**/*.test.ts", "!../**/*.test.tsx", "!./**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

function keys(): Map<string, string> {
  const out = new Map<string, string>();
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) out.set(JSON.parse(`"${m[1]}"`), file);
  }
  return out;
}

describe("i18n", () => {
  it("화면 코드를 읽었다", () => expect(Object.keys(sources).length).toBeGreaterThan(20));
  it("화면의 모든 t(…) 글에 영어 번역이 있다", () => {
    const missing = [...keys()].filter(([k]) => !(k in en)).map(([k, f]) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });
  it("같은 한국어를 사전마다 다르게 번역하지 않았다(다르면 \"원문|맥락\" 열쇠로 나눈다)", () => {
    const seen = new Map<string, [string, string]>();
    const clash: string[] = [];
    for (const [part, dict] of Object.entries(parts)) {
      for (const [k, v] of Object.entries(dict)) {
        const prev = seen.get(k);
        if (prev && prev[1] !== v) clash.push(`${k}: ${prev[0]}="${prev[1]}" / ${part}="${v}"`);
        else seen.set(k, [part, v]);
      }
    }
    expect(clash).toEqual([]);
  });
  it("번역에서 {자리} 이름이 원문과 같다", () => {
    const bad = Object.entries(en).filter(([k, v]) => {
      const a = (k.match(/\{\w+\}/g) ?? []).sort().join();
      const b = (v.match(/\{\w+\}/g) ?? []).sort().join();
      return a !== b;
    });
    expect(bad).toEqual([]);
  });
});
