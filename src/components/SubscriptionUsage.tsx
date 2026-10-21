import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, type SubscriptionQuota } from "../api";
import { lang, t } from "../i18n";

export function SubscriptionUsage() {
  const [quotas, setQuotas] = useState<SubscriptionQuota[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    let pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true; setLoading(true);
      try { const q = await api.subscriptionUsage(); if (alive) { setQuotas(q); setFailed(false); } }
      catch { if (alive) setFailed(true); }
      finally { pending = false; if (alive) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => void load(), 120_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  const date = (seconds: number) => new Date(seconds * 1000).toLocaleString(lang === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const errorMessage = (error: string | undefined | null) => error === "login_required" ? t("CLI 구독 로그인이 필요합니다") : error === "cli_missing" ? t("CLI를 설치해 주세요") : error === "rate_limited" ? t("조회 한도 초과. 잠시 후 다시 확인하세요") : t("사용량을 조회하지 못했습니다");
  return <div className="subscription-usage" aria-label={t("구독 한도 사용률")} aria-busy={loading}>
    {(["claude", "codex"] as const).map((provider) => {
      const quota = quotas.find((q) => q.provider === provider);
      const name = provider === "claude" ? "Claude" : "Codex";
      const title = [name, failed ? t("사용량을 조회하지 못했습니다") : quota?.error ? errorMessage(quota.error) : "",
        ...(quota?.windows ?? []).map((w) => {
          const reset = w.resetsAt ?? (w.resetText ? Date.parse(w.resetText) / 1000 : NaN);
          return `${w.windowMinutes === 10080 ? t("주간") : `${w.windowMinutes / 60}h`}: ${w.usedPercent}%${Number.isFinite(reset) ? ` · ${t("초기화")}: ${date(reset)}` : ""}`;
        }), quota ? `${t("마지막 확인")}: ${date(quota.checkedAt)}` : ""].filter(Boolean).join("\n");
      return <span className={`quota-provider${quota?.error || failed ? " unavailable" : ""}`} key={provider} title={title}>
        <strong>{name}</strong>
        {quota?.windows.length ? quota.windows.map((w) => <span className={`quota-window${w.usedPercent >= 90 ? " high" : ""}`} key={w.windowMinutes}>
          {w.windowMinutes === 10080 ? t("주간") : `${w.windowMinutes / 60}h`} {Math.round(w.usedPercent)}%
          <span className="quota-meter" role="meter" aria-label={`${name} ${w.windowMinutes === 10080 ? t("주간") : `${w.windowMinutes / 60}h`}`} aria-valuenow={w.usedPercent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${w.usedPercent}%` }} /></span>
        </span>) : <span>{loading && !failed ? t("조회 중…") : t("확인 불가")}</span>}
        {failed && !!quota?.windows.length && <span>{t("이전 조회값")}</span>}
      </span>;
    })}
    <button className="quota-refresh" disabled={loading} title={t("사용량 새로고침 (최대 2분 간격)")} aria-label={t("사용량 새로고침 (최대 2분 간격)")} onClick={() => setRefresh((n) => n + 1)}><RefreshCw size={11} aria-hidden /></button>
  </div>;
}
