// Shiki 를 필요할 때만 불러와 코드에 색을 입힌다. 문법 파일은 앱 번들 안에 있어 네트워크를 쓰지 않는다.
import type { BundledLanguage, BundledTheme, HighlighterGeneric } from "shiki";

const EXT: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "jsonc", md: "markdown", mdx: "mdx", rs: "rust", py: "python", rb: "ruby", go: "go",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
  css: "css", scss: "scss", less: "less", html: "html", vue: "vue", svelte: "svelte", sh: "shellscript",
  bash: "shellscript", zsh: "shellscript", yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", xml: "xml",
  dart: "dart", php: "php", lua: "lua", dockerfile: "dockerfile", graphql: "graphql", prisma: "prisma",
  ini: "ini", gradle: "groovy", tf: "hcl", proto: "proto", r: "r", scala: "scala", ex: "elixir", exs: "elixir",
};

export function langOf(path: string): string | null {
  const name = path.split("/").pop()!.toLowerCase();
  if (name === "dockerfile") return "dockerfile";
  if (name === "makefile") return "make";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXT[ext] ?? null;
}

let hl: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;

async function highlighter(): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> {
  if (!hl) {
    hl = import("shiki").then((m) => m.createHighlighter({ themes: ["github-dark-default"], langs: [] }));
  }
  return hl;
}

/** 색칠한 HTML 줄 배열. 너무 크거나 언어를 모르면 null (호출하는 쪽이 평문으로 그린다). */
export async function highlightLines(code: string, path: string): Promise<string[] | null> {
  const lang = langOf(path);
  if (!lang || code.length > 400_000) return null;
  try {
    const h = await highlighter();
    if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(lang as BundledLanguage);
    const tokens = h.codeToTokensBase(code, { lang: lang as BundledLanguage, theme: "github-dark-default" });
    return tokens.map((line) =>
      line.map((t) => `<span style="color:${t.color ?? "inherit"}">${escapeHtml(t.content)}</span>`).join(""),
    );
  } catch {
    return null;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
