// 기억 담아 새로 시작: 새 세션에 넣을 글 만들기. 지난 대화 전체 대신 '최근 대화 + 고른 기억'만 넣는다.
import type { MemoryHit, TranscriptItem } from "./api";
import { t } from "./i18n";

export interface RecentTurn {
  user: string;
  assistant: string;
  ts: number | null;
}

/** 넣는 글 전체 상한(글자). Claude 시작 훅 출력은 1만 자를 넘으면 잘린다. */
export const MEMORY_LIMIT = 8000;

/** 대화 기록을 턴(사람 요청 + 그 뒤 AI 답)으로 묶는다. 도구 항목은 뺀다. */
export function turnsFromTranscript(items: TranscriptItem[]): RecentTurn[] {
  const out: RecentTurn[] = [];
  for (const it of items) {
    if (it.kind === "user") out.push({ user: it.text.trim(), assistant: "", ts: it.timestamp });
    else if (it.kind === "assistant" && out.length) {
      const cur = out[out.length - 1];
      const text = it.text.trim();
      if (text) cur.assistant = cur.assistant ? `${cur.assistant}\n\n${text}` : text;
    }
  }
  return out.filter((x) => x.user);
}

const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** 끝부분(마지막 보고가 가장 쓸모 있다) */
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(s.length - n)}` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const baseName = (p: string) => p.split("/").pop() || p;

function day(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 새 세션에 넣을 글. 사실을 적은 참고 자료로 쓰고(명령처럼 쓰지 않는다), 지금 코드와 다를 수 있다고 밝힌다.
 * 상한을 넘으면 가장 최근 대화와 위쪽 기억부터 남긴다. 넣을 것이 없으면 빈 글.
 */
export function composeMemory(opts: { title: string; recent: RecentTurn[]; hits: MemoryHit[]; limit?: number }): string {
  const limit = opts.limit ?? MEMORY_LIMIT;
  if (!opts.recent.length && !opts.hits.length) return "";
  const open = `<previous-work>\n${t("아래는 지난 작업 기록입니다. 참고용이며, 기록할 때의 상태라 지금 코드와 다를 수 있습니다. 필요하면 파일을 직접 확인하세요.")}\n`;
  const close = "</previous-work>";
  let budget = limit - open.length - close.length - 2;

  // 최근 대화: 가장 최근 턴부터 들어갈 만큼
  const recent: string[] = [];
  const recentHead = `\n## ${t("직전 대화")} — ${oneLine(opts.title)}\n`;
  if (opts.recent.length) budget -= recentHead.length;
  for (const r of [...opts.recent].reverse()) {
    const block = `[${t("사용자")}] ${head(r.user.trim(), 600)}\n[AI] ${tail(r.assistant.trim(), 1500) || t("(답 없음)")}\n`;
    if (block.length > budget) break;
    recent.unshift(block);
    budget -= block.length;
  }

  // 관련된 지난 작업: 순위대로 들어갈 만큼
  const hits: string[] = [];
  const hitsHead = `\n## ${t("관련된 지난 작업")}\n`;
  if (opts.hits.length) budget -= hitsHead.length;
  for (const h of opts.hits) {
    const files = h.files.length ? ` / ${t("수정한 파일")}: ${h.files.slice(0, 8).map(baseName).join(", ")}` : "";
    const block = `- [${day(h.ts)} · ${h.project}] ${t("요청")}: ${head(oneLine(h.user), 300)} / ${t("결과")}: ${tail(oneLine(h.assistant), 700) || t("(답 없음)")}${files}\n`;
    if (block.length > budget) continue;
    hits.push(block);
    budget -= block.length;
  }

  if (!recent.length && !hits.length) return "";
  let out = open;
  if (recent.length) out += recentHead + recent.join("");
  if (hits.length) out += hitsHead + hits.join("");
  return `${out}\n${close}`;
}
