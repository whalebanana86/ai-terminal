import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorText, type EditorApp } from "../api";
import { EXTENSIONS, useExtensions, type ExtensionId } from "../extensions";
import { getExternalEditor, setExternalEditor } from "../externalEditor";
import { lang, setLang, t } from "../i18n";
import { useStore } from "../store";
import { getThemePref, setThemePref, type ThemePref } from "../theme";

/** 설정 창(언어·화면 모드·기능·외부 편집기). 맥 메뉴 막대의 "코드행방 → 설정… (⌘,)" 이 open-settings 를 보내면 열린다. */
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
        <ExternalEditorRow />
        <div className="settings-section">
          <h4>{t("기능")}</h4>
          {EXTENSIONS.map((e) => (
            <FeatureRow key={e.id} id={e.id} title={e.title()} description={e.description()} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 기능 하나 켜고 끄기. 파일 편집은 켤 때 맥 확인창이 뜨고, 취소하면 꺼진 채로 남는다. */
function FeatureRow({ id, title, description }: { id: ExtensionId; title: string; description: string }) {
  const on = useExtensions((s) => s.enabled[id]);
  const setOn = useExtensions((s) => s.set);
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await setOn(id, !on);
    } catch (e) {
      useStore.getState().toast("error", errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <label className="feature-row" data-feature={id}>
      <span className="feature-text">
        <span className="feature-title">{title}</span>
        <span className="feature-desc">{description}</span>
      </span>
      <input type="checkbox" className="switch" role="switch" checked={on} disabled={busy} onChange={() => void toggle()} aria-label={title} />
    </label>
  );
}

function ExternalEditorRow() {
  const [apps, setApps] = useState<EditorApp[] | null>(null);
  const [pick, setPick] = useState(getExternalEditor);
  useEffect(() => {
    api.editorsInstalled().then(setApps, () => setApps([]));
  }, []);
  const choose = (id: string) => {
    setPick(id);
    setExternalEditor(id);
  };
  // 고른 편집기를 지웠으면 목록에 없으니 자동처럼 보여 준다
  const value = pick === "auto" || apps?.some((a) => a.id === pick) ? pick : "auto";
  return (
    <div className="settings-row">
      <span className="settings-label">{t("외부 편집기")}</span>
      <select className="settings-select" value={value} onChange={(e) => choose(e.target.value)} aria-label={t("외부 편집기")} data-testid="external-editor">
        <option value="auto">{t("자동 (설치된 편집기)")}</option>
        {(apps ?? []).map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
}
