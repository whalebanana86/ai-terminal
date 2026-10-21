import { Settings as Gear } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { lang, setLang, t } from "../i18n";
import { getThemePref, setThemePref, type ThemePref } from "../theme";

/** 아래 상태줄의 ⚙: 언어(한국어/English)와 화면 모드(시스템/밝게/어둡게) */
export function SettingsButton() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemePref>(getThemePref);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [open]);
  const pickTheme = (p: ThemePref) => {
    setTheme(p);
    setThemePref(p);
  };
  return (
    <div className="settings" ref={box}>
      <button className="settings-btn" onClick={() => setOpen(!open)} title={t("설정")} aria-label={t("설정")} aria-expanded={open} data-testid="settings">
        <Gear size={12} aria-hidden /> {t("설정")}
      </button>
      {open && (
        <div className="settings-pop" role="dialog" aria-label={t("설정")}>
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
      )}
    </div>
  );
}
