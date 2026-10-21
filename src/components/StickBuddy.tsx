import { Bug, Plus, Trash2, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { relativeTime } from "../logic";
import { takeNewRequests, type RequestKind, type SeenRequest } from "../requestKind";
import { useStore } from "../store";

/**
 * 위쪽 막대 오른쪽 끝의 스틱맨. AI 에게 새 요청이 가면(앱 채팅·앱 터미널·바깥 터미널 모두, 기록 파일로 알아챈다)
 * 요청을 추가·수정·삭제·버그로 나눠 그에 맞는 동작을 한 번 하고, 그 종류의 오늘 개수를 올린다.
 * 요청이 없을 때는 움직이지 않는다(CPU 를 쓰지 않게).
 */

const KINDS: { kind: RequestKind; label: string; icon: LucideIcon; color: string }[] = [
  { kind: "add", label: "추가", icon: Plus, color: "#4fd18b" },
  { kind: "modify", label: "수정", icon: Wrench, color: "#4cc2ff" },
  { kind: "delete", label: "삭제", icon: Trash2, color: "#ff8a5b" },
  { kind: "bug", label: "버그·오류", icon: Bug, color: "#c792ff" },
];
const KEY = "aiterm.stick.v1";
const ACT_MS = 1600;

type Counts = Record<RequestKind, number>;
interface Saved {
  day: string;
  counts: Counts;
  recent: SeenRequest[];
}

const today = () => new Date().toLocaleDateString("sv");
const empty = (): Saved => ({ day: today(), counts: { add: 0, modify: 0, delete: 0, bug: 0 }, recent: [] });

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    if (v && v.day === today() && v.counts) return v;
  } catch {
    /* 깨진 값은 버린다 */
  }
  return empty();
}

type Act = RequestKind | "none";

export function StickBuddy() {
  const sessions = useStore((s) => s.sessions);
  const [saved, setSaved] = useState<Saved>(load);
  const [act, setAct] = useState<{ kind: Act; n: number } | null>(null);
  const [bump, setBump] = useState<{ kind: RequestKind; n: number } | null>(null);
  const [open, setOpen] = useState(false);
  const queue = useRef<SeenRequest[]>([]);
  const playing = useRef(false);
  const seen = useRef(new Map<string, number>());
  const startedAt = useRef(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const count = useCallback((r: SeenRequest) => {
    setSaved((prev) => {
      const base = prev.day === today() ? prev : empty();
      const next: Saved = {
        day: base.day,
        counts: r.kind ? { ...base.counts, [r.kind]: base.counts[r.kind] + 1 } : base.counts,
        recent: [r, ...base.recent].slice(0, 30),
      };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* 저장 못 해도 화면은 그대로 */
      }
      return next;
    });
    if (r.kind) setBump({ kind: r.kind, n: Date.now() });
  }, []);

  // 줄 선 요청을 하나씩: 동작 → 끝나면 개수 +1 → 다음
  const playNext = useCallback(() => {
    const r = queue.current.shift();
    if (!r) {
      playing.current = false;
      setAct(null);
      return;
    }
    playing.current = true;
    if (reduced) {
      count(r);
      window.setTimeout(playNext, 50);
      return;
    }
    setAct({ kind: r.kind ?? "none", n: Date.now() });
    window.setTimeout(() => {
      count(r);
      playNext();
    }, ACT_MS);
  }, [count, reduced]);

  const push = useCallback(
    (list: SeenRequest[]) => {
      if (!list.length) return;
      // 한꺼번에 많이 오면 마지막 몇 개만 움직이고 나머지는 바로 센다
      const extra = queue.current.length + list.length - 4;
      const items = [...queue.current, ...list];
      if (extra > 0) items.splice(0, extra).forEach(count);
      queue.current = items;
      if (!playing.current) playNext();
    },
    [count, playNext],
  );

  useEffect(() => {
    push(takeNewRequests(seen.current, sessions, startedAt.current));
  }, [sessions, push]);

  // 자정이 지나면 오늘 개수를 비운다
  useEffect(() => {
    const t = window.setInterval(() => setSaved((p) => (p.day === today() ? p : empty())), 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);

  // 바깥을 누르면 목록을 닫는다
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close, true);
    return () => window.removeEventListener("mousedown", close, true);
  }, [open]);

  // 테스트·화면 확인용(automation·개발 빌드에서만)
  const testable = useStore((s) => !!s.info?.automation) || import.meta.env.DEV;
  useEffect(() => {
    if (!testable) return;
    (window as unknown as { __aitermStick?: unknown }).__aitermStick = {
      play: (kind: RequestKind | null, text = "테스트 요청") => push([{ sessionId: "test", title: "테스트", text, at: Date.now(), kind }]),
      state: () => ({ counts: load().counts, playing: playing.current }),
    };
  }, [push, testable]);

  const total = saved.counts.add + saved.counts.modify + saved.counts.delete + saved.counts.bug;
  const now = Date.now();
  return (
    <div className="stick-buddy" ref={box} data-testid="stick-buddy">
      <button className="stick-counts" onClick={() => setOpen(!open)} title="오늘 AI 에게 보낸 요청 (눌러서 목록)" aria-label={`오늘 요청 ${total}개`} aria-expanded={open}>
        {KINDS.map(({ kind, label, icon: Icon, color }) => (
          <span key={kind} className="stick-count" data-kind={kind} title={`${label} ${saved.counts[kind]}`} style={{ color }}>
            <Icon size={12} strokeWidth={2.4} aria-hidden />
            <b key={bump?.kind === kind ? bump.n : 0} className={bump?.kind === kind ? "bump" : ""}>
              {saved.counts[kind]}
            </b>
          </span>
        ))}
      </button>
      <svg
        className={`stickman${act ? ` act-${act.kind}` : ""}`}
        key={act?.n ?? 0}
        width={60}
        height={36}
        viewBox="0 0 60 36"
        aria-hidden
        onClick={() => setOpen(!open)}
      >
        {/* 소품 */}
        <g className="p-add" stroke="#4fd18b" strokeWidth={2.6} strokeLinecap="round">
          <line x1={24} y1={-1} x2={24} y2={7} />
          <line x1={20} y1={3} x2={28} y2={3} />
        </g>
        <g className="p-box">
          <rect x={30} y={28} width={6} height={6} rx={1} fill="#ff8a5b" />
          <path d="M31.5 29.5l3 3m0-3l-3 3" stroke="#15171c" strokeWidth={1.2} />
        </g>
        <g className="p-trash" stroke="#9aa3b5" strokeWidth={1.4} fill="none">
          <path d="M48 25h8M49 25l1 9h4l1-9" />
        </g>
        <g className="p-bug">
          <ellipse cx={58} cy={32} rx={3.2} ry={2.2} fill="#c792ff" />
          <circle cx={55} cy={31.4} r={1.3} fill="#c792ff" />
          <path d="M56.5 30l-1-1.6M59.5 30l1-1.6M56.5 34l-1 1.4M59.5 34l1 1.4" stroke="#c792ff" strokeWidth={0.9} />
        </g>
        <g className="p-spark" stroke="#ffd166" strokeWidth={1.3} strokeLinecap="round">
          <path d="M36 27l3-2M37 30l4 0M36 33l3 2" />
        </g>
        <text className="p-what" x={30} y={7} fontSize={9} fontWeight={700} fill="#9aa3b5">
          ?
        </text>
        {/* 사람 */}
        <g className="fig" stroke="currentColor" strokeWidth={2} strokeLinecap="round" fill="none">
          <circle className="head" cx={24} cy={7} r={4} />
          <line x1={24} y1={11} x2={24} y2={22} />
          <g className="arm-l">
            <line x1={24} y1={14} x2={18} y2={20} />
          </g>
          <g className="arm-r">
            <line x1={24} y1={14} x2={30} y2={20} />
            <g className="p-hammer">
              <line x1={30} y1={20} x2={34} y2={14} stroke="#c9a86a" strokeWidth={1.8} />
              <rect x={31.5} y={10.5} width={6} height={3.6} rx={0.8} transform="rotate(33 34.5 12.3)" fill="#4cc2ff" stroke="none" />
            </g>
          </g>
          <g className="leg-l">
            <line x1={24} y1={22} x2={20} y2={33} />
          </g>
          <g className="leg-r">
            <line x1={24} y1={22} x2={28} y2={33} />
          </g>
        </g>
      </svg>
      {open && (
        <div className="stick-pop" role="dialog" aria-label="오늘 받은 요청">
          <div className="stick-pop-head">
            <b>오늘 AI 에게 보낸 요청</b>
            <span className="muted small">
              {KINDS.map((k) => `${k.label} ${saved.counts[k.kind]}`).join(" · ")}
            </span>
          </div>
          <ul>
            {saved.recent.map((r, i) => {
              const k = KINDS.find((x) => x.kind === r.kind);
              const Icon = k?.icon;
              return (
                <li key={`${r.sessionId}:${r.at}:${i}`}>
                  <span className="stick-pop-kind" style={{ color: k?.color ?? "var(--fg-faint)" }}>
                    {Icon ? <Icon size={12} aria-hidden /> : "?"}
                  </span>
                  <span className="stick-pop-text" title={r.text}>
                    {r.text}
                  </span>
                  <span className="muted small">{relativeTime(r.at, now)}</span>
                </li>
              );
            })}
            {!saved.recent.length && <li className="muted small">아직 없어요. AI 에게 요청을 보내면 여기에 쌓여요.</li>}
          </ul>
          <div className="muted small stick-pop-foot">요청 글자로 추가·수정·삭제·버그를 나눠요(앱 안에서만, 어디에도 보내지 않음). 하루가 지나면 0 부터.</div>
        </div>
      )}
    </div>
  );
}
