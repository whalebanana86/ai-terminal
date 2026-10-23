import { Channel } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { api } from "../api";
import { attachHangulInput } from "../hangulInput";
import { t } from "../i18n";
import { useStore } from "../store";
import { fileLinkProvider } from "../terminalLinks";
import { currentTheme, onThemeChange, type Theme } from "../theme";
import { termPasters } from "../termPaste";

/** 실행 id → 터미널. 테스트 자동화와 디버깅에서 화면 글자를 읽는 데 쓴다. */
const registry = new Map<string, Terminal>();

declare global {
  interface Window {
    __aiterm?: {
      terminalText: (execId: string) => string | null;
      terminalIds: () => string[];
      terminalCursor: (execId: string) => { x: number; y: number; rows: number; cols: number } | null;
    };
  }
}

/** 테스트 자동화 빌드·개발 모드에서만 터미널 화면 글자를 읽을 수 있게 노출한다. */
export function exposeTerminals() {
  window.__aiterm = {
    terminalText: (execId) => {
    const t = registry.get(execId);
    if (!t) return null;
    const buf = t.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    return lines.join("\n");
  },
    terminalIds: () => [...registry.keys()],
    terminalCursor: (execId) => {
      const t = registry.get(execId);
      return t ? { x: t.buffer.active.cursorX, y: t.buffer.active.cursorY, rows: t.rows, cols: t.cols } : null;
    },
  };
}

const DARK = {
  background: "#0f1115",
  foreground: "#d7dae0",
  cursor: "#4cc2ff",
  selectionBackground: "#2c3e57",
  black: "#1c1f26",
  brightBlack: "#5c6370",
  red: "#ff6b6b",
  green: "#7ee787",
  yellow: "#ffb454",
  blue: "#4cc2ff",
  magenta: "#c792ea",
  cyan: "#56d4bc",
  white: "#d7dae0",
};

/** 밝은 화면용(설정 → 화면 모드). CLI 가 쓰는 기본 16색도 흰 바탕에서 읽히게 진하게 */
const LIGHT = {
  background: "#fbfbfc",
  foreground: "#1f2329",
  cursor: "#0a78c2",
  selectionBackground: "#cfe3f7",
  black: "#1f2329",
  brightBlack: "#6a7380",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightWhite: "#8c959f",
};
const themeFor = (t: Theme) => (t === "light" ? LIGHT : DARK);

/** 한글이 영문 정확히 두 칸 폭인 글꼴을 먼저(SF Mono 두 칸은 한글보다 넓어 글자 사이가 벌어진다) */
const TERM_FONT = '"Haengbang Mono", "SF Mono", Menlo, "Apple SD Gothic Neo", monospace';
const TERM_FONT_SIZE = 13;
/** 글꼴 파일을 다 불러온 뒤에 칸 크기를 재야 한다(먼저 재면 대신 쓴 글꼴 폭으로 굳는다) */
const termFontReady: Promise<unknown> =
  typeof document !== "undefined" && document.fonts
    ? Promise.all([document.fonts.load(`${TERM_FONT_SIZE}px "Haengbang Mono"`), document.fonts.load(`bold ${TERM_FONT_SIZE}px "Haengbang Mono"`)]).catch(() => null)
    : Promise.resolve();

export function TerminalView({ execId, visible }: { execId: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  /** 칸에 맞춰 크기를 다시 재고 PTY 에 알린다 */
  const fitRef = useRef<() => void>(() => {});
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: TERM_FONT,
      fontSize: TERM_FONT_SIZE,
      lineHeight: 1.15,
      cursorBlink: true,
      // 화면 메모리 절약: 이전 출력은 백엔드 버퍼(2MB)에도 남아 다시 붙을 때 재생된다.
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: themeFor(currentTheme()),
    });
    const links = term.registerLinkProvider(fileLinkProvider(term, () => {
      const state = useStore.getState();
      const exec = state.execs.find(e => e.id === execId);
      if (!exec) return null;
      const root = exec.worktreePath ?? state.repos.flatMap(r => r.worktrees).filter(w => exec.cwd === w.path || exec.cwd.startsWith(`${w.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]?.path;
      return root ? { worktree: root, cwd: exec.cwd } : null;
    }, (ctx, paths) => api.fsTerminalPaths(ctx.worktree, ctx.cwd, paths), (ctx, rel) => {
      const state = useStore.getState();
      if (state.focus?.worktreePath !== ctx.worktree) state.setFocusWorktree(ctx.worktree);
      useStore.getState().openViewer({ kind: "file", rel, mode: "preview" });
    }));
    const fit = new FitAddon();
    term.loadAddon(fit);
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11"; // 한글 등 전각 문자 폭
    term.open(el);
    // macOS WebView 의 한글 입력기 바꿔치기 방식 처리(그대로 두면 첫 자모만 들어간다)
    const detachHangul = attachHangulInput(term, el);
    termRef.current = term;
    // 화면 모드가 바뀌면 터미널 색도 바로 바꾼다
    const offTheme = onThemeChange((th) => (term.options.theme = themeFor(th)));
    registry.set(execId, term);
    // 파일을 끌어다 놓으면 경로를 붙여넣기로(괄호 붙여넣기 모드면 CLI 가 붙여넣기로 알아본다)
    termPasters.set(execId, (text) => {
      term.paste(text);
      term.focus();
    });

    const ch = new Channel<ArrayBuffer | number[] | string>();
    ch.onmessage = (m) => {
      if (m instanceof ArrayBuffer) term.write(new Uint8Array(m));
      else if (Array.isArray(m)) term.write(new Uint8Array(m));
      else term.write(m);
    };
    let sinkId: number | null = null;
    let disposed = false;
    // 다시 붙을 때 앞선 출력을 재생하지만 재생한 화면은 실제와 다를 수 있다. 오래된 앞부분이 잘려 켜 두었던
    // 모드(스크롤 영역·커서 숨김 등)가 빠지고, 에이전트는 바뀐 곳만 다시 그려서 이미 그렸다고 아는 입력칸이 안 보이기도 한다.
    // PTY 크기가 그대로면 에이전트는 다시 그리지 않으니, 폭을 한 칸 줄였다 되돌려 화면 전체를 다시 그리게 한다.
    let needRepaint = false;
    let repainting = false;
    const sendSize = () => {
      // 다시 그리게 하는 중이면 끝날 때 지금 크기를 보낸다
      if (!repainting) void api.execResize(execId, term.cols, term.rows).catch(() => {});
    };
    const repaint = () => {
      if (!needRepaint || disposed || el.clientWidth < 20 || el.clientHeight < 20) return; // 보일 때 한다
      needRepaint = false;
      repainting = true;
      void api.execResize(execId, Math.max(2, term.cols - 1), term.rows).catch(() => {});
      // 바로 되돌리면 크기 바뀜 신호 둘을 한꺼번에 처리해 크기가 그대로로 보이므로 사이를 둔다
      window.setTimeout(() => {
        repainting = false;
        if (!disposed) sendSize();
      }, 200);
    };
    api.execAttach(execId, ch).then(
      (a) => {
        if (disposed) return void api.execDetach(execId, a.sinkId);
        sinkId = a.sinkId;
        if (a.replayed > 0) needRepaint = true;
        repaint();
      },
      (e) => term.write(`\r\n${t("[연결 실패]")} ${e}\r\n`),
    );
    const onData = term.onData((d) => void api.execWrite(execId, d).catch(() => {}));
    let retries = 0;
    const resize = () => {
      if (disposed || el.clientWidth < 20 || el.clientHeight < 20) return; // 숨겨진 상태
      try {
        // 칸 크기를 아직 못 재면 맞추지 못한 기본 크기(80x24)를 알리게 되므로 조금 뒤 다시 한다
        const dims = fit.proposeDimensions();
        if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) {
          if (retries++ < 20) window.setTimeout(resize, 100);
          return;
        }
        retries = 0;
        fit.fit();
      } catch {
        return;
      }
      // 다시 그리게 할 때는 크기 알림을 따로 보내지 않는다(두 요청의 처리 순서가 바뀌면 크기가 그대로로 보일 수 있다)
      if (needRepaint) repaint();
      else sendSize();
    };
    fitRef.current = resize;
    try {
      const gl = new WebglAddon();
      // 동시에 쓸 수 있는 WebGL 개수를 넘으면 오래된 것부터 끊긴다. 기본 렌더러로 바뀌면 칸 크기가 달라질 수 있고
      // 끊기기 전 화면이 어긋나 보일 수 있으니, 크기를 다시 재고 에이전트가 화면 전체를 다시 그리게 한다.
      gl.onContextLoss(() => {
        gl.dispose();
        if (disposed) return;
        needRepaint = true;
        resize();
      });
      term.loadAddon(gl);
    } catch {
      /* WebGL 이 안 되면 기본 렌더러 */
    }
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);
    resize();
    // 글꼴을 늦게 불러왔으면 칸 크기를 다시 재고(옵션을 다시 넣어야 잰다) 터미널 크기를 맞춘다
    void termFontReady.then(() => {
      if (disposed) return;
      term.options.fontFamily = "monospace";
      term.options.fontFamily = TERM_FONT;
      resize();
    });
    return () => {
      disposed = true;
      offTheme();
      detachHangul();
      ro.disconnect();
      onData.dispose();
      links.dispose();
      if (sinkId !== null) void api.execDetach(execId, sinkId);
      registry.delete(execId);
      termPasters.delete(execId);
      term.dispose();
    };
  }, [execId]);

  useEffect(() => {
    if (!visible) return;
    const t = window.setTimeout(() => {
      fitRef.current();
      termRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible, execId]);

  return <div className="term-host" ref={host} style={{ display: visible ? "block" : "none" }} data-exec={execId} />;
}
