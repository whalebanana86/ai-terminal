import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { useStore } from "../store";
import { useWtColor } from "../wtColors";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog() {
  const req = useStore((s) => s.confirm);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!req) return;
    // 위험한 작업은 기본 포커스를 "취소"에 둔다.
    if (!req.danger) okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") req.resolve(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  return (
    <div className="modal-backdrop" onMouseDown={() => req.resolve(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={req.title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{req.title}</h3>
        <p className="modal-body">{req.body}</p>
        <div className="modal-actions">
          <button className="btn" autoFocus={req.danger} onClick={() => req.resolve(false)}>
            {t("취소")}
          </button>
          {req.altLabel && (
            <button className="btn btn-danger" onClick={() => req.resolve("alt")} data-action="alt">
              {req.altLabel}
            </button>
          )}
          <button ref={okRef} className={req.danger ? "btn btn-danger" : "btn btn-primary"} onClick={() => req.resolve(true)}>
            {req.confirmLabel ?? t("확인")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 작은 공통 조각들 */
export function AgentBadge({ agent, small }: { agent: string; small?: boolean }) {
  return (
    <span className={`agent-badge agent-${agent}${small ? " small" : ""}`} title={agent === "claude" ? "Claude Code" : "Codex"}>
      {agent === "claude" ? "Claude" : "Codex"}
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

/** 여러 칸을 받는 입력 대화상자 (useStore.promptForm) */
export function PromptDialog() {
  const req = useStore((s) => s.prompt);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!req) return;
    setValues(Object.fromEntries(req.fields.map((f) => [f.key, f.value])));
    setError(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") req.resolve(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);
  if (!req) return null;
  const submit = () => {
    const err = req.validate?.(values) ?? null;
    if (err) return setError(err);
    req.resolve(values);
  };
  return (
    <div className="modal-backdrop" onMouseDown={() => req.resolve(null)}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h3>{req.title}</h3>
        {req.body && <p className="modal-body">{req.body}</p>}
        {req.fields.map((f, i) => (
          <label key={f.key} className={f.checkbox ? "form-row" : "form-row col"}>
            {f.checkbox ? (
              <>
                <input
                  type="checkbox"
                  checked={values[f.key] === "true"}
                  onChange={(e) => setValues({ ...values, [f.key]: String(e.target.checked) })}
                />
                <span>{f.label}</span>
              </>
            ) : (
              <>
                <span className="muted">{f.label}</span>
                {f.options ? (
                  <select value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="text-input"
                    autoFocus={i === 0}
                    value={values[f.key] ?? ""}
                    placeholder={f.placeholder}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  />
                )}
              </>
            )}
          </label>
        ))}
        {error && <div className="banner banner-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => req.resolve(null)}>
            {t("취소")}
          </button>
          <button type="submit" className={req.danger ? "btn btn-danger" : "btn btn-primary"}>
            {req.confirmLabel ?? t("확인")}
          </button>
        </div>
      </form>
    </div>
  );
}

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 구분선 */
  separator?: boolean;
  /** 누를 수 없는 묶음 제목 */
  header?: boolean;
  hint?: string;
  /** 테스트·자동화용 data-action */
  testId?: string;
  /** 하위 메뉴(마우스를 올리거나 → 키로 펼침) */
  children?: MenuItem[];
}

/** 우클릭 메뉴. 바깥을 누르거나 Esc 로 닫힌다. 항목에 children 이 있으면 하위 메뉴로 펼친다. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(":scope > .menu");
    if (el) {
      // 화면 밖으로 나가지 않게
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 6), y: Math.min(y, window.innerHeight - r.height - 6) });
    }
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", onClose);
    };
  }, [x, y, onClose]);
  const openSub = (i: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const right = r.right + 260 < window.innerWidth;
    setSub({ index: i, x: right ? r.right + 2 : r.left - 262, y: r.top - 4 });
  };
  return (
    <div ref={ref}>
      <MenuList items={items} style={{ left: pos.x, top: pos.y }} onClose={onClose} onOpenSub={openSub} activeSub={sub?.index ?? null} onHoverPlain={() => setSub(null)} />
      {sub && items[sub.index]?.children && (
        <MenuList items={items[sub.index].children!} style={{ left: sub.x, top: Math.min(sub.y, window.innerHeight - 40 * items[sub.index].children!.length - 10) }} onClose={onClose} sub />
      )}
    </div>
  );
}

function MenuList(props: {
  items: MenuItem[];
  style: React.CSSProperties;
  onClose: () => void;
  onOpenSub?: (i: number, el: HTMLElement) => void;
  onHoverPlain?: () => void;
  activeSub?: number | null;
  sub?: boolean;
}) {
  return (
    <div className={`menu${props.sub ? " submenu" : ""}`} style={props.style} role="menu">
      {props.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : it.header ? (
          <div key={i} className="menu-header">
            {it.label}
          </div>
        ) : it.children ? (
          <button
            key={i}
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={props.activeSub === i}
            className={`menu-item has-sub${props.activeSub === i ? " open" : ""}`}
            onMouseEnter={(e) => props.onOpenSub?.(i, e.currentTarget)}
            onClick={(e) => props.onOpenSub?.(i, e.currentTarget)}
            onKeyDown={(e) => e.key === "ArrowRight" && props.onOpenSub?.(i, e.currentTarget)}
            data-action={it.testId}
          >
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            <span className="menu-caret">▸</span>
          </button>
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${it.danger ? " danger" : ""}`}
            disabled={it.disabled}
            title={it.hint}
            data-action={it.testId}
            onMouseEnter={() => props.onHoverPlain?.()}
            onClick={() => {
              props.onClose();
              it.onClick?.();
            }}
          >
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** 워크트리 노선 색 점(지하철 역 모양) */
export function WtDot({ path }: { path: string | null | undefined }) {
  const c = useWtColor(path);
  return <i className="wt-dot" style={{ "--wc": c } as React.CSSProperties} aria-hidden />;
}
