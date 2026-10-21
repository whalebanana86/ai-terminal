// Shiki 를 필요할 때만 불러와 코드에 색을 입힌다. 문법 파일은 앱 번들 안에 있어 네트워크를 쓰지 않는다.

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

// 필요한 언어 문법만 따로 불러온다(전체 번들은 수백 개 언어 + 600KB WASM 이라 무겁다).
// 정규식 엔진은 WASM(oniguruma) 대신 JS 엔진을 쓴다: 메모리·번들 크기가 작고 CSP 에 wasm 허용이 필요 없다.
const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  markdown: () => import("@shikijs/langs/markdown"),
  rust: () => import("@shikijs/langs/rust"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  go: () => import("@shikijs/langs/go"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  html: () => import("@shikijs/langs/html"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  sql: () => import("@shikijs/langs/sql"),
  xml: () => import("@shikijs/langs/xml"),
  dart: () => import("@shikijs/langs/dart"),
  php: () => import("@shikijs/langs/php"),
  lua: () => import("@shikijs/langs/lua"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  graphql: () => import("@shikijs/langs/graphql"),
  prisma: () => import("@shikijs/langs/prisma"),
  ini: () => import("@shikijs/langs/ini"),
  make: () => import("@shikijs/langs/make"),
};

type Core = import("shiki/core").HighlighterCore;
let hl: Promise<Core> | null = null;

async function highlighter(): Promise<Core> {
  if (!hl) {
    hl = Promise.all([import("shiki/core"), import("shiki/engine/javascript"), import("@shikijs/themes/github-dark-default")]).then(
      ([core, eng, theme]) =>
        core.createHighlighterCore({
          themes: [theme.default],
          langs: [],
          engine: eng.createJavaScriptRegexEngine({ forgiving: true }),
        }),
    );
  }
  return hl;
}

/** 색칠한 HTML 줄 배열. 너무 크거나 언어를 모르면 null (호출하는 쪽이 평문으로 그린다). */
export async function highlightLines(code: string, path: string): Promise<string[] | null> {
  const lang = langOf(path);
  const loader = lang ? LANG_LOADERS[lang] : undefined;
  if (!lang || !loader || code.length > 400_000) return null;
  try {
    const h = await highlighter();
    if (!h.getLoadedLanguages().includes(lang)) {
      const mod = (await loader()) as { default: Parameters<Core["loadLanguage"]>[0] };
      await h.loadLanguage(mod.default);
    }
    const tokens = h.codeToTokensBase(code, { lang, theme: "github-dark-default" });
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
