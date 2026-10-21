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
import { currentTheme, onThemeChange, type Theme } from "../theme";
import { termPasters } from "../termPaste";

/** 실행 id → 터미널. 테스트 자동화와 디버깅에서 화면 글자를 읽는 데 쓴다. */
const registry = new Map<string, Terminal>();

declare global {
  interface Window {
    __aiterm?: {
      terminalText: (execId: string) => string | null;
      terminalIds: () => string[];
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

export function TerminalView({ execId, visible }: { execId: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new Terminal({
      fontFamily: '"SF Mono", Menlo, "D2Coding", "Apple SD Gothic Neo", monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      cursorBlink: true,
      // 화면 메모리 절약: 이전 출력은 백엔드 버퍼(2MB)에도 남아 다시 붙을 때 재생된다.
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: themeFor(currentTheme()),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const uni = new Unicode11Addon();
    term.loadAddon(uni);
    term.unicode.activeVersion = "11"; // 한글 등 전각 문자 폭
    term.open(el);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {
      /* WebGL 이 안 되면 기본 렌더러 */
    }
    // macOS WebView 의 한글 입력기 바꿔치기 방식 처리(그대로 두면 첫 자모만 들어간다)
    const detachHangul = attachHangulInput(term, el);
    termRef.current = term;
    fitRef.current = fit;
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
    api.execAttach(execId, ch).then(
      (id) => {
        if (disposed) void api.execDetach(execId, id);
        else sinkId = id;
      },
      (e) => term.write(`\r\n${t("[연결 실패]")} ${e}\r\n`),
    );
    const onData = term.onData((d) => void api.execWrite(execId, d).catch(() => {}));
    const resize = () => {
      if (el.clientWidth < 20 || el.clientHeight < 20) return; // 숨겨진 상태
      try {
        fit.fit();
        void api.execResize(execId, term.cols, term.rows).catch(() => {});
      } catch {
        /* 무시 */
      }
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);
    resize();
    return () => {
      disposed = true;
      offTheme();
      detachHangul();
      ro.disconnect();
      onData.dispose();
      if (sinkId !== null) void api.execDetach(execId, sinkId);
      registry.delete(execId);
      termPasters.delete(execId);
      term.dispose();
    };
  }, [execId]);

  useEffect(() => {
    if (!visible) return;
    const t = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          void api.execResize(execId, term.cols, term.rows).catch(() => {});
          term.focus();
        }
      } catch {
        /* 무시 */
      }
    }, 30);
    return () => window.clearTimeout(t);
  }, [visible, execId]);

  return <div className="term-host" ref={host} style={{ display: visible ? "block" : "none" }} data-exec={execId} />;
}
