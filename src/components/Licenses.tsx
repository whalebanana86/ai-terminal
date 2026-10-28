// 오픈소스 라이선스 고지. 목록(scripts/licenses.mjs 가 만든 JSON)은 이 창을 열 때만 불러온다.
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";

interface Pkg {
  name: string;
  version: string;
  license: string;
  url: string;
  kind: "rust" | "npm" | "font" | "download";
  /** texts 의 번호(같은 원문은 한 번만 싣는다) */
  texts: number[];
}
interface Data {
  packages: Pkg[];
  texts: string[];
}

const KINDS: { kind: Pkg["kind"]; title: () => string }[] = [
  { kind: "rust", title: () => t("앱에 담긴 라이브러리 (Rust)") },
  { kind: "npm", title: () => t("화면 라이브러리 (JavaScript)") },
  { kind: "font", title: () => t("글꼴") },
  { kind: "download", title: () => t("작업 기억을 켜면 내려받는 것") },
];

export function LicensesDialog({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void import("../generated/third-party-licenses.json").then((m) => alive && setData(m.default as Data));
    return () => {
      alive = false;
    };
  }, []);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.packages ?? []).filter((p) => !s || p.name.toLowerCase().includes(s) || p.license.toLowerCase().includes(s));
  }, [data, q]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal licenses-modal" role="dialog" aria-label={t("오픈소스 라이선스")} data-testid="licenses-dialog">
        <div className="settings-head">
          <h3>{t("오픈소스 라이선스")}</h3>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t("닫기")} title={t("닫기")}>
            <X size={14} aria-hidden />
          </button>
        </div>
        <p className="muted small">{t("코드행방은 MIT 라이선스로 공개된 오픈소스예요. 아래 오픈소스 소프트웨어를 함께 써요.")}</p>
        <input className="text-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("이름이나 라이선스로 찾기")} aria-label={t("이름이나 라이선스로 찾기")} />
        <div className="licenses-body">
          {!data ? (
            <p className="muted small">{t("읽는 중…")}</p>
          ) : (
            KINDS.map(({ kind, title }) => {
              const list = shown.filter((p) => p.kind === kind);
              if (!list.length) return null;
              return (
                <section key={kind}>
                  <h4 className="mem-h">
                    {title()} <span className="muted">{list.length}</span>
                  </h4>
                  <ul className="licenses-list">
                    {list.map((p) => {
                      const key = `${p.kind}:${p.name}@${p.version}`;
                      const on = open === key;
                      return (
                        <li key={key}>
                          <button className="licenses-row" onClick={() => setOpen(on ? null : key)} aria-expanded={on}>
                            <span className="licenses-name">
                              {p.name} {p.version && <span className="muted">{p.version}</span>}
                            </span>
                            <span className="licenses-license">{p.license}</span>
                          </button>
                          {on && (
                            <div className="licenses-text">
                              {p.url && <div className="path-text">{p.url}</div>}
                              {p.texts.map((i) => (
                                <pre key={i}>{data.texts[i]}</pre>
                              ))}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
