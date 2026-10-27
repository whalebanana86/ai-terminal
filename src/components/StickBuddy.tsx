import { Bug, MessageCircleQuestion, Play, Sparkles, Trash2, Wrench, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { relativeTime } from "../logic";
import { takeNewRequests, type RequestKind, type SeenRequest } from "../requestKind";
import { useStore } from "../store";

/**
 * 위쪽 막대 오른쪽 끝의 스틱맨. AI 에게 새 요청이 가면(앱 채팅·앱 터미널·바깥 터미널 모두, 기록 파일로 알아챈다)
 * 요청을 추가·수정·삭제·버그로 나눠 그에 맞는 동작을 한 번 하고, 그 종류의 오늘 개수를 올린다.
 * 요청이 없을 때는 좌우로 서성인다(창이 가려지면 멈춤).
 */

const KINDS: { kind: RequestKind; label: string; icon: LucideIcon; color: string }[] = [
  { kind: "add", label: t("추가"), icon: Sparkles, color: "#4fd18b" },
  { kind: "modify", label: t("수정"), icon: Wrench, color: "#4cc2ff" },
  { kind: "delete", label: t("삭제"), icon: Trash2, color: "#ff8a5b" },
  { kind: "bug", label: t("버그·오류"), icon: Bug, color: "#c792ff" },
  { kind: "question", label: t("질문"), icon: MessageCircleQuestion, color: "#e2c08d" },
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
const empty = (): Saved => ({ day: today(), counts: { add: 0, modify: 0, delete: 0, bug: 0, question: 0 }, recent: [] });

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    // 예전 저장값에 없는 칸(질문)은 0 으로 채운다
    if (v && v.day === today() && v.counts) {
      let additions = 0;
      const recent = (v.recent ?? []).map((r) => {
        if (r.kind || !r.text?.trim()) return r;
        // Previously unclassified retained requests now belong to the addition count too.
        additions++;
        return { ...r, kind: "add" as const };
      });
      const counts = { ...empty().counts, ...v.counts };
      counts.add += additions;
      return { ...v, recent, counts };
    }
  } catch {
    /* 깨진 값은 버린다 */
  }
  return empty();
}

/** none is reserved for an empty legacy/test request. */
type Act = RequestKind | "none";

export function StickBuddy() {
  const sessions = useStore((s) => s.sessions);
  const [saved, setSaved] = useState<Saved>(load);
  const [act, setAct] = useState<{ kind: Act; n: number } | null>(null);
  const [bump, setBump] = useState<{ kind: RequestKind; n: number } | null>(null);
  const [open, setOpen] = useState(false);
  /** replay = 목록에서 눌러 다시 보는 것(개수는 올리지 않음) */
  const queue = useRef<(SeenRequest & { replay?: boolean })[]>([]);
  const playing = useRef(false);
  const seen = useRef(new Map<string, number>());
  const startedAt = useRef(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
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
      if (!r.replay) count(r);
      window.setTimeout(playNext, 50);
      return;
    }
    setAct({ kind: r.kind ?? "none", n: Date.now() });
    window.setTimeout(() => {
      if (!r.replay) count(r);
      playNext();
    }, ACT_MS);
  }, [count, reduced]);

  const push = useCallback(
    (list: (SeenRequest & { replay?: boolean })[]) => {
      if (!list.length) return;
      // 한꺼번에 많이 오면 마지막 몇 개만 움직이고 나머지는 바로 센다(다시 보기는 세지 않고 버림)
      const extra = queue.current.length + list.length - 4;
      const items = [...queue.current, ...list];
      if (extra > 0) items.splice(0, extra).forEach((x) => !x.replay && count(x));
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

  // 창이 안 보일 때는 서성이기를 멈춘다(CPU)
  const [hidden, setHidden] = useState(document.hidden);
  useEffect(() => {
    const on = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  const awake = useAwake();

  // 평소에는 좌우로 서성인다. CSS 애니메이션은 WebKit 이 매 프레임 스타일을 다시 계산해 CPU 를 꽤 써서(측정 +6~11%),
  // 타이머로 초당 몇 번만 자세(속성)를 바꾼다. 요청 동작 중이거나 창이 가려지거나 사용자가 쉬는 동안에는 멈춘다.
  useEffect(() => {
    if (act || hidden || reduced || !awake) return;
    const svg = svgRef.current;
    if (!svg) return;
    const part = (c: string) => svg.querySelector<SVGGElement>(`.${c}`);
    const fig = part("fig");
    const limbs = [part("leg-l"), part("arm-r"), part("leg-r"), part("arm-l")];
    let x = -8;
    let dir = 1;
    let rest = 0;
    let step = 0;
    const tick = () => {
      if (rest > 0) {
        // 끝에 닿으면 잠깐 서서 쉰다
        rest--;
        limbs.forEach((l) => l && (l.style.transform = ""));
      } else {
        step++;
        x += dir * 1.5;
        if (x >= 9 || x <= -8) {
          dir = -dir;
          rest = 4;
        }
        const a = step % 2 ? 16 : -16;
        // 축(엉덩이·어깨)은 CSS transform-origin 에 있다. 왼다리·오른팔 / 오른다리·왼팔이 서로 반대로 흔든다
        limbs.forEach((l, i) => l && (l.style.transform = `rotate(${i < 2 ? a : -a}deg)`));
      }
      if (fig) fig.style.transform = `translateX(${x}px)`;
    };
    const t = window.setInterval(tick, 230);
    return () => {
      window.clearInterval(t);
      if (fig) fig.style.transform = "";
      limbs.forEach((l) => l && (l.style.transform = ""));
    };
  }, [act, hidden, reduced, awake]);

  const total = KINDS.reduce((n, k) => n + saved.counts[k.kind], 0);
  const now = Date.now();
  return (
    <div className={`stick-buddy${hidden ? " paused" : ""}`} ref={box} data-testid="stick-buddy">
      <svg
        ref={svgRef}
        className={`stickman ${act ? `act-${act.kind}` : "idle"}`}
        key={act?.n ?? 0}
        width={42}
        height={25}
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
      <button className="stick-counts" onClick={() => setOpen(!open)} title={t("오늘 AI 에게 보낸 요청 (눌러서 목록)")} aria-label={t("오늘 요청 {n}개", { n: total })} aria-expanded={open}>
        {KINDS.map(({ kind, label, icon: Icon, color }) => (
          <span key={kind} className="stick-count" data-kind={kind} title={`${label} ${saved.counts[kind]}`} style={{ color }}>
            <Icon size={11} strokeWidth={2.4} aria-hidden />
            <b key={bump?.kind === kind ? bump.n : 0} className={bump?.kind === kind ? "bump" : ""}>
              {saved.counts[kind]}
            </b>
          </span>
        ))}
      </button>
      {open && (
        <div className="stick-pop" role="dialog" aria-label={t("오늘 받은 요청")}>
          <div className="stick-pop-head">
            <b>{t("오늘 AI 에게 보낸 요청")}</b>
            <span className="muted small">
              {KINDS.map((k) => `${k.label} ${saved.counts[k.kind]}`).join(" · ")}
            </span>
          </div>
          <ul>
            {saved.recent.map((r, i) => {
              const k = KINDS.find((x) => x.kind === r.kind);
              const Icon = k?.icon;
              return (
                // 누르면 그 요청에 맞는 동작을 한 번 더 보여 준다(못 보고 지나간 동작 다시 보기)
                <li
                  key={`${r.sessionId}:${r.at}:${i}`}
                  className="stick-pop-item"
                  role="button"
                  tabIndex={0}
                  title={`${r.text}\n${t("눌러서 스틱맨 동작 다시 보기")}`}
                  onClick={() => push([{ ...r, replay: true }])}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), push([{ ...r, replay: true }]))}
                  data-kind={r.kind ?? "none"}
                >
                  <span className="stick-pop-kind" style={{ color: k?.color ?? "var(--fg-faint)" }}>
                    {Icon ? <Icon size={12} aria-hidden /> : "·"}
                  </span>
                  <span className="stick-pop-text">{r.text}</span>
                  <span className="muted small stick-pop-time">{relativeTime(r.at, now)}</span>
                  <Play size={11} className="stick-pop-play" aria-hidden />
                </li>
              );
            })}
            {!saved.recent.length && <li className="muted small">{t("아직 없어요. AI 에게 요청을 보내면 여기에 쌓여요.")}</li>}
          </ul>
          <div className="muted small stick-pop-foot">
            {t("줄을 누르면 스틱맨이 그 동작을 다시 해요.")}{" "}
            {t("요청 글자로 추가·수정·삭제·버그·질문을 나눠요(앱 안에서만, 어디에도 보내지 않음). 분류하기 어려운 요청은 추가로 세어요. 하루가 지나면 0 부터.")}
          </div>
        </div>
      )}
    </div>
  );
}

/** 사용자가 이 창을 쓰는 중인지: 창이 활성이고 마지막으로 손댄(마우스·키) 지 30초 안.
 *  쉬는 동안 서성이기를 멈춘다. 0.23초마다 자세를 바꾸면 화면을 계속 다시 그려 아무것도 안 할 때도 CPU 를 쓴다(측정 약 1~2%). */
function useAwake(ms = 30_000): boolean {
  const [awake, setAwake] = useState(() => !document.hidden && document.hasFocus());
  useEffect(() => {
    let timer = 0;
    let last = 0;
    const sleep = () => {
      window.clearTimeout(timer);
      // 1초 안에 돌아와도 타이머를 다시 걸게 한다(안 그러면 깬 채로 남아 계속 걷는다)
      last = 0;
      setAwake(false);
    };
    const wake = () => {
      if (document.hidden || !document.hasFocus()) return sleep();
      setAwake(true);
      // 마우스를 움직이는 동안 매번 타이머를 다시 걸지 않게 1초에 한 번만
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      window.clearTimeout(timer);
      timer = window.setTimeout(sleep, ms);
    };
    const events = ["pointermove", "pointerdown", "keydown", "wheel", "focus"] as const;
    events.forEach((e) => window.addEventListener(e, wake, { capture: true, passive: true }));
    window.addEventListener("blur", sleep);
    document.addEventListener("visibilitychange", wake);
    wake();
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, wake, { capture: true }));
      window.removeEventListener("blur", sleep);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [ms]);
  return awake;
}
