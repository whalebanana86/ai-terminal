/**
 * 화면 모드: 시스템(맥 설정 따라가기) / 밝게 / 어둡게. <html data-theme="light|dark"> 로 색 변수를 바꾼다.
 * 터미널·코드 색처럼 CSS 밖에서 칠하는 곳은 onThemeChange 로 알림을 받는다.
 */
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";
const KEY = "aiterm.theme";
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
const listeners = new Set<(t: Theme) => void>();

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* 못 읽으면 기본값 */
  }
  return "system";
}

export function currentTheme(): Theme {
  const p = getThemePref();
  if (p !== "system") return p;
  return media && !media.matches ? "light" : "dark";
}

function apply() {
  const th = currentTheme();
  document.documentElement.dataset.theme = th;
  listeners.forEach((f) => f(th));
}

export function setThemePref(p: ThemePref) {
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* 저장 못 하면 이번만 */
  }
  apply();
}

export function onThemeChange(f: (t: Theme) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** 앱 시작 때 한 번: 지금 모드를 칠하고, 시스템 모드면 맥 설정이 바뀔 때 따라간다 */
export function initTheme() {
  apply();
  media?.addEventListener("change", () => getThemePref() === "system" && apply());
}
