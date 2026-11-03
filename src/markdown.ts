// md 파일을 꼴 갖춘 문서(HTML)로. 파일 보기의 '미리보기' 와 '브라우저로 열기' 가 함께 쓴다(필요할 때만 불러온다).
// 저장소 파일은 남이 쓴 것일 수 있어 DOMPurify 로 거른다(스크립트·이벤트 속성·javascript: 주소·style 속성·입력칸 제거).
// 앱 CSP(script-src 'self')가 한 번 더 막는다.
import DOMPurify from "dompurify";
import { Marked } from "marked";

/** GitHub 와 같은 제목 앵커: 소문자, 글자·숫자·한글·-·_ 만, 빈칸은 - */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** 미리보기 안 링크를 어떻게 다룰지. 웹뷰가 다른 주소로 넘어가지 않게 모든 링크는 이것으로 판단해 직접 처리한다 */
export type LinkTarget = { kind: "anchor"; id: string } | { kind: "external"; url: string } | { kind: "file"; rel: string } | { kind: "none" };

/** md 파일(rel) 안의 상대 경로를 워크트리 기준 경로로. 워크트리 밖으로 나가면 null */
export function resolveRel(fromRel: string, href: string): string | null {
  const clean = decodeURIComponentSafe(href.split(/[?#]/)[0]);
  if (!clean) return null;
  const parts = clean.startsWith("/") ? [] : fromRel.split("/").slice(0, -1);
  for (const seg of clean.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.length ? parts.join("/") : null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function linkTarget(fromRel: string, href: string | null): LinkTarget {
  if (!href) return { kind: "none" };
  if (href.startsWith("#")) return { kind: "anchor", id: decodeURIComponentSafe(href.slice(1)) };
  if (/^(https?:|mailto:)/i.test(href)) return { kind: "external", url: href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: "none" }; // file:·javascript: 등은 열지 않는다
  const rel = resolveRel(fromRel, href);
  return rel ? { kind: "file", rel } : { kind: "none" };
}

const marked = new Marked({ gfm: true, breaks: false, async: false });
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

/**
 * md → 거른 HTML.
 * - 앱 안 미리보기(app): 그림 주소는 data-src 로 옮겨 두고(앱이 워크트리에서 읽어 blob 으로 바꾼다),
 *   제목 id 는 "user-content-" 를 붙여 앱 전역 이름과 겹치지 않게 한다.
 * - 브라우저용: 저장소 안 상대 경로 그림·링크를 원래 파일의 file:// 주소로 바꾼다(문서는 캐시 폴더에 쓰이므로).
 *   `<base>` 를 쓰면 "#제목" 링크까지 그 폴더로 가 버려서 쓰지 않는다. 워크트리 밖·모르는 주소는 뺀다.
 */
export function renderMarkdown(src: string, opts: { app: true } | { app: false; worktree: string; rel: string }): string {
  const raw = marked.parse(src.replace(/^\uFEFF/, "")) as string;
  // 걸러진 결과를 화면에 없는 문서(그림을 읽지 않음)로 받아 마저 손본 뒤 글로 돌려준다
  const body = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "form", "button", "textarea", "select", "option", "iframe", "frame", "object", "embed", "link", "meta", "base", "dialog"],
    FORBID_ATTR: ["style", "srcdoc", "formaction", "ping"],
    SANITIZE_NAMED_PROPS: opts.app,
    RETURN_DOM: true,
  }) as HTMLElement;
  // 할 일 목록 체크 칸만 남기고(누를 수 없게) 다른 입력칸은 뺀다
  for (const el of [...body.querySelectorAll("input")]) {
    if (el.getAttribute("type") === "checkbox") el.setAttribute("disabled", "");
    else el.remove();
  }
  if (opts.app) {
    for (const img of [...body.querySelectorAll("img")]) {
      const s = img.getAttribute("src");
      if (s) img.setAttribute("data-src", s);
      img.removeAttribute("src");
      img.removeAttribute("srcset");
    }
  } else {
    for (const [el, attr] of [...[...body.querySelectorAll("img")].map((e) => [e, "src"] as const), ...[...body.querySelectorAll("a")].map((e) => [e, "href"] as const)]) {
      if (attr === "src") el.removeAttribute("srcset");
      const v = el.getAttribute(attr);
      if (v === null || /^data:image\//i.test(v)) continue;
      const target = linkTarget(opts.rel, v);
      if (target.kind === "file") el.setAttribute(attr, fileUrl(opts.worktree, target.rel) + (attr === "href" && v.includes("#") ? v.slice(v.indexOf("#")) : ""));
      else if (target.kind === "none") el.removeAttribute(attr);
    }
  }
  return body.innerHTML;
}

/** 워크트리 안 파일의 file:// 주소(경로 마디마다 인코딩: 빈칸·한글·#·? 가 든 이름도 그대로) */
export function fileUrl(worktree: string, rel: string): string {
  const abs = `${worktree.replace(/\/+$/, "")}/${rel}`;
  return "file://" + abs.split("/").map(encodeURIComponent).join("/");
}
