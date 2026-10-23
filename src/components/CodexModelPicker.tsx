import { useEffect, useState } from "react";
import { api, type CodexModelMode, type CodexModelRoute } from "../api";
import { t } from "../i18n";

const KEY = "aiterm.codexModelMode";
export function savedCodexModelMode(): CodexModelMode {
  try { const mode = localStorage.getItem(KEY); if (["auto", "simple", "general", "complex", "inherit"].includes(mode ?? "")) return mode as CodexModelMode; } catch { /* Use automatic routing. */ }
  return "auto";
}
export function taskLabel(task: string) {
  return task === "simple" ? t("단순 작업") : task === "complex" ? t("복잡한 개발") : t("일반 개발");
}
export function routeLabel(route: CodexModelRoute) {
  return `${route.model === "gpt-6-luna" ? "GPT-6 Luna" : "GPT-6.1 Sol"} ${route.effort === "medium" ? "Medium" : "Low"}`;
}
export function CodexModelPicker({ text, mode, onChange, previous, disabled }: {
  text: string; mode: CodexModelMode; onChange: (mode: CodexModelMode) => void; previous?: string; disabled?: boolean;
}) {
  const [preview, setPreview] = useState<{key:string; route:CodexModelRoute | null; error?:boolean} | null>(null);
  const key = JSON.stringify([text, mode, previous]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void api.codexModelRoute(text, mode, previous).then(route => { if (alive) setPreview({key,route}); }, () => { if (alive) setPreview({key,route:null,error:true}); });
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [text, mode, previous, key]);
  const route = preview?.key === key ? preview.route : null;
  return <div className="codex-model-picker" data-testid="codex-model-picker">
    <label><span>{t("Codex 모델")}</span>
      <select aria-label={t("Codex 모델")} value={mode} disabled={disabled} onChange={e => {
        const next = e.target.value as CodexModelMode;
        try { localStorage.setItem(KEY, next); } catch { /* Keep this selection in memory. */ }
        onChange(next);
      }}>
        <option value="auto">{t("자동 선택 (요청 난이도)")}</option>
        <option value="simple">{t("단순 작업")} · GPT-6 Luna Low</option>
        <option value="general">{t("일반 개발")} · GPT-6.1 Sol Low</option>
        <option value="complex">{t("복잡한 개발")} · GPT-6.1 Sol Medium</option>
        <option value="inherit">{t("CLI 설정 유지")}</option>
      </select>
    </label>
    <span className="muted small" data-testid="codex-model-preview" title={t("요청 문구를 앱 안에서 분류합니다. 선택 결과가 맞지 않으면 직접 바꿀 수 있어요.")}>
      {mode === "inherit" ? t("기존 Codex 모델·추론 설정을 사용합니다") : route ? `${taskLabel(route.task)} · ${routeLabel(route)}` : preview?.key === key && preview.error ? t("선택 미리보기를 불러오지 못했습니다") : t("선택 확인 중…")}
    </span>
  </div>;
}
