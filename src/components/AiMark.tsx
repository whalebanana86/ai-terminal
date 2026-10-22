import { Bot } from "lucide-react";
import type { AiAgent } from "../aiAuthors";

/** AI 와 함께 쓴 커밋 표시(로봇). Claude·Codex 는 그 색, 나머지는 흐린 글자색 */
export function AiMark({ agent, size = 12 }: { agent: AiAgent; size?: number }) {
  return <Bot size={size} className={`ai-mark ai-${agent}`} aria-hidden />;
}
