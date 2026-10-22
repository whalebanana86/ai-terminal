/**
 * 커밋 작성자·공동 작성자(Co-authored-by 트레일러)가 어떤 AI 인지 이름·이메일로 알아낸다.
 * 트레일러 값 "이름 <이메일>" 을 그대로 넘기거나 이름·이메일을 따로 넘긴다.
 */
export type AiAgent = "claude" | "codex" | "copilot" | "cursor" | "gemini";

export const AI_NAME: Record<AiAgent, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  cursor: "Cursor",
  gemini: "Gemini",
};

export interface Identity {
  name: string;
  email: string;
}

/** "이름 <이메일>" → 이름·이메일. 꺾쇠가 없으면 @ 가 있을 때 이메일, 아니면 이름. */
export function parseIdentity(s: string): Identity {
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(s.trim());
  if (m) return { name: m[1].trim(), email: m[2].trim() };
  const v = s.trim();
  return v.includes("@") && !/\s/.test(v) ? { name: "", email: v } : { name: v, email: "" };
}

// 이름이나 이메일 앞부분(@ 앞, GitHub 의 "123+Copilot" 포함)에 이 낱말이 있으면 그 AI
const WORDS: [AiAgent, RegExp][] = [
  ["claude", /\bclaude\b/],
  ["codex", /\b(codex|chatgpt)\b/],
  ["copilot", /\bcopilot\b/],
  ["cursor", /\bcursor(agent)?\b/],
  ["gemini", /\bgemini\b/],
];

// 회사 이름·주소는 사람도 쓴다 → 이름이 회사 이름뿐이거나, 회사의 noreply 주소이거나, GitHub 봇([bot])일 때만
const COMPANIES: [AiAgent, string, string][] = [
  ["claude", "anthropic", "anthropic.com"],
  ["codex", "openai", "openai.com"],
  ["cursor", "cursor", "cursor.com"],
  ["gemini", "google", "google.com"],
];
const COMPANY_WORD = new Map(COMPANIES.map(([, w]) => [w, new RegExp(`\\b${w}\\b`)]));

export function aiAgentOf(identity: string | Identity): AiAgent | null {
  const { name, email } = typeof identity === "string" ? parseIdentity(identity) : identity;
  const n = name.trim().toLowerCase();
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  const local = at >= 0 ? e.slice(0, at) : e;
  const domain = at >= 0 ? e.slice(at + 1) : "";
  const hay = `${n} ${local}`;
  for (const [agent, re] of WORDS) if (re.test(hay)) return agent;
  const bot = hay.includes("[bot]");
  for (const [agent, word, dom] of COMPANIES) {
    if (n === word) return agent;
    if ((domain === dom || domain.endsWith(`.${dom}`)) && /^no-?reply$/.test(local)) return agent;
    if (bot && COMPANY_WORD.get(word)!.test(hay)) return agent;
  }
  return null;
}

/** 공동 작성자 목록에 나오는 AI(겹치지 않게, 나온 순서대로) */
export function aiAgentsIn(coAuthors: string[]): AiAgent[] {
  const out: AiAgent[] = [];
  for (const c of coAuthors) {
    const a = aiAgentOf(c);
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}
