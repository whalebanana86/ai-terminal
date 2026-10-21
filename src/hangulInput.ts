import type { Terminal } from "@xterm/xterm";

/**
 * macOS WebKit(WKWebView)의 한글 입력기는 조합 이벤트 없이
 *   insertText "ㅎ" → insertReplacementText "하" → "한" → (다음 글자) insertText "ㄱ" …
 * 처럼 마지막 글자를 바꿔치기한다. xterm.js 는 첫 자모만 보내고 바꿔치기를 무시해서 "ㅎㄱ" 만 들어간다.
 * 그래서 조합 중인 글자는 붙잡아 두고(화면에는 미리보기), 다음 글자가 시작되거나 다른 키를 누르면 완성된 글자를 보낸다.
 */
export class HangulBuffer {
  pending = "";
  constructor(
    private readonly send: (text: string) => void,
    private readonly show: (text: string) => void,
  ) {}

  /** input/beforeinput 이벤트. true 면 여기서 처리했으니 xterm 에 넘기지 않는다. */
  input(type: string, data: string | null): boolean {
    if (type === "insertReplacementText") {
      if (!this.pending) return false;
      this.set(data ?? "");
      return true;
    }
    if (type === "insertText" && data && isHangul(data)) {
      this.flush();
      this.set(data);
      return true;
    }
    if (type === "deleteContentBackward" && this.pending) {
      // 조합 중 글자를 지운 것(아직 터미널로 보낸 적 없음)
      this.set("");
      return true;
    }
    this.flush();
    return false;
  }

  /** keydown. true 면 xterm 에 넘기지 않는다. */
  key(keyCode: number): boolean {
    if (keyCode === 229) return this.pending !== ""; // 입력기가 처리한 키
    if (keyCode === 8 && this.pending) {
      // 자모 하나만 남은 상태에서 지우기: 입력기가 넘겨준 Backspace. 보낸 적 없는 글자이니 그냥 버린다.
      this.set("");
      return true;
    }
    if (keyCode === 16 || keyCode === 17 || keyCode === 18 || keyCode === 91 || keyCode === 93) return false; // 수식 키만
    this.flush(); // Enter·방향키·영문 등: 조합 중 글자를 먼저 보낸다
    return false;
  }

  flush() {
    if (!this.pending) return;
    const text = this.pending;
    this.set("");
    this.send(text);
  }

  private set(text: string) {
    this.pending = text;
    this.show(text);
  }
}

/** 한글 자모·음절로만 된 문자열인지 */
export function isHangul(s: string): boolean {
  return /^[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]+$/.test(s);
}

/** 터미널에 붙인다. 반환값은 해제 함수. */
export function attachHangulInput(term: Terminal, host: HTMLElement): () => void {
  const textarea = host.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  if (!textarea || !screen) return () => {};
  const preview = document.createElement("div");
  preview.className = "hangul-preview";
  screen.appendChild(preview);
  const show = (text: string) => {
    preview.textContent = text;
    preview.style.display = text ? "block" : "none";
    if (!text) return;
    // 터미널 커서 자리에 조합 중 글자를 겹쳐 보여 준다.
    const cw = screen.clientWidth / term.cols;
    const ch = screen.clientHeight / term.rows;
    const buf = term.buffer.active;
    preview.style.left = `${Math.min(buf.cursorX, term.cols - 2) * cw}px`;
    preview.style.top = `${buf.cursorY * ch}px`;
    preview.style.height = `${ch}px`;
    preview.style.lineHeight = `${ch}px`;
    preview.style.fontSize = `${term.options.fontSize}px`;
    preview.style.fontFamily = term.options.fontFamily ?? "monospace";
  };
  const buffer = new HangulBuffer((text) => term.input(text, true), show);
  let composing = false; // 조합 이벤트를 쓰는 입력기(일본어 등)는 xterm 이 원래대로 처리
  // 캡처 단계로 텍스트 영역보다 먼저 받아, 처리한 이벤트는 xterm 까지 가지 않게 막는다.
  const onInput = (e: Event) => {
    const ev = e as InputEvent;
    if (composing || ev.target !== textarea) return;
    if (buffer.input(ev.inputType, ev.data)) e.stopPropagation();
  };
  const onKey = (e: KeyboardEvent) => {
    if (composing || e.target !== textarea) return;
    if (buffer.key(e.keyCode)) e.stopPropagation();
  };
  const onCompStart = () => {
    buffer.flush();
    composing = true;
  };
  const onCompEnd = () => {
    composing = false;
  };
  const onFlush = () => buffer.flush();
  host.addEventListener("input", onInput, true);
  host.addEventListener("keydown", onKey, true);
  host.addEventListener("compositionstart", onCompStart, true);
  host.addEventListener("compositionend", onCompEnd, true);
  host.addEventListener("paste", onFlush, true);
  textarea.addEventListener("blur", onFlush);
  return () => {
    buffer.flush();
    host.removeEventListener("input", onInput, true);
    host.removeEventListener("keydown", onKey, true);
    host.removeEventListener("compositionstart", onCompStart, true);
    host.removeEventListener("compositionend", onCompEnd, true);
    host.removeEventListener("paste", onFlush, true);
    textarea.removeEventListener("blur", onFlush);
    preview.remove();
  };
}
