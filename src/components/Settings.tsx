import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { lang, setLang, t } from "../i18n";
import { getThemePref, setThemePref, type ThemePref } from "../theme";

/** 설정 창(언어·화면 모드). 맥 메뉴 막대의 "코드행방 → 설정… (⌘,)" 이 open-settings 를 보내면 열린다. */
export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  useEffect(() => {
    const un = listen("open-settings", () => setOpen(true));
    return () => void un.then((f) => f());
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);
  if (!open) return null;
  const pickTheme = (p: ThemePref) => {
    setTheme(p);
    setThemePref(p);
  };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal settings-modal" role="dialog" aria-label={t("설정")} data-testid="settings-dialog">
        <div className="settings-head">
          <h3>{t("설정")}</h3>
          <button className="icon-btn ghost" onClick={() => setOpen(false)} aria-label={t("닫기")} title={t("닫기")}>
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-label">{t("언어")}</span>
          <div className="seg">
            <button className={lang === "ko" ? "on" : ""} onClick={() => lang !== "ko" && setLang("ko")} data-lang="ko">
              한국어
            </button>
            <button className={lang === "en" ? "on" : ""} onClick={() => lang !== "en" && setLang("en")} data-lang="en">
              English
            </button>
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">{t("화면 모드")}</span>
          <div className="seg">
            {(
              [
                ["system", t("시스템")],
                ["light", t("밝게")],
                ["dark", t("어둡게")],
              ] as [ThemePref, string][]
            ).map(([p, label]) => (
              <button key={p} className={theme === p ? "on" : ""} onClick={() => pickTheme(p)} data-theme-pref={p} title={p === "system" ? t("맥 설정을 따라가요") : undefined}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
