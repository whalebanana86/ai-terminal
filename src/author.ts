/** 그래프 작성자 칸: 같은 사람 판단, 머리글자, 회색 단계 (순수 함수) */

/** 회색 단계 수. 노선 색과 헷갈리지 않게 명도만 다르다(styles.css .gauthor-0 ~ 4). */
export const AUTHOR_SHADES = 5;

/** 같은 사람 판단 열쇠: 이메일 우선, 없으면 이름. 대소문자 무시 */
export function authorKey(name: string, email: string): string {
  return (email.trim() || name.trim()).toLowerCase();
}

/** 불러온 커밋 전체의 작성자가 한 명(또는 커밋 없음)이면 true → 작성자 칸을 그리지 않는다 */
export function isSingleAuthor(rows: readonly { author: string; email: string }[]): boolean {
  let first: string | undefined;
  for (const r of rows) {
    const k = authorKey(r.author, r.email);
    if (first === undefined) first = k;
    else if (k !== first) return false;
  }
  return true;
}

const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 한글(한자·가나) 이름은 첫 글자, 그 밖은 첫 단어와 마지막 단어의 머리글자(최대 2자). 이름이 비면 이메일 앞부분 */
export function authorInitials(name: string, email: string): string {
  const src = name.trim() || email.trim().split("@")[0];
  const words = src
    .split(/[\s._-]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ""))
    .filter(Boolean);
  if (!words.length) return "?";
  const first = Array.from(words[0])[0];
  if (CJK.test(first)) return first;
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : "";
  return (first + last).toUpperCase();
}

/** 마우스를 올리면 보이는 글: "이름 <이메일>" */
export function authorLabel(name: string, email: string): string {
  const n = name.trim();
  const e = email.trim();
  return n && e ? `${n} <${e}>` : n || (e ? `<${e}>` : "");
}

/** 같은 사람은 늘 같은 회색 단계(0 ~ AUTHOR_SHADES-1) */
export function authorShade(name: string, email: string): number {
  // FNV-1a
  const s = authorKey(name, email);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) % AUTHOR_SHADES;
}
