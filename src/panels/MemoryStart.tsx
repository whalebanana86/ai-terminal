// 기억 담아 새로 시작: 지난 대화 전체를 다시 보내는 '이어가기' 대신, 최근 대화 몇 턴과 고른 지난 기록만 담아 새 세션을 연다.
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorText, type LinkedSession, type MemoryHit, type MemoryStatus } from "../api";
import { t } from "../i18n";
import { composeMemory, MEMORY_LIMIT, turnsFromTranscript, type RecentTurn } from "../memoryCompose";
import { useStore } from "../store";
import { currentTheme } from "../theme";
import { Buki } from "../components/Buki";

/** 넣을 최근 턴 수 */
const RECENT = 3;
/** 처음에 골라 두는 관련 기록 수와 점수 문턱. 엉뚱한 기억을 넣으면 오히려 해롭다 — 가까운 것만 골라 둔다.
 *  (데모·PoC 에서 관련 기록은 0.85 안팎, 관련 없는 기록은 0.81 아래였다. 실제 기록으로 더 맞춰야 한다) */
const PRESELECT = 3;
const CLOSE = 0.82;

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const tailLine = (s: string, n: number) => {
  const x = oneLine(s);
  return x.length > n ? `…${x.slice(x.length - n)}` : x;
};
function day(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 작업 기억 상태를 읽고 바뀔 때마다 따라간다 */
export function useMemoryStatus(): MemoryStatus | null {
  const [st, setSt] = useState<MemoryStatus | null>(null);
  useEffect(() => {
    let alive = true;
    api.memoryStatus().then((s) => alive && setSt(s), () => {});
    const un = listen<MemoryStatus>("memory-status", (e) => setSt(e.payload));
    return () => {
      alive = false;
      void un.then((f) => f());
    };
  }, []);
  return st;
}

export function MemoryStartDialog({ session, onClose }: { session: LinkedSession; onClose: () => void }) {
  const toast = useStore((s) => s.toast);
  const status = useMemoryStatus();
  const [recent, setRecent] = useState<RecentTurn[] | null>(null);
  const [useRecent, setUseRecent] = useState<boolean[]>([]);
  const [query, setQuery] = useState(() => oneLine(session.lastPrompt ?? session.firstPrompt ?? session.title).slice(0, 200));
  const [all, setAll] = useState(false);
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [searching, setSearching] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const searched = useRef(false);
  const cwd = session.worktreePath ?? session.cwd;
  const canSearch = !!status?.enabled && (status.state === "ready" || status.state === "indexing");

  useEffect(() => {
    let alive = true;
    api.transcript(session.id).then(
      (tr) => {
        if (!alive) return;
        const turns = turnsFromTranscript(tr.items).slice(-RECENT);
        setRecent(turns);
        setUseRecent(turns.map(() => true));
      },
      (e) => {
        if (!alive) return;
        setRecent([]);
        toast("error", errorText(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [session.id, toast]);

  const search = async (q = query, everywhere = all) => {
    if (!canSearch || !q.trim()) return;
    setSearching(true);
    try {
      // 최근 대화로 따로 넣는 턴은 관련 기록에서 뺀다
      const from = recent?.find((r) => r.ts)?.ts ?? undefined;
      const found = await api.memorySearch({ query: q, cwd, all: everywhere, excludeSession: from ? session.id : undefined, excludeAfter: from, limit: 8 });
      // 직전 대화와 같은 요청(갈라 낸 세션 등)은 관련 기록에서 뺀다
      const mine = new Set((recent ?? []).map((r) => oneLine(r.user)));
      setHits(found.filter((h) => !mine.has(oneLine(h.user))));
      setPicked(new Set(found.filter((h) => !mine.has(oneLine(h.user)) && h.score >= CLOSE).slice(0, PRESELECT).map((h) => h.id)));
    } catch (e) {
      toast("error", t("기억 찾기 실패: {error}", { error: errorText(e) }));
      setHits([]);
    } finally {
      setSearching(false);
    }
  };

  // 최근 대화를 읽고 기억을 쓸 수 있으면 한 번 자동으로 찾는다
  useEffect(() => {
    if (searched.current || recent === null || !canSearch) return;
    searched.current = true;
    void search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recent, canSearch]);

  const text = useMemo(
    () =>
      composeMemory({
        title: session.title,
        recent: (recent ?? []).filter((_, i) => useRecent[i]),
        hits: (hits ?? []).filter((h) => picked.has(h.id)),
      }),
    [session.title, recent, useRecent, hits, picked],
  );

  const start = async () => {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      const st = useStore.getState();
      const sandbox = session.agent === "codex" ? localStorage.getItem("aiterm.terminalMode.codex") ?? "workspace-write" : undefined;
      const e = await api.execStart({ agent: session.agent, mode: "new", cwd, cols: 100, rows: 30, prompt: prompt.trim() || undefined, sandbox, theme: currentTheme(), memory: text || undefined });
      await st.refreshExecs();
      st.selectSession(e.sessionId ?? `exec:${e.id}`);
      onClose();
    } catch (err) {
      toast("error", t("시작 실패: {error}", { error: errorText(err) }));
    } finally {
      setBusy(false);
    }
  };

  const togglePick = (id: number) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  let related: React.ReactNode;
  if (!status) related = null;
  else if (!status.supported) related = <p className="muted small">{t("이 맥에서는 관련 기록 찾기를 쓸 수 없어요(Apple Silicon, macOS 14 이상). 직전 대화만 넣어요.")}</p>;
  else if (!status.enabled) related = <p className="muted small">{t("설정 → 작업 기억을 켜면 지난 작업에서 관련 기록도 찾아 넣어요.")}</p>;
  else if (!canSearch) related = <p className="muted small">{t("작업 기억을 준비하는 중이에요. 준비되면 관련 기록도 찾을 수 있어요.")}</p>;
  else
    related = (
      <>
        <div className="mem-search">
          <input
            className="text-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) void search();
            }}
            placeholder={t("예: 인증 API 버그")}
            aria-label={t("찾을 내용")}
            data-testid="memory-query"
          />
          <button className="btn btn-small" onClick={() => void search()} disabled={searching || !query.trim()}>
            {t("찾기")}
          </button>
        </div>
        <label className="mem-scope">
          <input
            type="checkbox"
            checked={all}
            onChange={(e) => {
              setAll(e.target.checked);
              void search(query, e.target.checked);
            }}
          />{" "}
          {t("다른 저장소 기록도 찾기")}
        </label>
        {status.state === "indexing" && <p className="muted small">{t("아직 기록을 정리하는 중이라 일부만 찾을 수 있어요 ({done}/{total})", { done: status.embedded, total: status.chunks })}</p>}
        {searching ? (
          <p className="muted small">{t("찾는 중…")}</p>
        ) : hits && hits.length === 0 ? (
          <p className="muted small">{t("관련 기록을 찾지 못했어요")}</p>
        ) : (
          hits && (
            <ul className="mem-list" data-testid="memory-hits">
              {hits.map((h) => (
                <li key={h.id}>
                  <label className="mem-item">
                    <input type="checkbox" checked={picked.has(h.id)} onChange={() => togglePick(h.id)} />
                    <span className="mem-text">
                      <span className="mem-meta">
                        {day(h.ts)} · {h.project} · {h.agent === "codex" ? "Codex" : "Claude"}
                        {h.score >= CLOSE && <span className="mem-close"> · {t("가까움")}</span>}
                      </span>
                      <span className="mem-user">{oneLine(h.user)}</span>
                      <span className="mem-answer">{tailLine(h.assistant, 160)}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )
        )}
      </>
    );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal modal-wide memory-start" role="dialog" aria-modal="true" aria-label={t("기억 담아 새로 시작")} onMouseDown={(e) => e.stopPropagation()} data-testid="memory-start">
        <h3 className="buki-title">
          <Buki px={2} pose={searching ? "look-r" : hits?.length === 0 ? "puzzled" : status && !status.enabled ? "sleep" : "idle"} />
          {t("기억 담아 새로 시작")}
        </h3>
        <p className="muted small">{t("지난 대화 전체를 다시 보내는 대신, 고른 기록만 새 세션에 넣어요. 토큰을 아끼고 오래된 맥락이 섞이지 않아요.")}</p>

        <h4 className="mem-h">{t("직전 대화")}</h4>
        {recent === null ? (
          <p className="muted small">{t("읽는 중…")}</p>
        ) : recent.length === 0 ? (
          <p className="muted small">{t("넣을 대화가 없어요")}</p>
        ) : (
          <ul className="mem-list" data-testid="memory-recent">
            {recent.map((r, i) => (
              <li key={i}>
                <label className="mem-item">
                  <input type="checkbox" checked={!!useRecent[i]} onChange={() => setUseRecent((u) => u.map((x, j) => (j === i ? !x : x)))} />
                  <span className="mem-text">
                    <span className="mem-user">{oneLine(r.user)}</span>
                    {r.assistant && <span className="mem-answer">{tailLine(r.assistant, 160)}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <h4 className="mem-h">{t("관련된 지난 작업")}</h4>
        {related}

        <label className="form-row col">
          <span className="muted">{t("이어서 할 일 (선택)")}</span>
          <textarea
            className="text-input"
            rows={2}
            value={prompt}
            placeholder={t("예: 남은 테스트를 마저 고쳐 줘")}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) void start();
            }}
          />
        </label>
        <div className="mem-foot muted small">
          <span data-testid="memory-size">{text ? t("넣을 기록 {n}자 (최대 {max}자)", { n: text.length.toLocaleString(), max: MEMORY_LIMIT.toLocaleString() }) : t("넣을 기록 없음 — 빈 새 세션으로 시작해요")}</span>
          {text && (
            <button className="link-btn" onClick={() => setPreview(!preview)} aria-expanded={preview}>
              {preview ? t("미리 보기 닫기") : t("미리 보기")}
            </button>
          )}
        </div>
        {preview && text && <pre className="mem-preview">{text}</pre>}
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t("취소")}
          </button>
          <button className="btn btn-primary" disabled={!cwd || busy} onClick={start} title="⌘⏎" data-testid="memory-start-go">
            {busy ? t("시작하는 중…") : t("새 세션 시작")}
          </button>
        </div>
      </div>
    </div>
  );
}
