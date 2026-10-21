import en from "./en";

/**
 * 화면 글자 번역. 한국어 원문을 그대로 열쇠로 쓰고(t("커밋")), 영어는 src/i18n/en/*.ts 사전에 둔다.
 * 바뀌는 값은 {이름} 자리에 넣는다: t("커밋 ({n}개 파일)", { n: 3 }).
 * 같은 한국어가 자리마다 다른 영어가 되면 맥락을 붙인다: t("수정|파일 상태") → 한국어 "수정", 영어 "Modified".
 * 사전에 없는 글은 한국어 그대로 보인다 — `pnpm test` 의 i18n 검사가 빠진 번역을 알려 준다.
 * 언어를 바꾸면 창을 다시 그린다(드물게 바꾸는 설정이라 단순하게).
 */
export type Lang = "ko" | "en";
const KEY = "aiterm.lang";

function detect(): Lang {
  // 테스트는 언제나 한국어로(Node 21+ 에는 navigator 가 있어 기계 언어에 따라 바뀔 수 있다)
  if (import.meta.env?.MODE === "test") return "ko";
  try {
    const v = localStorage.getItem(KEY);
    if (v === "ko" || v === "en") return v;
  } catch {
    /* 저장소를 못 읽으면 시스템 언어로 */
  }
  return typeof navigator !== "undefined" && !navigator.language.toLowerCase().startsWith("ko") ? "en" : "ko";
}

export const lang: Lang = detect();
const dict: Record<string, string> = lang === "en" ? en : {};

export function t(ko: string, vars?: Record<string, string | number | null | undefined>): string {
  // 같은 한국어가 자리마다 다른 영어가 될 때는 "수정|파일 상태" 처럼 | 뒤에 맥락을 붙인다(한국어로는 | 앞만 보인다)
  const bar = ko.indexOf("|");
  const s = dict[ko] ?? (bar >= 0 ? ko.slice(0, bar) : ko);
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k] ?? "") : m)) : s;
}

/** 날짜·숫자 형식에 쓰는 지역 이름 */
export const locale = lang === "en" ? "en-US" : "ko-KR";

export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* 저장 못 하면 이번만 */
  }
  location.reload();
}
